export const AGENT_STATUS_POLL_MS = 30_000;
export const AGENT_STATUS_MAX_AGE_MS = 65_000;

export interface FreshAgentStatusShape {
  available: boolean;
  provenance: "LIVE" | "UNAVAILABLE";
  blockers: string[];
  readiness: {
    status: "READY" | "READ_ONLY" | "NOT_READY";
    write_ready: boolean;
  };
  note: string;
}

export function projectFreshAgentStatus<T extends FreshAgentStatusShape>(
  status: T | null,
  options: {
    error: boolean;
    observedAtMs: number | null;
    nowMs: number;
    visible: boolean;
    online: boolean;
    refreshPending?: boolean;
    requiredObservationAfterMs?: number | null;
    maxAgeMs?: number;
  },
): T | null {
  if (status === null) return null;
  const maxAgeMs = options.maxAgeMs ?? AGENT_STATUS_MAX_AGE_MS;
  let blocker: string | null = null;
  if (options.error) blocker = "AGENT_STATUS_REFRESH_FAILED";
  else if (!options.visible) blocker = "AGENT_STATUS_DOCUMENT_HIDDEN";
  else if (!options.online) blocker = "AGENT_STATUS_OFFLINE";
  else if (
    options.refreshPending ||
    (options.requiredObservationAfterMs !== null &&
      options.requiredObservationAfterMs !== undefined &&
      (options.observedAtMs === null ||
        options.observedAtMs < options.requiredObservationAfterMs))
  ) {
    blocker = "AGENT_STATUS_REFRESH_REQUIRED";
  } else if (
    options.observedAtMs === null ||
    options.nowMs - options.observedAtMs >= maxAgeMs
  ) {
    blocker = "AGENT_STATUS_STALE";
  }
  if (blocker === null) return status;

  return {
    ...status,
    available: false,
    provenance: "UNAVAILABLE",
    blockers: [...new Set([...status.blockers, blocker])],
    readiness: { ...status.readiness, write_ready: false },
    note: `Governed agent status is unavailable: ${blocker}. Refresh is required before execution.`,
  };
}
