import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  authorityVisualState,
  deriveAuthorityView,
} from "../frontend/src/lib/authority-view";
import type { ImmuneState } from "../frontend/src/lib/immune-api";

function snapshot(overrides: Partial<ImmuneState["tripwireState"]> = {}): ImmuneState {
  const tripwireState: ImmuneState["tripwireState"] = {
    evidenceState: "VERIFIED",
    mode: "PASS",
    deadman: false,
    tripwire: null,
    reason: "signed action and receipt chain verified",
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
    tripwireState,
  };
}

test("cached VERIFIED state becomes UNAVAILABLE after a refresh error", () => {
  const authority = deriveAuthorityView(snapshot(), new Error("network down"));
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
  );
  assert.equal(authorityVisualState(authority), "VERIFIED_DEADMAN");
  assert.equal(authority.tripwire, "T07");

  const inconsistent = deriveAuthorityView(
    snapshot({ mode: "PASS", deadman: true, tripwire: "T07" }),
    null,
  );
  assert.equal(inconsistent.evidenceState, "FAILED");
  assert.equal(authorityVisualState(inconsistent), "FAILED");
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
  assert.match(home, /deriveAuthorityView\(stateQuery\.data, stateQuery\.error\)/);
  assert.doesNotMatch(home, /lastCycleResult/);
  for (const relative of surfaces) {
    const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.match(source, /authority: AuthoritativeTripwireState/);
    assert.doesNotMatch(source, /useGetImmuneState/);
    assert.doesNotMatch(source, /lastCycleResult/);
  }
});
