"""MESH 3-of-4 quorum. Matches src/lib/immune/mesh.ts.

A vote counts toward the quorum only when its surface was actually observed
(provenance LIVE for this process, OBSERVED for a probed estate surface) and
the observed stage is a ready stage. A provenance label alone never makes a
vote live: an observed NOT_READY / READ_ONLY / UNAVAILABLE / UNOBSERVED stage
does not count.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

ORGAN_IDS = ("immune", "a11oy", "killinchu", "khipu")
READY_STAGES = frozenset({"LIVE", "WRITE-READY", "READY", "RUNNING", "TRAINED"})
EXPECTED_PROVENANCE = {oid: "LIVE" if oid == "immune" else "OBSERVED" for oid in ORGAN_IDS}


def vote_is_live(surface: dict[str, Any]) -> bool:
    return (
        surface.get("id") in EXPECTED_PROVENANCE
        and surface.get("provenance") == EXPECTED_PROVENANCE[surface["id"]]
        and surface.get("stage") in READY_STAGES
    )


def _vote(oid: str, surface: dict[str, Any] | None) -> dict[str, Any]:
    if not surface:
        return {
            "id": oid,
            "title": oid,
            "live": False,
            "stage": "UNAVAILABLE",
            "provenance": "UNAVAILABLE",
            "href": "",
            "detail": "not observed",
        }
    return {
        "id": oid,
        "title": surface.get("title") or oid,
        "live": vote_is_live(surface),
        "stage": surface.get("stage") or "UNAVAILABLE",
        "provenance": surface.get("provenance") or "UNAVAILABLE",
        "href": surface.get("href") or "",
        "detail": surface.get("detail") or "",
    }


def mesh_from_surfaces(surfaces: list[dict[str, Any]]) -> dict[str, Any]:
    votes = [
        _vote(oid, next((row for row in surfaces if row.get("id") == oid), None))
        for oid in ORGAN_IDS
    ]
    live_count = sum(1 for row in votes if row["live"])
    reached = live_count >= 3
    return {
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "required": 3,
        "of": 4,
        "liveCount": live_count,
        "reached": reached,
        "provenance": "LIVE"
        if reached or any(row["live"] for row in votes)
        else "UNAVAILABLE",
        "votes": votes,
    }
