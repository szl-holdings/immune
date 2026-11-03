"""Offline shadow-evidence regressions; no runtime, handler, model or network."""
from __future__ import annotations

import importlib.util
import math
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "frontier_evidence_under_test",
    Path(__file__).resolve().parents[1] / "immune" / "frontier.py",
)
assert SPEC is not None and SPEC.loader is not None
frontier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(frontier)


def observation(**overrides):
    data = {
        "observationId": "fixture:offline-shadow",
        "sourceAgeMinutes": 0,
        "sourceConfidence": 0.9,
        "calibrationScores": [0.1] * 40,
    }
    data.update(overrides)
    return data


class FrontierEvidenceGatesTests(unittest.TestCase):
    def test_labels_and_authority_cannot_be_inherited(self):
        for label in ("PROVED", "MEASURED", "VERIFIED", "LIVE", "OPERATIONAL", None):
            with self.subTest(label=label):
                result = frontier.evaluate_frontier(observation(
                    evidenceLabel=label, executable=True, mode="operational",
                    authorizationLease={"verification": "VERIFIED"},
                ))
                self.assertEqual(result["recommendation"]["evidenceLabel"], "MODELED")
                self.assertIs(result["recommendation"]["executable"], False)
                self.assertEqual(result["mode"], "shadow")
                self.assertNotIn("authorizationLease", result)

    def test_missing_or_empty_calibration_is_not_generated(self):
        for calibration in (None, [], [0.1] * 19):
            data = observation(calibrationScores=calibration)
            if calibration is None:
                data.pop("calibrationScores")
            with self.subTest(calibration=calibration):
                result = frontier.evaluate_frontier(data)
                self.assertIsNone(result["scores"]["conformalPValue"])
                self.assertEqual(result["recommendation"]["state"], "REVIEW_REQUIRED")
                self.assertEqual(result["recommendation"]["action"], "OPEN_INCIDENT")
                self.assertTrue(result["recommendation"]["humanApprovalRequired"])
        self.assertIsNone(frontier.evaluate_frontier(
            observation(calibrationScores=None),
        )["scores"]["conformalPValue"])

    def test_absent_freshness_is_unavailable_not_live(self):
        for explicit_null in (False, True):
            data = observation()
            data.pop("sourceAgeMinutes")
            if explicit_null:
                data["sourceAgeMinutes"] = None
            result = frontier.evaluate_frontier(data)
            self.assertEqual(result["sourceState"], "UNAVAILABLE")
            self.assertEqual(result["recommendation"]["state"], "WITHHOLD")

    def test_future_age_is_conflicted(self):
        result = frontier.evaluate_frontier(observation(sourceAgeMinutes=-1))
        self.assertEqual(result["sourceState"], "CONFLICTED")
        self.assertEqual(result["recommendation"]["state"], "WITHHOLD")

    def test_legitimate_freshness_and_hard_policy_controls_remain(self):
        for age, expected in ((0, "LIVE"), (5, "LIVE"), (6, "CACHED"),
                              (60, "CACHED"), (61, "STALE"), (240, "STALE"),
                              (241, "DEGRADED")):
            result = frontier.evaluate_frontier(observation(sourceAgeMinutes=age))
            self.assertEqual(result["sourceState"], expected)
            if expected in ("STALE", "DEGRADED"):
                self.assertEqual(result["recommendation"]["state"], "WITHHOLD")
        result = frontier.evaluate_frontier(observation(hardPolicyViolation=True))
        self.assertEqual(result["recommendation"]["state"], "QUARANTINE_RECOMMENDED")
        self.assertFalse(result["recommendation"]["executable"])
        result = frontier.evaluate_frontier(observation(sourceConfidence=0.1))
        self.assertEqual(result["recommendation"]["state"], "WITHHOLD")
        result = frontier.evaluate_frontier(observation(
            hardPolicyViolation=True, sourceAgeMinutes=None,
        ))
        self.assertEqual(result["recommendation"]["state"], "WITHHOLD")
        self.assertIn("HARD_POLICY_SIGNAL", result["recommendation"]["reasonCodes"])
        self.assertEqual(frontier.evaluate_frontier(observation())["recommendation"]["action"], "OBSERVE")

    def test_existing_risk_formula_and_policy_thresholds_are_unchanged(self):
        for score, state in ((0.1, "ALLOW_OBSERVE"), (0.46, "REVIEW_REQUIRED"),
                             (0.73, "QUARANTINE_RECOMMENDED")):
            result = frontier.evaluate_frontier(observation(
                novelty=score, dangerContext=score, baselineAnomaly=score,
                causalShift=score, propagationRisk=score,
            ))
            self.assertEqual(result["scores"]["compositeRisk"], score)
            self.assertEqual(result["recommendation"]["state"], state)

    def test_invalid_numeric_metadata_does_not_enter_hashes_or_confidence(self):
        for key in ("novelty", "dangerContext", "baselineAnomaly", "causalShift",
                    "propagationRisk", "sourceConfidence", "sourceAgeMinutes"):
            for value in (True, "0", math.nan, math.inf, -math.inf, 10**400):
                with self.subTest(key=key, value=repr(value)):
                    with self.assertRaises(ValueError):
                        frontier.evaluate_frontier(observation(**{key: value}))
        for values in ([math.nan] * 20, [True] * 20, ["0.1"] * 20, [1.1] * 20,
                       [0.1] * 10001, "calibration"):
            with self.subTest(values=repr(values)[:80]):
                with self.assertRaises(ValueError):
                    frontier.evaluate_frontier(observation(calibrationScores=values))

    def test_conformal_statistic_requires_actual_supplied_scores(self):
        result = frontier.evaluate_frontier(observation(calibrationScores=[0.1] * 20))
        self.assertEqual(result["scores"]["conformalPValue"], 1.0)
        result = frontier.evaluate_frontier(observation(
            novelty=1, dangerContext=1, baselineAnomaly=1,
            causalShift=1, propagationRisk=1, calibrationScores=[0.1] * 20,
        ))
        self.assertAlmostEqual(result["scores"]["conformalPValue"], 1 / 21)
        self.assertEqual(result["recommendation"]["state"], "QUARANTINE_RECOMMENDED")

    def test_handler_reports_validation_errors_without_starting_a_server(self):
        from immune.server import Handler

        for path in ("/api/immune/frontier", "/api/immune/agent/frontier/evaluate"):
            for data, code in ((observation(novelty=float("nan")), 400),
                               (observation(), 200)):
                responses = []
                handler = SimpleNamespace(
                    path=path, _read_json=lambda: data,
                    _json=lambda status, body: responses.append((status, body)),
                )
                # No runtime construction, sockets, persistent data or authority calls.
                with patch("immune.server.get_runtime", return_value=object()):
                    Handler.do_POST(handler)
                self.assertEqual(responses[0][0], code)
                if code == 400:
                    self.assertEqual(responses[0][1]["error"], "INVALID_FRONTIER_INPUT")
                else:
                    self.assertEqual(responses[0][1]["recommendation"]["evidenceLabel"], "MODELED")


if __name__ == "__main__":
    unittest.main()
