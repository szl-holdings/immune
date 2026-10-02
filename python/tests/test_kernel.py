"""IMMUNE Python kernel — aligned with src/lib/immune."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


class KernelTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._environment = patch.dict(
            os.environ,
            {
                "IMMUNE_DATA_DIR": self._tmp.name,
                "IMMUNE_SIGNING_KEY": "",
            },
        )
        self._environment.start()
        import immune.runtime as runtime_mod

        runtime_mod._RUNTIME = None

    def tearDown(self) -> None:
        import immune.runtime as runtime_mod

        runtime_mod._RUNTIME = None
        self._environment.stop()
        self._tmp.cleanup()

    def _http_json(
        self, path: str, *, method: str = "GET", body=None
    ) -> tuple[int, dict]:
        from immune.server import Handler

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = Request(
                f"http://127.0.0.1:{server.server_address[1]}{path}",
                data=json.dumps(body or {}).encode() if method != "GET" else None,
                headers={"Content-Type": "application/json"},
                method=method,
            )
            try:
                with urlopen(request, timeout=5) as response:
                    return response.status, json.loads(response.read())
            except HTTPError as exc:
                return exc.code, json.loads(exc.read())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_canonical_stable(self) -> None:
        from immune.canonical import hash_canonical

        a, _ = hash_canonical({"b": 1, "a": 2})
        b, _ = hash_canonical({"a": 2, "b": 1})
        self.assertEqual(a, b)
        self.assertEqual(len(a), 64)

    def test_sentra_blocks_people(self) -> None:
        from immune.sentra import sentra_inspect

        blocked = sentra_inspect(
            {"actor": "x", "intent": "hack people in production"}, "PASS"
        )
        self.assertFalse(blocked["accepted"])
        self.assertEqual(blocked["signatureMatched"], "no.hack.persons")
        ok = sentra_inspect(
            {"actor": "immune:live-operator", "intent": "observe inbound radar"}, "PASS"
        )
        self.assertTrue(ok["accepted"])

    def test_boot_is_read_only_without_external_authority(self) -> None:
        from immune.runtime import get_runtime

        rt = get_runtime()
        ready = rt.readiness()
        self.assertFalse(ready["write_ready"])
        self.assertFalse(ready["live_operator"])
        self.assertTrue(ready["external_operator"])
        self.assertFalse(ready["demo_operator"])
        self.assertEqual(rt.snapshot()["evidenceState"], "UNAVAILABLE")
        self.assertEqual(rt.snapshot()["mode"], "SENTRA_REJECT")
        self.assertEqual(rt.ledger_count(), 0)
        self.assertTrue(rt.verify_ledger()["ok"])
        self.assertIn("RECEIPT_LEDGER_EMPTY", ready["blockers"])
        self.assertNotIn("RECEIPT_LEDGER_INTEGRITY_FAILED", ready["blockers"])

    def test_corrupt_persisted_ledger_is_not_reported_as_empty(self) -> None:
        from immune.runtime import ImmuneRuntime

        bundle_path = Path(self._tmp.name) / "runtime.json"
        for body in ('{"ledger":', '{"ledger": {}, "evidence": []}'):
            with self.subTest(body=body):
                bundle_path.write_text(body, encoding="utf-8")
                runtime = ImmuneRuntime()
                runtime.boot()
                report = runtime.verify_ledger()
                ready = runtime.readiness()
                self.assertFalse(report["ok"])
                self.assertEqual(report["issues"][0]["kind"], "load_failure")
                self.assertIn("RECEIPT_LEDGER_INTEGRITY_FAILED", ready["blockers"])
                self.assertNotIn("RECEIPT_LEDGER_EMPTY", ready["blockers"])
                self.assertFalse(ready["runtime_ready"])
                self.assertFalse(ready["write_ready"])

    def test_cycle_and_local_mode_controls_fail_closed(self) -> None:
        from immune.runtime import get_runtime

        rt = get_runtime()
        refused = rt.run_cycle("immune:live-operator", "observe lattice heartbeat")
        self.assertFalse(refused["pass"])
        self.assertIsNone(refused["receipt"])
        self.assertFalse(refused["deadman"])
        with self.assertRaises(PermissionError):
            rt.set_mode("DEADMAN", "T07")
        with self.assertRaises(PermissionError):
            rt.reset()
        self.assertEqual(rt.snapshot()["mode"], "SENTRA_REJECT")
        self.assertFalse(rt.readiness()["write_ready"])

    def test_http_liveness_is_separate_from_fail_closed_readiness(self) -> None:
        from immune.runtime import get_runtime

        runtime = get_runtime()
        health_code, health = self._http_json("/healthz")
        self.assertEqual(health_code, 200)
        self.assertTrue(health["ok"])
        self.assertEqual(health["status"], "LIVE")
        self.assertEqual(health["readiness_endpoint"], "/readyz")
        self.assertNotIn("authority", health)

        ready_code, ready = self._http_json("/readyz")
        self.assertEqual(ready_code, 503)
        self.assertFalse(ready["ok"])
        self.assertFalse(ready["write_ready"])
        self.assertFalse(ready["authority"]["enabled"])
        self.assertFalse(ready["authority"]["live_operator"])
        self.assertFalse(ready["authority"]["demo_operator"])
        self.assertTrue(ready["authority"]["external_operator"])
        self.assertIsNone(ready["authority"]["key_id"])
        self.assertIn("RECEIPT_LEDGER_EMPTY", ready["blockers"])
        self.assertNotIn("RECEIPT_LEDGER_INTEGRITY_FAILED", ready["blockers"])
        if runtime.key_id is not None:
            self.assertNotIn(runtime.key_id, json.dumps(ready))

    def test_malformed_persisted_bundles_are_integrity_failures(self) -> None:
        import immune.runtime as runtime_mod

        path = Path(self._tmp.name) / "runtime.json"
        for raw in (
            b'{"ledger":',
            b'null',
            b'[]',
            b'{"ledger":{},"evidence":[]}',
            b'{"ledger":null,"evidence":[]}',
            b'{"ledger":[null],"evidence":[]}',
            b'{"ledger":[{}],"evidence":[]}',
            b'{}',
        ):
            with self.subTest(persisted_bytes=raw):
                path.write_bytes(raw)
                runtime_mod._RUNTIME = None
                health_code, health = self._http_json("/healthz")
                ready_code, ready = self._http_json("/readyz")
                self.assertEqual(health_code, 200)
                self.assertTrue(health["ok"])
                self.assertEqual(ready_code, 503)
                self.assertFalse(ready["ledger"]["ok"])
                self.assertFalse(ready["runtime_ready"])
                self.assertFalse(ready["write_ready"])
                self.assertFalse(ready["authority"]["enabled"])
                self.assertIn("RECEIPT_LEDGER_INTEGRITY_FAILED", ready["blockers"])
                self.assertNotIn("RECEIPT_LEDGER_EMPTY", ready["blockers"])
                with self.assertRaisesRegex(RuntimeError, "RUNTIME_BUNDLE_RESTORE_FAILED"):
                    runtime_mod.get_runtime().run_cycle("immune:live-operator", "observe lattice heartbeat")
                self.assertEqual(path.read_bytes(), raw)

    def test_valid_persisted_empty_ledger_retains_bootstrap_diagnostic(self) -> None:
        import immune.runtime as runtime_mod

        path = Path(self._tmp.name) / "runtime.json"
        path.write_text('{"ledger":[],"evidence":[]}', encoding="utf-8")
        runtime_mod._RUNTIME = None
        code, ready = self._http_json("/readyz")
        self.assertEqual(code, 503)
        self.assertTrue(ready["ledger"]["ok"])
        self.assertEqual(ready["ledger"]["count"], 0)
        self.assertIn("RECEIPT_LEDGER_EMPTY", ready["blockers"])
        self.assertNotIn("RECEIPT_LEDGER_INTEGRITY_FAILED", ready["blockers"])
        self.assertFalse(ready["write_ready"])

    def test_http_readiness_requires_authority_and_ledger_integrity(self) -> None:
        from immune.runtime import get_runtime

        runtime = get_runtime()
        runtime.append_receipt({"actor": "test", "intent": "local receipt only"})
        ready_code, ready = self._http_json("/readyz")
        self.assertEqual(ready_code, 503)
        self.assertTrue(ready["runtime_ready"])
        self.assertFalse(ready["authority_ready"])
        self.assertFalse(ready["write_ready"])
        self.assertTrue(ready["ledger"]["ok"])

        runtime.ledger[0]["payload"]["intent"] = "tampered"
        failed_code, failed = self._http_json("/readyz")
        self.assertEqual(failed_code, 503)
        self.assertFalse(failed["ok"])
        self.assertFalse(failed["runtime_ready"])
        self.assertFalse(failed["write_ready"])
        self.assertFalse(failed["ledger"]["ok"])
        self.assertIn("RECEIPT_LEDGER_INTEGRITY_FAILED", failed["blockers"])
        self.assertNotIn("RECEIPT_LEDGER_EMPTY", failed["blockers"])

    def test_http_contradictory_ready_flag_cannot_bypass_authority(self) -> None:
        class ContradictoryRuntime:
            def readiness(self) -> dict:
                return {
                    "status": "READY",
                    "ready": True,
                    "runtime_ready": True,
                    "read_ready": True,
                    "authority_ready": True,
                    "write_ready": True,
                    "blockers": [],
                    "live_operator": True,
                    "demo_operator": True,
                    "external_operator": True,
                }

            def snapshot(self) -> dict:
                return {
                    "evidenceState": "UNAVAILABLE",
                    "authorityReceiptCount": 0,
                    "authorityReceiptHash": None,
                    "authority": {
                        "enabled": False,
                        "version": "immune.action.v2",
                        "keyId": None,
                        "audience": "hf-space:SZLHOLDINGS/immune",
                        "source": {
                            "repository": "szl-holdings/immune",
                            "revision": None,
                        },
                    },
                }

            def verify_ledger(self) -> dict:
                return {"ok": True, "count": 1, "issues": [], "firstBadSeq": None}

        with patch("immune.server.get_runtime", return_value=ContradictoryRuntime()):
            code, body = self._http_json("/readyz")
        self.assertEqual(code, 503)
        self.assertFalse(body["ok"])
        self.assertFalse(body["ready"])
        self.assertFalse(body["authority_ready"])
        self.assertFalse(body["write_ready"])
        self.assertFalse(body["authority"]["enabled"])
        self.assertFalse(body["authority"]["live_operator"])
        self.assertFalse(body["authority"]["demo_operator"])

    def test_http_mode_and_reset_are_disabled(self) -> None:
        for path in ("/api/immune/mode", "/api/immune/reset"):
            code, body = self._http_json(path, method="POST")
            self.assertEqual(code, 503)
            self.assertFalse(body["ok"])
            self.assertFalse(body["write_ready"])
            self.assertEqual(body["error"], "EXTERNAL_ACTION_REQUIRED")

    def test_http_readiness_exception_is_503_but_health_stays_live(self) -> None:
        with patch("immune.server.get_runtime", side_effect=RuntimeError("boom")):
            health_code, health = self._http_json("/healthz")
            ready_code, ready = self._http_json("/readyz")
        self.assertEqual(health_code, 200)
        self.assertTrue(health["ok"])
        self.assertEqual(ready_code, 503)
        self.assertFalse(ready["ok"])
        self.assertEqual(ready["blockers"], ["RUNTIME_EXCEPTION"])
        self.assertFalse(ready["authority"]["live_operator"])

    def test_static_hud_has_no_local_authority_claim_or_reset(self) -> None:
        html = (ROOT / "space" / "index.html").read_text(encoding="utf-8")
        folded = html.casefold()
        self.assertNotIn("reset pass", folded)
        self.assertNotIn("live operator", folded)
        self.assertNotIn("write-ready", folded)
        self.assertNotIn('id="reset"', folded)
        self.assertNotIn('$("reset")', folded)
        self.assertIn('id="cycle" disabled', folded)
        self.assertIn('statusjson("/readyz")', folded)
        self.assertIn("external v2 authority required", folded)

    def test_channel_b_never_generates_or_reads_a_private_key_file(self) -> None:
        from immune.persist import load_receipt_key

        marker = Path(self._tmp.name) / "operator.json"
        marker.write_text(
            "preserve legacy private material without reading", encoding="utf-8"
        )
        before = marker.read_bytes()
        with patch.dict(os.environ, {"IMMUNE_SIGNING_KEY": ""}):
            keys = load_receipt_key()
        self.assertIsNone(keys["privateKey"])
        self.assertEqual(marker.read_bytes(), before)
        self.assertEqual(
            [p.name for p in Path(self._tmp.name).iterdir()], ["operator.json"]
        )
        source = (ROOT / "immune" / "persist.py").read_text(encoding="utf-8")
        self.assertNotIn("Ed25519PrivateKey.generate", source)
        self.assertNotIn('"operator.json"', source)
        self.assertNotIn(".private_bytes(", source)

    def test_optional_receipt_secret_does_not_enable_action_authority(self) -> None:
        import base64
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import (
            Encoding,
            NoEncryption,
            PrivateFormat,
        )
        from immune.runtime import ImmuneRuntime

        ephemeral = Ed25519PrivateKey.generate()
        seed = ephemeral.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
        with patch.dict(
            os.environ, {"IMMUNE_SIGNING_KEY": base64.b64encode(seed).decode()}
        ):
            runtime = ImmuneRuntime()
        runtime.boot()
        receipt = runtime.append_receipt({"actor": "test", "intent": "receipt-only"})
        self.assertEqual(receipt["alg"], "ed25519")
        self.assertIsNone(runtime.snapshot()["authority"]["keyId"])
        self.assertFalse(runtime.readiness()["write_ready"])
        self.assertFalse((Path(self._tmp.name) / "receipt-signer.json").exists())

    def test_invalid_receipt_secret_never_creates_replacement_identity(self) -> None:
        from immune.persist import load_receipt_key

        for malformed in ("not-base64!", "eA==", "", " "):
            with self.subTest(value=malformed):
                with patch.dict(os.environ, {"IMMUNE_SIGNING_KEY": malformed}):
                    keys = load_receipt_key()
                self.assertIsNone(keys["privateKey"])
                self.assertIsNone(keys["keyId"])
        self.assertEqual(list(Path(self._tmp.name).iterdir()), [])

    def test_legacy_receipts_survive_but_legacy_pass_is_not_restored(self) -> None:
        from immune.runtime import ImmuneRuntime

        with patch.dict(os.environ, {"IMMUNE_SIGNING_KEY": ""}):
            runtime = ImmuneRuntime()
        receipt = runtime.append_receipt({"actor": "legacy", "intent": "history"})
        bundle_path = Path(self._tmp.name) / "runtime.json"
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        bundle.update(
            {
                "keyId": "legacy-key",
                "state": {"mode": "PASS"},
                "authorityReceipts": [{"mode": "PASS"}],
            }
        )
        bundle_path.write_text(json.dumps(bundle), encoding="utf-8")
        recovered = ImmuneRuntime()
        recovered.boot()
        self.assertEqual(recovered.latest(), [receipt])
        self.assertEqual(recovered.snapshot()["mode"], "SENTRA_REJECT")
        self.assertEqual(recovered.authority_receipts, [])

    def test_nexus_execution_is_refused_before_computation(self) -> None:
        from immune.runtime import get_runtime

        runtime = get_runtime()
        with patch("immune.server.run_nexus") as computation:
            code, body = self._http_json(
                "/api/immune/nexus/run",
                method="POST",
                body={
                    "actor": "test",
                    "requestId": "test-readonly-0001",
                    "program": "lorenz",
                    "mode": "OP",
                    "steps": 8,
                    "dt": 0.01,
                    "chaos": 0.45,
                    "drive": 0.92,
                    "seed": 0.2,
                    "repeatEvery": 64,
                },
            )
        self.assertEqual(code, 503)
        self.assertEqual(body["reason"], "EXTERNAL_ACTION_REQUIRED")
        self.assertFalse(body["computationPerformed"])
        computation.assert_not_called()
        self.assertEqual(runtime.ledger_count(), 0)

    def test_nexus_catalog_verify_and_history_remain_available(self) -> None:
        from immune.nexus import run_nexus
        from immune.runtime import get_runtime
        from immune.server import _compact_nexus_receipt

        request = {
            "program": "lorenz",
            "mode": "OP",
            "steps": 8,
            "dt": 0.01,
            "chaos": 0.45,
            "drive": 0.92,
            "seed": 0.2,
            "repeatEvery": 64,
        }
        result = run_nexus(request)
        code, catalog = self._http_json("/api/immune/nexus/catalog")
        self.assertEqual(code, 200)
        self.assertEqual(len(catalog["programs"]), 6)
        code, proof = self._http_json(
            "/api/immune/nexus/verify",
            method="POST",
            body={**request, "expectedOutputHash": result["outputHash"]},
        )
        self.assertEqual(code, 200)
        self.assertTrue(proof["verified"])
        runtime = get_runtime()
        self.assertEqual(runtime.ledger_count(), 0)
        nexus = _compact_nexus_receipt("test-history-0001", result)
        receipt = runtime.append_receipt(
            {"actor": "test", "agentJson": json.dumps({"nexus": nexus})}
        )
        code, stored = self._http_json("/api/immune/nexus/receipts/test-history-0001")
        self.assertEqual(code, 200)
        self.assertEqual(stored["receipt"], receipt)
        self.assertEqual(stored["nexus"], nexus)
        self.assertFalse(runtime.readiness()["write_ready"])

    def test_mesh_missing_surfaces_are_unavailable(self) -> None:
        from immune.mesh import mesh_from_surfaces

        mesh = mesh_from_surfaces([])
        self.assertFalse(mesh["reached"])
        self.assertEqual(mesh["liveCount"], 0)
        self.assertEqual(mesh["provenance"], "UNAVAILABLE")
        self.assertTrue(all(not vote["live"] for vote in mesh["votes"]))
        self.assertTrue(all(vote["stage"] == "UNAVAILABLE" for vote in mesh["votes"]))
        self.assertTrue(
            all(vote["provenance"] == "UNAVAILABLE" for vote in mesh["votes"])
        )

    def test_mesh_unavailable_immune_is_not_inflated(self) -> None:
        from immune.mesh import mesh_from_surfaces

        mesh = mesh_from_surfaces(
            [
                {
                    "id": "immune",
                    "title": "IMMUNE",
                    "stage": "UNAVAILABLE",
                    "provenance": "UNAVAILABLE",
                    "detail": "no independent observation",
                }
            ]
        )
        immune = next(vote for vote in mesh["votes"] if vote["id"] == "immune")
        self.assertFalse(immune["live"])
        self.assertEqual(immune["stage"], "UNAVAILABLE")
        self.assertEqual(immune["provenance"], "UNAVAILABLE")
        self.assertEqual(mesh["liveCount"], 0)
        self.assertFalse(mesh["reached"])

    def test_mesh_three_independently_live_non_immune_surfaces_reach_quorum(
        self,
    ) -> None:
        from immune.mesh import mesh_from_surfaces

        surfaces = [
            {
                "id": "a11oy",
                "title": "a11oy",
                "stage": "LIVE",
                "provenance": "LIVE",
                "href": "",
                "detail": "",
            },
            {
                "id": "killinchu",
                "title": "killinchu",
                "stage": "LIVE",
                "provenance": "LIVE",
                "href": "",
                "detail": "",
            },
            {
                "id": "khipu",
                "title": "khipu",
                "stage": "TRAINED",
                "provenance": "LIVE",
                "href": "",
                "detail": "",
            },
        ]
        mesh = mesh_from_surfaces(surfaces)
        self.assertTrue(mesh["reached"])
        self.assertEqual(mesh["liveCount"], 3)
        self.assertEqual(mesh["provenance"], "LIVE")
        immune = next(vote for vote in mesh["votes"] if vote["id"] == "immune")
        self.assertFalse(immune["live"])
        self.assertEqual(immune["stage"], "UNAVAILABLE")

    def test_brain_and_silhouette(self) -> None:
        from immune.second_brain import (
            brain_status,
            get_chunks,
            search_brain,
            train_silhouette,
        )

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

    def test_organs_are_live_but_not_write_ready(self) -> None:
        from immune.organs import dashboard, local_organ_mesh
        from immune.runtime import get_runtime

        get_runtime()
        mesh = local_organ_mesh()
        self.assertEqual(len(mesh["organs"]), 5)
        self.assertTrue(all(o["provenance"] == "LIVE" for o in mesh["organs"]))
        self.assertFalse(mesh["yawar"]["writeReady"])
        self.assertEqual(mesh["yawar"]["keyPurpose"], "RECEIPT_SIGNING_ONLY")
        self.assertTrue(mesh["secondBrain"]["trained"])
        projected = dashboard()
        self.assertFalse(projected["readiness"]["write_ready"])
        self.assertFalse(projected["readiness"]["live_operator"])
        self.assertIsNone(projected["authority"]["authority"]["keyId"])

    def test_organs_never_coerce_nonverified_evidence_to_pass(self) -> None:
        from immune.organs import local_organ_mesh

        class FakeRuntime:
            key_id = "receipt-only"

            def __init__(self, evidence_state: str) -> None:
                self.evidence_state = evidence_state

            def snapshot(self) -> dict:
                return {
                    "mode": "PASS",
                    "evidenceState": self.evidence_state,
                    "revision": 0,
                }

            def readiness(self) -> dict:
                return {"status": "READ_ONLY", "write_ready": False}

            def ledger_count(self) -> int:
                return 0

            def evidence_latest(self, limit: int = 8) -> list:
                del limit
                return []

        for evidence_state in ("UNAVAILABLE", "FAILED", "STALE"):
            with self.subTest(evidence_state=evidence_state):
                with patch(
                    "immune.organs.get_runtime",
                    return_value=FakeRuntime(evidence_state),
                ):
                    mesh = local_organ_mesh()
                yawar = next(
                    organ for organ in mesh["organs"] if organ["id"] == "circulatory"
                )
                self.assertIn(f"mode {evidence_state}", yawar["detail"])
                self.assertNotIn("mode PASS", yawar["detail"])

    def test_tamper_breaks_verify(self) -> None:
        from immune.runtime import get_runtime

        rt = get_runtime()
        rt.append_receipt({"actor": "test", "intent": "seal one"})
        rt.ledger[0]["payload"]["intent"] = "tampered"
        report = rt.verify_ledger()
        self.assertFalse(report["ok"])
        self.assertEqual(report["issues"][0]["kind"], "bad_hash")


if __name__ == "__main__":
    unittest.main()
