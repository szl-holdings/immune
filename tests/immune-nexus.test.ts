import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  NEXUS_PROGRAMS,
  NEXUS_SOURCE_REVISION,
  NexusValidationError,
  analogCorrelate,
  analogSchmitt,
  opticalInterfere,
  runNexus,
  seedNexusState,
  verifyNexusRun,
  type NexusProgram,
  type NexusRunInput,
} from "../server/routes/immune/nexus-engine.ts";


const PARITY = JSON.parse(
  readFileSync(new URL("../contracts/immune-nexus-parity-v1.json", import.meta.url), "utf8"),
) as {
  input: {
    mode: "OP";
    steps_standard: number;
    steps_nemo: number;
    dt_standard: number;
    dt_nemo: number;
    chaos: number;
    drive: number;
    seed: number;
    repeatEvery: number;
    axes: number[];
  };
  output_hashes: Record<NexusProgram, string>;
};

function request(program: NexusProgram, overrides: Partial<NexusRunInput> = {}): NexusRunInput {
  return {
    program,
    mode: "OP",
    steps: program === "nemo" ? 80 : 320,
    dt: program === "nemo" ? 0.002 : 0.01,
    chaos: 0.45,
    drive: 0.92,
    seed: 0.2,
    repeatEvery: 64,
    axes: [0.97, 0.96, 0.93, 0.91, 0.9, 0.92, 0.88, 0.91],
    ...overrides,
  };
}

test("all six Nexus programs execute as bounded deterministic software", () => {
  assert.equal(NEXUS_PROGRAMS.length, 6);
  for (const program of NEXUS_PROGRAMS) {
    const result = runNexus(request(program));
    assert.equal(result.source.revision, NEXUS_SOURCE_REVISION);
    assert.equal(result.execution.program, program);
    assert.equal(result.execution.externalCalls, 0);
    assert.equal(result.execution.externalEffectors, false);
    assert.equal(result.execution.arbitraryCode, false);
    assert.equal(result.execution.arbitraryUrls, false);
    assert.equal(result.execution.energy, "UNAVAILABLE");
    assert.equal(result.invariants.allHold, true, program);
    assert.match(result.inputHash, /^[a-f0-9]{64}$/);
    assert.match(result.outputHash, /^[a-f0-9]{64}$/);
  }
});


test("TypeScript engine matches the cross-language parity vectors", () => {
  for (const program of NEXUS_PROGRAMS) {
    const result = runNexus({
      program,
      mode: PARITY.input.mode,
      steps: program === "nemo" ? PARITY.input.steps_nemo : PARITY.input.steps_standard,
      dt: program === "nemo" ? PARITY.input.dt_nemo : PARITY.input.dt_standard,
      chaos: PARITY.input.chaos,
      drive: PARITY.input.drive,
      seed: PARITY.input.seed,
      repeatEvery: PARITY.input.repeatEvery,
      axes: PARITY.input.axes,
    });
    assert.equal(result.outputHash, PARITY.output_hashes[program], program);
  }
});

test("same input has the same output hash and can be replay-verified", () => {
  const input = request("lorenz", { steps: 128 });
  const first = runNexus(input);
  const second = runNexus(input);
  assert.equal(first.outputHash, second.outputHash);
  assert.deepEqual(first.finalState, second.finalState);
  assert.equal(verifyNexusRun(input, first.outputHash).verified, true);
});

test("IC, HALT, OP, and REP are distinct executable modes", () => {
  const seed = seedNexusState("harmonic", 0.2);
  const ic = runNexus(request("harmonic", { mode: "IC", steps: 100, state: seed }));
  const halt = runNexus(request("harmonic", { mode: "HALT", steps: 100, state: seed }));
  const op = runNexus(request("harmonic", { mode: "OP", steps: 100, state: seed }));
  const rep = runNexus(
    request("harmonic", { mode: "REP", steps: 130, repeatEvery: 32, state: seed }),
  );
  assert.equal(ic.execution.stepsExecuted, 0);
  assert.equal(halt.execution.stepsExecuted, 0);
  assert.notDeepEqual(op.finalState, seed);
  assert.ok(rep.execution.repeatCount >= 4);
  assert.notEqual(rep.outputHash, op.outputHash);
});

test("NEMO executes five-organ analog dynamics with bounded 20-cell bank", () => {
  const result = runNexus(request("nemo", { steps: 180, dt: 0.002, drive: 1 }));
  assert.equal(result.finalState.bank?.length, 20);
  assert.equal(result.invariants.nemoBankBounded, true);
  assert.ok((result.finalState.bank ?? []).slice(15, 20).every((value) => value >= 0.05 && value <= 4));
  assert.ok(result.finalState.z >= 0 && result.finalState.z <= 1);
});

test("Lotka-Volterra remains in the first quadrant", () => {
  const result = runNexus(request("lotka", { steps: 1_400, dt: 0.01 }));
  assert.equal(result.invariants.lotkaFirstQuadrant, true);
  assert.ok(result.finalState.x > 0);
  assert.ok(result.finalState.y > 0);
});

test("optical and analog primitives preserve their published contracts", () => {
  assert.ok(Math.abs(opticalInterfere(0.6, 0, 0.4, 0) - 1) < 1e-12);
  assert.ok(Math.abs(opticalInterfere(0.6, 0, 0.4, Math.PI) - 0.04) < 1e-12);
  let corr = 0;
  for (let index = 0; index < 80; index += 1) {
    corr = analogCorrelate(0.8, 0.5, corr, 0.02, 0.12);
  }
  assert.ok(corr > 0.3);
  assert.equal(analogSchmitt(-0.04, 1), 1);
  assert.equal(analogSchmitt(-0.2, 1), -1);
});

test("unbounded or non-finite requests fail closed", () => {
  assert.throws(
    () => runNexus(request("lorenz", { steps: 2_401 })),
    (error: unknown) => error instanceof NexusValidationError && error.code === "OUT_OF_RANGE",
  );
  assert.throws(
    () => runNexus(request("nemo", { state: { x: -65, y: -70, z: 0, t: 0, bank: [1, 2] } })),
    (error: unknown) => error instanceof NexusValidationError && error.code === "INVALID_NEMO_BANK",
  );
  assert.throws(
    () => runNexus(request("lorenz", { dt: Number.POSITIVE_INFINITY })),
    (error: unknown) => error instanceof NexusValidationError && error.code === "NON_FINITE_NUMBER",
  );
});
