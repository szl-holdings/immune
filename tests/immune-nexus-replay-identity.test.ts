// Finding #4 (Appendix I): the TS Nexus /run route hashed the raw request body for
// replay (`nexusInputHash(input)`), while runNexus pads a 15-slot NEMO bank to 20
// slots and stores the normalized `result.inputHash`. An identical 15-slot retry
// therefore presented a hash that never matches its own stored record (409
// collision), while a different 20-slot body matched it (replay).
//
// Requirement: normalize once at admission and use that one identity for
// validation, execution, storage and replay, WITHOUT changing any stored identity.
// The stored identity is (and stays) szl.immune-nexus-engine/v1 over the
// normalized input. The Python route already does this (python/immune/server.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as engine from "../server/routes/immune/nexus-engine.ts";
import type { NexusRunInput } from "../server/routes/immune/nexus-engine.ts";

const { NexusValidationError, nexusInputHash, runNexus } = engine;
type Identity = { actor: string; inputHash: string };
const api = engine as unknown as {
  admitNexusInput(input: NexusRunInput): { input: NexusRunInput; inputHash: string };
  nexusReplayDecision(stored: Identity | null, presented: Identity): "NEW" | "REPLAY" | "COLLISION";
};

const BANK_15 = [-63.8, -62.8, -69, -58.6, -65.4, -12.76, -12.56, -13.8, -11.72, -13.080000000000002, 0, 0, 0, 0, 0];
function nemo15(): NexusRunInput {
  return {
    program: "nemo",
    mode: "OP",
    steps: 40,
    dt: 0.01,
    chaos: 0.45,
    drive: 0.7,
    seed: 0.2,
    repeatEvery: 64,
    state: { x: -63.8, y: -69, z: 0.06, t: 0, bank: [...BANK_15] },
  };
}
function withBank(input: NexusRunInput, bank: number[]): NexusRunInput {
  return { ...input, state: { ...input.state!, bank } };
}
const LORENZ: NexusRunInput = {
  program: "lorenz", mode: "OP", steps: 40, dt: 0.01, chaos: 0.45, drive: 0.7, seed: 0.2, repeatEvery: 64,
};

// Measured at base 70754c5a (TS runNexus and Python run_nexus agree on it).
const STORED_V1_NEMO15 = "5400a842076b4609fa7020e4df6f8405799314d97f4e1423bf4ea3fde9d0118d";
const RAW_BODY_HASH_NEMO15 = "db6acb5cff2acccfd2c792eca96ecdb3c5525c26c7b2cf45dfbd572f2df3bde8";

// The route's stored record identity, exactly as compactReceiptPayload builds it.
function storedRecord(actor: string, input: NexusRunInput): Identity {
  return { actor, inputHash: runNexus(input).inputHash };
}

test("characterization: raw 15-slot body hash is not the stored normalized identity", () => {
  const raw = nemo15();
  assert.equal(runNexus(raw).inputHash, STORED_V1_NEMO15);
  assert.equal(nexusInputHash(raw), RAW_BODY_HASH_NEMO15);
  assert.notEqual(nexusInputHash(raw), runNexus(raw).inputHash);
  // ...while a padded 20-slot body (a different request body) hashes to it.
  assert.equal(nexusInputHash(withBank(raw, [...BANK_15, 1, 1, 1, 1, 1])), STORED_V1_NEMO15);
  // Non-NEMO inputs were never affected.
  assert.equal(nexusInputHash(LORENZ), runNexus(LORENZ).inputHash);
});

test("route admits once and never hashes the raw body for replay", () => {
  const route = readFileSync(new URL("../server/routes/immune/nexus.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /nexusInputHash\(\s*input\s*\)/);
  assert.match(route, /admitNexusInput\(/);
  assert.match(route, /nexusReplayDecision\(/);
  assert.match(route, /runNexus\(\s*admitted\.input\s*\)/);
  assert.match(route, /NEXUS_IDENTITY_DIVERGENCE/);
});

test("admission identity equals the stored identity and does not change stored identities", () => {
  for (const input of [nemo15(), withBank(nemo15(), [...BANK_15, 1, 1, 1, 1, 1]), LORENZ]) {
    const admitted = api.admitNexusInput(input);
    assert.equal(admitted.inputHash, runNexus(input).inputHash);
    assert.equal(runNexus(admitted.input).inputHash, admitted.inputHash);
    assert.equal(runNexus(admitted.input).outputHash, runNexus(input).outputHash);
  }
  assert.equal(api.admitNexusInput(nemo15()).inputHash, STORED_V1_NEMO15);
  assert.equal(api.admitNexusInput(nemo15()).input.state?.bank?.length, 20);
});

test("identical 15-slot retry replays the one completed record", () => {
  const stored = storedRecord("operator-a", nemo15());
  const retry = { actor: "operator-a", inputHash: api.admitNexusInput(nemo15()).inputHash };
  assert.equal(api.nexusReplayDecision(stored, retry), "REPLAY");
  assert.equal(api.nexusReplayDecision(null, retry), "NEW");
});

test("genuine actor, program, state and step changes reject as collisions", () => {
  const stored = storedRecord("operator-a", nemo15());
  const present = (actor: string, input: NexusRunInput) => ({
    actor,
    inputHash: api.admitNexusInput(input).inputHash,
  });
  const changedBank = [...BANK_15];
  changedBank[3] = -58.5;
  const cases: Array<[string, Identity]> = [
    ["actor", present("operator-b", nemo15())],
    ["program", present("operator-a", LORENZ)],
    ["state.bank value", present("operator-a", withBank(nemo15(), changedBank))],
    ["state.bank slots 15..19", present("operator-a", withBank(nemo15(), [...BANK_15, 1, 1, 1, 1, 2]))],
    ["steps", present("operator-a", { ...nemo15(), steps: 41 })],
    ["mode", present("operator-a", { ...nemo15(), mode: "REP" })],
  ];
  for (const [label, presented] of cases) {
    assert.equal(api.nexusReplayDecision(stored, presented), "COLLISION", label);
  }
});

test("existing v1 storage equivalence: 15-slot and padded 20-slot share one identity", () => {
  // OWNER DECISION RECORDED, NOT MADE HERE: v1 storage already cannot tell these two
  // bodies apart (same stored inputHash and outputHash). Admission now applies that
  // same equivalence symmetrically. Treating them as distinct needs a new identity
  // version (spec delivered with this change as SPEC_nexus_identity.md), not a v1 change.
  const stored = storedRecord("operator-a", withBank(nemo15(), [...BANK_15, 1, 1, 1, 1, 1]));
  const retry15 = { actor: "operator-a", inputHash: api.admitNexusInput(nemo15()).inputHash };
  assert.equal(stored.inputHash, STORED_V1_NEMO15);
  assert.equal(api.nexusReplayDecision(stored, retry15), "REPLAY");
});

test("admission rejects engine-invalid bodies before any identity is computed", () => {
  const noBank = { ...nemo15(), state: { x: 0, y: 0, z: 0, t: 0 } };
  assert.throws(() => api.admitNexusInput(noBank), (error: unknown) =>
    error instanceof NexusValidationError && error.code === "INVALID_NEMO_BANK");
  assert.throws(() => api.admitNexusInput({ ...LORENZ, state: { x: 0, y: 0, z: 0, t: 0, bank: BANK_15 } }),
    (error: unknown) => error instanceof NexusValidationError && error.code === "UNSUPPORTED_STATE_FIELD");
});
