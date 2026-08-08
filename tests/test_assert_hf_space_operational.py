import unittest

from scripts.assert_hf_space_operational import (
    SpaceOperationalBlocker,
    inspect_space_state,
)


REVISION = "a" * 40


def payload(*, revision=REVISION, stage="RUNNING", error=""):
    return {
        "sha": revision,
        "runtime": {
            "stage": stage,
            "errorMessage": error,
        },
    }


class HfSpaceOperationalStateTests(unittest.TestCase):
    def test_running_exact_revision_is_observed(self):
        observation = inspect_space_state(payload(), REVISION)
        self.assertTrue(observation.revision_matches)
        self.assertEqual(observation.stage, "RUNNING")
        self.assertEqual(observation.provider_error, "")

    def test_running_revision_drift_remains_visible(self):
        observation = inspect_space_state(payload(revision="b" * 40), REVISION)
        self.assertFalse(observation.revision_matches)
        self.assertEqual(observation.observed_revision, "b" * 40)

    def test_paused_quota_is_a_terminal_specific_blocker(self):
        with self.assertRaisesRegex(
            SpaceOperationalBlocker,
            r"HF_SPACE_QUOTA_EXCEEDED:.*stage=PAUSED.*current=6, limit=3",
        ):
            inspect_space_state(
                payload(
                    stage="PAUSED",
                    error="Quota exceeded for flavor cpu-basic (requested=1): "
                    "current=6, limit=3",
                ),
                REVISION,
            )

    def test_paused_without_quota_is_a_terminal_blocker(self):
        with self.assertRaisesRegex(SpaceOperationalBlocker, "HF_SPACE_PAUSED"):
            inspect_space_state(payload(stage="PAUSED"), REVISION)

    def test_quota_error_is_terminal_in_any_stage(self):
        with self.assertRaisesRegex(
            SpaceOperationalBlocker, "HF_SPACE_QUOTA_EXCEEDED"
        ):
            inspect_space_state(payload(stage="BUILDING", error="quota exceeded"), REVISION)

    def test_malformed_state_fails_closed(self):
        for bad_payload, bad_revision in (
            (None, REVISION),
            ({"sha": REVISION}, REVISION),
            ({"sha": "branch", "runtime": {"stage": "RUNNING"}}, REVISION),
            (payload(), "main"),
        ):
            with self.subTest(payload=bad_payload, revision=bad_revision):
                with self.assertRaisesRegex(
                    SpaceOperationalBlocker, "HF_SPACE_STATE_INVALID"
                ):
                    inspect_space_state(bad_payload, bad_revision)


if __name__ == "__main__":
    unittest.main()
