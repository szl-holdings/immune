"""Finding #5 (Appendix I) -- CHARACTERIZATION ONLY (passes at base 70754c5a).

Pins the Python side of the 9-decimal Nexus identity projection. The values
differ from the TypeScript ones in tests/immune-nexus-numeric-identity.test.ts
for exact decimal ties and |x| >= 1e21. Not a fix: see SPEC_nexus_numeric_identity.md.
"""

from __future__ import annotations

import unittest

from immune.nexus import nexus_input_hash, normalize_nexus_input, run_nexus

BASE = {"program": "lorenz", "mode": "OP", "steps": 2400, "dt": 0.01, "chaos": 0.45, "drive": 0.7, "seed": 0.2, "repeatEvery": 64}


def at(x: float) -> dict:
    return {**BASE, "state": {"x": x, "y": 1.0, "z": 1.0, "t": 0.0}}


class NexusNumericIdentityCharacterization(unittest.TestCase):
    def test_sub_1e9_change_collides_on_input_hash(self) -> None:
        a = run_nexus(at(1.0))
        b = run_nexus(at(1.0 + 4e-10))
        self.assertEqual(a["inputHash"], "63cc3381556a47c0373a6b0b67b92998810717d85bee0fb2de11b6b6acbca5e2")
        self.assertEqual(b["inputHash"], a["inputHash"])
        self.assertNotEqual(b["outputHash"], a["outputHash"])

    def test_python_side_of_cross_language_divergence(self) -> None:
        self.assertEqual(f"{0.0009765625:.9f}", "0.000976562")
        tie = {**BASE, "steps": 400, "dt": 0.0009765625}
        self.assertEqual(run_nexus(tie)["inputHash"], "a7a23ec08a5de8e615a012775cc7ff7a56ae68359bc7c75d00236c0295311103")
        big = {**BASE, "mode": "HALT", "state": {"x": 1e21, "y": 1.0, "z": 1.0, "t": 0.0}}
        self.assertEqual(
            nexus_input_hash(normalize_nexus_input(big)),
            "469d7905bf85814e62124f8b8eb3902c764aaac5794836d14f5eca296a74ec5b",
        )


if __name__ == "__main__":
    unittest.main()
