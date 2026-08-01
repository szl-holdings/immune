import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  authorityVisualState,
  deriveAuthorityView,
  initialAuthorityTransportState,
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
import type { ImmuneState } from "../frontend/src/lib/immune-api";

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
      version: "immune.action.v1",
      keyId: "0123456789abcdef",
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

test("cached VERIFIED state becomes UNAVAILABLE after a refresh error", () => {
  const authority = deriveAuthorityView(snapshot(), new Error("network down"), {
    nowMs: OBSERVED_AT,
  });
  assert.equal(authority.evidenceState, "UNAVAILABLE");
  assert.equal(authority.mode, "SENTRA_REJECT");
  assert.equal(authority.deadman, false);
  assert.equal(authority.tripwire, null);
  assert.equal(authorityVisualState(authority), "UNAVAILABLE");
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

test("background, offline, and resume-without-refresh states stay unavailable", () => {
  const cached = snapshot();
  assert.equal(
    deriveAuthorityView(cached, null, { nowMs: OBSERVED_AT, visible: false }).evidenceState,
    "UNAVAILABLE",
  );
  assert.equal(
    deriveAuthorityView(cached, null, { nowMs: OBSERVED_AT, online: false }).evidenceState,
    "UNAVAILABLE",
  );
  assert.equal(
    deriveAuthorityView(cached, null, {
      nowMs: OBSERVED_AT,
      visible: true,
      online: true,
      observedAtMs: OBSERVED_AT,
      requiredObservationAfterMs: OBSERVED_AT + 1,
    }).evidenceState,
    "UNAVAILABLE",
  );
});

test("agent status polling fails closed on refresh error, hidden, offline, and stale observations", () => {
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
  for (const [overrides, blocker] of [
    [{ error: true }, "AGENT_STATUS_REFRESH_FAILED"],
    [{ visible: false }, "AGENT_STATUS_DOCUMENT_HIDDEN"],
    [{ online: false }, "AGENT_STATUS_OFFLINE"],
    [
      { nowMs: OBSERVED_AT + AGENT_STATUS_MAX_AGE_MS },
      "AGENT_STATUS_STALE",
    ],
  ] as const) {
    const status = project(overrides);
    assert.equal(status?.available, false, blocker);
    assert.equal(status?.provenance, "UNAVAILABLE", blocker);
    assert.equal(status?.readiness.write_ready, false, blocker);
    assert.ok(status?.blockers.includes(blocker), blocker);
  }
  const resumeRequiredAt = OBSERVED_AT + 1_000;
  const resumePending = project({
    observedAtMs: OBSERVED_AT,
    nowMs: resumeRequiredAt,
    visible: true,
    online: true,
    refreshPending: true,
    requiredObservationAfterMs: resumeRequiredAt,
  });
  assert.equal(resumePending?.available, false);
  assert.ok(resumePending?.blockers.includes("AGENT_STATUS_REFRESH_REQUIRED"));
  const resumedWithOldObservation = project({
    observedAtMs: OBSERVED_AT,
    nowMs: resumeRequiredAt + 1,
    visible: true,
    online: true,
    refreshPending: false,
    requiredObservationAfterMs: resumeRequiredAt,
  });
  assert.equal(resumedWithOldObservation?.available, false);
  assert.ok(
    resumedWithOldObservation?.blockers.includes("AGENT_STATUS_REFRESH_REQUIRED"),
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

test("hidden mount cannot reuse a cached success while resume refetch is pending", () => {
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
    "UNAVAILABLE",
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
    "UNAVAILABLE",
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

test("Home is the sole authority query and every security surface consumes its projection", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const home = fs.readFileSync(path.join(repoRoot, "frontend/src/pages/Home.tsx"), "utf8");
  const surfaces = [
    "frontend/src/components/ControlsPanel.tsx",
    "frontend/src/components/AuditConsole.tsx",
    "frontend/src/components/ThreeScene.tsx",
  ];

  assert.equal((home.match(/useGetImmuneState\(\)/g) ?? []).length, 1);
  assert.match(home, /deriveAuthorityView\(stateQuery\.data, stateQuery\.error,/);
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
  assert.match(controls, /Accepted input writes a real governed-cycle receipt/);
  assert.match(controls, /aria-describedby="cycle-write-warning"/);
  assert.doesNotMatch(controls, /operator@immune\.demo|DEMO: inject payload/);

  assert.match(home, /href="#main-content"/);
  assert.match(home, /LIVE \/ MEASURED/);
  assert.match(home, /MODELED \/ SAMPLE/);
  assert.match(home, /UNAVAILABLE \/ LIMITS/);
  assert.match(home, /Public readback is not an ATO or a performance claim/);
  assert.doesNotMatch(home, /Nothing on this page is fabricated/);
});
