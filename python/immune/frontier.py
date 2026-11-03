"""Modeled, non-executable shadow output for the legacy flat Python interface.

Caller-supplied freshness/calibration are assertions, not authenticated evidence.
This adapter is not a portable TS DecisionGenome validator or an authority gate.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Any

SCHEMA_ID = "urn:szl:contracts:decision-genome:v1"


def _number(name: str, value: Any, *, unit_interval: bool = True) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite JSON number")
    try:
        number = float(value)
    except OverflowError as exc:
        raise ValueError(f"{name} must be finite") from exc
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    if unit_interval and not 0 <= number <= 1:
        raise ValueError(f"{name} must be between 0 and 1")
    return number


def _conformal_p(score: float, calibration: list[float]) -> float | None:
    if len(calibration) < 20:
        return None
    at_least = sum(1 for item in calibration if item >= score)
    return (1 + at_least) / (len(calibration) + 1)


def evaluate_frontier(inp: dict[str, Any]) -> dict[str, Any]:
    novelty = _number("novelty", inp.get("novelty", 0))
    danger = _number("dangerContext", inp.get("dangerContext", 0))
    baseline = _number("baselineAnomaly", inp.get("baselineAnomaly", 0))
    causal = _number("causalShift", inp.get("causalShift", 0))
    prop = _number("propagationRisk", inp.get("propagationRisk", 0))
    composite = round(0.25 * novelty + 0.3 * danger + 0.2 * baseline + 0.15 * causal + 0.1 * prop, 4)
    supplied_calibration = inp.get("calibrationScores")
    if supplied_calibration is None:
        supplied_calibration = []
    if not isinstance(supplied_calibration, list) or len(supplied_calibration) > 10_000:
        raise ValueError("calibrationScores must be a list of at most 10000 scores")
    cal = [_number(f"calibrationScores[{i}]", value) for i, value in enumerate(supplied_calibration)]
    p_value = _conformal_p(composite, cal)
    age = None if inp.get("sourceAgeMinutes") is None else _number(
        "sourceAgeMinutes", inp["sourceAgeMinutes"], unit_interval=False,
    )
    if age is None:
        freshness = "UNAVAILABLE"
    elif age < 0:
        freshness = "CONFLICTED"
    elif age <= 5:
        freshness = "LIVE"
    elif age <= 60:
        freshness = "CACHED"
    elif age <= 240:
        freshness = "STALE"
    else:
        freshness = "DEGRADED"
    unavailable = freshness in ("STALE", "DEGRADED", "UNAVAILABLE", "CONFLICTED")
    freshness_debt = 0.35 if unavailable else (0.1 if freshness == "CACHED" else 0)
    confidence = _number("sourceConfidence", inp.get("sourceConfidence", 0))
    uncertainty = min(1.0, 0.55 * (1 - confidence) + freshness_debt + (0.2 if p_value is None else 0))
    hard = inp.get("hardPolicyViolation", False)
    if not isinstance(hard, bool):
        raise ValueError("hardPolicyViolation must be a boolean")
    reason: list[str] = []
    if confidence < 0.5 or unavailable:
        state = "WITHHOLD"
        action = "REQUEST_READ_ONLY_PROBE" if freshness == "STALE" else "OPEN_INCIDENT"
        reason.append("PROVENANCE_OR_FRESHNESS_GATE")
        if hard:
            reason.append("HARD_POLICY_SIGNAL")
    elif hard:
        state = "QUARANTINE_RECOMMENDED"
        action = "REQUEST_QUARANTINE_REVIEW"
        reason.append("HARD_POLICY_SIGNAL")
    elif p_value is None:
        state = "REVIEW_REQUIRED"
        action = "OPEN_INCIDENT"
        reason.append("INSUFFICIENT_CALIBRATION")
    elif composite >= 0.72:
        state = "QUARANTINE_RECOMMENDED"
        action = "REQUEST_QUARANTINE_REVIEW"
        reason.append("COMPOSITE_RISK")
    elif composite >= 0.45 or uncertainty >= 0.55:
        state = "REVIEW_REQUIRED"
        action = "OPEN_INCIDENT"
        reason.append("UNCERTAINTY_OR_MID_RISK")
    else:
        state = "ALLOW_OBSERVE"
        action = "OBSERVE"
        reason.append("WITHIN_SHADOW_BAND")

    rec = {
        "state": state,
        "action": action,
        "reasonCodes": reason,
        "humanApprovalRequired": state != "ALLOW_OBSERVE",
        "executable": False,
        "evidenceLabel": "MODELED",
    }
    subject = {"kind": inp.get("subjectKind") or "observation", "id": inp.get("subjectId") or "unknown", "digest": hashlib.sha256(json.dumps(inp, sort_keys=True, allow_nan=False).encode()).hexdigest()}
    genome = {
        "schemaId": SCHEMA_ID,
        "decisionId": inp.get("observationId") or "obs",
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "mode": "shadow",
        "digest": hashlib.sha256(json.dumps({"subject": subject, "composite": composite, "rec": rec}, sort_keys=True).encode()).hexdigest(),
        "subject": subject,
        "scores": {
            "novelty": novelty,
            "dangerContext": danger,
            "baselineAnomaly": baseline,
            "causalShift": causal,
            "propagationRisk": prop,
            "compositeRisk": composite,
            "conformalPValue": p_value,
            "uncertainty": round(uncertainty, 4),
        },
        "recommendation": rec,
        "sourceState": freshness,
    }
    return genome
