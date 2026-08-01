import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  authorityVisualState,
  deriveAuthorityView,
} from "../frontend/src/lib/authority-view";
import { startAnimationLoop } from "../frontend/src/lib/animation-loop";
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
});
