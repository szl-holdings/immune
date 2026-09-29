import json
import tempfile
import unittest
from pathlib import Path

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
        self.assertIn("- scripts/attest_hf_space_runtime.py", text)


if __name__ == "__main__":
    unittest.main()
