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
                # Hermetic by default: no estate egress from the test suite.
                "IMMUNE_ESTATE_PROBE": "0",
            },
        )
        self._environment.start()
        import immune.organs as organs_mod
        import immune.runtime as runtime_mod

        runtime_mod._RUNTIME = None
        organs_mod.reset_estate_probe_cache()

    def tearDown(self) -> None:
        import time

        import immune.organs as organs_mod
        import immune.runtime as runtime_mod

        runtime_mod._RUNTIME = None
        organs_mod.reset_estate_probe_cache()
        # No probe worker may leak into the next test.
        limit = time.monotonic() + 10
        while organs_mod.outstanding_estate_workers() and time.monotonic() < limit:
            time.sleep(0.01)
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

    def test_declared_bundle_identity_does_not_change_readiness_or_write_on_get(self) -> None:
        declaration = {
            "revision": "a" * 40,
            "evidence_class": "DECLARED",
            "manifest_sha256": "b" * 64,
        }
        with patch("immune.server.bundled_source", return_value=declaration):
            code, ready = self._http_json("/readyz")
        self.assertEqual(code, 503)
        self.assertFalse(ready["ok"])
        self.assertFalse(ready["read_ready"])
        self.assertFalse(ready["write_ready"])
        self.assertIn("ACTION_AUTHORITY_UNAVAILABLE", ready["blockers"])
        self.assertEqual(ready["source"]["revision"], declaration["revision"])
        self.assertEqual(ready["source"]["evidence_class"], "DECLARED")
        with patch.dict(os.environ, {"GITHUB_SHA": "c" * 40,
                                   "SOURCE_REVISION": "c" * 40}):
            unknown_code, unknown = self._http_json("/readyz")
        self.assertEqual(unknown_code, 503)
        self.assertEqual(unknown["source"]["evidence_class"], "UNKNOWN")
        self.assertIsNone(unknown["source"]["revision"])
        self.assertEqual(list(Path(self._tmp.name).iterdir()), [])

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

    def test_hash_corrupt_persisted_ledger_survives_refused_cycle(self) -> None:
        import immune.runtime as runtime_mod

        path = Path(self._tmp.name) / "runtime.json"
        raw = (
            b'{"ledger":[{"seq":1,"ts":"2026-10-02T00:00:00Z",'
            b'"prevHash":"GENESIS","hash":"' + b"0" * 64
            + b'","payload":{"synthetic":true}}],"evidence":[]}'
        )
        path.write_bytes(raw)
        runtime_mod._RUNTIME = None

        code, ready = self._http_json("/readyz")
        self.assertEqual(code, 503)
        self.assertFalse(ready["ledger"]["ok"])
        self.assertEqual(ready["ledger"]["issues"][0]["kind"], "bad_hash")
        self.assertIn("RECEIPT_LEDGER_INTEGRITY_FAILED", ready["blockers"])
        self.assertIn("ACTION_AUTHORITY_UNAVAILABLE", ready["blockers"])
        self.assertFalse(ready["write_ready"])

        runtime = runtime_mod.get_runtime()
        with self.assertRaisesRegex(RuntimeError, "RUNTIME_LEDGER_INTEGRITY_FAILED"):
            runtime.run_cycle("immune:live-operator", "observe lattice heartbeat")
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(runtime.ledger_count(), 1)

    def test_http_cycle_corrupt_ledger_returns_503_without_phantom_evidence(self) -> None:
        import immune.runtime as runtime_mod

        path = Path(self._tmp.name) / "runtime.json"
        raw = (
            b'{"ledger":[{"seq":1,"ts":"2026-10-02T00:00:00Z",'
            b'"prevHash":"GENESIS","hash":"' + b"0" * 64
            + b'","payload":{"synthetic":true}}],"evidence":[]}'
        )
        path.write_bytes(raw)
        runtime_mod._RUNTIME = None

        code, body = self._http_json(
            "/api/immune/cycle", method="POST",
            body={"actor": "immune:test", "intent": "observe synthetic ledger"},
        )
        self.assertEqual(code, 503)
        self.assertEqual(body["error"], "RUNTIME_LEDGER_INTEGRITY_FAILED")
        self.assertFalse(body["write_ready"])
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(runtime_mod.get_runtime().evidence_latest(), [])

    def test_legacy_cycle_routes_return_503_for_corrupt_ledger(self) -> None:
        import immune.runtime as runtime_mod

        path = Path(self._tmp.name) / "runtime.json"
        raw = (
            b'{"ledger":[{"seq":1,"ts":"2026-10-02T00:00:00Z",'
            b'"prevHash":"GENESIS","hash":"' + b"0" * 64
            + b'","payload":{"synthetic":true}}],"evidence":[]}'
        )
        for route, request in (
            ("/api/sentra", {"signal": "observe synthetic ledger"}),
            ("/api/yawar", {"event": "observe synthetic ledger"}),
            ("/api/bind", {"engine": "synthetic"}),
            ("/api/canary", {"id": "synthetic"}),
        ):
            with self.subTest(route=route):
                path.write_bytes(raw)
                runtime_mod._RUNTIME = None
                code, body = self._http_json(route, method="POST", body=request)
                self.assertEqual(code, 503)
                self.assertEqual(body["error"], "RUNTIME_LEDGER_INTEGRITY_FAILED")
                self.assertFalse(body["write_ready"])
                self.assertEqual(path.read_bytes(), raw)
                self.assertEqual(runtime_mod.get_runtime().evidence_latest(), [])

    def test_noncanonical_persisted_receipt_returns_503_without_mutation(self) -> None:
        import immune.runtime as runtime_mod

        path = Path(self._tmp.name) / "runtime.json"
        raw = (
            b'{"ledger":[{"seq":1,"ts":1.5,"prevHash":"GENESIS",'
            b'"hash":"' + b"0" * 64 + b'","payload":{}}],"evidence":[]}'
        )
        path.write_bytes(raw)
        runtime_mod._RUNTIME = None
        code, body = self._http_json(
            "/api/immune/cycle", method="POST",
            body={"actor": "immune:test", "intent": "observe synthetic ledger"},
        )
        self.assertEqual(code, 503)
        self.assertEqual(body["error"], "RUNTIME_LEDGER_INTEGRITY_FAILED")
        self.assertFalse(body["write_ready"])
        ready_code, ready = self._http_json("/readyz")
        self.assertEqual(ready_code, 503)
        self.assertEqual(ready["ledger"]["issues"][0]["kind"], "bad_payload")
        self.assertIn("RECEIPT_LEDGER_INTEGRITY_FAILED", ready["blockers"])
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(runtime_mod.get_runtime().evidence_latest(), [])

    def test_self_hashed_receipts_with_wrong_field_types_fail_integrity(self) -> None:
        import immune.runtime as runtime_mod
        from immune.canonical import hash_canonical

        path = Path(self._tmp.name) / "runtime.json"
        for field, value in (
            ("seq", True),
            ("ts", True),
            ("ts", None),
            ("payload", None),
            ("payload", []),
        ):
            with self.subTest(field=field, value=value):
                receipt = {
                    "seq": 1,
                    "ts": "2026-10-02T00:00:00Z",
                    "prevHash": "GENESIS",
                    "payload": {"synthetic": True},
                }
                receipt[field] = value
                receipt["hash"] = hash_canonical(receipt)[0]
                raw = json.dumps({"ledger": [receipt], "evidence": []}).encode()
                path.write_bytes(raw)
                runtime_mod._RUNTIME = None
                ready_code, ready = self._http_json("/readyz")
                self.assertEqual(ready_code, 503)
                self.assertFalse(ready["ledger"]["ok"])
                self.assertFalse(ready["runtime_ready"])
                self.assertIn("RECEIPT_LEDGER_INTEGRITY_FAILED", ready["blockers"])
                cycle_code, cycle = self._http_json(
                    "/api/immune/cycle", method="POST",
                    body={"actor": "immune:test", "intent": "observe synthetic ledger"},
                )
                self.assertEqual(cycle_code, 503)
                self.assertEqual(cycle["error"], "RUNTIME_LEDGER_INTEGRITY_FAILED")
                self.assertEqual(path.read_bytes(), raw)
                self.assertEqual(runtime_mod.get_runtime().evidence_latest(), [])

    def test_malformed_persisted_evidence_is_preserved_and_unavailable(self) -> None:
        import immune.runtime as runtime_mod

        path = Path(self._tmp.name) / "runtime.json"
        for raw in (
            b'{"ledger":[],"evidence":{}}',
            b'{"ledger":[],"evidence":null}',
            b'{"ledger":[],"evidence":[null]}',
            b'{"ledger":[],"evidence":[NaN]}',
            b'{"ledger":[],"evidence":[{"ts":null,"cycleSeq":0,"fired":[]}]}',
            b'{"ledger":[],"evidence":[{"ts":"2026-10-02T00:00:00Z",'
            b'"cycleSeq":0,"fired":[null]}]}',
            b'{"ledger":[]}',
        ):
            with self.subTest(raw=raw):
                path.write_bytes(raw)
                runtime_mod._RUNTIME = None
                code, body = self._http_json(
                    "/api/immune/cycle", method="POST",
                    body={"actor": "immune:test", "intent": "observe synthetic ledger"},
                )
                self.assertEqual(code, 503)
                self.assertEqual(body["error"], "RUNTIME_BUNDLE_RESTORE_FAILED")
                self.assertEqual(path.read_bytes(), raw)
                runtime = runtime_mod.get_runtime()
                self.assertEqual(runtime.evidence_latest(), [])
                self.assertEqual(runtime.verify_ledger()["issues"][0]["kind"], "load_failure")

    def test_valid_refused_cycle_evidence_survives_reopen(self) -> None:
        import immune.runtime as runtime_mod

        code, cycle = self._http_json(
            "/api/immune/cycle", method="POST",
            body={"actor": "immune:test", "intent": "observe synthetic ledger"},
        )
        self.assertEqual(code, 200)
        self.assertFalse(cycle["pass"])
        self.assertIsNone(cycle["receipt"])
        path = Path(self._tmp.name) / "runtime.json"
        raw = path.read_bytes()
        runtime_mod._RUNTIME = None
        ready_code, ready = self._http_json("/readyz")
        self.assertEqual(ready_code, 503)
        self.assertTrue(ready["ledger"]["ok"])
        self.assertIn("RECEIPT_LEDGER_EMPTY", ready["blockers"])
        self.assertEqual(len(runtime_mod.get_runtime().evidence_latest()), 1)
        self.assertEqual(path.read_bytes(), raw)

    def test_failed_bundle_replace_refuses_all_cycle_routes_without_phantom_evidence(self) -> None:
        import immune.runtime as runtime_mod

        runtime = runtime_mod.get_runtime()
        runtime.run_cycle("immune:test", "establish durable baseline")
        path = Path(self._tmp.name) / "runtime.json"
        baseline = path.read_bytes()
        self.assertEqual(len(runtime.evidence), 1)
        for route in (
            "/api/immune/cycle", "/api/sentra", "/api/yawar",
            "/api/bind", "/api/canary",
        ):
            with self.subTest(route=route):
                observed: list[tuple[int, int]] = []

                def fail_replace(*_args: object) -> None:
                    observed.append((len(runtime.evidence), runtime.ledger_count()))
                    raise OSError("disk full")

                with (
                    patch("immune.persist.Path.write_text", side_effect=OSError("disk full")),
                    patch("immune.persist.os.replace", side_effect=fail_replace),
                ):
                    code, body = self._http_json(
                        route, method="POST",
                        body={"actor": "immune:test", "intent": "observe synthetic ledger"},
                    )
                self.assertEqual(code, 503)
                self.assertEqual(observed, [(1, 0)])
                self.assertEqual(body, {"error": "RUNTIME_BUNDLE_PERSIST_FAILED", "write_ready": False})
                self.assertEqual(runtime.evidence, json.loads(baseline)["evidence"])
                self.assertEqual(path.read_bytes(), baseline)
                self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ["runtime.json"])
        runtime_mod._RUNTIME = None
        self.assertEqual(runtime_mod.get_runtime().evidence, json.loads(baseline)["evidence"])

    def test_failed_bundle_flush_rolls_back_direct_receipt_and_preserves_restart_state(self) -> None:
        from immune.runtime import ImmuneRuntime, RuntimeIntegrityError

        runtime = ImmuneRuntime()
        runtime.boot()
        runtime.run_cycle("immune:test", "establish durable baseline")
        path = Path(self._tmp.name) / "runtime.json"
        baseline = path.read_bytes()
        observed: list[int] = []

        def fail_fsync(_fd: int) -> None:
            observed.append(runtime.ledger_count())
            raise OSError("I/O error")

        with patch("immune.persist.os.fsync", side_effect=fail_fsync):
            with self.assertRaisesRegex(RuntimeIntegrityError, "RUNTIME_BUNDLE_PERSIST_FAILED"):
                runtime.append_receipt({"actor": "test", "intent": "fault injection"})
        self.assertEqual(runtime.ledger_count(), 0)
        self.assertEqual(observed, [0])
        self.assertEqual(path.read_bytes(), baseline)
        self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ["runtime.json"])
        reopened = ImmuneRuntime()
        reopened.boot()
        self.assertEqual(reopened.ledger_count(), 0)
        self.assertEqual(reopened.evidence, json.loads(baseline)["evidence"])

    def test_concurrent_boot_and_append_preserve_both_committed_receipts(self) -> None:
        import immune.runtime as runtime_mod

        seed = runtime_mod.ImmuneRuntime()
        seed.append_receipt({"actor": "test", "intent": "durable seed"})
        target = runtime_mod.ImmuneRuntime()
        loaded = threading.Event()
        release = threading.Event()
        writer_started = threading.Event()
        writer_done = threading.Event()
        failures: list[BaseException] = []
        receipts: list[dict] = []
        original_load = runtime_mod.load_bundle

        def delayed_load() -> dict | None:
            bundle = original_load()
            loaded.set()
            if not release.wait(5):
                raise RuntimeError("test boot release timed out")
            return bundle

        def read_ready() -> None:
            try:
                target.readiness()
            except BaseException as error:
                failures.append(error)

        def append() -> None:
            writer_started.set()
            try:
                receipts.append(target.append_receipt(
                    {"actor": "test", "intent": "racing append"}
                ))
            except BaseException as error:
                failures.append(error)
            finally:
                writer_done.set()

        reader = threading.Thread(target=read_ready, daemon=True)
        writer = threading.Thread(target=append, daemon=True)
        with patch("immune.runtime.load_bundle", side_effect=delayed_load):
            reader.start()
            try:
                self.assertTrue(loaded.wait(5))
                writer.start()
                self.assertTrue(writer_started.wait(5))
                writer_done.wait(1)
            finally:
                release.set()
                reader.join(timeout=5)
                if writer.ident is not None:
                    writer.join(timeout=5)
        self.assertFalse(reader.is_alive())
        self.assertFalse(writer.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual([receipt["seq"] for receipt in receipts], [2])
        self.assertEqual([entry["payload"]["intent"] for entry in target.ledger],
                         ["durable seed", "racing append"])
        reopened = runtime_mod.ImmuneRuntime()
        reopened.boot()
        self.assertEqual(reopened.ledger, target.ledger)

    def test_get_readiness_restores_without_writing_or_signing(self) -> None:
        import immune.runtime as runtime_mod

        seed = runtime_mod.ImmuneRuntime()
        seed.append_receipt({"actor": "test", "intent": "read-only seed"})
        path = Path(self._tmp.name) / "runtime.json"
        raw = path.read_bytes()
        runtime_mod._RUNTIME = None
        with (
            patch("immune.runtime.save_bundle", side_effect=AssertionError("GET wrote")) as save,
            patch.object(runtime_mod.ImmuneRuntime, "_sign", side_effect=AssertionError("GET signed")) as sign,
        ):
            code, ready = self._http_json("/readyz")
        self.assertEqual(code, 503)
        self.assertEqual(ready["ledger"]["count"], 1)
        self.assertFalse(ready["write_ready"])
        save.assert_not_called()
        sign.assert_not_called()
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(runtime_mod.get_runtime().ledger_count(), 1)

    def test_impossible_or_decreasing_evidence_sequence_preserves_bundle(self) -> None:
        import immune.runtime as runtime_mod
        from immune.canonical import hash_canonical

        receipt = {
            "seq": 1,
            "ts": "2026-10-02T00:00:00Z",
            "prevHash": "GENESIS",
            "payload": {"synthetic": True},
        }
        receipt["hash"] = hash_canonical(receipt)[0]
        evidence = {"ts": "2026-10-02T00:00:01Z", "cycleSeq": 0, "fired": []}
        bundles = (
            {"ledger": [], "evidence": [{**evidence, "cycleSeq": 42}]},
            {"ledger": [receipt], "evidence": [
                {**evidence, "cycleSeq": 1}, evidence,
            ]},
        )
        path = Path(self._tmp.name) / "runtime.json"
        for bundle in bundles:
            with self.subTest(bundle=bundle):
                raw = json.dumps(bundle).encode()
                path.write_bytes(raw)
                runtime_mod._RUNTIME = None
                code, body = self._http_json(
                    "/api/immune/cycle", method="POST",
                    body={"actor": "immune:test", "intent": "observe synthetic ledger"},
                )
                self.assertEqual(code, 503)
                self.assertEqual(body["error"], "RUNTIME_BUNDLE_RESTORE_FAILED")
                self.assertEqual(path.read_bytes(), raw)
                self.assertEqual(runtime_mod.get_runtime().evidence_latest(), [])

    def test_repeated_refused_evidence_sequence_zero_survives_reopen(self) -> None:
        import immune.runtime as runtime_mod

        for _ in range(2):
            code, cycle = self._http_json(
                "/api/immune/cycle", method="POST",
                body={"actor": "immune:test", "intent": "observe synthetic ledger"},
            )
            self.assertEqual(code, 200)
            self.assertFalse(cycle["pass"])
        path = Path(self._tmp.name) / "runtime.json"
        raw = path.read_bytes()
        runtime_mod._RUNTIME = None
        ready_code, ready = self._http_json("/readyz")
        self.assertEqual(ready_code, 503)
        self.assertTrue(ready["ledger"]["ok"])
        records = runtime_mod.get_runtime().evidence_latest()
        self.assertEqual([item["cycleSeq"] for item in records], [0, 0])
        self.assertEqual(path.read_bytes(), raw)

    def test_duplicate_json_keys_in_persisted_bundle_fail_closed(self) -> None:
        import immune.runtime as runtime_mod

        path = Path(self._tmp.name) / "runtime.json"
        for raw in (
            b'{"ledger":{},"ledger":[],"evidence":[]}',
            b'{"ledger":[],"evidence":[],"extra":{"key":1,"key":2}}',
        ):
            with self.subTest(raw=raw):
                path.write_bytes(raw)
                runtime_mod._RUNTIME = None
                code, body = self._http_json(
                    "/api/immune/cycle", method="POST",
                    body={"actor": "immune:test", "intent": "observe synthetic ledger"},
                )
                self.assertEqual(code, 503)
                self.assertEqual(body["error"], "RUNTIME_BUNDLE_RESTORE_FAILED")
                self.assertFalse(body["write_ready"])
                self.assertEqual(path.read_bytes(), raw)
                runtime = runtime_mod.get_runtime()
                self.assertEqual(runtime.evidence_latest(), [])
                self.assertEqual(runtime.verify_ledger()["issues"][0]["kind"], "load_failure")

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
                "provenance": "OBSERVED",
                "href": "",
                "detail": "",
            },
            {
                "id": "killinchu",
                "title": "killinchu",
                "stage": "LIVE",
                "provenance": "OBSERVED",
                "href": "",
                "detail": "",
            },
            {
                "id": "khipu",
                "title": "khipu",
                "stage": "TRAINED",
                "provenance": "OBSERVED",
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

    def test_mesh_provenance_label_alone_never_makes_a_vote_live(self) -> None:
        from immune.mesh import mesh_from_surfaces

        for stage in ("NOT_READY", "READ_ONLY", "UNAVAILABLE", "UNOBSERVED"):
            with self.subTest(stage=stage):
                mesh = mesh_from_surfaces(
                    [{"id": "immune", "stage": stage, "provenance": "LIVE"}]
                )
                immune = next(v for v in mesh["votes"] if v["id"] == "immune")
                self.assertFalse(immune["live"])
                self.assertEqual(immune["stage"], stage)
                self.assertEqual(mesh["liveCount"], 0)
                self.assertEqual(mesh["provenance"], "UNAVAILABLE")
        # A ready stage that was not observed (reference only) does not count.
        mesh = mesh_from_surfaces(
            [{"id": "khipu", "stage": "TRAINED", "provenance": "REFERENCE"}]
        )
        self.assertEqual(mesh["liveCount"], 0)

    def test_mesh_former_remote_live_fixture_is_rejected(self) -> None:
        # The input the original positive test used to close quorum: remote
        # organs labelled LIVE as if they were this process. It must not count.
        from immune.mesh import mesh_from_surfaces

        surfaces = [
            {"id": "a11oy", "title": "a11oy", "stage": "LIVE", "provenance": "LIVE"},
            {"id": "killinchu", "title": "killinchu", "stage": "LIVE", "provenance": "LIVE"},
            {"id": "khipu", "title": "khipu", "stage": "TRAINED", "provenance": "LIVE"},
        ]
        mesh = mesh_from_surfaces(surfaces)
        self.assertEqual(mesh["liveCount"], 0)
        self.assertFalse(mesh["reached"])
        self.assertEqual(mesh["provenance"], "UNAVAILABLE")
        for vote in mesh["votes"][1:]:
            self.assertFalse(vote["live"])
            self.assertIn("requires OBSERVED", vote["reason"])

    def test_mesh_provenance_is_bound_to_organ(self) -> None:
        from immune.mesh import mesh_from_surfaces, vote_is_live

        for oid in ("immune", "a11oy", "killinchu", "khipu"):
            correct = "LIVE" if oid == "immune" else "OBSERVED"
            incorrect = "OBSERVED" if oid == "immune" else "LIVE"
            for provenance in (incorrect, "REFERENCE", "UNAVAILABLE", None):
                row = {"id": oid, "stage": "READY", "provenance": provenance}
                self.assertFalse(vote_is_live(row), (oid, provenance))
                self.assertEqual(mesh_from_surfaces([row])["liveCount"], 0)
            row = {"id": oid, "stage": "READY", "provenance": correct}
            self.assertTrue(vote_is_live(row), oid)
            for stage in ("NOT_READY", "UNAVAILABLE", "WEIGHTS_LISTED",
                          "NO_READINESS_CONTRACT", None):
                self.assertFalse(vote_is_live({**row, "stage": stage}), (oid, stage))
        for identity in ("unknown", "", None, 7, ["a11oy"], {"id": "a11oy"}):
            self.assertFalse(
                vote_is_live({"id": identity, "stage": "READY", "provenance": "OBSERVED"})
            )
        self.assertFalse(vote_is_live({"stage": "READY", "provenance": "OBSERVED"}))
        self.assertFalse(vote_is_live(None))

    def test_mesh_unknown_and_duplicate_identities_cannot_add_or_override_votes(
        self,
    ) -> None:
        from immune.mesh import mesh_from_surfaces

        ready = {"id": "a11oy", "stage": "READY", "provenance": "OBSERVED"}
        unready = {"id": "a11oy", "stage": "UNAVAILABLE", "provenance": "UNAVAILABLE"}
        extras = [
            {"id": "a11oy-2", "stage": "READY", "provenance": "OBSERVED"},
            {"id": "", "stage": "READY", "provenance": "OBSERVED"},
            {"id": None, "stage": "READY", "provenance": "OBSERVED"},
            {"id": ["khipu"], "stage": "READY", "provenance": "OBSERVED"},
            {"stage": "READY", "provenance": "OBSERVED"},
            "a11oy",
            None,
        ]
        mesh = mesh_from_surfaces([ready, *extras])
        self.assertEqual(mesh["liveCount"], 1)
        self.assertEqual([v["id"] for v in mesh["votes"]], ["immune", "a11oy", "killinchu", "khipu"])
        # Identical repeats collapse into exactly one vote.
        self.assertEqual(mesh_from_surfaces([ready, dict(ready), dict(ready)])["liveCount"], 1)
        # Conflicting repeats fail closed in either order; neither row wins.
        for rows in ([ready, unready], [unready, ready],
                     [ready, {**ready, "provenance": "LIVE"}],
                     [ready, {**ready, "stage": "NOT_READY"}]):
            vote = next(v for v in mesh_from_surfaces(rows)["votes"] if v["id"] == "a11oy")
            self.assertFalse(vote["live"])
            self.assertEqual(vote["stage"], "CONFLICT")
            self.assertIn("conflicting", vote["reason"])
        # Duplicated ready identities cannot manufacture a quorum.
        many = [ready, dict(ready), dict(ready),
                {"id": "khipu", "stage": "READY", "provenance": "OBSERVED"},
                {"id": "khipu", "stage": "READY", "provenance": "OBSERVED"}]
        mesh = mesh_from_surfaces(many)
        self.assertEqual(mesh["liveCount"], 2)
        self.assertFalse(mesh["reached"])

    @staticmethod
    def _a11oy_ready_body() -> dict:
        # Shape of the a11oy producer GET /api/a11oy/healthz (serve.py healthz at
        # a11oy 84ba3cbd and de36cfea, identical blob c6e6dbdf).
        return {
            "status": "ok",
            "scope": "SERVICE_HEALTH",
            "service": "a11oy",
            "operational_readiness": {
                "scope": "FRONTIER_CAPABILITIES_AND_SERVICE_HEALTH",
                "ready": True,
                "status": "READY",
                "service_blockers": [],
                "frontier": {
                    "ready": True,
                    "ready_tiles": [{"name": "running"}],
                    "blocked_tiles": [],
                },
            },
            "degraded_reasons": [],
        }

    _KHIPU_SHA = "e40242a48e5d75f2bd44badc103d070d699a72fc"

    @classmethod
    def _khipu_body(cls) -> dict:
        return {
            "id": "SZLHOLDINGS/SZL-Khipu-1.5B",
            "private": False,
            "disabled": False,
            "sha": cls._KHIPU_SHA,
            "tags": ["safetensors"],
            "siblings": [
                {"rfilename": "README.md"},
                {"rfilename": "model.safetensors"},
                {"rfilename": "adapter/adapter_model.safetensors"},
            ],
        }

    def test_a11oy_operational_readiness_contract(self) -> None:
        import copy

        from immune.organs import ESTATE_PROBES, _accept

        spec = next(row for row in ESTATE_PROBES if row["id"] == "a11oy")
        self.assertEqual(spec["probe"], "https://szlholdings-a11oy.hf.space/api/a11oy/healthz")
        self.assertIsNone(_accept(spec, 200, self._a11oy_ready_body()))

        def mutated(change):
            body = copy.deepcopy(self._a11oy_ready_body())
            change(body, body["operational_readiness"])
            return body

        process_liveness = {
            "status": "ok", "scope": "PROCESS_LIVENESS", "organ": "a11oy",
            "capability_readiness_asserted": False,
            "operational_readiness_endpoint": "/api/a11oy/healthz",
        }
        cases = {
            "process liveness only": process_liveness,
            "process liveness labelled a11oy": {**process_liveness, "service": "a11oy"},
            "ok but ready=false": mutated(lambda b, r: r.update(ready=False, status="NOT_READY")),
            "readiness missing": mutated(lambda b, r: b.pop("operational_readiness")),
            "readiness not object": mutated(lambda b, r: b.update(operational_readiness=[])),
            "ready string": mutated(lambda b, r: r.update(ready="true")),
            "ready int": mutated(lambda b, r: r.update(ready=1)),
            "ready missing": mutated(lambda b, r: r.pop("ready")),
            "status contradicts": mutated(lambda b, r: r.update(status="NOT_READY")),
            "unavailable": mutated(lambda b, r: r.update(ready=False, status="UNAVAILABLE", frontier=None)),
            "wrong identity": mutated(lambda b, r: b.update(service="killinchu")),
            "identity missing": mutated(lambda b, r: b.pop("service")),
            "organ is not identity": mutated(lambda b, r: (b.pop("service"), b.update(organ="a11oy"))),
            "wrong scope": mutated(lambda b, r: b.update(scope="FRONTIER")),
            "wrong readiness scope": mutated(lambda b, r: r.update(scope="SOURCE_REACHABILITY")),
            "blocker despite ready": mutated(lambda b, r: r.update(service_blockers=["storage-unavailable"])),
            "blockers missing": mutated(lambda b, r: r.pop("service_blockers")),
            "blockers not list": mutated(lambda b, r: r.update(service_blockers="none")),
            "degraded reasons": mutated(lambda b, r: b.update(degraded_reasons=["node-backend-unavailable"])),
            "degraded reasons missing": mutated(lambda b, r: b.pop("degraded_reasons")),
            "degraded status": mutated(lambda b, r: b.update(status="degraded")),
            "frontier missing": mutated(lambda b, r: r.update(frontier=None)),
            "frontier not ready": mutated(lambda b, r: r["frontier"].update(ready=False)),
            "frontier blocked tile": mutated(lambda b, r: r["frontier"].update(blocked_tiles=[{"name": "operator"}])),
        }
        for label, body in cases.items():
            with self.subTest(label):
                self.assertIsNotNone(_accept(spec, 200, body))
        self.assertIn("process liveness", _accept(spec, 200, process_liveness))
        self.assertIn("service_blockers", _accept(spec, 200, cases["blocker despite ready"]))
        self.assertIn("service='killinchu'", _accept(spec, 200, cases["wrong identity"]))
        self.assertEqual(_accept(spec, 503, self._a11oy_ready_body()), "HTTP 503")
        self.assertIsNotNone(_accept(spec, 200, [self._a11oy_ready_body()]))

    def test_khipu_weight_inventory_contract(self) -> None:
        from immune.organs import ESTATE_PROBES, _accept

        spec = next(row for row in ESTATE_PROBES if row["id"] == "khipu")
        self.assertIsNone(_accept(spec, 200, self._khipu_body()))

        def body(**changes):
            value = self._khipu_body()
            value.update(changes)
            return value

        no_siblings = self._khipu_body()
        no_siblings.pop("siblings")
        no_disabled = self._khipu_body()
        no_disabled.pop("disabled")
        no_private = self._khipu_body()
        no_private.pop("private")
        no_sha = self._khipu_body()
        no_sha.pop("sha")
        good = {"rfilename": "model.safetensors"}
        cases = {
            "tag only, no siblings": no_siblings,
            "empty siblings": body(siblings=[]),
            "siblings object": body(siblings={"rfilename": "model.safetensors"}),
            "siblings string": body(siblings="model.safetensors"),
            "bare string entry": body(siblings=[good, "model.safetensors"]),
            "null entry": body(siblings=[good, None]),
            "entry without name": body(siblings=[good, {}]),
            "non-string name": body(siblings=[good, {"rfilename": 5}]),
            "blank name": body(siblings=[good, {"rfilename": " "}]),
            "readme only": body(siblings=[{"rfilename": "README.md"}, {"rfilename": "config.json"}]),
            "index json only": body(siblings=[{"rfilename": "model.safetensors.index.json"}]),
            "nameless extension": body(siblings=[{"rfilename": ".safetensors"}]),
            "wrong model": body(id="SZLHOLDINGS/other"),
            "private": body(private=True),
            "private missing": no_private,
            "disabled": body(disabled=True),
            "disabled missing": no_disabled,
            "disabled string": body(disabled="false"),
            "sha missing": no_sha,
            "sha short": body(sha="e40242a4"),
            "sha not string": body(sha=None),
        }
        for label, value in cases.items():
            with self.subTest(label):
                self.assertIsNotNone(_accept(spec, 200, value))
        self.assertIn("malformed entry", _accept(spec, 200, cases["null entry"]))
        self.assertIn("disabled", _accept(spec, 200, cases["disabled missing"]))
        self.assertEqual(_accept(spec, 404, self._khipu_body()), "HTTP 404")

    def _transport(self, *, a11oy=None, khipu=None, gate=None, before=None):
        """Fake estate transport. Records URLs; never reaches the network."""
        import copy as copy_mod

        calls: list[str] = []
        calls_lock = threading.Lock()

        def fetch(url, timeout):
            self.assertNotIn("killinchu", url)
            self.assertGreater(timeout, 0)
            with calls_lock:
                calls.append(url)
            if before is not None:
                before(url)
            if gate is not None:
                gate.wait(10)
            if "/api/a11oy/healthz" in url:
                value = a11oy if a11oy is not None else self._a11oy_ready_body()
            elif url.startswith("https://huggingface.co/api/models/"):
                value = khipu if khipu is not None else self._khipu_body()
            else:
                raise AssertionError(f"unexpected probe target {url}")
            if isinstance(value, BaseException):
                raise value
            return 200, copy_mod.deepcopy(value)

        return fetch, calls

    def _probing(self, fetch, **constants):
        from contextlib import ExitStack

        stack = ExitStack()
        stack.enter_context(patch.dict(os.environ, {"IMMUNE_ESTATE_PROBE": "1"}))
        stack.enter_context(patch("immune.organs._fetch_json", side_effect=fetch))
        for name, value in constants.items():
            stack.enter_context(patch(f"immune.organs.{name}", value))
        return stack

    def _drain(self, gate=None) -> None:
        import time

        import immune.organs as organs_mod

        if gate is not None:
            gate.set()
        limit = time.monotonic() + 10
        while organs_mod.outstanding_estate_workers() and time.monotonic() < limit:
            time.sleep(0.01)
        self.assertEqual(organs_mod.outstanding_estate_workers(), 0)

    def test_estate_failed_probes_are_unavailable_and_quorum_open(self) -> None:
        from urllib.error import URLError

        from immune.organs import dashboard

        fetch, calls = self._transport(
            a11oy=URLError("egress refused"),
            khipu=HTTPError("https://huggingface.co", 503, "Service Unavailable", {}, None),
        )
        with self._probing(fetch):
            projected = dashboard()
        self._drain()
        votes = {v["id"]: v for v in projected["mesh"]["votes"]}
        for oid in ("a11oy", "khipu"):
            self.assertFalse(votes[oid]["live"])
            self.assertEqual(votes[oid]["stage"], "UNAVAILABLE")
            self.assertEqual(votes[oid]["provenance"], "UNAVAILABLE")
        self.assertIn("URLError", votes["a11oy"]["detail"])
        self.assertIn("HTTP 503", votes["khipu"]["detail"])
        self.assertEqual(votes["killinchu"]["stage"], "NO_READINESS_CONTRACT")
        self.assertFalse(votes["immune"]["live"])
        self.assertEqual(projected["mesh"]["liveCount"], 0)
        self.assertFalse(projected["mesh"]["reached"])
        self.assertEqual(len(calls), 2)
        for row in projected["estate"]:
            self.assertNotIn("observed from this process", row["detail"])

    def test_estate_contract_negatives_are_not_live(self) -> None:
        from immune.organs import dashboard

        fetch, _ = self._transport(
            a11oy={"status": "ok", "scope": "PROCESS_LIVENESS", "organ": "a11oy"},
            khipu={**self._khipu_body(), "id": "someone/else"},
        )
        with self._probing(fetch):
            projected = dashboard()
        self._drain()
        votes = {v["id"]: v for v in projected["mesh"]["votes"]}
        self.assertEqual(projected["mesh"]["liveCount"], 0)
        self.assertIn("process liveness is not operational readiness", votes["a11oy"]["detail"])
        self.assertIn("does not match", votes["khipu"]["detail"])

    def test_estate_observed_probes_count_and_are_cached(self) -> None:
        from immune.organs import dashboard, local_organ_mesh

        fetch, calls = self._transport()
        with self._probing(fetch):
            projected = dashboard()
            organs = local_organ_mesh()
        self._drain()
        votes = {v["id"]: v for v in projected["mesh"]["votes"]}
        self.assertTrue(votes["a11oy"]["live"])
        self.assertEqual(votes["a11oy"]["stage"], "READY")
        self.assertEqual(votes["a11oy"]["provenance"], "OBSERVED")
        # killinchu has no whole-organ readiness contract: never fetched, never counted.
        self.assertFalse(votes["killinchu"]["live"])
        self.assertEqual(votes["killinchu"]["stage"], "NO_READINESS_CONTRACT")
        self.assertEqual(votes["killinchu"]["provenance"], "REFERENCE")
        self.assertIn("no whole-organ operational-readiness contract", votes["killinchu"]["detail"])
        # Listed weights are observed but are not a quorum vote.
        self.assertFalse(votes["khipu"]["live"])
        self.assertEqual(votes["khipu"]["stage"], "WEIGHTS_LISTED")
        self.assertEqual(votes["khipu"]["provenance"], "OBSERVED")
        self.assertIn(f"at revision {self._KHIPU_SHA}", votes["khipu"]["detail"])
        self.assertIn("not quorum-eligible", votes["khipu"]["detail"])
        khipu_row = next(r for r in projected["estate"] if r["id"] == "khipu")
        self.assertEqual(khipu_row["revision"], self._KHIPU_SHA)
        self.assertEqual(projected["organs"]["khipu"]["stage"], "WEIGHTS_LISTED")
        self.assertEqual(projected["organs"]["khipu"]["revision"], self._KHIPU_SHA)
        self.assertFalse(votes["immune"]["live"])
        self.assertEqual(projected["mesh"]["liveCount"], 1)
        self.assertFalse(projected["mesh"]["reached"])
        # One observation serves both dashboard projections and the next read.
        self.assertEqual(projected["mesh"]["votes"], projected["organs"]["mesh"]["votes"])
        self.assertEqual(organs["khipu"]["revision"], self._KHIPU_SHA)
        self.assertEqual(len(calls), 2)

    def test_two_eligible_votes_and_unqualified_organs_leave_quorum_open(self) -> None:
        from immune.mesh import mesh_from_surfaces
        from immune.organs import local_estate

        class WriteReadyRuntime:
            def readiness(self) -> dict:
                return {"status": "READY", "write_ready": True}

            def snapshot(self) -> dict:
                return {"evidenceState": "VERIFIED"}

        for a11oy, expected in ((None, 2),
                                ({"status": "ok", "scope": "PROCESS_LIVENESS", "organ": "a11oy"}, 1)):
            with self.subTest(expected=expected):
                import immune.organs as organs_mod

                organs_mod.reset_estate_probe_cache()
                fetch, _ = self._transport(a11oy=a11oy)
                with self._probing(fetch), patch(
                    "immune.organs.get_runtime", return_value=WriteReadyRuntime()
                ):
                    mesh = mesh_from_surfaces(local_estate())
                self._drain()
                self.assertEqual(mesh["liveCount"], expected)
                self.assertFalse(mesh["reached"])

    def test_estate_probe_disabled_is_unobserved(self) -> None:
        import immune.organs as organs_mod
        from immune.organs import dashboard

        generation = organs_mod._STATE["generation"]
        with patch("immune.organs._fetch_json") as fetched:
            projected = dashboard()
        fetched.assert_not_called()
        self.assertEqual(organs_mod._STATE["generation"], generation)
        self.assertEqual(organs_mod.outstanding_estate_workers(), 0)
        votes = {v["id"]: v for v in projected["mesh"]["votes"]}
        for oid in ("a11oy", "killinchu", "khipu"):
            self.assertFalse(votes[oid]["live"])
            self.assertEqual(votes[oid]["stage"], "UNOBSERVED")
            self.assertEqual(votes[oid]["provenance"], "REFERENCE")
            self.assertIn("estate probe disabled", votes[oid]["detail"])
        self.assertFalse(projected["mesh"]["reached"])

    def test_projection_routes_apply_the_same_acceptance_rules(self) -> None:
        import immune.organs as organs_mod

        routes = ("/api/immune/state", "/api/immune/dashboard", "/api/immune/organs")
        liveness = {"status": "ok", "scope": "PROCESS_LIVENESS", "organ": "a11oy"}
        for a11oy, a11oy_live in ((None, True), (liveness, False)):
            organs_mod.reset_estate_probe_cache()
            fetch, calls = self._transport(a11oy=a11oy)
            with self._probing(fetch):
                for route in routes:
                    with self.subTest(route=route, a11oy_live=a11oy_live):
                        code, body = self._http_json(route)
                        self.assertEqual(code, 200)
                        votes = {v["id"]: v for v in body["mesh"]["votes"]}
                        self.assertIs(votes["a11oy"]["live"], a11oy_live)
                        self.assertFalse(votes["killinchu"]["live"])
                        self.assertFalse(votes["khipu"]["live"])
                        self.assertEqual(votes["khipu"]["stage"], "WEIGHTS_LISTED")
                        self.assertFalse(votes["immune"]["live"])
                        self.assertEqual(body["mesh"]["liveCount"], int(a11oy_live))
                        self.assertFalse(body["mesh"]["reached"])
            self._drain()
            self.assertEqual(len(calls), 2)

    def test_refresh_normal_completion_within_budget(self) -> None:
        import time

        from immune.organs import observe_estate

        fetch, calls = self._transport()
        with self._probing(fetch, PROBE_DEADLINE_SECONDS=1.0):
            started = time.monotonic()
            rows = observe_estate()
            elapsed = time.monotonic() - started
        self._drain()
        self.assertLess(elapsed, 1.0)
        stages = {row["id"]: row["stage"] for row in rows}
        self.assertEqual(stages, {"a11oy": "READY", "killinchu": "NO_READINESS_CONTRACT",
                                  "khipu": "WEIGHTS_LISTED"})
        self.assertEqual(len(calls), 2)

    def test_concurrent_readers_share_one_refresh(self) -> None:
        import time

        import immune.organs as organs_mod
        from immune.organs import observe_estate

        gate = threading.Event()
        fetch, calls = self._transport(gate=gate)
        generation = organs_mod._STATE["generation"]
        results: list = []
        start = threading.Barrier(6)

        def reader():
            start.wait(5)
            results.append(observe_estate())

        with self._probing(fetch, PROBE_DEADLINE_SECONDS=5.0):
            threads = [threading.Thread(target=reader) for _ in range(6)]
            for thread in threads:
                thread.start()
            limit = time.monotonic() + 5
            while len(calls) < 2 and time.monotonic() < limit:
                time.sleep(0.01)
            time.sleep(0.1)  # let the remaining readers join the in-flight refresh
            gate.set()
            for thread in threads:
                thread.join(10)
        self._drain(gate)
        self.assertEqual(len(results), 6)
        self.assertEqual(len(calls), 2)
        self.assertEqual(organs_mod._STATE["generation"], generation + 1)
        self.assertTrue(all(rows == results[0] for rows in results))
        self.assertEqual(results[0][0]["stage"], "READY")

    def test_ttl_expiry_and_expired_cache_with_injected_clock(self) -> None:
        from urllib.error import URLError

        import immune.organs as organs_mod
        from immune.organs import observe_estate

        clock = [1000.0]
        mode = {"fail": False}

        def before(url):
            if mode["fail"]:
                raise URLError("egress refused")

        fetch, calls = self._transport(before=before)
        with self._probing(fetch), patch("immune.organs._monotonic", lambda: clock[0]):
            first = observe_estate()
            self.assertEqual(len(calls), 2)
            clock[0] += organs_mod.PROBE_TTL_SECONDS - 1
            self.assertEqual(observe_estate(), first)
            self.assertEqual(len(calls), 2)
            # Expired evidence is never served, and a failed refresh never
            # resurrects the old READY row.
            clock[0] += 2
            mode["fail"] = True
            expired = observe_estate()
        self._drain()
        self.assertEqual(len(calls), 4)
        self.assertEqual(first[0]["stage"], "READY")
        self.assertEqual(expired[0]["stage"], "UNAVAILABLE")
        self.assertIn("URLError", expired[0]["detail"])

    def test_slow_read_past_deadline_is_bounded_and_does_not_wait_for_cleanup(self) -> None:
        import time

        import immune.organs as organs_mod
        from immune.organs import observe_estate

        gate = threading.Event()  # never released until cleanup: a hung peer
        fetch, calls = self._transport(gate=gate)
        try:
            with self._probing(fetch, PROBE_DEADLINE_SECONDS=0.3):
                started = time.monotonic()
                rows = observe_estate()
                elapsed = time.monotonic() - started
                # Executor exit did not wait for the hung workers.
                self.assertEqual(organs_mod.outstanding_estate_workers(), 2)
                again = observe_estate()
            self.assertLess(elapsed, 0.3 + organs_mod.PROBE_LOCK_GRACE_SECONDS + 1.0)
            for row in (rows[0], rows[2]):
                self.assertEqual(row["stage"], "UNAVAILABLE")
                self.assertIn("deadline", row["detail"])
            self.assertEqual(rows[1]["stage"], "NO_READINESS_CONTRACT")
            # The bounded failure is cached for the TTL: no new egress.
            self.assertEqual(again, rows)
            self.assertEqual(len(calls), 2)
        finally:
            self._drain(gate)

    def test_transport_timeout_and_failing_worker_are_honest(self) -> None:
        import subprocess

        import immune.organs as organs_mod
        from immune.organs import observe_estate

        fetch, _ = self._transport(
            a11oy=subprocess.TimeoutExpired("probe", 3.0), khipu=RuntimeError("boom")
        )
        with self._probing(fetch):
            rows = observe_estate()
        self._drain()
        self.assertIn("deadline exceeded", rows[0]["detail"])
        self.assertIn("RuntimeError", rows[2]["detail"])
        self.assertTrue(all(row["stage"] != "READY" for row in rows))

        organs_mod.reset_estate_probe_cache()
        with self._probing(fetch), patch(
            "immune.organs._observe", side_effect=RuntimeError("worker crashed")
        ):
            rows = observe_estate()
        self._drain()
        for row in (rows[0], rows[2]):
            self.assertEqual(row["stage"], "UNAVAILABLE")
            self.assertIn("probe worker failed: RuntimeError", row["detail"])

    def test_lock_contention_returns_bounded_failure(self) -> None:
        import time

        import immune.organs as organs_mod
        from immune.organs import observe_estate

        fetch, calls = self._transport()
        with self._probing(fetch, PROBE_DEADLINE_SECONDS=0.3):
            organs_mod._STATE_LOCK.acquire()
            try:
                started = time.monotonic()
                rows = observe_estate()
                elapsed = time.monotonic() - started
            finally:
                organs_mod._STATE_LOCK.release()
        self.assertLess(elapsed, 1.5)
        self.assertEqual(calls, [])
        self.assertIn("lock was not available", rows[0]["detail"])
        self.assertEqual(rows[1]["stage"], "NO_READINESS_CONTRACT")
        self.assertTrue(all(row["stage"] != "READY" for row in rows))

    def test_cancelled_refresh_and_late_completion_cannot_overwrite_newer(self) -> None:
        import time

        import immune.organs as organs_mod
        from immune.organs import observe_estate

        newer_sha = "b" * 40
        old_gate = threading.Event()
        mode = {"old": True}

        def before(url):
            if mode["old"]:
                old_gate.wait(10)

        old_body = {**self._khipu_body(), "sha": "a" * 40}
        fetch, calls = self._transport(khipu=old_body, before=before)
        cancelled: list = []
        try:
            with self._probing(fetch, PROBE_DEADLINE_SECONDS=1.0):
                leader = threading.Thread(target=lambda: cancelled.append(observe_estate()))
                leader.start()
                limit = time.monotonic() + 5
                while len(calls) < 2 and time.monotonic() < limit:
                    time.sleep(0.01)
                organs_mod.reset_estate_probe_cache()  # cancel the in-flight refresh
                mode["old"] = False
                with patch("immune.organs._fetch_json", side_effect=self._transport(
                    khipu={**self._khipu_body(), "sha": newer_sha})[0]):
                    newer = observe_estate()
                old_gate.set()  # the cancelled refresh now completes late
                leader.join(5)
                self._drain()
                served = observe_estate()
        finally:
            self._drain(old_gate)
        self.assertEqual(len(cancelled), 1)
        self.assertIn("cancelled", cancelled[0][0]["detail"])
        self.assertEqual(newer[2]["revision"], newer_sha)
        # The late result did not overwrite the newer observation or its clock.
        self.assertEqual(served, newer)
        self.assertEqual(served[2]["observedAt"], newer[2]["observedAt"])

    def test_completion_after_deadline_never_becomes_ready(self) -> None:
        import immune.organs as organs_mod
        from immune.organs import observe_estate

        clock = [5000.0]

        def before(url):
            if "/api/a11oy/healthz" in url:
                clock[0] += organs_mod.PROBE_DEADLINE_SECONDS + 1

        fetch, _ = self._transport(before=before)
        with self._probing(fetch), patch("immune.organs._monotonic", lambda: clock[0]):
            rows = observe_estate()
        self._drain()
        self.assertEqual(rows[0]["stage"], "UNAVAILABLE")
        self.assertIn("deadline", rows[0]["detail"])

        # Independently of the probe's own check: a READY row handed over after
        # the refresh deadline is discarded by the coordinator.
        organs_mod.reset_estate_probe_cache()

        def late_ready(spec, deadline):
            clock[0] = deadline + 1
            return {"id": spec["id"], "title": spec["title"], "role": spec["role"],
                    "href": spec["href"], "stage": spec["readyStage"],
                    "provenance": "OBSERVED", "detail": "late", "observedAt": "late"}

        with self._probing(fetch), patch("immune.organs._monotonic", lambda: clock[0]), patch(
            "immune.organs._observe", side_effect=late_ready
        ):
            rows = observe_estate()
        self._drain()
        for row in (rows[0], rows[2]):
            self.assertEqual(row["stage"], "UNAVAILABLE")
            self.assertIn("no result within", row["detail"])

    def test_stalled_refresh_is_closed_honestly_by_the_next_reader(self) -> None:
        import immune.organs as organs_mod
        from immune.organs import observe_estate

        clock = [9000.0]
        fetch, calls = self._transport()
        with self._probing(fetch), patch("immune.organs._monotonic", lambda: clock[0]):
            with patch("immune.organs._run_refresh", lambda refresh: None), patch(
                "immune.organs.PROBE_DEADLINE_SECONDS", 0.2
            ):
                stalled = observe_estate()  # leader never closes its refresh
            self.assertIsNotNone(organs_mod._STATE["inflight"])
            clock[0] += 1
            recovered = observe_estate()
        self.assertIn("did not complete", stalled[0]["detail"])
        self.assertIsNone(organs_mod._STATE["inflight"])
        self.assertEqual(recovered[0]["stage"], "UNAVAILABLE")
        self.assertIn("no result within", recovered[0]["detail"])
        self.assertEqual(calls, [])

    def test_probe_worker_count_is_bounded(self) -> None:
        import immune.organs as organs_mod
        from immune.organs import observe_estate

        gate = threading.Event()
        fetch, calls = self._transport(gate=gate)
        try:
            with self._probing(fetch, PROBE_DEADLINE_SECONDS=0.2):
                for _ in range(2):
                    observe_estate()
                    organs_mod.reset_estate_probe_cache()
                self.assertEqual(organs_mod.outstanding_estate_workers(), 4)
                rows = observe_estate()
                alive = [t for t in threading.enumerate()
                         if t.name.startswith("immune-estate-probe")]
            self.assertEqual(len(calls), 4)
            self.assertLessEqual(len(alive), organs_mod.PROBE_MAX_OUTSTANDING_WORKERS)
            for row in (rows[0], rows[2]):
                self.assertIn("probe not started: 4 probe workers still outstanding", row["detail"])
        finally:
            self._drain(gate)

    def test_probe_deadline_terminates_stuck_fetch_process(self) -> None:
        import subprocess
        import time
        from immune.organs import _fetch_json

        helper = Path(self._tmp.name) / "blocked_fetch.py"
        helper.write_text("import time; time.sleep(30)\n", encoding="utf-8")
        started = time.monotonic()
        with patch("immune.organs.PROBE_HELPER", helper):
            with self.assertRaises(subprocess.TimeoutExpired):
                _fetch_json("https://unused.invalid", 0.2)
        self.assertLess(time.monotonic() - started, 5.0)

    def test_fetch_helper_decodes_json_and_bounds_response(self) -> None:
        from http.server import BaseHTTPRequestHandler
        from immune.organs import _fetch_json

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                status = 503 if self.path == "/unavailable" else 200
                self.send_response(status)
                self.end_headers()
                if self.path == "/large":
                    self.wfile.write(b"x" * 300_000)
                else:
                    self.wfile.write(b'{"status":"ok"}')

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            self.assertEqual(_fetch_json(base, 3.0), (200, {"status": "ok"}))
            self.assertEqual(_fetch_json(base + "/unavailable", 3.0), (503, None))
            with self.assertRaises(ValueError):
                _fetch_json(base + "/large", 3.0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


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

    def test_local_organs_are_live_but_remote_state_is_observed_separately(self) -> None:
        from immune.organs import dashboard, local_organ_mesh
        from immune.runtime import get_runtime

        get_runtime()
        mesh = local_organ_mesh()
        self.assertEqual(len(mesh["organs"]), 5)
        local = [o for o in mesh["organs"] if o["id"] != "skeleton"]
        self.assertTrue(all(o["provenance"] == "LIVE" for o in local))
        skeleton = next(o for o in mesh["organs"] if o["id"] == "skeleton")
        self.assertEqual(skeleton["provenance"], "REFERENCE")
        self.assertEqual(skeleton["status"], "UNOBSERVED")
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
