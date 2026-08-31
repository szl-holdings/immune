"""IMMUNE Python kernel — aligned with src/lib/immune."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class KernelTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["IMMUNE_DATA_DIR"] = self._tmp.name
        import immune.runtime as runtime_mod

        runtime_mod._RUNTIME = None

    def tearDown(self) -> None:
        import immune.runtime as runtime_mod

        runtime_mod._RUNTIME = None
        self._tmp.cleanup()

    def test_canonical_stable(self) -> None:
        from immune.canonical import hash_canonical

        a, _ = hash_canonical({"b": 1, "a": 2})
        b, _ = hash_canonical({"a": 2, "b": 1})
        self.assertEqual(a, b)
        self.assertEqual(len(a), 64)

    def test_sentra_blocks_people(self) -> None:
        from immune.sentra import sentra_inspect

        blocked = sentra_inspect({"actor": "x", "intent": "hack people in production"}, "PASS")
        self.assertFalse(blocked["accepted"])
        self.assertEqual(blocked["signatureMatched"], "no.hack.persons")
        ok = sentra_inspect({"actor": "immune:live-operator", "intent": "observe inbound radar"}, "PASS")
        self.assertTrue(ok["accepted"])

    def test_boot_write_ready(self) -> None:
        from immune.runtime import get_runtime

        rt = get_runtime()
        ready = rt.readiness()
        self.assertTrue(ready["write_ready"])
        self.assertTrue(ready["live_operator"])
        self.assertFalse(ready["demo_operator"])
        self.assertEqual(rt.snapshot()["evidenceState"], "VERIFIED")
        self.assertGreaterEqual(rt.ledger_count(), 1)
        self.assertTrue(rt.verify_ledger()["ok"])

    def test_cycle_seals_and_refuses_deadman(self) -> None:
        from immune.runtime import get_runtime

        rt = get_runtime()
        sealed = rt.run_cycle("immune:live-operator", "observe lattice heartbeat")
        self.assertTrue(sealed["pass"])
        self.assertIsNotNone(sealed["receipt"])
        self.assertEqual(sealed["receipt"]["alg"], "ed25519")
        rt.set_mode("DEADMAN", "T07")
        frozen = rt.run_cycle("immune:live-operator", "should not write")
        self.assertFalse(frozen["pass"])
        self.assertTrue(frozen["deadman"])
        rt.reset()
        self.assertEqual(rt.snapshot()["mode"], "PASS")
        self.assertTrue(rt.readiness()["write_ready"])

    def test_mesh_quorum(self) -> None:
        from immune.mesh import mesh_from_surfaces

        surfaces = [
            {"id": "immune", "title": "IMMUNE", "stage": "WRITE-READY", "provenance": "LIVE", "href": "", "detail": ""},
            {"id": "a11oy", "title": "a11oy", "stage": "LIVE", "provenance": "LIVE", "href": "", "detail": ""},
            {"id": "killinchu", "title": "killinchu", "stage": "LIVE", "provenance": "LIVE", "href": "", "detail": ""},
            {"id": "khipu", "title": "khipu", "stage": "TRAINED", "provenance": "LIVE", "href": "", "detail": ""},
        ]
        mesh = mesh_from_surfaces(surfaces)
        self.assertTrue(mesh["reached"])
        self.assertEqual(mesh["liveCount"], 4)
        self.assertEqual(mesh["provenance"], "LIVE")

    def test_brain_and_silhouette(self) -> None:
        from immune.second_brain import brain_status, get_chunks, search_brain, train_silhouette

        chunks = get_chunks()
        self.assertEqual(len(chunks), 575)
        hits = search_brain("yawar", 6)
        self.assertGreaterEqual(len(hits), 1)
        self.assertTrue(any("yawar" in h["handle"] for h in hits))
        trained = train_silhouette()
        self.assertEqual(trained["kind"], "MEASURED_SOFTWARE_SILHOUETTE")
        self.assertEqual(trained["chunks"], 575)
        self.assertGreaterEqual(trained["accuracy"], 0.8)
        self.assertLess(trained["finalLoss"], trained["initialLoss"])
        self.assertEqual(brain_status()["chunks"], 575)

    def test_frontier_withhold_stale(self) -> None:
        from immune.frontier import evaluate_frontier

        genome = evaluate_frontier(
            {
                "observationId": "t1",
                "subjectKind": "host",
                "subjectId": "range-1",
                "novelty": 0.2,
                "dangerContext": 0.1,
                "baselineAnomaly": 0.1,
                "causalShift": 0.1,
                "propagationRisk": 0.1,
                "hardPolicyViolation": False,
                "sourceAgeMinutes": 400,
                "sourceConfidence": 0.9,
                "calibrationScores": [0.1] * 40,
            }
        )
        self.assertEqual(genome["recommendation"]["state"], "WITHHOLD")
        self.assertFalse(genome["recommendation"]["executable"])
        self.assertEqual(genome["mode"], "shadow")

    def test_organs_live(self) -> None:
        from immune.organs import local_organ_mesh
        from immune.runtime import get_runtime

        get_runtime()
        mesh = local_organ_mesh()
        self.assertEqual(len(mesh["organs"]), 5)
        self.assertTrue(all(o["provenance"] == "LIVE" for o in mesh["organs"]))
        self.assertTrue(mesh["yawar"]["writeReady"])
        self.assertTrue(mesh["secondBrain"]["trained"])

    def test_tamper_breaks_verify(self) -> None:
        from immune.runtime import get_runtime

        rt = get_runtime()
        rt.run_cycle("immune:live-operator", "seal one")
        rt.ledger[0]["payload"]["intent"] = "tampered"
        report = rt.verify_ledger()
        self.assertFalse(report["ok"])
        self.assertEqual(report["issues"][0]["kind"], "bad_hash")


if __name__ == "__main__":
    unittest.main()
