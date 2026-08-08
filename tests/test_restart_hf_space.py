import types
import unittest
from unittest import mock

from scripts.restart_hf_space import RestartContractError, restart_repository_space


REVISION = "a" * 40


class RestartHfSpaceTests(unittest.TestCase):
    def api(self, *, revision=REVISION, stage="PAUSED", after_stage="BUILDING"):
        api = mock.Mock()
        api.space_info.side_effect = [
            types.SimpleNamespace(sha=revision),
            types.SimpleNamespace(sha=revision),
        ]
        api.get_space_runtime.side_effect = [
            types.SimpleNamespace(stage=stage),
            types.SimpleNamespace(stage=after_stage),
        ]
        api.restart_space.return_value = types.SimpleNamespace(stage="BUILDING")
        return api

    def test_explicit_repository_restart_records_evidence(self):
        api = self.api()
        evidence = restart_repository_space(
            "SZLHOLDINGS/immune",
            "restart repository SZLHOLDINGS/immune",
            "governed-token",
            api=api,
        )
        self.assertTrue(evidence.restarted)
        self.assertEqual(evidence.before_revision, REVISION)
        self.assertEqual(evidence.before_stage, "PAUSED")
        self.assertEqual(evidence.after_revision, REVISION)
        self.assertEqual(evidence.after_stage, "BUILDING")
        api.restart_space.assert_called_once_with(
            repo_id="SZLHOLDINGS/immune",
            token="governed-token",
        )

    def test_running_repository_does_not_restart(self):
        api = self.api(stage="RUNNING")
        evidence = restart_repository_space(
            "SZLHOLDINGS/immune",
            "restart repository SZLHOLDINGS/immune",
            "governed-token",
            api=api,
        )
        self.assertFalse(evidence.restarted)
        self.assertEqual(evidence.before_stage, "RUNNING")
        api.restart_space.assert_not_called()

    def test_revision_change_is_recorded_not_misrepresented_as_a_precondition(self):
        api = self.api()
        api.space_info.side_effect = [
            types.SimpleNamespace(sha=REVISION),
            types.SimpleNamespace(sha="b" * 40),
        ]
        evidence = restart_repository_space(
            "SZLHOLDINGS/immune",
            "restart repository SZLHOLDINGS/immune",
            "governed-token",
            api=api,
        )
        self.assertEqual(evidence.before_revision, REVISION)
        self.assertEqual(evidence.after_revision, "b" * 40)
        api.restart_space.assert_called_once()

    def test_invalid_identity_confirmation_and_missing_token_fail_closed(self):
        for repo_id, confirmation, token, message in (
            ("other-host", "restart repository other-host", "token", "repository id"),
            ("SZLHOLDINGS/immune", "restart the Space", "token", "confirmation"),
            (
                "SZLHOLDINGS/immune",
                "restart repository SZLHOLDINGS/immune",
                "",
                "HF_TOKEN",
            ),
        ):
            with self.subTest(message=message):
                with self.assertRaisesRegex(RestartContractError, message):
                    restart_repository_space(
                        repo_id,
                        confirmation,
                        token,
                        api=self.api(),
                    )


if __name__ == "__main__":
    unittest.main()
