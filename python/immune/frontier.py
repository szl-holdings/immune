"""Shadow Decision Genome. Matches src/lib/immune/frontier.ts."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

SCHEMA_ID = "urn:szl:contracts:decision-genome:v1"


def default_calibration() -> list[float]:
    return [round(0.08 + (i % 7) * 0.04, 2) for i in range(40)]


def _conformal_p(score: float, calibration: list[float]) -> float | None:
    if len(calibration) < 20:
        return None
    at_least = sum(1 for item in calibration if item >= score)
    return (1 + at_least) / (len(calibration) + 1)


def evaluate_frontier(inp: dict[str, Any]) -> dict[str, Any]:
    novelty = float(inp.get("novelty") or 0)
    danger = float(inp.get("dangerContext") or 0)
    baseline = float(inp.get("baselineAnomaly") or 0)
    causal = float(inp.get("causalShift") or 0)
    prop = float(inp.get("propagationRisk") or 0)
    composite = round(0.25 * novelty + 0.3 * danger + 0.2 * baseline + 0.15 * causal + 0.1 * prop, 4)
    cal = inp.get("calibrationScores") or default_calibration()
    p_value = _conformal_p(composite, cal)
    age = float(inp.get("sourceAgeMinutes") or 0)
    if age <= 5:
        freshness = "LIVE"
    elif age <= 60:
        freshness = "CACHED"
    elif age <= 240:
        freshness = "STALE"
    else:
        freshness = "DEGRADED"
    freshness_debt = 0.35 if freshness in ("STALE", "DEGRADED") else (0.1 if freshness == "CACHED" else 0)
    confidence = float(inp.get("sourceConfidence") or 0)
    uncertainty = min(1.0, 0.55 * (1 - confidence) + freshness_debt + (0.2 if p_value is None else 0))
    hard = bool(inp.get("hardPolicyViolation"))
    reason: list[str] = []
    if confidence < 0.5 or freshness in ("STALE", "DEGRADED"):
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
        action = "REQUEST_HUMAN_REVIEW"
        reason.append("INSUFFICIENT_CALIBRATION")
    elif composite >= 0.72:
        state = "QUARANTINE_RECOMMENDED"
        action = "REQUEST_QUARANTINE_REVIEW"
        reason.append("COMPOSITE_RISK")
    elif composite >= 0.45 or uncertainty >= 0.55:
        state = "REVIEW_REQUIRED"
        action = "REQUEST_HUMAN_REVIEW"
        reason.append("UNCERTAINTY_OR_MID_RISK")
    else:
        state = "ALLOW_OBSERVE"
        action = "CONTINUE_OBSERVE"
        reason.append("WITHIN_SHADOW_BAND")

    evidence_label = inp.get("evidenceLabel") or ("LIVE" if freshness == "LIVE" else "MODELED")
    rec = {
        "state": state,
        "action": action,
        "reasonCodes": reason,
        "humanApprovalRequired": state != "ALLOW_OBSERVE",
        "executable": False,
        "evidenceLabel": evidence_label,
    }
    subject = {"kind": inp.get("subjectKind") or "observation", "id": inp.get("subjectId") or "unknown", "digest": hashlib.sha256(json.dumps(inp, sort_keys=True).encode()).hexdigest()}
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
