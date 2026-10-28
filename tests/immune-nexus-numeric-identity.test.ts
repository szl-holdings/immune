// Finding #5 (Appendix I) — CHARACTERIZATION ONLY. Hash values measured at base
// 70754c5a (engine unchanged since); the replay consequence uses the #4 helper.
//
// The Nexus identity projection (canonicalNumber -> toFixed(9)) rounds every
// number to 9 decimals, while execution uses full float64 precision. These tests
// pin the current, known-defective behaviour so it cannot change silently. They
// are NOT the fix: changing the projection re-hashes every stored v1 identity and
// the parity contract, so it needs a new identity version (SPEC_nexus_numeric_identity.md).
import assert from "node:assert/strict";
import test from "node:test";
import { nexusInputHash, nexusReplayDecision, runNexus, type NexusRunInput } from "../server/routes/immune/nexus-engine.ts";

const BASE: NexusRunInput = {
  program: "lorenz", mode: "OP", steps: 2400, dt: 0.01, chaos: 0.45, drive: 0.7, seed: 0.2, repeatEvery: 64,
};
const at = (x: number): NexusRunInput => ({ ...BASE, state: { x, y: 1, z: 1, t: 0 } });

test("characterization: a sub-1e-9 state change collides on inputHash but executes differently", () => {
  const a = runNexus(at(1));
  const b = runNexus(at(1 + 4e-10));
  assert.equal(a.inputHash, "63cc3381556a47c0373a6b0b67b92998810717d85bee0fb2de11b6b6acbca5e2");
  assert.equal(b.inputHash, a.inputHash);
  assert.notEqual(b.outputHash, a.outputHash);
  assert.ok(Math.abs(a.finalState.x - b.finalState.x) > 1e-6, "chaotic run amplifies the hidden difference");
  // Consequence for replay: the second, different request is classified as a replay
  // of the first, and the route then reports NEXUS_DETERMINISM_DIVERGENCE instead of
  // a request-id collision.
  assert.equal(
    nexusReplayDecision({ actor: "op", inputHash: a.inputHash }, { actor: "op", inputHash: b.inputHash }),
    "REPLAY",
  );
});

test("characterization: a sub-1e-9 dt change collides on inputHash but executes differently", () => {
  const a = runNexus({ ...BASE, steps: 400, dt: 0.0009765625 });
  const b = runNexus({ ...BASE, steps: 400, dt: 0.0009765628 });
  assert.equal(b.inputHash, a.inputHash);
  assert.notEqual(b.outputHash, a.outputHash);
});

test("characterization: TS and Python identities diverge on exact ties and |x| >= 1e21", () => {
  // dt = 2^-10 is an exact decimal tie at the 10th place: JS toFixed rounds up
  // ("0.000976563"), Python f"{x:.9f}" rounds half-even ("0.000976562").
  assert.equal((0.0009765625).toFixed(9), "0.000976563");
  const tie = { ...BASE, steps: 400, dt: 0.0009765625 };
  assert.equal(nexusInputHash(tie), "02bd5c492cbf579c971067ef7831d744a7b531e3e02c09407ed68ab4c2183d7f");
  // Python run_nexus at base (python/tests/test_nexus_numeric_identity.py):
  const PYTHON_TIE = "a7a23ec08a5de8e615a012775cc7ff7a56ae68359bc7c75d00236c0295311103";
  assert.notEqual(nexusInputHash(tie), PYTHON_TIE);
  // toFixed switches to exponent form at 1e21; Python prints all digits.
  assert.equal((1e21).toFixed(9), "1e+21");
  const big: NexusRunInput = { ...BASE, mode: "HALT", state: { x: 1e21, y: 1, z: 1, t: 0 } };
  assert.equal(nexusInputHash(big), "d51004c8763a7f3c794ea64a0513dfb6c1c7583e4604c923d7b277c566804eb3");
  const PYTHON_BIG = "469d7905bf85814e62124f8b8eb3902c764aaac5794836d14f5eca296a74ec5b";
  assert.notEqual(nexusInputHash(big), PYTHON_BIG);
});

test("characterization: negative zero shares identity and output with zero", () => {
  const negative = runNexus(at(-0));
  const positive = runNexus(at(0));
  assert.equal(negative.inputHash, positive.inputHash);
  assert.equal(negative.outputHash, positive.outputHash);
});
