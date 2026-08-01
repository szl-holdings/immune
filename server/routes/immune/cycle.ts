// The governed cycle, extracted so BOTH the manual POST /cycle handler and the
// live-agent loop (agent.ts) run the EXACT same path — SENTRA gate -> (if
// accepted) append a SHA-256 hash-linked + optionally Ed25519-signed YAWAR
// receipt -> evaluate HUKLLA tripwires -> append evidence. No forked logic.
import { authoritativeTripwireState, getState } from "./state";
import type { AuthoritySnapshot, ImmuneMode } from "./state";
import { sentraInspect, type SentraVerdict } from "./sentra";
import { evaluateTripwires, type HukllaFiredTripwire } from "./huklla";
import {
  appendReceipt,
  appendEvidence,
  ledgerCount,
  type AppendInput,
  type Receipt,
} from "./ledger";
import { canonicalBytes } from "./canonical";

export interface GovernedCycleResult {
  pass: boolean;
  mode: ImmuneMode;
  deadman: boolean;
  sentra: SentraVerdict;
  huklla: HukllaFiredTripwire[];
  receipt: Receipt | null;
  payloadBytes: number;
}

export interface GovernedIntent {
  actor: string;
  intent: string;
}

export interface GovernedCycleDependencies {
  getAuthorityState: () => AuthoritySnapshot;
  appendReceipt: (input: AppendInput, beforeAppend?: () => void) => Promise<Receipt>;
  appendEvidence: typeof appendEvidence;
  ledgerCount: typeof ledgerCount;
}

const DEFAULT_DEPENDENCIES: GovernedCycleDependencies = {
  getAuthorityState: getState,
  appendReceipt,
  appendEvidence,
  ledgerCount,
};

class AuthorityRevisionError extends Error {
  constructor() {
    super("signed authority changed before receipt persistence");
    this.name = "AuthorityRevisionError";
  }
}

function sameAuthority(
  expected: AuthoritySnapshot,
  current: AuthoritySnapshot,
): boolean {
  const currentEffective = authoritativeTripwireState(current);
  return (
    currentEffective.evidenceState === "VERIFIED" &&
    !currentEffective.deadman &&
    current.revision === expected.revision &&
    current.requestId === expected.requestId &&
    current.authorityReceiptHash === expected.authorityReceiptHash &&
    current.authority.version === expected.authority.version &&
    current.authority.keyId === expected.authority.keyId &&
    currentEffective.validUntil === authoritativeTripwireState(expected).validUntil
  );
}

/**
 * Run one governed cycle over an intent. `extra` (optional) is recorded under a
 * namespaced `agent` field inside the receipt payload so the receipt reflects
 * the concrete governed action without colliding with the base fields.
 */
export async function runGovernedCycle(
  intentPayload: GovernedIntent,
  extra?: Record<string, unknown>,
  dependencies: GovernedCycleDependencies = DEFAULT_DEPENDENCIES,
): Promise<GovernedCycleResult> {
  const s = dependencies.getAuthorityState();
  const authority = authoritativeTripwireState(s);
  const effectiveMode: ImmuneMode = authority.mode;

  // SENTRA inspects the FULL intent (base fields + any agent extra) so the gate
  // sees exactly what will be governed.
  const inspected = extra ? { ...intentPayload, agent: extra } : intentPayload;
  const sentra = sentraInspect(inspected, effectiveMode);

  let receiptOut: Receipt | null = null;
  let payloadBytes = 0;
  let pass = false;

  if (authority.deadman) {
    pass = false;
  } else if (sentra.accepted) {
    const payload: Record<string, unknown> = {
      actor: intentPayload.actor,
      intent: intentPayload.intent,
      mode: effectiveMode,
      sentra: {
        accepted: true,
        signatureMatched: sentra.signatureMatched ?? "intent.required",
      },
      authority: {
        version: s.authority.version,
        keyId: s.authority.keyId,
        revision: authority.revision,
        requestId: authority.requestId,
        receiptHash: s.authorityReceiptHash,
        validUntil: authority.validUntil,
      },
    };
    if (extra) payload.agent = extra;
    try {
      payloadBytes = canonicalBytes({ payload }).byteLength;
      receiptOut = await dependencies.appendReceipt({ payload }, () => {
        if (!sameAuthority(s, dependencies.getAuthorityState())) {
          throw new AuthorityRevisionError();
        }
      });
      pass = true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      receiptOut = null;
      pass = false;
      sentra.accepted = false;
      if (err instanceof AuthorityRevisionError) {
        sentra.reason = detail;
        sentra.signatureMatched = "guard.authority-revision";
      } else {
        sentra.reason = `canonicalize: ${detail}`;
        sentra.signatureMatched = "guard.canonical";
      }
    }
  }

  const huklla = evaluateTripwires({
    mode: effectiveMode,
    selectedTripwire: authority.tripwire,
    sentraAccepted: sentra.accepted,
    payloadBytes,
    receiptWritten: receiptOut !== null,
  });

  dependencies.appendEvidence({
    ts: new Date().toISOString(),
    cycleSeq: dependencies.ledgerCount(),
    fired: huklla,
  });

  return {
    pass,
    mode: effectiveMode,
    deadman: authority.deadman,
    sentra,
    huklla,
    receipt: receiptOut,
    payloadBytes,
  };
}
