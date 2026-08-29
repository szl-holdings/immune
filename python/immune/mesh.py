"""MESH 3-of-4 quorum. Matches src/lib/immune/mesh.ts."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

ORGAN_IDS = ("immune", "a11oy", "killinchu", "khipu")
LIVE_STAGES = {"LIVE", "WRITE-READY", "RUNNING", "READY", "TRAINED", "HUB", "OBSERVED"}


def _vote(oid: str, surface: dict[str, Any] | None) -> dict[str, Any]:
    if not surface:
        live = oid == "immune"
        return {
            "id": oid,
            "title": oid,
            "live": live,
            "stage": "WRITE-READY" if live else "UNAVAILABLE",
            "provenance": "LIVE" if live else "UNAVAILABLE",
            "href": "",
            "detail": "this process" if live else "not observed",
        }
    live = surface.get("provenance") == "LIVE" or surface.get("stage") in LIVE_STAGES
    return {
        "id": oid,
        "title": surface.get("title") or oid,
        "live": True if oid == "immune" else bool(live),
        "stage": surface.get("stage") or "LIVE",
        "provenance": surface.get("provenance") or "LIVE",
        "href": surface.get("href") or "",
        "detail": surface.get("detail") or "",
    }


def mesh_from_surfaces(surfaces: list[dict[str, Any]]) -> dict[str, Any]:
    votes = [_vote(oid, next((row for row in surfaces if row.get("id") == oid), None)) for oid in ORGAN_IDS]
    live_count = sum(1 for row in votes if row["live"])
    reached = live_count >= 3
    return {
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "required": 3,
        "of": 4,
        "liveCount": live_count,
        "reached": reached,
        "provenance": "LIVE" if reached or any(row["live"] for row in votes) else "UNAVAILABLE",
        "votes": votes,
    }
