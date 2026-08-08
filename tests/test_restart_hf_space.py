import types
import unittest
from unittest import mock

from scripts.restart_hf_space import RestartContractError, restart_if_paused


REVISION = "a" * 40


class RestartHfSpaceTests(unittest.TestCase):
    def api(self, *, revision=REVISION, stage="PAUSED"):
        api = mock.Mock()
        api.space_info.return_value = types.SimpleNamespace(sha=revision)
        api.get_space_runtime.return_value = types.SimpleNamespace(stage=stage)
        api.restart_space.return_value = types.SimpleNamespace(stage="BUILDING")
        return api

    def test_exact_paused_revision_restarts_once(self):
        api = self.api()
        self.assertTrue(
            restart_if_paused(
                "SZLHOLDINGS/immune",
                REVISION,
                "governed-token",
                api=api,
            )
        )
        api.restart_space.assert_called_once_with(
            repo_id="SZLHOLDINGS/immune",
            token="governed-token",
        )

    def test_running_revision_does_not_restart(self):
        api = self.api(stage="RUNNING")
        self.assertFalse(
            restart_if_paused(
                "SZLHOLDINGS/immune",
                REVISION,
                "governed-token",
                api=api,
            )
        )
        api.restart_space.assert_not_called()

    def test_revision_drift_fails_before_restart(self):
        api = self.api(revision="b" * 40)
        with self.assertRaisesRegex(RestartContractError, "advanced"):
            restart_if_paused(
                "SZLHOLDINGS/immune",
                REVISION,
                "governed-token",
                api=api,
            )
        api.restart_space.assert_not_called()

    def test_invalid_identity_and_missing_token_fail_closed(self):
        for repo_id, revision, token, message in (
            ("other-host", REVISION, "token", "repository id"),
            ("SZLHOLDINGS/immune", "not-a-sha", "token", "exact lowercase SHA"),
            ("SZLHOLDINGS/immune", REVISION, "", "HF_TOKEN"),
        ):
            with self.subTest(message=message):
                with self.assertRaisesRegex(RestartContractError, message):
                    restart_if_paused(repo_id, revision, token, api=self.api())


if __name__ == "__main__":
    unittest.main()
