from __future__ import annotations

import json
import math
import unittest
from pathlib import Path

from immune.nexus import (
    NEXUS_PROGRAMS,
    NEXUS_SOURCE_REVISION,
    NexusValidationError,
    analog_correlate,
    analog_schmitt,
    optical_interfere,
    run_nexus,
    seed_nexus_state,
    verify_nexus_run,
)


def request(program: str, **overrides):
    payload = {
        "program": program,
        "mode": "OP",
        "steps": 80 if program == "nemo" else 320,
        "dt": 0.002 if program == "nemo" else 0.01,
        "chaos": 0.45,
        "drive": 0.92,
        "seed": 0.2,
        "repeatEvery": 64,
        "axes": [0.97, 0.96, 0.93, 0.91, 0.9, 0.92, 0.88, 0.91],
    }
    payload.update(overrides)
    return payload


PARITY = json.loads((Path(__file__).resolve().parents[2] / "contracts" / "immune-nexus-parity-v1.json").read_text(encoding="utf-8"))


class NexusExecutionTests(unittest.TestCase):
    def test_all_six_programs_execute_bounded(self):
        self.assertEqual(len(NEXUS_PROGRAMS), 6)
        for program in NEXUS_PROGRAMS:
            with self.subTest(program=program):
                result = run_nexus(request(program))
                self.assertEqual(result["source"]["revision"], NEXUS_SOURCE_REVISION)
                self.assertEqual(result["execution"]["program"], program)
                self.assertEqual(result["execution"]["externalCalls"], 0)
                self.assertFalse(result["execution"]["externalEffectors"])
                self.assertFalse(result["execution"]["arbitraryCode"])
                self.assertFalse(result["execution"]["arbitraryUrls"])
                self.assertEqual(result["execution"]["energy"], "UNAVAILABLE")
                self.assertTrue(result["invariants"]["allHold"])
                self.assertEqual(len(result["inputHash"]), 64)
                self.assertEqual(len(result["outputHash"]), 64)

    def test_python_engine_matches_cross_language_parity_vectors(self):
        vector = PARITY["input"]
        for program in NEXUS_PROGRAMS:
            with self.subTest(program=program):
                result = run_nexus(
                    {
                        "program": program,
                        "mode": vector["mode"],
                        "steps": vector["steps_nemo"] if program == "nemo" else vector["steps_standard"],
                        "dt": vector["dt_nemo"] if program == "nemo" else vector["dt_standard"],
                        "chaos": vector["chaos"],
                        "drive": vector["drive"],
                        "seed": vector["seed"],
                        "repeatEvery": vector["repeatEvery"],
                        "axes": vector["axes"],
                    }
                )
                self.assertEqual(result["outputHash"], PARITY["output_hashes"][program])

    def test_deterministic_output_and_replay(self):
        payload = request("lorenz", steps=128)
        first = run_nexus(payload)
        second = run_nexus(payload)
        self.assertEqual(first["outputHash"], second["outputHash"])
        self.assertEqual(first["finalState"], second["finalState"])
        self.assertTrue(verify_nexus_run(payload, first["outputHash"])["verified"])

    def test_execution_modes(self):
        seed = seed_nexus_state("harmonic", 0.2)
        ic = run_nexus(request("harmonic", mode="IC", steps=100, state=seed))
        halt = run_nexus(request("harmonic", mode="HALT", steps=100, state=seed))
        op = run_nexus(request("harmonic", mode="OP", steps=100, state=seed))
        rep = run_nexus(
            request(
                "harmonic",
                mode="REP",
                steps=130,
                repeatEvery=32,
                state=seed,
            )
        )
        self.assertEqual(ic["execution"]["stepsExecuted"], 0)
        self.assertEqual(halt["execution"]["stepsExecuted"], 0)
        self.assertNotEqual(op["finalState"], seed)
        self.assertGreaterEqual(rep["execution"]["repeatCount"], 4)
        self.assertNotEqual(rep["outputHash"], op["outputHash"])

    def test_nemo_bank_is_bounded(self):
        result = run_nexus(request("nemo", steps=180, dt=0.002, drive=1))
        bank = result["finalState"]["bank"]
        self.assertEqual(len(bank), 20)
        self.assertTrue(result["invariants"]["nemoBankBounded"])
        self.assertTrue(all(0.05 <= value <= 4 for value in bank[15:20]))
        self.assertGreaterEqual(result["finalState"]["z"], 0)
        self.assertLessEqual(result["finalState"]["z"], 1)

    def test_lotka_remains_positive(self):
        result = run_nexus(request("lotka", steps=1_400, dt=0.01))
        self.assertTrue(result["invariants"]["lotkaFirstQuadrant"])
        self.assertGreater(result["finalState"]["x"], 0)
        self.assertGreater(result["finalState"]["y"], 0)

    def test_optical_and_analog_primitives(self):
        self.assertAlmostEqual(optical_interfere(0.6, 0, 0.4, 0), 1)
        self.assertAlmostEqual(optical_interfere(0.6, 0, 0.4, math.pi), 0.04)
        corr = 0.0
        for _ in range(80):
            corr = analog_correlate(0.8, 0.5, corr, 0.02, 0.12)
        self.assertGreater(corr, 0.3)
        self.assertEqual(analog_schmitt(-0.04, 1), 1)
        self.assertEqual(analog_schmitt(-0.2, 1), -1)

    def test_invalid_requests_fail_closed(self):
        with self.assertRaises(NexusValidationError):
            run_nexus(request("lorenz", steps=2_401))
        with self.assertRaises(NexusValidationError):
            run_nexus(
                request(
                    "nemo",
                    state={"x": -65, "y": -70, "z": 0, "t": 0, "bank": [1, 2]},
                )
            )


if __name__ == "__main__":
    unittest.main()
