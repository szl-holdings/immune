import type {
  AuthoritativeTripwireState,
  EvidenceState,
  ImmuneMode,
  ImmuneState,
} from "./immune-api";

const EVIDENCE_STATES = new Set<EvidenceState>([
  "VERIFIED",
  "FAILED",
  "UNAVAILABLE",
  "STALE",
]);
const MODES = new Set<ImmuneMode>(["PASS", "SENTRA_REJECT", "DEADMAN"]);

function unavailable(reason: string): AuthoritativeTripwireState {
  return {
    evidenceState: "UNAVAILABLE",
    mode: "SENTRA_REJECT",
    deadman: false,
    tripwire: null,
    reason,
    updatedAt: null,
    requestId: null,
    revision: 0,
  };
}

function failed(reason: string): AuthoritativeTripwireState {
  return {
    ...unavailable(reason),
    evidenceState: "FAILED",
  };
}

function isTripwireState(value: unknown): value is AuthoritativeTripwireState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AuthoritativeTripwireState>;
  return (
    EVIDENCE_STATES.has(candidate.evidenceState as EvidenceState) &&
    MODES.has(candidate.mode as ImmuneMode) &&
    typeof candidate.deadman === "boolean" &&
    (candidate.tripwire === null || typeof candidate.tripwire === "string") &&
    typeof candidate.reason === "string" &&
    (candidate.updatedAt === null || typeof candidate.updatedAt === "string") &&
    (candidate.requestId === null || typeof candidate.requestId === "string") &&
    Number.isSafeInteger(candidate.revision) &&
    Number(candidate.revision) >= 0
  );
}

/**
 * Convert one server snapshot into the only authority view exposed to UI
 * components. A transport error invalidates cached green state, and malformed
 * or internally inconsistent responses fail closed.
 */
export function deriveAuthorityView(
  snapshot: ImmuneState | undefined,
  queryError: unknown,
): AuthoritativeTripwireState {
  if (queryError) return unavailable("authoritative state refresh unavailable");
  if (!snapshot) return unavailable("authoritative state has not been observed");
  const state = snapshot.tripwireState;
  if (!isTripwireState(state)) return failed("authoritative tripwire response is invalid");

  if (state.evidenceState !== "VERIFIED") {
    if (state.mode !== "SENTRA_REJECT" || state.deadman || state.tripwire !== null) {
      return failed("unverified authority response attempted to expose active control state");
    }
    return state;
  }

  const deadmanConsistent =
    state.mode === "DEADMAN"
      ? state.deadman && state.tripwire !== null
      : !state.deadman && state.tripwire === null;
  if (!deadmanConsistent) {
    return failed("verified authority response contains inconsistent tripwire state");
  }
  return state;
}

export type AuthorityVisualState =
  | "VERIFIED_PASS"
  | "VERIFIED_REJECT"
  | "VERIFIED_DEADMAN"
  | "FAILED"
  | "UNAVAILABLE"
  | "STALE";

export function authorityVisualState(
  state: AuthoritativeTripwireState,
): AuthorityVisualState {
  if (state.evidenceState !== "VERIFIED") return state.evidenceState;
  if (state.deadman) return "VERIFIED_DEADMAN";
  return state.mode === "PASS" ? "VERIFIED_PASS" : "VERIFIED_REJECT";
}
