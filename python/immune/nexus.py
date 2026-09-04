"""IMMUNE NEXUS bounded deterministic simulation plane.

Source lineage:
  szl-holdings/nexus@617fb49f061c9eb369c4d879a7c29af64c08e72e
  - src/lib/nexus/math.ts
  - server.py

This is executable software simulation, not a physical analog or neuromorphic
chip. It performs no network calls, arbitrary code, URL fetches, shell commands,
or external effects. The HTTP host must wrap accepted runs in the existing
SENTRA -> YAWAR -> HUKLLA cycle.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any

NEXUS_SOURCE_REPOSITORY = "szl-holdings/nexus"
NEXUS_SOURCE_REVISION = "617fb49f061c9eb369c4d879a7c29af64c08e72e"
NEXUS_SOURCE_BLOBS = {
    "src/lib/nexus/math.ts": "d71a0f7d40f2c29d906c03636547b1eebfe196f1",
    "server.py": "b423576f3a50f4a1ed249e86532b713b19e3ce37",
}
NEXUS_ENGINE_SCHEMA = "szl.immune-nexus-engine/v1"
NEXUS_RUN_SCHEMA = "szl.immune-nexus-run/v1"
NEXUS_PARITY_SCHEMA = "szl.immune-nexus-parity/v1"
NEXUS_PROGRAMS = ("lorenz", "harmonic", "vanderpol", "duffing", "lotka", "nemo")
NEXUS_MODES = ("IC", "OP", "HALT", "REP")

MAX_STANDARD_STEPS = 2_400
MAX_NEMO_STEPS = 400
MAX_TRAIL_POINTS = 256
FIELD_COLS = 16
FIELD_ROWS = 9
TRUST_CEILING = 0.97


class NexusValidationError(ValueError):
    """Strict input or deterministic-output contract failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _finite(name: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise NexusValidationError(
            "NON_FINITE_NUMBER", f"{name} must be a JSON number"
        )
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise NexusValidationError("NON_FINITE_NUMBER", f"{name} must be finite") from error
    if not math.isfinite(number):
        raise NexusValidationError("NON_FINITE_NUMBER", f"{name} must be finite")
    return number


def _in_range(name: str, value: Any, minimum: float, maximum: float) -> float:
    number = _finite(name, value)
    if number < minimum or number > maximum:
        raise NexusValidationError(
            "OUT_OF_RANGE", f"{name} must be between {minimum} and {maximum}"
        )
    return number


def _integer_in_range(name: str, value: Any, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise NexusValidationError(
            "OUT_OF_RANGE", f"{name} must be an integer between {minimum} and {maximum}"
        )
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise NexusValidationError(
            "OUT_OF_RANGE", f"{name} must be an integer between {minimum} and {maximum}"
        ) from error
    if number != value or number < minimum or number > maximum:
        raise NexusValidationError(
            "OUT_OF_RANGE", f"{name} must be an integer between {minimum} and {maximum}"
        )
    return number


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def _clamp_unit(value: float) -> float:
    return min(1.0, max(-1.0, value if math.isfinite(value) else 0.0))


def _round_finite(value: float) -> float:
    if not math.isfinite(value):
        raise NexusValidationError("NON_FINITE_OUTPUT", "simulation produced a non-finite value")
    rounded = round(value, 12)
    return 0.0 if rounded == 0 else rounded


def _clone_state(state: dict[str, Any]) -> dict[str, Any]:
    cloned = {
        "x": float(state["x"]),
        "y": float(state["y"]),
        "z": float(state["z"]),
        "t": float(state["t"]),
    }
    if "bank" in state:
        cloned["bank"] = [float(value) for value in state["bank"]]
    return cloned


def seed_nemo_bank(nudge: float = 0.0) -> list[float]:
    n = nudge % 1
    membranes = [-65 + n * 6, -62 - n * 4, -70 + n * 5, -58 - n * 3, -67 + n * 8]
    recovery = [0.2 * value for value in membranes]
    return [*membranes, *recovery, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0]


def pad_nemo_bank(raw: Any = None) -> list[float]:
    if isinstance(raw, list) and len(raw) >= 20:
        values = [_finite(f"state.bank[{index}]", value) for index, value in enumerate(raw[:20])]
        return values
    if isinstance(raw, list) and len(raw) == 15:
        values = [_finite(f"state.bank[{index}]", value) for index, value in enumerate(raw)]
        return [*values, 1.0, 1.0, 1.0, 1.0, 1.0]
    return seed_nemo_bank()


def seed_nexus_state(program: str, nudge: float = 0.0) -> dict[str, Any]:
    n = nudge % 1
    if program == "harmonic":
        return {"x": 1.0, "y": 0.02 + n * 0.08, "z": 0.5, "t": 0.0}
    if program == "vanderpol":
        return {"x": 0.12 + n * 0.2, "y": 0.04, "z": 0.4, "t": 0.0}
    if program == "duffing":
        return {"x": 0.18 + n * 0.12, "y": 0.0, "z": 0.5, "t": 0.0}
    if program == "lotka":
        return {"x": 1.15 + n * 0.25, "y": 0.82 + n * 0.12, "z": 0.5, "t": 0.0}
    if program == "nemo":
        bank = seed_nemo_bank(nudge)
        return {"x": bank[0], "y": bank[2], "z": 0.06, "t": 0.0, "bank": bank}
    return {
        "x": 0.12 + nudge * 0.31,
        "y": -0.08 + nudge * 0.17,
        "z": 22 + (nudge % 1) * 6,
        "t": 0.0,
    }


def _validate_state(program: str, state: Any) -> dict[str, Any]:
    if not isinstance(state, dict):
        raise NexusValidationError("INVALID_STATE", "state must be an object")
    allowed = {"x", "y", "z", "t", "bank"}
    extras = sorted(set(state) - allowed)
    if extras:
        raise NexusValidationError("UNSUPPORTED_STATE_FIELD", f"unsupported state fields: {extras}")
    required = {"x", "y", "z", "t"}
    missing = sorted(required - set(state))
    if missing:
        raise NexusValidationError("INVALID_STATE", f"state missing required fields: {missing}")
    out: dict[str, Any] = {
        "x": _finite("state.x", state["x"]),
        "y": _finite("state.y", state["y"]),
        "z": _finite("state.z", state["z"]),
        "t": _in_range("state.t", state["t"], 0, 1_000_000),
    }
    if program == "nemo":
        bank = state.get("bank")
        if not isinstance(bank, list) or len(bank) not in {15, 20}:
            raise NexusValidationError(
                "INVALID_NEMO_BANK",
                "NEMO state.bank must contain exactly 15 or 20 finite values",
            )
        out["bank"] = pad_nemo_bank(bank)
    elif "bank" in state:
        raise NexusValidationError(
            "UNSUPPORTED_STATE_FIELD", "state.bank is accepted only for the NEMO program"
        )
    return out


def normalize_nexus_input(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise NexusValidationError("INVALID_REQUEST", "Nexus input must be an object")
    allowed = {
        "program",
        "mode",
        "steps",
        "dt",
        "chaos",
        "drive",
        "seed",
        "repeatEvery",
        "state",
        "axes",
    }
    extras = sorted(set(payload) - allowed)
    if extras:
        raise NexusValidationError("UNSUPPORTED_FIELD", f"unsupported fields: {extras}")
    program = str(payload.get("program") or "")
    mode = str(payload.get("mode") or "OP").upper()
    if program not in NEXUS_PROGRAMS:
        raise NexusValidationError("UNKNOWN_PROGRAM", f"unknown program: {program}")
    if mode not in NEXUS_MODES:
        raise NexusValidationError("UNKNOWN_MODE", f"unknown mode: {mode}")
    max_steps = MAX_NEMO_STEPS if program == "nemo" else MAX_STANDARD_STEPS
    steps = _integer_in_range("steps", payload.get("steps", 320), 0, max_steps)
    dt = _in_range("dt", payload.get("dt", 0.01), 0.0004, 0.08)
    chaos = _in_range("chaos", payload.get("chaos", 0.45), 0, 1)
    drive = _in_range("drive", payload.get("drive", 0.7), 0, 1)
    seed = _in_range("seed", payload.get("seed", 0.2), 0, 1)
    repeat_every = _integer_in_range("repeatEvery", payload.get("repeatEvery", 64), 1, 512)
    state = _validate_state(program, payload["state"]) if "state" in payload else None
    axes = None
    if "axes" in payload:
        if not isinstance(payload["axes"], list) or not 1 <= len(payload["axes"]) <= 64:
            raise NexusValidationError("INVALID_AXES", "axes must contain between 1 and 64 values")
        axes = [
            _in_range(f"axes[{index}]", value, 0, 1)
            for index, value in enumerate(payload["axes"])
        ]
    out = {
        "program": program,
        "mode": mode,
        "steps": steps,
        "dt": dt,
        "chaos": chaos,
        "drive": drive,
        "seed": seed,
        "repeatEvery": repeat_every,
    }
    if state is not None:
        out["state"] = state
    if axes is not None:
        out["axes"] = axes
    return out


def nexus_coefficients(chaos: float, program: str = "lorenz") -> dict[str, Any]:
    c = _clamp01(chaos)
    if program == "harmonic":
        omega = 1 + c * 3
        return {
            "sigma": 10,
            "rho": 18 + c * 22,
            "beta": 8 / 3,
            "omega": omega,
            "mu": 0,
            "delta": 0,
            "gamma": 0,
            "alpha": 0,
            "label": f"ω {omega:.2f}",
        }
    if program == "vanderpol":
        mu = 0.25 + c * 2.7
        return {
            "sigma": 10,
            "rho": 18 + c * 22,
            "beta": 8 / 3,
            "omega": 1,
            "mu": mu,
            "delta": 0,
            "gamma": 0,
            "alpha": 0,
            "label": f"μ {mu:.2f}",
        }
    if program == "duffing":
        delta = 0.08 + c * 0.32
        gamma = 0.18 + c * 0.55
        return {
            "sigma": 10,
            "rho": 18 + c * 22,
            "beta": 8 / 3,
            "omega": 1.2,
            "mu": 0,
            "delta": delta,
            "gamma": gamma,
            "alpha": 0,
            "label": f"δ {delta:.2f} · γ {gamma:.2f}",
        }
    if program == "lotka":
        alpha = 0.85 + c * 0.55
        beta = 0.42 + c * 0.7
        return {
            "sigma": 10,
            "rho": 18 + c * 22,
            "beta": beta,
            "omega": 1,
            "mu": 0,
            "delta": 0.4 + c * 0.35,
            "gamma": 0.62,
            "alpha": alpha,
            "label": f"α {alpha:.2f} · β {beta:.2f}",
        }
    if program == "nemo":
        mu = 0.02 + c * 0.08
        delta = 3.5 + c * 14
        gamma = 3 + (1 - c) * 9
        return {
            "sigma": 10,
            "rho": 18 + c * 22,
            "beta": 8 / 3,
            "omega": 1,
            "mu": mu,
            "delta": delta,
            "gamma": gamma,
            "alpha": 0.2,
            "label": "AdEx · 5ORG · WILLAY 2BRN",
        }
    rho = 18 + c * 22
    return {
        "sigma": 10,
        "rho": rho,
        "beta": 8 / 3,
        "omega": 1,
        "mu": 0,
        "delta": 0,
        "gamma": 0,
        "alpha": 0,
        "label": f"σ 10 · ρ {rho:.1f} · β {(8 / 3):.2f}",
    }


def optical_interfere(
    object_amplitude: float,
    object_phase: float,
    reference_amplitude: float,
    reference_phase: float,
) -> float:
    ao = max(0.0, object_amplitude)
    ar = max(0.0, reference_amplitude)
    intensity = ao * ao + ar * ar + 2 * ao * ar * math.cos(object_phase - reference_phase)
    return max(0.0, intensity) if math.isfinite(intensity) else 0.0


def optical_reconstruct(intensity: float, phase_difference: float) -> float:
    value = intensity * math.cos(phase_difference)
    if not math.isfinite(value):
        return 0.0
    return max(-1.0, min(1.0, value / 2))


def analog_circuit(x: float, y: float, z: float, corr: float = 0.0) -> dict[str, float]:
    xi, yi, zi = _clamp_unit(x), _clamp_unit(y), _clamp_unit(z)
    return {
        "intg": xi,
        "sum": _clamp_unit((xi + yi + zi) / 3),
        "mul": _clamp_unit(xi * yi),
        "inv": _clamp_unit(-xi),
        "cmp": 1.0 if xi >= 0 else -1.0,
        "corr": _clamp_unit(corr),
    }


def analog_correlate(pre: float, post: float, corr: float, dt: float, tau: float = 0.18) -> float:
    product = _clamp_unit(pre) * _clamp_unit(post)
    safe_tau = max(1e-4, tau)
    alpha = 1 - math.exp(-max(0.0, dt) / safe_tau)
    previous = _clamp_unit(corr)
    return _clamp_unit(previous + (product - previous) * alpha)


def analog_schmitt(x: float, last: float, hysteresis: float = 0.08) -> float:
    band = max(0.01, min(0.45, hysteresis))
    value = _clamp_unit(x)
    if last >= 0:
        return 1.0 if value > -band else -1.0
    return -1.0 if value < band else 1.0


def analog_jack(circuit: dict[str, float], reconstruct: float, drive: float) -> float:
    d = _clamp01(drive)
    return _clamp_unit(
        circuit["intg"] * 0.55
        + circuit["mul"] * 0.22 * d
        + circuit["corr"] * 0.12 * d
        + _clamp_unit(reconstruct) * 0.22 * d
    )


def _nemo_step(source: dict[str, Any], dt: float, chaos: float, drive: float) -> dict[str, Any]:
    c = _clamp01(chaos)
    pots = nexus_coefficients(c, "nemo")
    adaptive_coupling = float(pots["mu"])
    chemical_weight = float(pots["delta"])
    synaptic_tau = max(1.4, float(pots["gamma"]))
    injected_current = 2.2 + drive * 10.5
    resting_potential = -65.0
    threshold = -52 + c * 6
    slope_factor = 2.0
    leak_conductance = 0.12
    adaptation_tau = max(8.0, 42 - c * 28)
    reset_potential = -58 + c * 8
    adaptation_jump = 4 + c * 10
    peak_potential = 20.0
    modulator = _clamp01(drive)
    bank = pad_nemo_bank(source.get("bank"))
    rate = max(0.0, min(1.0, float(source.get("z", 0))))
    time_value = float(source.get("t", 0))
    total_ms = max(0.25, min(80.0, dt * 1_000))
    sub_steps = max(4, min(48, math.ceil(total_ms / 0.5)))
    h = total_ms / sub_steps

    for _ in range(sub_steps):
        currents = [0.0] * 5
        optical_inputs = [0.0] * 5
        time_ms = time_value * 1_000
        pacemaker_period = 170 + (1 - modulator) * 260
        pacemaker_current = modulator * (
            1.6 + 3.8 * (0.5 + 0.5 * math.sin((time_ms * math.pi * 2) / pacemaker_period))
        )
        willay_field = 0.0
        for index in range(5):
            opposite = (index + 2) % 5
            previous = (index + 4) % 5
            object_amplitude = max(0.0, (bank[index] + 70) / 110)
            reference_amplitude = max(0.0, (bank[opposite] + 70) / 110)
            optical_inputs[index] = optical_interfere(
                object_amplitude,
                bank[index] * 0.035,
                reference_amplitude,
                bank[opposite] * 0.035,
            )
            willay_field += optical_reconstruct(
                optical_inputs[index], (bank[index] - bank[opposite]) * 0.035
            )
            traveling_wave = 0.72 * max(
                0.0, (bank[previous] - resting_potential) / 40
            )
            optical_weight = max(0.05, min(4.0, bank[15 + index]))
            current = (
                bank[10 + index]
                + optical_inputs[index] * (1.1 + drive * 0.9) * optical_weight
                + traveling_wave
            )
            if index == 0:
                current += injected_current
            elif index == 1:
                current += 0.8 + drive * 2.4 + pacemaker_current
            else:
                current += 0.8 + drive * 2.4
            if index == 3:
                current += 0.45 * optical_inputs[index]
            currents[index] = current

        willay_field /= 5
        gate = 0.35 + 0.65 * (0.5 + 0.5 * willay_field)
        fired: list[int] = []
        for index in range(5):
            membrane = bank[index]
            recovery = bank[5 + index]
            synaptic_trace = bank[10 + index]
            exponent = max(-20.0, min(8.0, (membrane - threshold) / slope_factor))
            membrane_delta = (
                -leak_conductance * (membrane - resting_potential)
                + leak_conductance * slope_factor * math.exp(exponent)
                - recovery
                + currents[index]
            )
            recovery_delta = (
                adaptive_coupling * (membrane - resting_potential) - recovery
            ) / adaptation_tau
            membrane += membrane_delta * h
            recovery += recovery_delta * h
            if index == 4:
                membrane += (resting_potential - membrane) * (h / 420)
            synaptic_trace += (-synaptic_trace / synaptic_tau) * h
            if membrane >= peak_potential:
                membrane = reset_potential
                recovery += adaptation_jump
                fired.append(index)
            bank[index] = max(-90.0, min(40.0, membrane))
            bank[5 + index] = max(-40.0, min(80.0, recovery))
            bank[10 + index] = max(0.0, min(48.0, synaptic_trace))

        for index in fired:
            post = (index + 1) % 5
            opposite = (index + 2) % 5
            availability = 1 - min(1.0, bank[10 + post] / 48)
            jump = chemical_weight * availability * (0.55 + 0.45 * gate)
            bank[10 + post] = min(48.0, bank[10 + post] + jump)
            nervous_weight = 1.35 if index == 3 else 1.0
            bank[15 + index] = (
                bank[15 + index]
                + 0.018
                * (bank[10 + opposite] / 48)
                * optical_inputs[index]
                * modulator
                * gate
                * nervous_weight
            )
            bank[15 + opposite] -= 0.006

        for index in range(5):
            current = bank[15 + index]
            leaked = current + (1 - current) * (h / 180)
            bank[15 + index] = max(0.05, min(4.0, leaked))

        decay = math.exp(-h / 38)
        rate = rate * decay + (len(fired) / 5) * (1 - decay) * 10
        rate = min(1.0, rate)
        time_value += h * 0.001
        if not math.isfinite(bank[0]) or not math.isfinite(rate) or not math.isfinite(time_value):
            raise NexusValidationError(
                "NON_FINITE_OUTPUT", "simulation produced a non-finite value"
            )

    return {"x": bank[0], "y": bank[2], "z": rate, "t": time_value, "bank": bank}


def step_nexus_state(
    program: str,
    source: dict[str, Any],
    dt: float,
    chaos: float,
    drive: float = 0.5,
) -> dict[str, Any]:
    if program == "nemo":
        return _nemo_step(source, dt, chaos, drive)
    pots = nexus_coefficients(chaos, program)
    sub_steps = 4
    h = max(0.0004, min(0.08, dt)) / sub_steps
    x, y, z, time_value = (
        float(source["x"]),
        float(source["y"]),
        float(source["z"]),
        float(source["t"]),
    )
    for _ in range(sub_steps):
        dx = dy = dz = 0.0
        if program == "harmonic":
            omega_squared = float(pots["omega"]) ** 2
            dx, dy = y, -omega_squared * x
        elif program == "vanderpol":
            dx = y
            dy = float(pots["mu"]) * (1 - x * x) * y - x
        elif program == "duffing":
            force = float(pots["gamma"]) * (0.45 + drive * 0.7) * math.cos(
                float(pots["omega"]) * time_value
            )
            dx = y
            dy = x - x * x * x - float(pots["delta"]) * y + force
        elif program == "lotka":
            prey = max(0.02, x)
            predator = max(0.02, y)
            dx = float(pots["alpha"]) * prey - float(pots["beta"]) * prey * predator
            dy = float(pots["delta"]) * prey * predator - float(pots["gamma"]) * predator
        else:
            dx = float(pots["sigma"]) * (y - x)
            dy = x * (float(pots["rho"]) - z) - y
            dz = x * y - float(pots["beta"]) * z
        x += dx * h
        y += dy * h
        z += dz * h
        time_value += h
    if program == "lotka":
        x, y = max(0.02, x), max(0.02, y)
    if not all(math.isfinite(value) for value in (x, y, z, time_value)):
        raise NexusValidationError(
            "NON_FINITE_OUTPUT", "simulation produced a non-finite value"
        )
    return {"x": x, "y": y, "z": z, "t": time_value}


def scale_nexus_state(program: str, state: dict[str, Any]) -> dict[str, float]:
    x, y, z, time_value = (
        float(state["x"]),
        float(state["y"]),
        float(state["z"]),
        float(state["t"]),
    )
    if program == "harmonic":
        energy = 0.5 * (y * y + x * x)
        return {
            "x": max(-1.0, min(1.0, x)),
            "y": max(-1.0, min(1.0, y / 3)),
            "z": max(0.0, min(1.0, energy * 0.5)),
        }
    if program == "vanderpol":
        return {
            "x": max(-1.0, min(1.0, x / 2.4)),
            "y": max(-1.0, min(1.0, y / 3.2)),
            "z": max(0.0, min(1.0, (x * x + y * y) / 10)),
        }
    if program == "duffing":
        return {
            "x": max(-1.0, min(1.0, x / 2)),
            "y": max(-1.0, min(1.0, y / 2.4)),
            "z": max(0.0, min(1.0, 0.5 + 0.5 * math.sin(time_value))),
        }
    if program == "lotka":
        return {
            "x": max(-1.0, min(1.0, (x - 1.4) / 1.8)),
            "y": max(-1.0, min(1.0, (y - 1.1) / 1.6)),
            "z": max(0.0, min(1.0, (x + y) / 6)),
        }
    if program == "nemo":
        return {
            "x": max(-1.0, min(1.0, (x + 45) / 40)),
            "y": max(-1.0, min(1.0, (y + 45) / 40)),
            "z": max(0.0, min(1.0, z)),
        }
    return {
        "x": max(-1.0, min(1.0, x / 24)),
        "y": max(-1.0, min(1.0, y / 24)),
        "z": max(0.0, min(1.0, z / 48)),
    }


def _optical_field(program: str, state: dict[str, Any]) -> list[list[float]]:
    scaled = scale_nexus_state(program, state)
    field: list[list[float]] = []
    for row in range(FIELD_ROWS):
        values: list[float] = []
        for column in range(FIELD_COLS):
            object_amplitude = 0.35 + 0.45 * scaled["z"]
            reference_amplitude = 0.4 + 0.35 * abs(scaled["x"])
            object_phase = (
                (column / FIELD_COLS) * math.tau
                + scaled["y"] * 1.4
                + float(state["t"]) * 0.7
            )
            reference_phase = (row / FIELD_ROWS) * math.tau + scaled["z"] * 2.2
            values.append(
                _round_finite(
                    optical_interfere(
                        object_amplitude,
                        object_phase,
                        reference_amplitude,
                        reference_phase,
                    )
                )
            )
        field.append(values)
    return field


def lambda_aggregate(axes: list[float] | None = None) -> dict[str, Any]:
    if axes is None:
        return {"value": None, "blocked": True, "label": "UNAVAILABLE"}
    if not axes or any(not math.isfinite(axis) or axis < 0 or axis > 1 for axis in axes):
        return {"value": 0.0, "blocked": True, "label": "MODELED_FROM_CALLER_AXES"}
    if any(axis == 0 for axis in axes):
        return {"value": 0.0, "blocked": True, "label": "MODELED_FROM_CALLER_AXES"}
    weight = 1 / len(axes)
    raw = math.exp(sum(weight * math.log(axis) for axis in axes))
    return {
        "value": min(TRUST_CEILING, raw),
        "blocked": False,
        "label": "MODELED_FROM_CALLER_AXES",
    }


def ouroboros_tax(amplitude: float, bars: int = 8) -> float:
    bounded_bars = max(1, min(64, int(bars)))
    return max(0.0, amplitude * math.exp(-bounded_bars / 8))


def _rounded_state(state: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "x": _round_finite(float(state["x"])),
        "y": _round_finite(float(state["y"])),
        "z": _round_finite(float(state["z"])),
        "t": _round_finite(float(state["t"])),
    }
    if "bank" in state:
        out["bank"] = [_round_finite(float(value)) for value in state["bank"]]
    return out


def _canonical_number(value: float) -> str:
    safe = 0.0 if value == 0 else value
    return f"{safe:.9f}"


def _canonicalize_for_parity(value: Any) -> Any:
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return _canonical_number(float(value))
    if isinstance(value, list):
        return [_canonicalize_for_parity(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _canonicalize_for_parity(value[key])
            for key in sorted(value)
        }
    return value


def nexus_hash(value: Any) -> str:
    payload = json.dumps(
        _canonicalize_for_parity(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def nexus_input_hash(input_payload: dict[str, Any]) -> str:
    return nexus_hash(
        {
            "schema": NEXUS_ENGINE_SCHEMA,
            "source": NEXUS_SOURCE_REVISION,
            "input": input_payload,
        }
    )


def _sample_trail(
    program: str,
    initial: dict[str, Any],
    input_payload: dict[str, Any],
) -> tuple[dict[str, Any], list[list[float]], int, int]:
    if input_payload["mode"] == "IC":
        return seed_nexus_state(program, input_payload["seed"]), [], 0, 0
    if input_payload["mode"] == "HALT":
        return _clone_state(initial), [], 0, 0
    state = _clone_state(initial)
    trail: list[list[float]] = []
    stride = max(1, math.ceil(max(1, input_payload["steps"]) / MAX_TRAIL_POINTS))
    repeat_count = 0
    for step in range(input_payload["steps"]):
        if (
            input_payload["mode"] == "REP"
            and step > 0
            and step % input_payload["repeatEvery"] == 0
        ):
            repeat_count += 1
            state = seed_nexus_state(
                program, (input_payload["seed"] + repeat_count * 0.137) % 1
            )
        state = step_nexus_state(
            program,
            state,
            input_payload["dt"],
            input_payload["chaos"],
            input_payload["drive"],
        )
        if step % stride == 0 or step == input_payload["steps"] - 1:
            trail.append(
                [
                    _round_finite(state["x"]),
                    _round_finite(state["y"]),
                    _round_finite(state["z"]),
                ]
            )
    return state, trail, input_payload["steps"], repeat_count


def run_nexus(payload: Any) -> dict[str, Any]:
    input_payload = normalize_nexus_input(payload)
    seeded = seed_nexus_state(input_payload["program"], input_payload["seed"])
    initial = _clone_state(input_payload.get("state") or seeded)
    simulated, trail, steps_executed, repeat_count = _sample_trail(
        input_payload["program"], initial, input_payload
    )
    final_state = _rounded_state(simulated)
    normalized_raw = scale_nexus_state(input_payload["program"], final_state)
    normalized = {
        "x": _round_finite(normalized_raw["x"]),
        "y": _round_finite(normalized_raw["y"]),
        "z": _round_finite(normalized_raw["z"]),
    }
    object_amplitude = max(0.0, 0.5 + 0.5 * math.hypot(normalized["x"], normalized["y"]))
    reference_amplitude = max(0.0, 0.35 + 0.55 * normalized["z"])
    phase_difference = math.atan2(normalized["y"], normalized["x"] + 1e-9)
    intensity = optical_interfere(
        object_amplitude, phase_difference, reference_amplitude, 0.0
    )
    reconstruct = optical_reconstruct(intensity, phase_difference)
    corr = analog_correlate(normalized["x"], normalized["y"], 0.0, input_payload["dt"])
    circuit_base = analog_circuit(
        normalized["x"], normalized["y"], normalized["z"], corr
    )
    circuit = {key: _round_finite(value) for key, value in circuit_base.items()}
    circuit["jack"] = _round_finite(
        analog_jack(circuit_base, reconstruct, input_payload["drive"])
    )
    lambda_result = lambda_aggregate(input_payload.get("axes"))
    lotka_first_quadrant = (
        final_state["x"] > 0 and final_state["y"] > 0
        if input_payload["program"] == "lotka"
        else None
    )
    nemo_bank_bounded = None
    if input_payload["program"] == "nemo":
        bank = final_state.get("bank") or []
        nemo_bank_bounded = (
            len(bank) == 20
            and all(-90 <= value <= 40 for value in bank[:5])
            and all(-40 <= value <= 80 for value in bank[5:10])
            and all(0 <= value <= 48 for value in bank[10:15])
            and all(0.05 <= value <= 4 for value in bank[15:20])
        )
    finite_state = all(
        math.isfinite(float(value))
        for value in [final_state["x"], final_state["y"], final_state["z"], final_state["t"], *(final_state.get("bank") or [])]
    )
    trail_bounded = len(trail) <= MAX_TRAIL_POINTS + 1
    invariants = {
        "finiteState": finite_state,
        "lotkaFirstQuadrant": lotka_first_quadrant,
        "nemoBankBounded": nemo_bank_bounded,
        "trailBounded": trail_bounded,
        "externalCallsZero": True,
        "executableSoftwareNotHardware": True,
        "allHold": (
            finite_state
            and trail_bounded
            and lotka_first_quadrant is not False
            and nemo_bank_bounded is not False
        ),
    }
    input_hash = nexus_input_hash(input_payload)
    deterministic_output = {
        "schema": NEXUS_PARITY_SCHEMA,
        "sourceRevision": NEXUS_SOURCE_REVISION,
        "program": input_payload["program"],
        "mode": input_payload["mode"],
        "stepsExecuted": steps_executed,
        "repeatCount": repeat_count,
        "finalState": final_state,
        "normalized": normalized,
        "optics": {
            "objectAmplitude": _round_finite(object_amplitude),
            "referenceAmplitude": _round_finite(reference_amplitude),
            "phaseDifference": _round_finite(phase_difference),
            "intensity": _round_finite(intensity),
            "reconstruct": _round_finite(reconstruct),
        },
        "circuit": circuit,
        "lambda": lambda_result,
        "ouroborosTax": _round_finite(ouroboros_tax(abs(reconstruct))),
        "invariants": invariants,
    }
    output_hash = nexus_hash(deterministic_output)
    return {
        "schema": NEXUS_RUN_SCHEMA,
        "source": {
            "repository": NEXUS_SOURCE_REPOSITORY,
            "revision": NEXUS_SOURCE_REVISION,
            "importedFiles": ["src/lib/nexus/math.ts", "server.py"],
            "importedBlobs": NEXUS_SOURCE_BLOBS,
        },
        "execution": {
            "authority": "IMMUNE_SIMULATION_ONLY",
            "truth": "MEASURED_SOFTWARE_SIMULATION",
            "program": input_payload["program"],
            "mode": input_payload["mode"],
            "stepsRequested": input_payload["steps"],
            "stepsExecuted": steps_executed,
            "repeatEvery": input_payload["repeatEvery"],
            "repeatCount": repeat_count,
            "dt": input_payload["dt"],
            "chaos": input_payload["chaos"],
            "drive": input_payload["drive"],
            "externalCalls": 0,
            "externalEffectors": False,
            "arbitraryCode": False,
            "arbitraryUrls": False,
            "energy": "UNAVAILABLE",
            "uniqueness": "Conjecture 1 OPEN",
        },
        "coefficients": nexus_coefficients(input_payload["chaos"], input_payload["program"]),
        "initialState": _rounded_state(initial),
        "finalState": final_state,
        "normalized": normalized,
        "trail": trail,
        "optics": {
            "objectAmplitude": _round_finite(object_amplitude),
            "referenceAmplitude": _round_finite(reference_amplitude),
            "phaseDifference": _round_finite(phase_difference),
            "intensity": _round_finite(intensity),
            "reconstruct": _round_finite(reconstruct),
            "field": _optical_field(input_payload["program"], final_state),
        },
        "circuit": circuit,
        "formulas": {
            "lambda": {
                "value": None
                if lambda_result["value"] is None
                else _round_finite(lambda_result["value"]),
                "blocked": lambda_result["blocked"],
                "label": lambda_result["label"],
                "trustCeiling": TRUST_CEILING,
                "status": "Conjecture 1 OPEN",
            },
            "ouroborosTax": {
                "value": _round_finite(ouroboros_tax(abs(reconstruct))),
                "label": "MODELED",
                "bars": 8,
            },
        },
        "invariants": invariants,
        "inputHash": input_hash,
        "outputHash": output_hash,
    }


def verify_nexus_run(payload: Any, expected_output_hash: str) -> dict[str, Any]:
    if not isinstance(expected_output_hash, str) or len(expected_output_hash) != 64 or any(
        character not in "0123456789abcdefABCDEF" for character in expected_output_hash
    ):
        raise NexusValidationError(
            "INVALID_OUTPUT_HASH", "expectedOutputHash must be a 64-character SHA-256 digest"
        )
    result = run_nexus(payload)
    expected = expected_output_hash.lower()
    return {
        "schema": "szl.immune-nexus-verification/v1",
        "verified": result["outputHash"] == expected,
        "expectedOutputHash": expected,
        "observedOutputHash": result["outputHash"],
        "sourceRevision": NEXUS_SOURCE_REVISION,
        "truth": "DERIVED_REPLAY",
    }


def nexus_status() -> dict[str, Any]:
    return {
        "schema": "szl.immune-nexus-status/v1",
        "state": "EXECUTABLE",
        "role": "IMMUNE_COUNTERFACTUAL_DYNAMICS_PLANE",
        "publicProduct": "IMMUNE",
        "source": {
            "repository": NEXUS_SOURCE_REPOSITORY,
            "revision": NEXUS_SOURCE_REVISION,
            "blobs": NEXUS_SOURCE_BLOBS,
        },
        "programs": list(NEXUS_PROGRAMS),
        "modes": list(NEXUS_MODES),
        "limits": {
            "standardSteps": MAX_STANDARD_STEPS,
            "nemoSteps": MAX_NEMO_STEPS,
            "trailPoints": MAX_TRAIL_POINTS,
            "requestBytes": 1_048_576,
        },
        "controls": {
            "sentraAdmission": True,
            "hukllaEvidence": True,
            "yawarReceipts": True,
            "deterministicReplay": True,
            "arbitraryCode": False,
            "arbitraryUrls": False,
            "networkEgress": False,
            "externalEffectors": False,
            "physicalHardware": False,
        },
        "truth": {
            "execution": "MEASURED_SOFTWARE_SIMULATION",
            "energy": "UNAVAILABLE",
            "uniqueness": "Conjecture 1 OPEN",
        },
        "ui": "/nexus.html",
    }
