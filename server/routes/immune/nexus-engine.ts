import { createHash } from "node:crypto";

/**
 * IMMUNE NEXUS deterministic simulation engine.
 *
 * Source lineage:
 *   szl-holdings/nexus@617fb49f061c9eb369c4d879a7c29af64c08e72e
 *   - src/lib/nexus/math.ts
 *   - server.py
 *
 * This module consolidates the bounded, executable software dynamics into
 * IMMUNE as a simulation plane. It has no shell, arbitrary-code, URL, network,
 * filesystem, hardware, or external-effector authority.
 */

export const NEXUS_SOURCE_REPOSITORY = "szl-holdings/nexus" as const;
export const NEXUS_SOURCE_REVISION =
  "617fb49f061c9eb369c4d879a7c29af64c08e72e" as const;
export const NEXUS_SOURCE_BLOBS = {
  "src/lib/nexus/math.ts": "d71a0f7d40f2c29d906c03636547b1eebfe196f1",
  "server.py": "b423576f3a50f4a1ed249e86532b713b19e3ce37",
} as const;
export const NEXUS_ENGINE_SCHEMA = "szl.immune-nexus-engine/v1" as const;
export const NEXUS_RUN_SCHEMA = "szl.immune-nexus-run/v1" as const;
export const NEXUS_PARITY_SCHEMA = "szl.immune-nexus-parity/v1" as const;

export const NEXUS_PROGRAMS = [
  "lorenz",
  "harmonic",
  "vanderpol",
  "duffing",
  "lotka",
  "nemo",
] as const;
export type NexusProgram = (typeof NEXUS_PROGRAMS)[number];

export const NEXUS_MODES = ["IC", "OP", "HALT", "REP"] as const;
export type NexusMode = (typeof NEXUS_MODES)[number];

export interface NexusState {
  x: number;
  y: number;
  z: number;
  t: number;
  /** NEMO: 5 membrane + 5 recovery + 5 synaptic + 5 optical STDP values. */
  bank?: number[];
}

export interface NexusRunInput {
  program: NexusProgram;
  mode: NexusMode;
  steps: number;
  dt: number;
  chaos: number;
  drive: number;
  seed: number;
  repeatEvery: number;
  state?: NexusState;
  axes?: number[];
}

export interface NexusCoefficients {
  sigma: number;
  rho: number;
  beta: number;
  omega: number;
  mu: number;
  delta: number;
  gamma: number;
  alpha: number;
  label: string;
}

export interface NexusRunResult {
  schema: typeof NEXUS_RUN_SCHEMA;
  source: {
    repository: typeof NEXUS_SOURCE_REPOSITORY;
    revision: typeof NEXUS_SOURCE_REVISION;
    importedFiles: readonly ["src/lib/nexus/math.ts", "server.py"];
    importedBlobs: typeof NEXUS_SOURCE_BLOBS;
  };
  execution: {
    authority: "IMMUNE_SIMULATION_ONLY";
    truth: "MEASURED_SOFTWARE_SIMULATION";
    program: NexusProgram;
    mode: NexusMode;
    stepsRequested: number;
    stepsExecuted: number;
    repeatEvery: number;
    repeatCount: number;
    dt: number;
    chaos: number;
    drive: number;
    externalCalls: 0;
    externalEffectors: false;
    arbitraryCode: false;
    arbitraryUrls: false;
    energy: "UNAVAILABLE";
    uniqueness: "Conjecture 1 OPEN";
  };
  coefficients: NexusCoefficients;
  initialState: NexusState;
  finalState: NexusState;
  normalized: { x: number; y: number; z: number };
  trail: Array<[number, number, number]>;
  optics: {
    objectAmplitude: number;
    referenceAmplitude: number;
    phaseDifference: number;
    intensity: number;
    reconstruct: number;
    field: number[][];
  };
  circuit: {
    intg: number;
    sum: number;
    mul: number;
    inv: number;
    cmp: number;
    corr: number;
    jack: number;
  };
  formulas: {
    lambda: {
      value: number | null;
      blocked: boolean;
      label: "MODELED_FROM_CALLER_AXES" | "UNAVAILABLE";
      trustCeiling: 0.97;
      status: "Conjecture 1 OPEN";
    };
    ouroborosTax: {
      value: number;
      label: "MODELED";
      bars: 8;
    };
  };
  invariants: {
    finiteState: boolean;
    lotkaFirstQuadrant: boolean | null;
    nemoBankBounded: boolean | null;
    trailBounded: boolean;
    externalCallsZero: true;
    executableSoftwareNotHardware: true;
    allHold: boolean;
  };
  inputHash: string;
  outputHash: string;
}

export class NexusValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NexusValidationError";
    this.code = code;
  }
}

const MAX_STANDARD_STEPS = 2_400;
const MAX_NEMO_STEPS = 400;
const MAX_TRAIL_POINTS = 256;
const FIELD_COLS = 16;
const FIELD_ROWS = 9;
const TRUST_CEILING = 0.97 as const;

function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new NexusValidationError("NON_FINITE_NUMBER", `${name} must be finite`);
  }
  return value;
}

function inRange(name: string, value: number, min: number, max: number): number {
  finite(name, value);
  if (value < min || value > max) {
    throw new NexusValidationError(
      "OUT_OF_RANGE",
      `${name} must be between ${min} and ${max}`,
    );
  }
  return value;
}

function integerInRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new NexusValidationError(
      "OUT_OF_RANGE",
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampUnit(value: number): number {
  const safe = Number.isFinite(value) ? value : 0;
  return Math.min(1, Math.max(-1, safe));
}

function cleanZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function cloneState(state: NexusState): NexusState {
  return {
    x: state.x,
    y: state.y,
    z: state.z,
    t: state.t,
    ...(state.bank ? { bank: [...state.bank] } : {}),
  };
}

function validateState(program: NexusProgram, state: NexusState): NexusState {
  const out: NexusState = {
    x: finite("state.x", state.x),
    y: finite("state.y", state.y),
    z: finite("state.z", state.z),
    t: inRange("state.t", state.t, 0, 1_000_000),
  };
  if (program === "nemo") {
    const bank = state.bank;
    if (!bank || (bank.length !== 15 && bank.length !== 20)) {
      throw new NexusValidationError(
        "INVALID_NEMO_BANK",
        "NEMO state.bank must contain exactly 15 or 20 finite values",
      );
    }
    if (!bank.every(Number.isFinite)) {
      throw new NexusValidationError(
        "INVALID_NEMO_BANK",
        "NEMO state.bank contains a non-finite value",
      );
    }
    out.bank = padNemoBank(bank);
  } else if (state.bank !== undefined) {
    throw new NexusValidationError(
      "UNSUPPORTED_STATE_FIELD",
      "state.bank is accepted only for the NEMO program",
    );
  }
  return out;
}

export function normalizeNexusInput(input: NexusRunInput): NexusRunInput {
  if (!NEXUS_PROGRAMS.includes(input.program)) {
    throw new NexusValidationError("UNKNOWN_PROGRAM", `unknown program: ${String(input.program)}`);
  }
  if (!NEXUS_MODES.includes(input.mode)) {
    throw new NexusValidationError("UNKNOWN_MODE", `unknown mode: ${String(input.mode)}`);
  }
  const maxSteps = input.program === "nemo" ? MAX_NEMO_STEPS : MAX_STANDARD_STEPS;
  const steps = integerInRange("steps", input.steps, 0, maxSteps);
  const dt = inRange("dt", input.dt, 0.0004, 0.08);
  const chaos = inRange("chaos", input.chaos, 0, 1);
  const drive = inRange("drive", input.drive, 0, 1);
  const seed = inRange("seed", input.seed, 0, 1);
  const repeatEvery = integerInRange("repeatEvery", input.repeatEvery, 1, 512);
  const state = input.state ? validateState(input.program, input.state) : undefined;
  const axes = input.axes
    ? input.axes.map((axis, index) => inRange(`axes[${index}]`, axis, 0, 1))
    : undefined;
  if (axes && (axes.length < 1 || axes.length > 64)) {
    throw new NexusValidationError("INVALID_AXES", "axes must contain between 1 and 64 values");
  }
  return {
    program: input.program,
    mode: input.mode,
    steps,
    dt,
    chaos,
    drive,
    seed,
    repeatEvery,
    ...(state ? { state } : {}),
    ...(axes ? { axes } : {}),
  };
}

export function seedNemoBank(nudge = 0): number[] {
  const n = nudge % 1;
  const v = [-65 + n * 6, -62 - n * 4, -70 + n * 5, -58 - n * 3, -67 + n * 8];
  const u = v.map((membrane) => 0.2 * membrane);
  return [...v, ...u, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
}

export function padNemoBank(raw?: number[]): number[] {
  if (raw && raw.length >= 20 && raw.slice(0, 20).every(Number.isFinite)) {
    return raw.slice(0, 20);
  }
  if (raw && raw.length === 15 && raw.every(Number.isFinite)) {
    return [...raw, 1, 1, 1, 1, 1];
  }
  return seedNemoBank();
}

export function seedNexusState(program: NexusProgram, nudge = 0): NexusState {
  const n = nudge % 1;
  if (program === "harmonic") return { x: 1, y: 0.02 + n * 0.08, z: 0.5, t: 0 };
  if (program === "vanderpol") return { x: 0.12 + n * 0.2, y: 0.04, z: 0.4, t: 0 };
  if (program === "duffing") return { x: 0.18 + n * 0.12, y: 0, z: 0.5, t: 0 };
  if (program === "lotka") return { x: 1.15 + n * 0.25, y: 0.82 + n * 0.12, z: 0.5, t: 0 };
  if (program === "nemo") {
    const bank = seedNemoBank(nudge);
    return { x: bank[0] ?? -65, y: bank[2] ?? -70, z: 0.06, t: 0, bank };
  }
  return {
    x: 0.12 + nudge * 0.31,
    y: -0.08 + nudge * 0.17,
    z: 22 + (nudge % 1) * 6,
    t: 0,
  };
}

export function nexusCoefficients(
  chaos: number,
  program: NexusProgram = "lorenz",
): NexusCoefficients {
  const c = clamp01(chaos);
  if (program === "harmonic") {
    const omega = 1 + c * 3;
    return {
      sigma: 10,
      rho: 18 + c * 22,
      beta: 8 / 3,
      omega,
      mu: 0,
      delta: 0,
      gamma: 0,
      alpha: 0,
      label: `ω ${omega.toFixed(2)}`,
    };
  }
  if (program === "vanderpol") {
    const mu = 0.25 + c * 2.7;
    return {
      sigma: 10,
      rho: 18 + c * 22,
      beta: 8 / 3,
      omega: 1,
      mu,
      delta: 0,
      gamma: 0,
      alpha: 0,
      label: `μ ${mu.toFixed(2)}`,
    };
  }
  if (program === "duffing") {
    const delta = 0.08 + c * 0.32;
    const gamma = 0.18 + c * 0.55;
    return {
      sigma: 10,
      rho: 18 + c * 22,
      beta: 8 / 3,
      omega: 1.2,
      mu: 0,
      delta,
      gamma,
      alpha: 0,
      label: `δ ${delta.toFixed(2)} · γ ${gamma.toFixed(2)}`,
    };
  }
  if (program === "lotka") {
    const alpha = 0.85 + c * 0.55;
    const beta = 0.42 + c * 0.7;
    return {
      sigma: 10,
      rho: 18 + c * 22,
      beta,
      omega: 1,
      mu: 0,
      delta: 0.4 + c * 0.35,
      gamma: 0.62,
      alpha,
      label: `α ${alpha.toFixed(2)} · β ${beta.toFixed(2)}`,
    };
  }
  if (program === "nemo") {
    const mu = 0.02 + c * 0.08;
    const delta = 3.5 + c * 14;
    const gamma = 3 + (1 - c) * 9;
    return {
      sigma: 10,
      rho: 18 + c * 22,
      beta: 8 / 3,
      omega: 1,
      mu,
      delta,
      gamma,
      alpha: 0.2,
      label: "AdEx · 5ORG · WILLAY 2BRN",
    };
  }
  const rho = 18 + c * 22;
  return {
    sigma: 10,
    rho,
    beta: 8 / 3,
    omega: 1,
    mu: 0,
    delta: 0,
    gamma: 0,
    alpha: 0,
    label: `σ 10 · ρ ${rho.toFixed(1)} · β ${(8 / 3).toFixed(2)}`,
  };
}

export function opticalInterfere(
  objectAmplitude: number,
  objectPhase: number,
  referenceAmplitude: number,
  referencePhase: number,
): number {
  const ao = Math.max(0, objectAmplitude);
  const ar = Math.max(0, referenceAmplitude);
  const intensity =
    ao * ao + ar * ar + 2 * ao * ar * Math.cos(objectPhase - referencePhase);
  return Number.isFinite(intensity) ? Math.max(0, intensity) : 0;
}

export function opticalReconstruct(intensity: number, phaseDifference: number): number {
  const value = intensity * Math.cos(phaseDifference);
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value / 2));
}

export function analogCircuit(x: number, y: number, z: number, corr = 0) {
  const xi = clampUnit(x);
  const yi = clampUnit(y);
  const zi = clampUnit(z);
  return {
    intg: xi,
    sum: clampUnit((xi + yi + zi) / 3),
    mul: clampUnit(xi * yi),
    inv: clampUnit(-xi),
    cmp: xi >= 0 ? 1 : -1,
    corr: clampUnit(corr),
  };
}

export function analogCorrelate(
  pre: number,
  post: number,
  corr: number,
  dt: number,
  tau = 0.18,
): number {
  const product = clampUnit(pre) * clampUnit(post);
  const safeTau = Math.max(1e-4, tau);
  const alpha = 1 - Math.exp(-Math.max(0, dt) / safeTau);
  return clampUnit(clampUnit(corr) + (product - clampUnit(corr)) * alpha);
}

export function analogSchmitt(x: number, last: number, hysteresis = 0.08): number {
  const band = Math.max(0.01, Math.min(0.45, hysteresis));
  const value = clampUnit(x);
  if (last >= 0) return value > -band ? 1 : -1;
  return value < band ? -1 : 1;
}

export function analogJack(
  circuit: ReturnType<typeof analogCircuit>,
  reconstruct: number,
  drive: number,
): number {
  const d = clamp01(drive);
  return clampUnit(
    circuit.intg * 0.55 +
      circuit.mul * 0.22 * d +
      circuit.corr * 0.12 * d +
      clampUnit(reconstruct) * 0.22 * d,
  );
}

function analogNemoStep(
  source: NexusState,
  dt: number,
  chaos: number,
  drive: number,
): NexusState {
  const c = clamp01(chaos);
  const pots = nexusCoefficients(c, "nemo");
  const adaptiveCoupling = pots.mu;
  const chemicalWeight = pots.delta;
  const synapticTau = Math.max(1.4, pots.gamma);
  const injectedCurrent = 2.2 + drive * 10.5;
  const restingPotential = -65;
  const threshold = -52 + c * 6;
  const slopeFactor = 2;
  const leakConductance = 0.12;
  const adaptationTau = Math.max(8, 42 - c * 28);
  const resetPotential = -58 + c * 8;
  const adaptationJump = 4 + c * 10;
  const peakPotential = 20;
  const modulator = clamp01(drive);
  const bank = padNemoBank(source.bank);
  let rate = Number.isFinite(source.z) ? Math.max(0, Math.min(1, source.z)) : 0;
  let time = Number.isFinite(source.t) ? source.t : 0;
  const totalMs = Math.max(0.25, Math.min(80, dt * 1_000));
  const subSteps = Math.max(4, Math.min(48, Math.ceil(totalMs / 0.5)));
  const h = totalMs / subSteps;

  for (let subStep = 0; subStep < subSteps; subStep += 1) {
    const currents = [0, 0, 0, 0, 0];
    const opticalInputs = [0, 0, 0, 0, 0];
    const timeMs = time * 1_000;
    const pacemakerPeriod = 170 + (1 - modulator) * 260;
    const pacemakerCurrent =
      modulator *
      (1.6 +
        3.8 * (0.5 + 0.5 * Math.sin((timeMs * Math.PI * 2) / pacemakerPeriod)));
    let willayField = 0;

    for (let index = 0; index < 5; index += 1) {
      const opposite = (index + 2) % 5;
      const previous = (index + 4) % 5;
      const objectAmplitude = Math.max(0, ((bank[index] ?? -65) + 70) / 110);
      const referenceAmplitude = Math.max(
        0,
        ((bank[opposite] ?? -65) + 70) / 110,
      );
      opticalInputs[index] = opticalInterfere(
        objectAmplitude,
        (bank[index] ?? -65) * 0.035,
        referenceAmplitude,
        (bank[opposite] ?? -65) * 0.035,
      );
      willayField += opticalReconstruct(
        opticalInputs[index] ?? 0,
        ((bank[index] ?? -65) - (bank[opposite] ?? -65)) * 0.035,
      );
      const travelingWave =
        0.72 * Math.max(0, ((bank[previous] ?? restingPotential) - restingPotential) / 40);
      const opticalWeight = Math.max(0.05, Math.min(4, bank[15 + index] ?? 1));
      let current =
        (bank[10 + index] ?? 0) +
        (opticalInputs[index] ?? 0) * (1.1 + drive * 0.9) * opticalWeight +
        travelingWave;
      if (index === 0) current += injectedCurrent;
      else if (index === 1) current += 0.8 + drive * 2.4 + pacemakerCurrent;
      else current += 0.8 + drive * 2.4;
      if (index === 3) current += 0.45 * (opticalInputs[index] ?? 0);
      currents[index] = current;
    }

    willayField /= 5;
    const gate = 0.35 + 0.65 * (0.5 + 0.5 * willayField);
    const fired: number[] = [];

    for (let index = 0; index < 5; index += 1) {
      let membrane = bank[index] ?? restingPotential;
      let recovery = bank[5 + index] ?? 0;
      let synapticTrace = bank[10 + index] ?? 0;
      const exponent = Math.max(
        -20,
        Math.min(8, (membrane - threshold) / slopeFactor),
      );
      const membraneDelta =
        -leakConductance * (membrane - restingPotential) +
        leakConductance * slopeFactor * Math.exp(exponent) -
        recovery +
        (currents[index] ?? 0);
      const recoveryDelta =
        (adaptiveCoupling * (membrane - restingPotential) - recovery) / adaptationTau;
      membrane += membraneDelta * h;
      recovery += recoveryDelta * h;
      if (index === 4) {
        membrane += (restingPotential - membrane) * (h / 420);
      }
      synapticTrace += (-synapticTrace / synapticTau) * h;
      if (membrane >= peakPotential) {
        membrane = resetPotential;
        recovery += adaptationJump;
        fired.push(index);
      }
      bank[index] = Math.max(-90, Math.min(40, membrane));
      bank[5 + index] = Math.max(-40, Math.min(80, recovery));
      bank[10 + index] = Math.max(0, Math.min(48, synapticTrace));
    }

    for (const index of fired) {
      const post = (index + 1) % 5;
      const opposite = (index + 2) % 5;
      const availability = 1 - Math.min(1, (bank[10 + post] ?? 0) / 48);
      const jump = chemicalWeight * availability * (0.55 + 0.45 * gate);
      bank[10 + post] = Math.min(48, (bank[10 + post] ?? 0) + jump);
      const nervousWeight = index === 3 ? 1.35 : 1;
      bank[15 + index] =
        (bank[15 + index] ?? 1) +
        0.018 *
          ((bank[10 + opposite] ?? 0) / 48) *
          (opticalInputs[index] ?? 0) *
          modulator *
          gate *
          nervousWeight;
      bank[15 + opposite] = (bank[15 + opposite] ?? 1) - 0.006;
    }

    for (let index = 0; index < 5; index += 1) {
      const current = bank[15 + index] ?? 1;
      const leaked = current + (1 - current) * (h / 180);
      bank[15 + index] = Math.max(0.05, Math.min(4, leaked));
    }

    const decay = Math.exp(-h / 38);
    rate = rate * decay + (fired.length / 5) * (1 - decay) * 10;
    rate = Math.min(1, rate);
    time += h * 0.001;
    if (!Number.isFinite(bank[0]) || !Number.isFinite(rate) || !Number.isFinite(time)) {
      return seedNexusState("nemo");
    }
  }

  return {
    x: bank[0] ?? -65,
    y: bank[2] ?? -70,
    z: rate,
    t: time,
    bank,
  };
}

export function stepNexusState(
  program: NexusProgram,
  source: NexusState,
  dt: number,
  chaos: number,
  drive = 0.5,
): NexusState {
  if (program === "nemo") return analogNemoStep(source, dt, chaos, drive);
  const pots = nexusCoefficients(chaos, program);
  const subSteps = 4;
  const h = Math.max(0.0004, Math.min(0.08, dt)) / subSteps;
  let { x, y, z, t } = source;

  for (let index = 0; index < subSteps; index += 1) {
    let dx = 0;
    let dy = 0;
    let dz = 0;
    if (program === "harmonic") {
      const omegaSquared = pots.omega * pots.omega;
      dx = y;
      dy = -omegaSquared * x;
    } else if (program === "vanderpol") {
      dx = y;
      dy = pots.mu * (1 - x * x) * y - x;
    } else if (program === "duffing") {
      const force =
        pots.gamma * (0.45 + drive * 0.7) * Math.cos(pots.omega * t);
      dx = y;
      dy = x - x * x * x - pots.delta * y + force;
    } else if (program === "lotka") {
      const prey = Math.max(0.02, x);
      const predator = Math.max(0.02, y);
      dx = pots.alpha * prey - pots.beta * prey * predator;
      dy = pots.delta * prey * predator - pots.gamma * predator;
    } else {
      dx = pots.sigma * (y - x);
      dy = x * (pots.rho - z) - y;
      dz = x * y - pots.beta * z;
    }
    x += dx * h;
    y += dy * h;
    z += dz * h;
    t += h;
  }

  if (program === "lotka") {
    x = Math.max(0.02, x);
    y = Math.max(0.02, y);
  }
  if (![x, y, z, t].every(Number.isFinite)) {
    return seedNexusState(program);
  }
  return { x, y, z, t };
}

export function scaleNexusState(
  program: NexusProgram,
  state: NexusState,
): { x: number; y: number; z: number } {
  if (program === "harmonic") {
    const energy = 0.5 * (state.y * state.y + state.x * state.x);
    return {
      x: Math.max(-1, Math.min(1, state.x)),
      y: Math.max(-1, Math.min(1, state.y / 3)),
      z: Math.max(0, Math.min(1, energy * 0.5)),
    };
  }
  if (program === "vanderpol") {
    return {
      x: Math.max(-1, Math.min(1, state.x / 2.4)),
      y: Math.max(-1, Math.min(1, state.y / 3.2)),
      z: Math.max(0, Math.min(1, (state.x * state.x + state.y * state.y) / 10)),
    };
  }
  if (program === "duffing") {
    return {
      x: Math.max(-1, Math.min(1, state.x / 2)),
      y: Math.max(-1, Math.min(1, state.y / 2.4)),
      z: Math.max(0, Math.min(1, 0.5 + 0.5 * Math.sin(state.t))),
    };
  }
  if (program === "lotka") {
    return {
      x: Math.max(-1, Math.min(1, (state.x - 1.4) / 1.8)),
      y: Math.max(-1, Math.min(1, (state.y - 1.1) / 1.6)),
      z: Math.max(0, Math.min(1, (state.x + state.y) / 6)),
    };
  }
  if (program === "nemo") {
    return {
      x: Math.max(-1, Math.min(1, (state.x + 45) / 40)),
      y: Math.max(-1, Math.min(1, (state.y + 45) / 40)),
      z: Math.max(0, Math.min(1, state.z)),
    };
  }
  return {
    x: Math.max(-1, Math.min(1, state.x / 24)),
    y: Math.max(-1, Math.min(1, state.y / 24)),
    z: Math.max(0, Math.min(1, state.z / 48)),
  };
}

function opticalField(program: NexusProgram, state: NexusState): number[][] {
  const scaled = scaleNexusState(program, state);
  const field: number[][] = [];
  for (let row = 0; row < FIELD_ROWS; row += 1) {
    const values: number[] = [];
    for (let column = 0; column < FIELD_COLS; column += 1) {
      const objectAmplitude = 0.35 + 0.45 * scaled.z;
      const referenceAmplitude = 0.4 + 0.35 * Math.abs(scaled.x);
      const objectPhase =
        (column / FIELD_COLS) * Math.PI * 2 + scaled.y * 1.4 + state.t * 0.7;
      const referencePhase =
        (row / FIELD_ROWS) * Math.PI * 2 + scaled.z * 2.2;
      values.push(
        roundFinite(
          opticalInterfere(
            objectAmplitude,
            objectPhase,
            referenceAmplitude,
            referencePhase,
          ),
        ),
      );
    }
    field.push(values);
  }
  return field;
}

export function lambdaAggregate(axes?: number[]): {
  value: number | null;
  blocked: boolean;
  label: "MODELED_FROM_CALLER_AXES" | "UNAVAILABLE";
} {
  if (!axes) return { value: null, blocked: true, label: "UNAVAILABLE" };
  if (axes.length === 0 || axes.some((axis) => axis < 0 || axis > 1 || !Number.isFinite(axis))) {
    return { value: 0, blocked: true, label: "MODELED_FROM_CALLER_AXES" };
  }
  if (axes.some((axis) => axis === 0)) {
    return { value: 0, blocked: true, label: "MODELED_FROM_CALLER_AXES" };
  }
  const weight = 1 / axes.length;
  const raw = Math.exp(axes.reduce((sum, axis) => sum + weight * Math.log(axis), 0));
  return {
    value: Math.min(TRUST_CEILING, raw),
    blocked: false,
    label: "MODELED_FROM_CALLER_AXES",
  };
}

export function ouroborosTax(amplitude: number, bars = 8): number {
  const boundedBars = Math.max(1, Math.min(64, Math.floor(bars)));
  return Math.max(0, amplitude * Math.exp(-boundedBars / 8));
}

function roundFinite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new NexusValidationError("NON_FINITE_OUTPUT", "simulation produced a non-finite value");
  }
  return cleanZero(Math.round(value * 1_000_000_000_000) / 1_000_000_000_000);
}

function roundedState(state: NexusState): NexusState {
  return {
    x: roundFinite(state.x),
    y: roundFinite(state.y),
    z: roundFinite(state.z),
    t: roundFinite(state.t),
    ...(state.bank ? { bank: state.bank.map(roundFinite) } : {}),
  };
}

function canonicalNumber(value: number): string {
  const safe = cleanZero(value);
  return safe.toFixed(9);
}

function canonicalizeForParity(value: unknown): unknown {
  if (typeof value === "number") return canonicalNumber(value);
  if (Array.isArray(value)) return value.map(canonicalizeForParity);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalizeForParity((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalizeForParity(value));
}

export function nexusHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function nexusInputHash(input: NexusRunInput): string {
  return nexusHash({ schema: NEXUS_ENGINE_SCHEMA, source: NEXUS_SOURCE_REVISION, input });
}

function sampleTrail(
  program: NexusProgram,
  initial: NexusState,
  input: NexusRunInput,
): {
  finalState: NexusState;
  trail: Array<[number, number, number]>;
  stepsExecuted: number;
  repeatCount: number;
} {
  if (input.mode === "IC") {
    return { finalState: cloneState(seedNexusState(program, input.seed)), trail: [], stepsExecuted: 0, repeatCount: 0 };
  }
  if (input.mode === "HALT") {
    return { finalState: cloneState(initial), trail: [], stepsExecuted: 0, repeatCount: 0 };
  }

  let state = cloneState(initial);
  const trail: Array<[number, number, number]> = [];
  const stride = Math.max(1, Math.ceil(Math.max(1, input.steps) / MAX_TRAIL_POINTS));
  let repeatCount = 0;
  for (let step = 0; step < input.steps; step += 1) {
    if (input.mode === "REP" && step > 0 && step % input.repeatEvery === 0) {
      repeatCount += 1;
      state = seedNexusState(program, (input.seed + repeatCount * 0.137) % 1);
    }
    state = stepNexusState(program, state, input.dt, input.chaos, input.drive);
    if (step % stride === 0 || step === input.steps - 1) {
      trail.push([
        roundFinite(state.x),
        roundFinite(state.y),
        roundFinite(state.z),
      ]);
    }
  }
  return { finalState: state, trail, stepsExecuted: input.steps, repeatCount };
}

export function runNexus(inputValue: NexusRunInput): NexusRunResult {
  const input = normalizeNexusInput(inputValue);
  const seeded = seedNexusState(input.program, input.seed);
  const initialState = input.state ? cloneState(input.state) : seeded;
  const simulated = sampleTrail(input.program, initialState, input);
  const finalState = roundedState(simulated.finalState);
  const normalizedRaw = scaleNexusState(input.program, finalState);
  const normalized = {
    x: roundFinite(normalizedRaw.x),
    y: roundFinite(normalizedRaw.y),
    z: roundFinite(normalizedRaw.z),
  };
  const objectAmplitude = Math.max(0, 0.5 + 0.5 * Math.hypot(normalized.x, normalized.y));
  const referenceAmplitude = Math.max(0, 0.35 + 0.55 * normalized.z);
  const phaseDifference = Math.atan2(normalized.y, normalized.x + 1e-9);
  const intensity = opticalInterfere(
    objectAmplitude,
    phaseDifference,
    referenceAmplitude,
    0,
  );
  const reconstruct = opticalReconstruct(intensity, phaseDifference);
  const corr = analogCorrelate(normalized.x, normalized.y, 0, input.dt);
  const circuitBase = analogCircuit(normalized.x, normalized.y, normalized.z, corr);
  const circuit = {
    ...Object.fromEntries(
      Object.entries(circuitBase).map(([key, value]) => [key, roundFinite(value)]),
    ),
    jack: roundFinite(analogJack(circuitBase, reconstruct, input.drive)),
  } as NexusRunResult["circuit"];
  const lambda = lambdaAggregate(input.axes);
  const lotkaFirstQuadrant =
    input.program === "lotka" ? finalState.x > 0 && finalState.y > 0 : null;
  const nemoBankBounded =
    input.program === "nemo"
      ? Boolean(
          finalState.bank &&
            finalState.bank.length === 20 &&
            finalState.bank.slice(0, 5).every((value) => value >= -90 && value <= 40) &&
            finalState.bank.slice(5, 10).every((value) => value >= -40 && value <= 80) &&
            finalState.bank.slice(10, 15).every((value) => value >= 0 && value <= 48) &&
            finalState.bank.slice(15, 20).every((value) => value >= 0.05 && value <= 4),
        )
      : null;
  const finiteState = [finalState.x, finalState.y, finalState.z, finalState.t]
    .concat(finalState.bank ?? [])
    .every(Number.isFinite);
  const trailBounded = simulated.trail.length <= MAX_TRAIL_POINTS + 1;
  const invariants = {
    finiteState,
    lotkaFirstQuadrant,
    nemoBankBounded,
    trailBounded,
    externalCallsZero: true as const,
    executableSoftwareNotHardware: true as const,
    allHold:
      finiteState &&
      trailBounded &&
      lotkaFirstQuadrant !== false &&
      nemoBankBounded !== false,
  };
  const inputHash = nexusInputHash(input);
  const deterministicOutput = {
    schema: NEXUS_PARITY_SCHEMA,
    sourceRevision: NEXUS_SOURCE_REVISION,
    program: input.program,
    mode: input.mode,
    stepsExecuted: simulated.stepsExecuted,
    repeatCount: simulated.repeatCount,
    finalState,
    normalized,
    optics: {
      objectAmplitude: roundFinite(objectAmplitude),
      referenceAmplitude: roundFinite(referenceAmplitude),
      phaseDifference: roundFinite(phaseDifference),
      intensity: roundFinite(intensity),
      reconstruct: roundFinite(reconstruct),
    },
    circuit,
    lambda,
    ouroborosTax: roundFinite(ouroborosTax(Math.abs(reconstruct))),
    invariants,
  };
  const outputHash = nexusHash(deterministicOutput);

  return {
    schema: NEXUS_RUN_SCHEMA,
    source: {
      repository: NEXUS_SOURCE_REPOSITORY,
      revision: NEXUS_SOURCE_REVISION,
      importedFiles: ["src/lib/nexus/math.ts", "server.py"],
      importedBlobs: NEXUS_SOURCE_BLOBS,
    },
    execution: {
      authority: "IMMUNE_SIMULATION_ONLY",
      truth: "MEASURED_SOFTWARE_SIMULATION",
      program: input.program,
      mode: input.mode,
      stepsRequested: input.steps,
      stepsExecuted: simulated.stepsExecuted,
      repeatEvery: input.repeatEvery,
      repeatCount: simulated.repeatCount,
      dt: input.dt,
      chaos: input.chaos,
      drive: input.drive,
      externalCalls: 0,
      externalEffectors: false,
      arbitraryCode: false,
      arbitraryUrls: false,
      energy: "UNAVAILABLE",
      uniqueness: "Conjecture 1 OPEN",
    },
    coefficients: nexusCoefficients(input.chaos, input.program),
    initialState: roundedState(initialState),
    finalState,
    normalized,
    trail: simulated.trail,
    optics: {
      objectAmplitude: roundFinite(objectAmplitude),
      referenceAmplitude: roundFinite(referenceAmplitude),
      phaseDifference: roundFinite(phaseDifference),
      intensity: roundFinite(intensity),
      reconstruct: roundFinite(reconstruct),
      field: opticalField(input.program, finalState),
    },
    circuit,
    formulas: {
      lambda: {
        value: lambda.value === null ? null : roundFinite(lambda.value),
        blocked: lambda.blocked,
        label: lambda.label,
        trustCeiling: TRUST_CEILING,
        status: "Conjecture 1 OPEN",
      },
      ouroborosTax: {
        value: roundFinite(ouroborosTax(Math.abs(reconstruct))),
        label: "MODELED",
        bars: 8,
      },
    },
    invariants,
    inputHash,
    outputHash,
  };
}

export function verifyNexusRun(
  input: NexusRunInput,
  expectedOutputHash: string,
): {
  schema: "szl.immune-nexus-verification/v1";
  verified: boolean;
  expectedOutputHash: string;
  observedOutputHash: string;
  sourceRevision: typeof NEXUS_SOURCE_REVISION;
  truth: "DERIVED_REPLAY";
} {
  if (!/^[a-f0-9]{64}$/i.test(expectedOutputHash)) {
    throw new NexusValidationError(
      "INVALID_OUTPUT_HASH",
      "expectedOutputHash must be a 64-character SHA-256 digest",
    );
  }
  const result = runNexus(input);
  return {
    schema: "szl.immune-nexus-verification/v1",
    verified: result.outputHash === expectedOutputHash.toLowerCase(),
    expectedOutputHash: expectedOutputHash.toLowerCase(),
    observedOutputHash: result.outputHash,
    sourceRevision: NEXUS_SOURCE_REVISION,
    truth: "DERIVED_REPLAY",
  };
}

export function nexusStatus() {
  return {
    schema: "szl.immune-nexus-status/v1",
    state: "EXECUTABLE",
    role: "IMMUNE_COUNTERFACTUAL_DYNAMICS_PLANE",
    publicProduct: "IMMUNE",
    source: {
      repository: NEXUS_SOURCE_REPOSITORY,
      revision: NEXUS_SOURCE_REVISION,
      blobs: NEXUS_SOURCE_BLOBS,
    },
    programs: [...NEXUS_PROGRAMS],
    modes: [...NEXUS_MODES],
    limits: {
      standardSteps: MAX_STANDARD_STEPS,
      nemoSteps: MAX_NEMO_STEPS,
      trailPoints: MAX_TRAIL_POINTS,
      requestBytes: 1_048_576,
    },
    controls: {
      sentraAdmission: true,
      hukllaEvidence: true,
      yawarReceipts: true,
      deterministicReplay: true,
      arbitraryCode: false,
      arbitraryUrls: false,
      networkEgress: false,
      externalEffectors: false,
      physicalHardware: false,
    },
    truth: {
      execution: "MEASURED_SOFTWARE_SIMULATION",
      energy: "UNAVAILABLE",
      uniqueness: "Conjecture 1 OPEN",
    },
    ui: "/nexus.html",
  };
}
