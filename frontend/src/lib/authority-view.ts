import type {
  AuthoritativeTripwireState,
  EvidenceState,
  ImmuneReadiness,
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
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const KEY_ID_PATTERN = /^[a-f0-9]{16}$/;
const INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/;
const TRUST_EPOCH_PATTERN = /^[a-f0-9]{32}$/;
const RECEIPT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;

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
  if (
    snapshot.authority?.version !== "immune.action.v2" ||
    snapshot.authority.audience !== "hf-space:SZLHOLDINGS/immune" ||
    snapshot.authority.source?.repository !== "szl-holdings/immune" ||
    !/^[a-f0-9]{40}$/.test(snapshot.authority.source.revision ?? "") ||
    snapshot.authority.externalOperator !== true
  ) {
    return failed("authoritative response is not bound to the external v2 operator contract");
  }
  const state = snapshot.tripwireState;
  if (!isTripwireState(state)) return failed("authoritative tripwire response is invalid");

  if (
    snapshot.evidenceState !== state.evidenceState ||
    snapshot.mode !== state.mode ||
    snapshot.deadman !== state.deadman ||
    snapshot.tripwire !== state.tripwire ||
    snapshot.reason !== state.reason ||
    snapshot.validUntil !== state.validUntil ||
    snapshot.updatedAt !== state.updatedAt ||
    snapshot.requestId !== state.requestId ||
    snapshot.revision !== state.revision
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
  if (
    snapshot.authority.enabled !== true ||
    !KEY_ID_PATTERN.test(snapshot.authority.keyId ?? "") ||
    !INSTANCE_ID_PATTERN.test(snapshot.authority.instanceId ?? "") ||
    !Number.isSafeInteger(snapshot.authorityReceiptCount) ||
    snapshot.authorityReceiptCount <= 0 ||
    !RECEIPT_HASH_PATTERN.test(snapshot.authorityReceiptHash ?? "")
  ) {
    return failed("verified authority response is missing valid trust-root or receipt evidence");
  }
  if (
    !REQUEST_ID_PATTERN.test(state.requestId ?? "") ||
    !Number.isSafeInteger(state.revision) ||
    state.revision <= 0 ||
    !state.updatedAt ||
    !Number.isFinite(Date.parse(state.updatedAt))
  ) {
    return failed("verified authority response is missing signed request or revision metadata");
  }
  const durableState = snapshot.durableState;
  if (
    !durableState ||
    durableState.mode !== state.mode ||
    durableState.deadman !== state.deadman ||
    durableState.tripwire !== state.tripwire ||
    durableState.updatedAt !== state.updatedAt ||
    durableState.requestId !== state.requestId ||
    durableState.revision !== state.revision
  ) {
    return failed("verified authority response contradicts durable authority state");
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

/**
 * Describe only the evidence-backed authority observation. This wording is
 * deliberately narrower than whole-system readiness: /api/immune/state does
 * not prove /readyz, runtime artifact integrity, or ledger read readiness.
 */
export function authorityVerificationLabel(
  state: AuthoritativeTripwireState,
  awaitingFirstObservation = false,
): string {
  if (awaitingFirstObservation) return "Authority evidence connecting";
  if (state.evidenceState === "VERIFIED") return "Authority evidence verified";
  return `Authority evidence ${state.evidenceState.toLowerCase()}`;
}

export const READINESS_MAX_AGE_MS = 15_000;

export type WholeSystemReadinessState =
  | "READY"
  | "READ_ONLY"
  | "NOT_READY"
  | "CONNECTING"
  | "UNAVAILABLE"
  | "STALE"
  | "INVALID";

export interface WholeSystemReadinessView {
  state: WholeSystemReadinessState;
  label: string;
  writeReady: boolean;
  reason: string;
}

function readinessView(
  state: WholeSystemReadinessState,
  label: string,
  reason: string,
  writeReady = false,
): WholeSystemReadinessView {
  return { state, label, writeReady, reason };
}

/**
 * Bind one fresh /readyz observation to the independently retrieved authority
 * snapshot. No single server boolean can enable a write control.
 */
export function deriveWholeSystemReadinessView(
  readiness: ImmuneReadiness | undefined,
  snapshot: ImmuneState | undefined,
  authority: AuthoritativeTripwireState,
  queryError: unknown,
  context: {
    nowMs?: number;
    observedAtMs?: number;
    visible?: boolean;
    online?: boolean;
  } = {},
): WholeSystemReadinessView {
  if (queryError) {
    return readinessView(
      "UNAVAILABLE",
      "UNAVAILABLE",
      "whole-system readiness refresh failed",
    );
  }
  if (!readiness) {
    return readinessView(
      "CONNECTING",
      "CONNECTING",
      "whole-system readiness has not been observed",
    );
  }
  if (context.visible === false || context.online === false) {
    return readinessView(
      "UNAVAILABLE",
      "UNAVAILABLE",
      "whole-system readiness requires a visible online observation",
    );
  }
  const nowMs = context.nowMs ?? Date.now();
  const observedAtMs = context.observedAtMs;
  if (
    !Number.isFinite(observedAtMs) ||
    Number(observedAtMs) <= 0 ||
    Number(observedAtMs) > nowMs + 1_000
  ) {
    return readinessView(
      "INVALID",
      "INVALID",
      "whole-system readiness observation time is invalid",
    );
  }
  if (nowMs - Number(observedAtMs) >= READINESS_MAX_AGE_MS) {
    return readinessView(
      "STALE",
      "STALE",
      "whole-system readiness observation is stale",
    );
  }

  const serverReady =
    readiness.status === "READY" &&
    readiness.ready === true &&
    readiness.write_ready === true &&
    readiness.runtime_ready === true &&
    readiness.read_ready === true &&
    readiness.authority_ready === true &&
    readiness.blockers.length === 0;
  if (!serverReady) {
    const state = readiness.status === "READ_ONLY" ? "READ_ONLY" : "NOT_READY";
    return readinessView(
      state,
      state === "READ_ONLY" ? "READ ONLY" : "NOT READY",
      "server readiness does not admit writes",
    );
  }
  if (!snapshot) {
    return readinessView(
      "INVALID",
      "INVALID",
      "ready response has no matching authority snapshot",
    );
  }

  const sourceRevision = snapshot.authority?.source?.revision;
  const keyId = snapshot.authority?.keyId;
  const receiptCount = snapshot.authorityReceiptCount;
  const receiptHash = snapshot.authorityReceiptHash;
  const bindingValid =
    authority.evidenceState === "VERIFIED" &&
    authority.mode === "PASS" &&
    authority.deadman === false &&
    snapshot.authority.enabled === true &&
    snapshot.authority.version === "immune.action.v2" &&
    snapshot.authority.audience === "hf-space:SZLHOLDINGS/immune" &&
    snapshot.authority.externalOperator === true &&
    snapshot.authority.source.repository === "szl-holdings/immune" &&
    REVISION_PATTERN.test(sourceRevision ?? "") &&
    snapshot.authority.deployment.space === "SZLHOLDINGS/immune" &&
    REVISION_PATTERN.test(snapshot.authority.deployment.revision ?? "") &&
    KEY_ID_PATTERN.test(keyId ?? "") &&
    TRUST_EPOCH_PATTERN.test(snapshot.authority.trustEpoch ?? "") &&
    INSTANCE_ID_PATTERN.test(snapshot.authority.instanceId ?? "") &&
    snapshot.authority.durability.required === true &&
    snapshot.authority.durability.verified === true &&
    snapshot.authority.durability.path === "/data/immune" &&
    Number.isSafeInteger(receiptCount) &&
    receiptCount > 0 &&
    snapshot.revision === receiptCount &&
    RECEIPT_HASH_PATTERN.test(receiptHash ?? "") &&
    readiness.source.repository === "szl-holdings/immune" &&
    readiness.source.revision === sourceRevision &&
    readiness.source.build_revision === sourceRevision &&
    readiness.source.manifest_schema === "szl.hf-deploy-manifest/v2" &&
    readiness.build.state === "OBSERVED_HASH_MATCH" &&
    readiness.build.artifact_count > 0 &&
    readiness.build.runtime_hash_match === true &&
    RECEIPT_HASH_PATTERN.test(readiness.build.deployment_manifest_sha256 ?? "") &&
    RECEIPT_HASH_PATTERN.test(readiness.build.artifact_set_sha256 ?? "") &&
    RECEIPT_HASH_PATTERN.test(readiness.runtime.immune_server_sha256 ?? "") &&
    RECEIPT_HASH_PATTERN.test(readiness.runtime.public_index_sha256 ?? "") &&
    readiness.runtime.artifact_integrity.status === "MATCH" &&
    readiness.runtime.artifact_integrity.checked > 0 &&
    readiness.runtime.artifact_integrity.failures.length === 0 &&
    readiness.ledger.ok === true &&
    readiness.ledger.count > 0 &&
    readiness.ledger.first_bad_seq === null &&
    readiness.ledger.durability.required === true &&
    readiness.ledger.durability.verified === true &&
    readiness.ledger.durability.path === "/data/immune/evidence" &&
    readiness.ledger.durability.mount_path === "/data" &&
    readiness.authority.enabled === true &&
    readiness.authority.evidence_state === "VERIFIED" &&
    readiness.authority.version === "immune.action.v2" &&
    readiness.authority.audience === "hf-space:SZLHOLDINGS/immune" &&
    readiness.authority.external_operator === true &&
    readiness.authority.source_revision === sourceRevision &&
    readiness.authority.deployment.space === "SZLHOLDINGS/immune" &&
    readiness.authority.deployment.revision ===
      snapshot.authority.deployment.revision &&
    readiness.authority.key_id === keyId &&
    readiness.authority.receipt_count === receiptCount &&
    readiness.authority.receipt_hash === receiptHash &&
    readiness.authority.durability.required === true &&
    readiness.authority.durability.verified === true &&
    readiness.authority.durability.path === "/data/immune";

  if (!bindingValid) {
    return readinessView(
      "INVALID",
      "INVALID",
      "whole-system readiness contradicts its authority or integrity evidence",
    );
  }
  return readinessView(
    "READY",
    "WRITE READY",
    "fresh whole-system readiness and authority bindings verified",
    true,
  );
}
