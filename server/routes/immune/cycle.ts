// The governed cycle, extracted so BOTH the manual POST /cycle handler and the
// live-agent loop (agent.ts) run the EXACT same path — SENTRA gate -> (if
// accepted) append a SHA-256 hash-linked + optionally Ed25519-signed YAWAR
// receipt -> evaluate HUKLLA tripwires -> append evidence. No forked logic.
import { getState } from "./state";
import type { ImmuneMode } from "./state";
import { sentraInspect, type SentraVerdict } from "./sentra";
import { evaluateTripwires, type HukllaFiredTripwire } from "./huklla";
import { appendReceipt, appendEvidence, ledgerCount, type Receipt } from "./ledger";
import { canonicalBytes, CanonicalError } from "./canonical";

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

/**
 * Run one governed cycle over an intent. `extra` (optional) is recorded under a
 * namespaced `agent` field inside the receipt payload so the receipt reflects
 * the concrete governed action without colliding with the base fields.
 */
export async function runGovernedCycle(
  intentPayload: GovernedIntent,
  extra?: Record<string, unknown>,
): Promise<GovernedCycleResult> {
  const s = getState();

  // SENTRA inspects the FULL intent (base fields + any agent extra) so the gate
  // sees exactly what will be governed.
  const inspected = extra ? { ...intentPayload, agent: extra } : intentPayload;
  const sentra = sentraInspect(inspected, s.mode);

  let receiptOut: Receipt | null = null;
  let payloadBytes = 0;
  let pass = false;

  if (s.deadman) {
    pass = false;
  } else if (sentra.accepted) {
    const payload: Record<string, unknown> = {
      actor: intentPayload.actor,
      intent: intentPayload.intent,
      mode: s.mode,
      sentra: {
        accepted: true,
        signatureMatched: sentra.signatureMatched ?? "intent.required",
      },
    };
    if (extra) payload.agent = extra;
    try {
      payloadBytes = canonicalBytes({ payload }).byteLength;
      receiptOut = await appendReceipt({ payload });
      pass = true;
    } catch (err) {
      const detail = err instanceof CanonicalError ? err.message : (err as Error).message;
      receiptOut = null;
      pass = false;
      sentra.accepted = false;
      sentra.reason = `canonicalize: ${detail}`;
      sentra.signatureMatched = "guard.canonical";
    }
  }

  const huklla = evaluateTripwires({
    mode: s.mode,
    selectedTripwire: s.tripwire,
    sentraAccepted: sentra.accepted,
    payloadBytes,
    receiptWritten: receiptOut !== null,
  });

  appendEvidence({
    ts: new Date().toISOString(),
    cycleSeq: ledgerCount(),
    fired: huklla,
  });

  return { pass, mode: s.mode, deadman: s.deadman, sentra, huklla, receipt: receiptOut, payloadBytes };
}
