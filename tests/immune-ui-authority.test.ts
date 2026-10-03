import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  authorityVisualState,
  authorityVerificationLabel,
  deriveAuthorityView,
  deriveWholeSystemReadinessView,
  firstPaintSystemStatus,
  initialAuthorityTransportState,
  READINESS_MAX_AGE_MS,
  transitionAuthorityTransportState,
} from "../frontend/src/lib/authority-view";
import { startAnimationLoop } from "../frontend/src/lib/animation-loop";
import {
  AGENT_STATUS_MAX_AGE_MS,
  AGENT_STATUS_POLL_MS,
  projectFreshAgentStatus,
} from "../frontend/src/lib/agent-status-freshness";
import {
  OPERATOR_ERROR_SUMMARY_MAX_LENGTH,
  summarizeOperatorError,
} from "../frontend/src/lib/operator-error";
import {
  fetchImmuneReadiness,
  parseImmuneReadiness,
  type ImmuneReadiness,
  type ImmuneState,
} from "../frontend/src/lib/immune-api";

const OBSERVED_AT = Date.parse("2026-08-01T12:00:00.000Z");

function snapshot(overrides: Partial<ImmuneState["tripwireState"]> = {}): ImmuneState {
  const tripwireState: ImmuneState["tripwireState"] = {
    evidenceState: "VERIFIED",
    mode: "PASS",
    deadman: false,
    tripwire: null,
    reason: "signed action and receipt chain verified",
    validUntil: "2026-08-01T12:01:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    requestId: "authority-view-0001",
    revision: 1,
    ...overrides,
  };
  return {
    mode: tripwireState.mode,
    tripwire: tripwireState.tripwire,
    deadman: tripwireState.deadman,
    ledgerCount: 1,
    lastHash: "a".repeat(64),
    evidenceState: tripwireState.evidenceState,
    reason: tripwireState.reason,
    validUntil: tripwireState.validUntil,
    updatedAt: tripwireState.updatedAt,
    requestId: tripwireState.requestId,
    revision: tripwireState.revision,
    authorityReceiptCount: 1,
    authorityReceiptHash: "b".repeat(64),
    authority: {
      enabled: true,
      version: "immune.action.v2",
      keyId: "0123456789abcdef",
      trustEpoch: "abcdef0123456789abcdef0123456789",
      instanceId: "0123456789abcdef0123456789abcdef",
      audience: "hf-space:SZLHOLDINGS/immune",
      source: {
        repository: "szl-holdings/immune",
        revision: "a".repeat(40),
      },
      deployment: {
        space: "SZLHOLDINGS/immune",
        revision: "c".repeat(40),
      },
      durability: {
        required: true,
        verified: true,
        path: "/data/immune",
      },
      externalOperator: true,
    },
    durableState: {
      mode: tripwireState.mode,
      tripwire: tripwireState.tripwire,
      deadman: tripwireState.deadman,
      updatedAt: tripwireState.updatedAt,
      requestId: tripwireState.requestId,
      revision: tripwireState.revision,
    },
    tripwireState,
  };
}

function readyz(): ImmuneReadiness {
  return {
    schema: "szl.immune-readiness/v1",
    status: "READY",
    ready: true,
    runtime_ready: true,
    read_ready: true,
    authority_ready: true,
    write_ready: true,
    blockers: [],
    source: {
      repository: "szl-holdings/immune",
      revision: "a".repeat(40),
      build_revision: "a".repeat(40),
      alignment_state: "OBSERVED_RUNTIME_HASH_MATCH",
      manifest_schema: "szl.hf-deploy-manifest/v2",
    },
    build: {
      state: "OBSERVED_HASH_MATCH",
      artifact_count: 7,
      runtime_hash_match: true,
      artifact_set_algorithm: "sha256(json(sorted[path,sha256]))",
      deployment_manifest_sha256: "c".repeat(64),
      artifact_set_sha256: "d".repeat(64),
    },
    runtime: {
      immune_server_sha256: "e".repeat(64),
      public_index_sha256: "f".repeat(64),
      artifact_integrity: {
        status: "MATCH",
        checked: 7,
        failures: [],
      },
    },
    ledger: {
      ok: true,
      count: 1,
      first_bad_seq: null,
      durability: { required: true, verified: true, path: "/data/immune/evidence", mount_path: "/data", reason: "verified test fixture" },
    },
    authority: {
      enabled: true,
      evidence_state: "VERIFIED",
      key_id: "0123456789abcdef",
      version: "immune.action.v2",
      audience: "hf-space:SZLHOLDINGS/immune",
      source_revision: "a".repeat(40),
      deployment: {
        space: "SZLHOLDINGS/immune",
        revision: "c".repeat(40),
      },
      external_operator: true,
      receipt_count: 1,
      receipt_hash: "b".repeat(64),
      durability: {
        required: true,
        verified: true,
        path: "/data/immune",
      },
    },
  };
}

test("cached VERIFIED state survives a refresh error until signed expiry", () => {
  const authority = deriveAuthorityView(snapshot(), new Error("network down"), {
    nowMs: OBSERVED_AT,
  });
  assert.equal(authority.evidenceState, "VERIFIED");
  assert.equal(authority.mode, "PASS");
  assert.equal(authorityVisualState(authority), "VERIFIED_PASS");

  const missing = deriveAuthorityView(undefined, new Error("network down"), {
    nowMs: OBSERVED_AT,
  });
  assert.equal(missing.evidenceState, "UNAVAILABLE");
  assert.equal(authorityVisualState(missing), "UNAVAILABLE");
});

test("legacy or malformed authority metadata can never render green", () => {
  const legacy = snapshot();
  (legacy.authority as { version: string }).version = "immune.action.v1";
  const legacyView = deriveAuthorityView(legacy, null, { nowMs: OBSERVED_AT });
  assert.equal(legacyView.evidenceState, "FAILED");
  assert.equal(legacyView.mode, "SENTRA_REJECT");

  const wrongSource = snapshot();
  wrongSource.authority.source.revision = "b".repeat(40);
  wrongSource.authority.source.repository = "szl-holdings/immune";
  wrongSource.authority.externalOperator = false as true;
  const wrongSourceView = deriveAuthorityView(wrongSource, null, {
    nowMs: OBSERVED_AT,
  });
  assert.equal(wrongSourceView.evidenceState, "FAILED");
  assert.equal(wrongSourceView.mode, "SENTRA_REJECT");
});

test("VERIFIED requires a configured trust root and complete receipt metadata", () => {
  const cases: Array<[string, (candidate: ImmuneState) => void]> = [
    ["disabled trust root", (candidate) => { candidate.authority.enabled = false; }],
    ["invalid key id", (candidate) => { candidate.authority.keyId = "not-a-key-id"; }],
    ["invalid instance id", (candidate) => { candidate.authority.instanceId = "not-an-instance"; }],
    ["empty receipt chain", (candidate) => { candidate.authorityReceiptCount = 0; }],
    ["invalid receipt hash", (candidate) => { candidate.authorityReceiptHash = "bad"; }],
  ];

  for (const [name, mutate] of cases) {
    const candidate = snapshot();
    mutate(candidate);
    const view = deriveAuthorityView(candidate, null, { nowMs: OBSERVED_AT });
    assert.equal(view.evidenceState, "FAILED", name);
    assert.equal(authorityVisualState(view), "FAILED", name);
  }
});

test("VERIFIED request, revision, and durable metadata must match exactly", () => {
  const cases: Array<[string, (candidate: ImmuneState) => void]> = [
    ["top-level request mismatch", (candidate) => { candidate.requestId = "authority-view-other"; }],
    ["top-level revision mismatch", (candidate) => { candidate.revision = 2; }],
    ["missing signed request", (candidate) => {
      candidate.requestId = null;
      candidate.tripwireState.requestId = null;
    }],
    ["nonpositive signed revision", (candidate) => {
      candidate.revision = 0;
      candidate.tripwireState.revision = 0;
      candidate.durableState.revision = 0;
    }],
    ["durable mode mismatch", (candidate) => { candidate.durableState.mode = "SENTRA_REJECT"; }],
    ["durable request mismatch", (candidate) => {
      candidate.durableState.requestId = "authority-view-other";
    }],
  ];

  for (const [name, mutate] of cases) {
    const candidate = snapshot();
    mutate(candidate);
    const view = deriveAuthorityView(candidate, null, { nowMs: OBSERVED_AT });
    assert.equal(view.evidenceState, "FAILED", name);
    assert.equal(authorityVisualState(view), "FAILED", name);
  }
});

test("STALE and malformed tripwire responses cannot render an active control", () => {
  const stale = deriveAuthorityView(
    snapshot({
      evidenceState: "STALE",
      mode: "SENTRA_REJECT",
      deadman: false,
      tripwire: null,
    }),
    null,
    { nowMs: OBSERVED_AT },
  );
  assert.equal(authorityVisualState(stale), "STALE");

  const malformed = deriveAuthorityView(
    snapshot({
      evidenceState: "STALE",
      mode: "DEADMAN",
      deadman: true,
      tripwire: "T07",
    }),
    null,
    { nowMs: OBSERVED_AT },
  );
  assert.equal(malformed.evidenceState, "FAILED");
  assert.equal(malformed.mode, "SENTRA_REJECT");
  assert.equal(malformed.deadman, false);
  assert.equal(malformed.tripwire, null);
});

test("only a consistent VERIFIED server state can engage the tripwire scene", () => {
  const authority = deriveAuthorityView(
    snapshot({ mode: "DEADMAN", deadman: true, tripwire: "T07" }),
    null,
    { nowMs: OBSERVED_AT },
  );
  assert.equal(authorityVisualState(authority), "VERIFIED_DEADMAN");
  assert.equal(authority.tripwire, "T07");

  const inconsistent = deriveAuthorityView(
    snapshot({ mode: "PASS", deadman: true, tripwire: "T07" }),
    null,
    { nowMs: OBSERVED_AT },
  );
  assert.equal(inconsistent.evidenceState, "FAILED");
  assert.equal(authorityVisualState(inconsistent), "FAILED");
});

test("verified reject and deadman labels never claim whole-system write readiness", () => {
  const cases: Array<[ImmuneState["mode"], boolean, string | null, string]> = [
    ["SENTRA_REJECT", false, null, "VERIFIED_REJECT"],
    ["DEADMAN", true, "T07", "VERIFIED_DEADMAN"],
  ];

  for (const [mode, deadman, tripwire, visual] of cases) {
    const view = deriveAuthorityView(
      snapshot({ mode, deadman, tripwire }),
      null,
      { nowMs: OBSERVED_AT },
    );
    const label = authorityVerificationLabel(view);
    assert.equal(view.evidenceState, "VERIFIED", mode);
    assert.equal(authorityVisualState(view), visual, mode);
    assert.equal(label, "Authority evidence verified", mode);
    assert.doesNotMatch(label, /write[- ]?ready|system ready/i, mode);
  }
});

test("authority-only label remains narrow when readiness or integrity is false", () => {
  const readiness = {
    ready: false,
    write_ready: false,
    ledger: { ok: false },
  };
  const view = deriveAuthorityView(snapshot(), null, { nowMs: OBSERVED_AT });
  const label = authorityVerificationLabel(view);

  assert.equal(readiness.ready, false);
  assert.equal(readiness.write_ready, false);
  assert.equal(readiness.ledger.ok, false);
  assert.equal(label, "Authority evidence verified");
  assert.doesNotMatch(label, /write[- ]?ready|system ready/i);
});

test("typed readiness fetch accepts and parses both 200 and fail-closed 503 bodies", async () => {
  const ready = readyz();
  const blocked: ImmuneReadiness = {
    ...ready,
    status: "READ_ONLY",
    ready: false,
    authority_ready: false,
    write_ready: false,
    blockers: ["ACTION_AUTHORITY_UNAVAILABLE"],
  };
  for (const [status, body] of [[200, ready], [503, blocked]] as const) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const parsed = await fetchImmuneReadiness(fetchImpl);
    assert.deepEqual(parsed, body);
  }
  assert.throws(
    () => parseImmuneReadiness({ ...ready, ledger: { ok: "yes" } }),
    /does not match/,
  );
});

test("whole-system write readiness requires one fresh exact-bound ready contract", () => {
  const state = snapshot();
  const authority = deriveAuthorityView(state, null, { nowMs: OBSERVED_AT });
  const exact = deriveWholeSystemReadinessView(
    readyz(),
    state,
    authority,
    null,
    { nowMs: OBSERVED_AT, observedAtMs: OBSERVED_AT, authorityObservedAtMs: OBSERVED_AT },
  );
  assert.equal(exact.state, "READY");
  assert.equal(exact.writeReady, true);
  assert.equal(exact.label, "WRITE READY");

  const stale = deriveWholeSystemReadinessView(
    readyz(),
    state,
    authority,
    null,
    {
      nowMs: OBSERVED_AT + READINESS_MAX_AGE_MS,
      observedAtMs: OBSERVED_AT,
      authorityObservedAtMs: OBSERVED_AT,
    },
  );
  assert.equal(stale.state, "STALE");
  assert.equal(stale.writeReady, false);

  const failedRefresh = deriveWholeSystemReadinessView(
    readyz(),
    state,
    authority,
    new Error("readyz unavailable"),
    { nowMs: OBSERVED_AT, observedAtMs: OBSERVED_AT, authorityObservedAtMs: OBSERVED_AT },
  );
  assert.equal(failedRefresh.state, "UNAVAILABLE");
  assert.equal(failedRefresh.writeReady, false);
});

test("resume requires successful authority and readiness observations after the transport boundary", () => {
  const state = snapshot();
  const offline = transitionAuthorityTransportState(
    initialAuthorityTransportState(OBSERVED_AT, true, true),
    OBSERVED_AT + 1_000,
    true,
    false,
  );
  const resumeTime = OBSERVED_AT + 3_000;
  const resumed = transitionAuthorityTransportState(offline, resumeTime, true, true);
  const authority = deriveAuthorityView(state, null, {
    nowMs: resumeTime,
    observedAtMs: OBSERVED_AT,
    requiredObservationAfterMs: resumed.requiredObservationAfterMs,
  });
  assert.equal(authority.evidenceState, "VERIFIED");

  for (const [name, authorityObservedAtMs, observedAtMs] of [
    ["both observations cached", OBSERVED_AT, OBSERVED_AT],
    ["only authority refreshed", resumeTime, OBSERVED_AT],
    ["only readiness refreshed", OBSERVED_AT, resumeTime],
  ] as const) {
    const view = deriveWholeSystemReadinessView(readyz(), state, authority, null, {
      nowMs: resumeTime,
      authorityObservedAtMs,
      observedAtMs,
      visible: resumed.visible,
      online: resumed.online,
      requiredObservationAfterMs: resumed.requiredObservationAfterMs,
    });
    assert.equal(view.writeReady, false, name);
    assert.equal(view.state, "CONNECTING", name);
  }

  const refreshed = deriveWholeSystemReadinessView(readyz(), state, authority, null, {
    nowMs: resumeTime,
    authorityObservedAtMs: resumeTime,
    observedAtMs: resumeTime,
    visible: resumed.visible,
    online: resumed.online,
    requiredObservationAfterMs: resumed.requiredObservationAfterMs,
  });
  assert.equal(refreshed.writeReady, true);
  assert.equal(refreshed.state, "READY");
});

test("a failed authority refresh disables writes without erasing cached signed authority", () => {
  const state = snapshot();
  const authorityError = new Error("state refresh unavailable");
  const authority = deriveAuthorityView(state, authorityError, { nowMs: OBSERVED_AT });
  assert.equal(authority.evidenceState, "VERIFIED");

  const view = deriveWholeSystemReadinessView(readyz(), state, authority, null, {
    nowMs: OBSERVED_AT,
    observedAtMs: OBSERVED_AT,
    authorityObservedAtMs: OBSERVED_AT,
    authorityQueryError: authorityError,
  });
  assert.equal(view.writeReady, false);
  assert.equal(view.state, "UNAVAILABLE");
});

test("invalid authority observation times and resume boundaries cannot admit writes", () => {
  const state = snapshot();
  const authority = deriveAuthorityView(state, null, { nowMs: OBSERVED_AT });
  for (const [name, overrides] of [
    ["missing authority observation", { authorityObservedAtMs: undefined }],
    ["zero authority observation", { authorityObservedAtMs: 0 }],
    ["nonfinite authority observation", { authorityObservedAtMs: Number.NaN }],
    ["infinite authority observation", { authorityObservedAtMs: Number.POSITIVE_INFINITY }],
    ["future authority observation", { authorityObservedAtMs: OBSERVED_AT + 1_001 }],
    ["negative resume boundary", { requiredObservationAfterMs: -1 }],
    ["nonfinite resume boundary", { requiredObservationAfterMs: Number.NaN }],
    ["infinite resume boundary", { requiredObservationAfterMs: Number.POSITIVE_INFINITY }],
  ] as const) {
    const view = deriveWholeSystemReadinessView(readyz(), state, authority, null, {
      nowMs: OBSERVED_AT,
      observedAtMs: OBSERVED_AT,
      authorityObservedAtMs: OBSERVED_AT,
      requiredObservationAfterMs: 0,
      ...overrides,
    });
    assert.equal(view.writeReady, false, name);
    assert.equal(view.state, "INVALID", name);
  }
});

test("hidden and offline transport cannot admit writes even with fresh observations", () => {
  const state = snapshot();
  const authority = deriveAuthorityView(state, null, { nowMs: OBSERVED_AT });
  for (const [visible, online] of [[false, true], [true, false], [false, false]]) {
    const view = deriveWholeSystemReadinessView(readyz(), state, authority, null, {
      nowMs: OBSERVED_AT,
      observedAtMs: OBSERVED_AT,
      authorityObservedAtMs: OBSERVED_AT,
      visible,
      online,
    });
    assert.equal(view.writeReady, false);
    assert.equal(view.state, "UNAVAILABLE");
  }
});

test("readyz false flags, integrity, durability, and binding mismatches disable writes", () => {
  const state = snapshot();
  const authority = deriveAuthorityView(state, null, { nowMs: OBSERVED_AT });
  const project = (readiness: ImmuneReadiness) =>
    deriveWholeSystemReadinessView(
      readiness,
      state,
      authority,
      null,
      { nowMs: OBSERVED_AT, observedAtMs: OBSERVED_AT, authorityObservedAtMs: OBSERVED_AT },
    );

  for (const field of [
    "ready",
    "runtime_ready",
    "read_ready",
    "authority_ready",
    "write_ready",
  ] as const) {
    const candidate = readyz();
    candidate[field] = false;
    assert.equal(project(candidate).writeReady, false, field);
  }

  const corruptLedger = readyz();
  corruptLedger.ledger.ok = false;
  assert.equal(project(corruptLedger).writeReady, false);

  const corruptRuntime = readyz();
  corruptRuntime.runtime.artifact_integrity.status = "MISMATCH";
  assert.equal(project(corruptRuntime).writeReady, false);

  const nondurable = readyz();
  nondurable.authority.durability.verified = false;
  assert.equal(project(nondurable).writeReady, false);

  const wrongSource = readyz();
  wrongSource.authority.source_revision = "9".repeat(40);
  assert.equal(project(wrongSource).writeReady, false);

  const wrongKey = readyz();
  wrongKey.authority.key_id = "fedcba9876543210";
  assert.equal(project(wrongKey).writeReady, false);

  const wrongReceipt = readyz();
  wrongReceipt.authority.receipt_hash = "9".repeat(64);
  assert.equal(project(wrongReceipt).writeReady, false);
});

test("verified reject and deadman remain non-write-ready despite a contradictory READY body", () => {
  for (const [mode, deadman, tripwire] of [
    ["SENTRA_REJECT", false, null],
    ["DEADMAN", true, "T07"],
  ] as const) {
    const state = snapshot({ mode, deadman, tripwire });
    const authority = deriveAuthorityView(state, null, { nowMs: OBSERVED_AT });
    const view = deriveWholeSystemReadinessView(
      readyz(),
      state,
      authority,
      null,
      { nowMs: OBSERVED_AT, observedAtMs: OBSERVED_AT, authorityObservedAtMs: OBSERVED_AT },
    );
    assert.equal(view.state, "INVALID", mode);
    assert.equal(view.writeReady, false, mode);
  }
});

test("cached VERIFIED state ages to STALE without any server response", () => {
  const cached = snapshot();
  assert.equal(
    deriveAuthorityView(cached, null, { nowMs: OBSERVED_AT + 30_000 }).evidenceState,
    "VERIFIED",
  );
  const expired = deriveAuthorityView(cached, null, { nowMs: OBSERVED_AT + 60_000 });
  assert.equal(expired.evidenceState, "STALE");
  assert.equal(expired.mode, "SENTRA_REJECT");
  assert.equal(expired.deadman, false);
  assert.equal(expired.tripwire, null);
});

test("background, offline, and resume keep a VERIFIED snapshot live", () => {
  const cached = snapshot();
  assert.equal(
    deriveAuthorityView(cached, null, { nowMs: OBSERVED_AT, visible: false }).evidenceState,
    "VERIFIED",
  );
  assert.equal(
    deriveAuthorityView(cached, null, { nowMs: OBSERVED_AT, online: false }).evidenceState,
    "VERIFIED",
  );
  assert.equal(
    deriveAuthorityView(cached, null, {
      nowMs: OBSERVED_AT,
      visible: true,
      online: true,
      observedAtMs: OBSERVED_AT,
      requiredObservationAfterMs: OBSERVED_AT + 1,
    }).evidenceState,
    "VERIFIED",
  );
});

test("agent status stays live across hidden, offline, and in-window refresh", () => {
  assert.ok(AGENT_STATUS_POLL_MS >= 30_000);
  assert.ok(AGENT_STATUS_MAX_AGE_MS >= AGENT_STATUS_POLL_MS * 2);
  const live = {
    available: true,
    provenance: "LIVE" as const,
    blockers: [] as string[],
    readiness: { status: "READY" as const, write_ready: true },
    note: "Live governed agent ready.",
  };
  const project = (
    overrides: Partial<Parameters<typeof projectFreshAgentStatus>[1]> = {},
  ) =>
    projectFreshAgentStatus(live, {
      error: false,
      observedAtMs: OBSERVED_AT,
      nowMs: OBSERVED_AT + AGENT_STATUS_POLL_MS,
      visible: true,
      online: true,
      ...overrides,
    });

  assert.equal(project()?.available, true);
  assert.equal(project({ error: true })?.available, true);
  assert.equal(project({ visible: false })?.available, true);
  assert.equal(project({ online: false })?.available, true);
  const stale = project({ nowMs: OBSERVED_AT + AGENT_STATUS_MAX_AGE_MS });
  assert.equal(stale?.available, false);
  assert.equal(stale?.provenance, "UNAVAILABLE");
  assert.ok(stale?.blockers.includes("AGENT_STATUS_STALE"));
  const resumeRequiredAt = OBSERVED_AT + 1_000;
  assert.equal(
    project({
      observedAtMs: OBSERVED_AT,
      nowMs: resumeRequiredAt,
      visible: true,
      online: true,
      refreshPending: true,
      requiredObservationAfterMs: resumeRequiredAt,
    })?.available,
    true,
  );
  assert.equal(
    project({
      observedAtMs: OBSERVED_AT,
      nowMs: resumeRequiredAt + 1,
      visible: true,
      online: true,
      refreshPending: false,
      requiredObservationAfterMs: resumeRequiredAt,
    })?.available,
    true,
  );
  assert.equal(
    project({
      observedAtMs: resumeRequiredAt + 1,
      nowMs: resumeRequiredAt + 1,
      visible: true,
      online: true,
      refreshPending: false,
      requiredObservationAfterMs: resumeRequiredAt,
    })?.available,
    true,
  );
  assert.equal(
    projectFreshAgentStatus(null, {
      error: true,
      observedAtMs: null,
      nowMs: OBSERVED_AT,
      visible: true,
      online: true,
    }),
    null,
  );
});

test("operator errors allowlist only the expected route and HTTP status", () => {
  const expected = { method: "POST", path: "/cycle" };
  const known = summarizeOperatorError(
    new Error(
      'IMMUNE API POST /cycle failed: HTTP 503 {"token":"do-not-render"}',
    ),
    expected,
  );
  assert.equal(known, "IMMUNE API POST /cycle failed: HTTP 503.");
  assert.ok(known.length <= OPERATOR_ERROR_SUMMARY_MAX_LENGTH);
  assert.doesNotMatch(known, /do-not-render/);

  for (const hostile of [
    "Authorization: Bearer secret123",
    "authorization=Basic Zm9vOmJhcg==",
    'request failed token="quoted-secret"',
    'request failed {"api_key":"json-secret"}',
    "Cookie: session=secret-cookie; csrf=secret-csrf",
    "secret=hidden C:\\private\\stack.ts:42",
    "IMMUNE API POST /state failed: HTTP 503 token=wrong-route",
  ]) {
    const summary = summarizeOperatorError(new Error(hostile), expected);
    assert.equal(
      summary,
      "Request failed. No response detail is shown; verify the ledger before retrying.",
    );
    assert.ok(summary.length <= OPERATOR_ERROR_SUMMARY_MAX_LENGTH);
    for (const secret of [
      "secret123",
      "Zm9vOmJhcg",
      "quoted-secret",
      "json-secret",
      "secret-cookie",
      "secret-csrf",
      "private",
      "wrong-route",
    ]) {
      assert.doesNotMatch(summary, new RegExp(secret, "i"));
    }
  }
  assert.equal(
    summarizeOperatorError({}, expected),
    "Request failed. No response detail is shown; verify the ledger before retrying.",
  );
});

test("hidden mount keeps a cached VERIFIED snapshot while refetch is pending", () => {
  const mountTime = OBSERVED_AT;
  const hiddenMount = initialAuthorityTransportState(mountTime, false, true);
  assert.equal(hiddenMount.requiredObservationAfterMs, mountTime);

  const hiddenObservation = mountTime + 500;
  assert.equal(
    deriveAuthorityView(snapshot(), null, {
      nowMs: hiddenObservation,
      visible: hiddenMount.visible,
      online: hiddenMount.online,
      observedAtMs: hiddenObservation,
      requiredObservationAfterMs: hiddenMount.requiredObservationAfterMs,
    }).evidenceState,
    "VERIFIED",
  );

  const resumeTime = mountTime + 1_000;
  const resumed = transitionAuthorityTransportState(
    hiddenMount,
    resumeTime,
    true,
    true,
  );
  assert.equal(resumed.requiredObservationAfterMs, resumeTime);
  assert.equal(
    deriveAuthorityView(snapshot(), null, {
      nowMs: resumeTime,
      visible: resumed.visible,
      online: resumed.online,
      observedAtMs: hiddenObservation,
      requiredObservationAfterMs: resumed.requiredObservationAfterMs,
    }).evidenceState,
    "VERIFIED",
  );
  assert.equal(
    deriveAuthorityView(snapshot(), null, {
      nowMs: resumeTime + 100,
      visible: resumed.visible,
      online: resumed.online,
      observedAtMs: resumeTime + 1,
      requiredObservationAfterMs: resumed.requiredObservationAfterMs,
    }).evidenceState,
    "VERIFIED",
  );
});

test("animation loop cleanup cancels repeated transitions and prevents rescheduling", () => {
  let nextId = 0;
  const callbacks = new Map<number, (timestamp: number) => void>();
  const request = (callback: (timestamp: number) => void) => {
    nextId += 1;
    callbacks.set(nextId, callback);
    return nextId;
  };
  const cancel = (frameId: number) => callbacks.delete(frameId);

  for (let transition = 0; transition < 4; transition += 1) {
    const stop = startAnimationLoop(() => undefined, request, cancel);
    assert.equal(callbacks.size, 1);
    const [frameId, callback] = callbacks.entries().next().value as [
      number,
      (timestamp: number) => void,
    ];
    callbacks.delete(frameId);
    callback(transition);
    assert.equal(callbacks.size, 1);
    stop();
    assert.equal(callbacks.size, 0);
    callback(transition + 0.5);
    assert.equal(callbacks.size, 0);
  }
});

test("Home owns independent state and readiness queries and projects them to security surfaces", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const home = fs.readFileSync(path.join(repoRoot, "frontend/src/pages/Home.tsx"), "utf8");
  const surfaces = [
    "frontend/src/components/ControlsPanel.tsx",
    "frontend/src/components/AuditConsole.tsx",
    "frontend/src/components/ThreeScene.tsx",
  ];

  assert.equal((home.match(/useGetImmuneState\(\)/g) ?? []).length, 1);
  assert.equal((home.match(/useGetImmuneReadiness\(\)/g) ?? []).length, 1);
  assert.match(home, /deriveAuthorityView\(stateQuery\.data, stateQuery\.error,/);
  assert.match(home, /deriveWholeSystemReadinessView/);
  assert.match(home, /data-testid="whole-system-readiness"/);
  assert.match(home, /systemReadiness=\{systemReadiness\}/);
  assert.match(home, /LatticeCop authority=\{authority\} writeReady=\{systemReadiness.writeReady\}/);
  assert.match(home, /InferConsole writeReady=\{systemReadiness.writeReady\}/);
  assert.match(home, /useState\(initialAuthorityTransportState\)/);
  assert.match(home, /transitionAuthorityTransportState/);
  assert.match(home, /updateTransport\(\);/);
  assert.doesNotMatch(home, /lastCycleResult/);
  for (const relative of surfaces) {
    const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.match(source, /authority: AuthoritativeTripwireState/);
    assert.doesNotMatch(source, /useGetImmuneState/);
    assert.doesNotMatch(source, /lastCycleResult/);
  }
  const scene = fs.readFileSync(
    path.join(repoRoot, "frontend/src/components/ThreeScene.tsx"),
    "utf8",
  );
  assert.match(scene, /startAnimationLoop/);
  assert.doesNotMatch(scene, /requestAnimationFrame\(/);

  const agentConsole = fs.readFileSync(
    path.join(repoRoot, "frontend/src/components/AgentConsole.tsx"),
    "utf8",
  );
  assert.match(agentConsole, /projectFreshAgentStatus/);
  assert.match(agentConsole, /requiredObservationAfterMs/);
  assert.match(agentConsole, /refreshBoundary\.pending/);
  assert.match(agentConsole, /AGENT_STATUS_POLL_MS/);
  assert.match(agentConsole, /AGENT_STATUS_MAX_AGE_MS \+ 1/);
  assert.match(agentConsole, /cache: "no-store"/);
  assert.match(agentConsole, /requestController\.signal\.aborted/);
  assert.match(agentConsole, /controller\?\.abort\(\)/);
  assert.match(agentConsole, /window\.clearInterval\(poll\)/);
  assert.match(agentConsole, /window\.clearTimeout\(staleTimer\)/);
  assert.match(agentConsole, /visibilitychange/);
  assert.match(agentConsole, /window\.addEventListener\("focus"/);
  assert.match(agentConsole, /window\.addEventListener\("offline"/);
});

test("governed-cycle UX requires real input and keeps proof labels evidence-scoped", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const controls = fs.readFileSync(
    path.join(repoRoot, "frontend/src/components/ControlsPanel.tsx"),
    "utf8",
  );
  const home = fs.readFileSync(
    path.join(repoRoot, "frontend/src/pages/Home.tsx"),
    "utf8",
  );

  assert.match(controls, /const \[cycleActor, setCycleActor\] = useState\(""\)/);
  assert.match(controls, /const \[cycleIntent, setCycleIntent\] = useState\(""\)/);
  assert.match(controls, /const actor = cycleActor\.trim\(\)/);
  assert.match(controls, /const intent = cycleIntent\.trim\(\)/);
  assert.match(controls, /if \(!canRunCycle \|\| !actor \|\| !intent\) return/);
  assert.match(controls, /data: \{ actor, intent \}/);
  assert.match(
    controls,
    /const \[cycleError, setCycleError\] = useState<string \| null>\(null\)/,
  );
  assert.match(
    controls,
    /summarizeOperatorError\(error, \{ method: "POST", path: "\/cycle" \}\)/,
  );
  assert.match(controls, /maxLength=\{256\}/);
  assert.match(controls, /maxLength=\{4_096\}/);
  assert.match(controls, /data-testid="cycle-request-error"/);
  assert.match(controls, /role="alert"/);
  assert.match(controls, /Governed-cycle result was not confirmed/);
  assert.match(controls, /Verify the ledger before/);
  assert.doesNotMatch(controls, /No governed-cycle receipt was written/);
  assert.match(controls, /currentMode === "PASS"/);
  assert.match(controls, /!authority\.deadman/);
  assert.match(controls, /systemReadiness\.writeReady/);
  assert.match(controls, /getGetImmuneReadinessQueryKey/);
  assert.match(controls, /Accepted input writes a real governed-cycle receipt/);
  assert.match(controls, /aria-describedby="cycle-write-warning"/);
  assert.doesNotMatch(controls, /operator@immune\.demo|DEMO: inject payload/);

  assert.match(home, /href="#main-content"/);
  assert.match(home, /LIVE \/ MEASURED/);
  assert.match(home, /MODELED \/ SAMPLE/);
  assert.match(home, /UNAVAILABLE \/ LIMITS/);
  assert.match(home, /Public readback is not an ATO or a performance claim/);
  assert.match(home, /firstPaintSystemStatus\(stateQuery\.data, stateQuery\.error, authority\)/);
  assert.match(home, /Authority State/);
  assert.match(home, /authorityVerificationLabel/);
  assert.doesNotMatch(home, /Write-ready authority/i);
  assert.doesNotMatch(home, /Nothing on this page is fabricated/);
});

test("first paint is CONNECTING until a snapshot or error is observed", () => {
  const connecting = deriveAuthorityView(undefined, null, { nowMs: OBSERVED_AT });
  assert.equal(connecting.evidenceState, "UNAVAILABLE");
  assert.equal(firstPaintSystemStatus(undefined, null, connecting), "CONNECTING");

  const failed = deriveAuthorityView(undefined, new Error("network down"), {
    nowMs: OBSERVED_AT,
  });
  assert.equal(firstPaintSystemStatus(undefined, new Error("network down"), failed), "UNAVAILABLE");

  const live = deriveAuthorityView(snapshot(), null, { nowMs: OBSERVED_AT });
  assert.equal(firstPaintSystemStatus(snapshot(), null, live), "PASS");
});
