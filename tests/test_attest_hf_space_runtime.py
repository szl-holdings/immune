import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from scripts import attest_hf_space_runtime as attest

SPACE = "SZLHOLDINGS/immune-lattice"
HUB = "a" * 40
OLD = "b" * 40
SOURCE = "c" * 40


def space_payload(*, repo=HUB, running=HUB, stage="RUNNING", error=""):
    body = {
        "sha": repo,
        "runtime": {"stage": stage, "sha": running, "errorMessage": error},
    }
    return 200, json.dumps(body).encode()


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class Sequence:
    """Serve API observations in order, repeating the last one."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        if len(self.responses) > 1:
            return self.responses.pop(0)
        return self.responses[0]


class WaitRunningTests(unittest.TestCase):
    def run_wait(self, fetch, timeout=120.0):
        clock = Clock()
        return attest.wait_running(
            SPACE,
            HUB,
            timeout=timeout,
            poll=15.0,
            fetch=fetch,
            sleep=clock.sleep,
            clock=clock,
        )

    def test_exact_running_build_is_accepted(self):
        fetch = Sequence(space_payload())
        state = self.run_wait(fetch)
        self.assertEqual(
            state, {"stage": "RUNNING", "repo_sha": HUB, "runtime_sha": HUB}
        )
        self.assertEqual(fetch.urls, ["https://huggingface.co/api/spaces/" + SPACE])

    def test_old_build_still_running_is_polled_not_accepted(self):
        fetch = Sequence(
            space_payload(running=OLD),
            space_payload(stage="BUILDING", running=OLD),
            space_payload(),
        )
        self.assertEqual(self.run_wait(fetch)["runtime_sha"], HUB)
        self.assertEqual(len(fetch.urls), 3)

    def test_head_lag_after_commit_is_polled(self):
        fetch = Sequence(space_payload(repo=OLD, running=OLD), space_payload())
        self.assertEqual(self.run_wait(fetch)["repo_sha"], HUB)

    def test_superseded_head_times_out(self):
        fetch = Sequence(space_payload(repo=OLD, running=OLD))
        with self.assertRaisesRegex(
            attest.AttestationError, "HF_SPACE_RUNNING_TIMEOUT"
        ):
            self.run_wait(fetch)

    def test_terminal_stage_at_published_commit_fails_immediately(self):
        for stage in ("BUILD_ERROR", "CONFIG_ERROR", "RUNTIME_ERROR"):
            fetch = Sequence(space_payload(stage=stage, running=OLD, error="boom"))
            with (
                self.subTest(stage=stage),
                self.assertRaisesRegex(attest.AttestationError, f"HF_SPACE_{stage}"),
            ):
                self.run_wait(fetch)
            self.assertEqual(len(fetch.urls), 1)

    def test_paused_and_quota_are_terminal(self):
        with self.assertRaisesRegex(attest.AttestationError, "HF_SPACE_PAUSED"):
            self.run_wait(Sequence(space_payload(stage="PAUSED")))
        with self.assertRaisesRegex(attest.AttestationError, "HF_SPACE_QUOTA_EXCEEDED"):
            self.run_wait(
                Sequence(space_payload(stage="RUNTIME_ERROR", error="Quota exceeded"))
            )

    def test_api_failures_are_polled_then_time_out(self):
        fetch = Sequence((503, b""), (200, b"not json"))
        with self.assertRaisesRegex(
            attest.AttestationError, "HF_SPACE_RUNNING_TIMEOUT"
        ):
            self.run_wait(fetch, timeout=60.0)
        self.assertGreater(len(fetch.urls), 2)


class SmokeTests(unittest.TestCase):
    def test_paths_are_probed_on_the_owned_space_host(self):
        fetch = Sequence((200, b"{}"))
        results = attest.smoke(
            SPACE, ["/healthz", "/health"], fetch=fetch, sleep=lambda _: None
        )
        self.assertEqual(
            fetch.urls,
            [
                "https://szlholdings-immune-lattice.hf.space/healthz",
                "https://szlholdings-immune-lattice.hf.space/health",
            ],
        )
        self.assertEqual([row["status"] for row in results], [200, 200])

    def test_transient_failure_is_retried_then_fails_closed(self):
        fetch = Sequence((502, b""), (200, b"ok"))
        self.assertEqual(
            attest.smoke(SPACE, ["/"], fetch=fetch, sleep=lambda _: None)[0]["status"],
            200,
        )
        with self.assertRaisesRegex(
            attest.AttestationError, "SMOKE_FAILED: /healthz HTTP 404"
        ):
            attest.smoke(
                SPACE, ["/healthz"], fetch=Sequence((404, b"")), sleep=lambda _: None
            )
        with self.assertRaisesRegex(attest.AttestationError, "SMOKE_FAILED"):
            attest.smoke(
                SPACE, ["/healthz"], fetch=Sequence((200, b"")), sleep=lambda _: None
            )

    def test_unsafe_paths_and_unowned_spaces_are_refused(self):
        for path in ("healthz", "//evil.example/", "/../x"):
            with self.subTest(path=path), self.assertRaises(attest.AttestationError):
                attest.smoke(
                    SPACE, [path], fetch=Sequence((200, b"x")), sleep=lambda _: None
                )
        with self.assertRaisesRegex(attest.AttestationError, "UNSUPPORTED_SPACE"):
            attest.space_host("SZLHOLDINGS/other")

    def test_failed_readiness_retains_blockers_without_accepting_503(self):
        body = json.dumps({
            "schema": "szl.immune-readiness/v1",
            "status": "NOT_READY",
            "ready": False,
            "runtime_ready": False,
            "read_ready": False,
            "authority_ready": False,
            "write_ready": False,
            "blockers": ["RECEIPT_LEDGER_EMPTY", "ACTION_AUTHORITY_UNAVAILABLE"],
            "operator_token": "must-never-enter-the-receipt",
        }).encode()
        with self.assertRaises(attest.AttestationError) as caught:
            attest.smoke(
                SPACE, ["/healthz", "/readyz"],
                fetch=Sequence((200, b"ok"), (503, body)),
                attempts=1, sleep=lambda _: None,
            )
        rows = caught.exception.observations
        self.assertEqual([row["status"] for row in rows], [200, 503])
        self.assertEqual(rows[-1]["bytes"], len(body))
        self.assertEqual(rows[-1]["readiness"]["blockers"], [
            "RECEIPT_LEDGER_EMPTY", "ACTION_AUTHORITY_UNAVAILABLE",
        ])
        self.assertNotIn("must-never-enter-the-receipt", json.dumps(rows))
        self.assertNotIn("operator_token", json.dumps(rows))

    def test_oversized_success_response_is_not_accepted(self):
        with self.assertRaises(attest.AttestationError) as caught:
            attest.smoke(
                SPACE, ["/healthz"], attempts=1,
                fetch=Sequence((200, b"x" * (attest.MAX_BODY_BYTES + 1))),
                sleep=lambda _: None,
            )
        self.assertEqual(caught.exception.observations[0]["status"], 200)

    def test_invalid_readiness_fields_are_not_copied(self):
        diagnostic = attest.readiness_diagnostic(json.dumps({
            "schema": "szl.immune-readiness/v1", "status": "SECRET_TOKEN",
            "ready": 1, "blockers": ["ACTION_AUTHORITY_UNAVAILABLE", "secret value"],
        }).encode())
        self.assertEqual(diagnostic, {"schema": "szl.immune-readiness/v1"})


class BlockedReadinessTests(unittest.TestCase):
    def body(self, space=SPACE, **changes):
        source = {"repository": "szl-holdings/immune", "revision": SOURCE}
        if space == SPACE:
            source["channel"] = "python"
            blockers = ["RECEIPT_LEDGER_EMPTY", "ACTION_AUTHORITY_UNAVAILABLE"]
        else:
            source.update({"build_revision": SOURCE,
                           "manifest_schema": "szl.hf-deploy-manifest/v2",
                           "alignment_state": "REVISION_UNAVAILABLE"})
            blockers = ["DEPLOYMENT_REVISION_BINDING_UNVERIFIED",
                        "ACTION_AUTHORITY_READ_ONLY",
                        "RECEIPT_LEDGER_DURABILITY_UNVERIFIED"]
        payload = {"schema": "szl.immune-readiness/v1", "status": "NOT_READY",
                   "ready": False, "runtime_ready": False, "read_ready": False,
                   "authority_ready": False, "write_ready": False,
                   "source": source, "blockers": blockers, "ok": False}
        if space != SPACE:
            payload.update(build={"state": "OBSERVED_HASH_MATCH"},
                           runtime={"artifact_integrity": {"status": "MATCH"}})
        payload.update(changes)
        return json.dumps(payload).encode()

    def test_channel_b_exact_source_blocked_readiness_is_observed_not_authorized(self):
        body = self.body(operator_token="never-copy-me")
        result = attest.blocked_readiness(SPACE, SOURCE, fetch=Sequence((503, body)))
        self.assertEqual(result["status"], 503)
        self.assertEqual(result["readiness"]["blockers"],
                         ["RECEIPT_LEDGER_EMPTY", "ACTION_AUTHORITY_UNAVAILABLE"])
        self.assertEqual(result["readiness"]["source_revision"], SOURCE)
        self.assertNotIn("operator_token", json.dumps(result))
        self.assertNotIn("never-copy-me", json.dumps(result))

    def test_channel_a_read_only_and_revision_unavailable_are_distinct(self):
        channel_a = "SZLHOLDINGS/immune"
        blocked = attest.blocked_readiness(channel_a, SOURCE,
                                           fetch=Sequence((503, self.body(channel_a))))
        self.assertEqual(blocked["readiness"]["status"], "NOT_READY")
        read_only = self.body(
            channel_a, status="READ_ONLY", runtime_ready=True, read_ready=True,
            source={"repository": "szl-holdings/immune", "revision": SOURCE,
                    "build_revision": SOURCE,
                    "manifest_schema": "szl.hf-deploy-manifest/v2",
                    "alignment_state": "OBSERVED_RUNTIME_HASH_MATCH"},
            blockers=["ACTION_AUTHORITY_READ_ONLY",
                      "RECEIPT_LEDGER_DURABILITY_UNVERIFIED"])
        observed = attest.blocked_readiness(channel_a, SOURCE,
                                            fetch=Sequence((503, read_only)))
        self.assertEqual(observed["readiness"]["status"], "READ_ONLY")

    def test_bad_status_schema_source_fields_and_boolean_contradictions_fail(self):
        cases = [
            (200, self.body()),
            (502, self.body()),
            (503, b"not json"),
            (503, self.body(schema="other")),
            (503, self.body(status="READY")),
            (503, self.body(ready=True)),
            (503, self.body(write_ready=True)),
            (503, self.body(authority_ready=True)),
            (503, self.body(ok=True)),
            (503, self.body(runtime_ready=True)),
            (503, self.body(source={"repository": "szl-holdings/immune",
                                    "revision": OLD, "channel": "python"})),
            (503, self.body(source={"repository": "szl-holdings/immune",
                                    "revision": SOURCE, "channel": "typescript"})),
            (503, self.body(blockers=["RECEIPT_LEDGER_INTEGRITY_FAILED",
                                          "ACTION_AUTHORITY_UNAVAILABLE"])),
            (503, self.body(blockers=[])),
            (503, self.body() + b" " * attest.MAX_READINESS_BYTES),
            (503, self.body().replace(b'"ready": false',
                                       b'"ready": true, "ready": false')),
        ]
        for status, body in cases:
            with self.subTest(status=status, body=body[:30]), \
                    self.assertRaises(attest.AttestationError):
                attest.blocked_readiness(SPACE, SOURCE,
                                         fetch=Sequence((status, body)))

    def test_channel_a_rejects_build_mismatch_and_lost_ledger(self):
        channel_a = "SZLHOLDINGS/immune"
        for body in (
            self.body(channel_a, source={"repository": "szl-holdings/immune",
                                         "revision": SOURCE, "build_revision": OLD,
                                         "manifest_schema": "szl.hf-deploy-manifest/v2",
                                         "alignment_state": "REVISION_UNAVAILABLE"}),
            self.body(channel_a, blockers=["RECEIPT_LEDGER_EMPTY",
                                           "ACTION_AUTHORITY_READ_ONLY"]),
            self.body(channel_a, build=None),
            self.body(channel_a, runtime={"artifact_integrity": None}),
        ):
            with self.assertRaises(attest.AttestationError):
                attest.blocked_readiness(channel_a, SOURCE,
                                         fetch=Sequence((503, body)))

    def test_fetch_failure_is_sanitized(self):
        def fail(_url):
            raise urllib.error.URLError("private upstream detail")

        with self.assertRaisesRegex(attest.AttestationError,
                                    "BLOCKED_READINESS_FETCH_FAILED") as caught:
            attest.blocked_readiness(SPACE, SOURCE, fetch=fail)
        self.assertNotIn("private upstream detail", str(caught.exception))


class HttpFailureTests(unittest.TestCase):
    def test_http_error_body_is_bounded_and_response_is_closed(self):
        stream = io.BytesIO(b"x" * (attest.MAX_BODY_BYTES + 10))
        error = urllib.error.HTTPError("https://example.invalid/readyz", 503, "not ready", {}, stream)
        with patch.object(attest.urllib.request, "urlopen", side_effect=error):
            status, body = attest.http_get("https://example.invalid/readyz")
        self.assertEqual(status, 503)
        self.assertEqual(len(body), attest.MAX_BODY_BYTES + 1)
        self.assertTrue(stream.closed)


class PublicationReceiptTests(unittest.TestCase):
    def write(self, **fields):
        receipt = {
            "space": SPACE,
            "state": "COMMITTED_LIVE_UNVERIFIED",
            "hub_commit": HUB,
            "source_revision": SOURCE,
        }
        receipt.update(fields)
        directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        path = directory / "channel.json"
        path.write_text(json.dumps(receipt), encoding="utf-8")
        return path

    def test_committed_receipt_yields_exact_identities(self):
        self.assertEqual(
            attest.load_publication(self.write(), SPACE),
            {"hub_commit": HUB, "source_revision": SOURCE},
        )

    def test_uncommitted_or_mismatched_receipts_are_refused(self):
        cases = {
            "PUBLICATION_RECEIPT_SPACE_MISMATCH": {"space": "SZLHOLDINGS/immune"},
            "PUBLICATION_NOT_COMMITTED": {"state": "BLOCKED_BEFORE_ATTEMPT"},
            "PUBLICATION_RECEIPT_INVALID_COMMIT": {"hub_commit": "main"},
            "PUBLICATION_RECEIPT_INVALID_SOURCE": {"source_revision": None},
        }
        for code, fields in cases.items():
            with (
                self.subTest(code=code),
                self.assertRaisesRegex(attest.AttestationError, code),
            ):
                attest.load_publication(self.write(**fields), SPACE)
        with self.assertRaisesRegex(
            attest.AttestationError, "PUBLICATION_RECEIPT_UNAVAILABLE"
        ):
            attest.load_publication(Path("does/not/exist.json"), SPACE)

    def test_main_writes_failed_smoke_evidence_and_keeps_failure_exit(self):
        publication = self.write()
        receipt = publication.parent / "live.json"
        observations = [{"path": "/readyz", "status": 503, "bytes": 42,
                         "readiness": {"schema": "szl.immune-readiness/v1",
                                       "status": "NOT_READY", "write_ready": False,
                                       "blockers": ["ACTION_AUTHORITY_UNAVAILABLE"]}}]
        failure = attest.AttestationError("SMOKE_FAILED: /readyz HTTP 503 bytes=42", observations=observations)
        with (
            patch.object(attest, "wait_running", return_value={"stage": "RUNNING", "repo_sha": HUB, "runtime_sha": HUB}),
            patch.object(attest, "smoke", side_effect=failure),
            patch("builtins.print"),
        ):
            code = attest.main(["--space", SPACE, "--publication-receipt", str(publication),
                                "--receipt", str(receipt), "--smoke-path", "/readyz"])
        saved = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(code, 1)
        self.assertEqual(saved["state"], "NOT_VERIFIED")
        self.assertFalse(saved["live_verified"])
        self.assertEqual(saved["smoke"], observations)

    def test_main_records_blocked_source_live_without_live_or_action_qualification(self):
        publication = self.write()
        receipt = publication.parent / "source-live.json"
        observation = {"path": "/readyz", "status": 503, "bytes": 1,
                       "readiness": {"status": "NOT_READY", "source_revision": SOURCE}}
        with (
            patch.object(attest, "wait_running", return_value={"stage": "RUNNING", "repo_sha": HUB, "runtime_sha": HUB}),
            patch.object(attest, "smoke", return_value=[{"path": "/healthz", "status": 200, "bytes": 2}]),
            patch.object(attest, "blocked_readiness", return_value=observation),
            patch("builtins.print"),
        ):
            code = attest.main(["--space", SPACE, "--publication-receipt", str(publication),
                                "--receipt", str(receipt), "--smoke-path", "/healthz",
                                "--blocked-readiness"])
        saved = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(saved["state"], "SOURCE_LIVE_READINESS_BLOCKED")
        self.assertTrue(saved["source_live_verified"])
        self.assertFalse(saved["live_verified"])
        self.assertFalse(saved["action_ready"])
        self.assertEqual(saved["blocked_readiness"], observation)

    def test_main_keeps_strict_smoke_proof_when_blocked_readiness_fails(self):
        publication = self.write()
        receipt = publication.parent / "blocked-readiness-failed.json"
        smoke = [{"path": "/healthz", "status": 200, "bytes": 2}]
        blocked = {"path": "/readyz", "status": 502, "bytes": 0}
        with (
            patch.object(attest, "wait_running", return_value={"stage": "RUNNING", "repo_sha": HUB, "runtime_sha": HUB}),
            patch.object(attest, "smoke", return_value=smoke),
            patch.object(attest, "blocked_readiness", side_effect=attest.AttestationError(
                "BLOCKED_READINESS_HTTP_OR_SIZE_INVALID", observations=[blocked])),
            patch("builtins.print"),
        ):
            code = attest.main(["--space", SPACE, "--publication-receipt", str(publication),
                                "--receipt", str(receipt), "--smoke-path", "/healthz",
                                "--blocked-readiness"])
        saved = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(code, 1)
        self.assertEqual(saved["state"], "NOT_VERIFIED")
        self.assertEqual(saved["smoke"], smoke)
        self.assertEqual(saved["blocked_readiness"], blocked)
        self.assertFalse(saved["source_live_verified"])
        self.assertFalse(saved["live_verified"])
        self.assertFalse(saved["action_ready"])


class WorkflowWiringTests(unittest.TestCase):
    def test_each_channel_attests_its_own_space_with_a_per_asset_lock(self):
        root = Path(__file__).resolve().parents[1]
        text = (root / ".github/workflows/deploy-hf-space.yml").read_text(
            encoding="utf-8"
        )
        for channel, space in (
            ("a", "SZLHOLDINGS/immune"),
            ("b", "SZLHOLDINGS/immune-lattice"),
        ):
            with self.subTest(space=space):
                self.assertIn(f"group: hf-write/space/{space}", text)
                self.assertIn(
                    f"--publication-receipt reports/publication-boundary/channel-{channel}.json",
                    text,
                )
                self.assertIn(
                    f"--receipt reports/publication-boundary/channel-{channel}-live.json",
                    text,
                )
        self.assertEqual(text.count("python3 -m scripts.attest_hf_space_runtime"), 2)
        for path in ("/healthz", "/health"):
            self.assertEqual(text.count(f"--smoke-path {path} "), 2)
        self.assertEqual(text.count("--blocked-readiness"), 2)
        self.assertNotIn("--smoke-path /readyz", text)
        self.assertIn("- scripts/attest_hf_space_runtime.py", text)


if __name__ == "__main__":
    unittest.main()
