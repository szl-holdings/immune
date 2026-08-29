import type {
  AuthoritativeTripwireState,
  EvidenceState,
  ImmuneMode,
  ImmuneState,
} from "./immune-api";

export interface AuthorityTransportState {
  visible: boolean;
  online: boolean;
  requiredObservationAfterMs: number;
}

export function initialAuthorityTransportState(
  nowMs = Date.now(),
  visible = typeof document === "undefined" || document.visibilityState === "visible",
  online = typeof navigator === "undefined" || navigator.onLine,
): AuthorityTransportState {
  return {
    visible,
    online,
    requiredObservationAfterMs: visible && online ? 0 : nowMs,
  };
}

export function transitionAuthorityTransportState(
  current: AuthorityTransportState,
  nowMs: number,
  visible: boolean,
  online: boolean,
): AuthorityTransportState {
  const resumed = visible && online && (!current.visible || !current.online);
  const unavailable = !visible || !online;
  return {
    visible,
    online,
    requiredObservationAfterMs:
      resumed || unavailable
        ? Math.max(current.requiredObservationAfterMs, nowMs)
        : current.requiredObservationAfterMs,
  };
}

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
    validUntil: null,
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
    (candidate.validUntil === null || typeof candidate.validUntil === "string") &&
    (candidate.updatedAt === null || typeof candidate.updatedAt === "string") &&
    (candidate.requestId === null || typeof candidate.requestId === "string") &&
    Number.isSafeInteger(candidate.revision) &&
    Number(candidate.revision) >= 0
  );
}

/**
 * Convert one server snapshot into the only authority view exposed to UI
 * components. Hidden tabs, iframes, and a blipped fetch must not erase a
 * still-valid VERIFIED snapshot — that is what made the public Space look dead.
 * Missing, malformed, or expired evidence still cannot become a green claim.
 */
export function deriveAuthorityView(
  snapshot: ImmuneState | undefined,
  queryError: unknown,
  context: {
    nowMs?: number;
    visible?: boolean;
    online?: boolean;
    observedAtMs?: number;
    requiredObservationAfterMs?: number;
  } = {},
): AuthoritativeTripwireState {
  if (!snapshot) {
    if (queryError) return unavailable("authoritative state refresh unavailable");
    return unavailable("authoritative state has not been observed");
  }
  const state = snapshot.tripwireState;
  if (!isTripwireState(state)) return failed("authoritative tripwire response is invalid");

  if (
    snapshot.evidenceState !== state.evidenceState ||
    snapshot.mode !== state.mode ||
    snapshot.deadman !== state.deadman ||
    snapshot.tripwire !== state.tripwire ||
    snapshot.validUntil !== state.validUntil
  ) {
    return failed("top-level authority fields contradict the authoritative tripwire projection");
  }

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
  const validUntilMs = Date.parse(state.validUntil ?? "");
  if (!Number.isFinite(validUntilMs)) {
    return failed("verified authority response is missing a valid signed expiry");
  }
  if ((context.nowMs ?? Date.now()) >= validUntilMs) {
    return {
      ...state,
      evidenceState: "STALE",
      mode: "SENTRA_REJECT",
      deadman: false,
      tripwire: null,
      reason: "signed authority evidence expired without a fresh server response",
    };
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

/**
 * HUD first-paint contract. Missing snapshot without an error is CONNECTING,
 * never UNAVAILABLE and never a fabricated PASS/LIVE. UNAVAILABLE is reserved
 * for a failed or impossible observation.
 */
export function firstPaintSystemStatus(
  snapshot: ImmuneState | undefined,
  queryError: unknown,
  authority: AuthoritativeTripwireState,
): string {
  if (!snapshot && !queryError) return "CONNECTING";
  if (authority.evidenceState === "VERIFIED") {
    return authority.deadman ? "FROZEN" : authority.mode;
  }
  return authority.evidenceState;
}
