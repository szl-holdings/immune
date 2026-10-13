"""MESH 3-of-4 quorum projection over observed organ surfaces.

This module was originally written to mirror a TypeScript module at
``src/lib/immune/mesh.ts``. That module is not in this repository, so parity
with it is not checked or asserted here; this file is the reference.

A vote counts toward the quorum only when all of these hold:

* the surface carries a known organ identity (``ORGAN_IDS``);
* its provenance is the one bound to that identity: ``LIVE`` for this process
  (``immune``) and ``OBSERVED`` for every external estate organ. A remote row
  labelled ``LIVE`` or a local row labelled ``OBSERVED`` never counts;
* its stage is a ready stage (``READY_STAGES``);
* the identity is not contradicted by another row. Repeated identical rows
  collapse into one vote; conflicting rows for one identity fail closed.

Rows with an unknown, missing or non-string identity are ignored and can never
add a vote. A provenance label alone never makes a vote live.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

ORGAN_IDS = ("immune", "a11oy", "killinchu", "khipu")
LOCAL_ORGAN_ID = "immune"
READY_STAGES = frozenset({"LIVE", "WRITE-READY", "READY", "RUNNING", "TRAINED"})
EXPECTED_PROVENANCE = {
    oid: "LIVE" if oid == LOCAL_ORGAN_ID else "OBSERVED" for oid in ORGAN_IDS
}
QUORUM_REQUIRED = 3


def _identity(surface: Any) -> str | None:
    if not isinstance(surface, dict):
        return None
    oid = surface.get("id")
    return oid if isinstance(oid, str) and oid in EXPECTED_PROVENANCE else None


def vote_reason(surface: Any) -> str | None:
    """Return None when this single surface is a live vote, else why not."""
    oid = _identity(surface)
    if oid is None:
        return "unknown organ identity"
    provenance = surface.get("provenance")
    expected = EXPECTED_PROVENANCE[oid]
    if provenance != expected:
        return f"provenance {provenance!r} is not valid for {oid} (requires {expected})"
    stage = surface.get("stage")
    if stage not in READY_STAGES:
        return f"stage {stage!r} is not a ready stage"
    return None


def vote_is_live(surface: Any) -> bool:
    return vote_reason(surface) is None


def _missing(oid: str) -> dict[str, Any]:
    return {
        "id": oid,
        "title": oid,
        "live": False,
        "stage": "UNAVAILABLE",
        "provenance": "UNAVAILABLE",
        "href": "",
        "detail": "not observed",
        "reason": "no surface for this organ",
    }


def _conflict(oid: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    claims = sorted({f"{row.get('stage')!r}/{row.get('provenance')!r}" for row in rows})
    return {
        "id": oid,
        "title": oid,
        "live": False,
        "stage": "CONFLICT",
        "provenance": "UNAVAILABLE",
        "href": "",
        "detail": f"{len(rows)} conflicting surfaces claim {oid}: {', '.join(claims)}",
        "reason": "conflicting duplicate identity fails closed",
    }


def _vote(oid: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return _missing(oid)
    surface = rows[0]
    # Duplicates may collapse into one vote only when they agree on everything
    # the vote predicate reads; any disagreement is contradictory evidence.
    if any(
        (row.get("stage"), row.get("provenance"))
        != (surface.get("stage"), surface.get("provenance"))
        for row in rows[1:]
    ):
        return _conflict(oid, rows)
    reason = vote_reason(surface)
    return {
        "id": oid,
        "title": surface.get("title") or oid,
        "live": reason is None,
        "stage": surface.get("stage") or "UNAVAILABLE",
        "provenance": surface.get("provenance") or "UNAVAILABLE",
        "href": surface.get("href") or "",
        "detail": surface.get("detail") or "",
        "reason": reason or "counted",
    }


def mesh_from_surfaces(surfaces: list[dict[str, Any]]) -> dict[str, Any]:
    by_id: dict[str, list[dict[str, Any]]] = {oid: [] for oid in ORGAN_IDS}
    for row in surfaces or ():
        oid = _identity(row)
        if oid is not None:
            by_id[oid].append(row)
    votes = [_vote(oid, by_id[oid]) for oid in ORGAN_IDS]
    live_count = sum(1 for row in votes if row["live"])
    reached = live_count >= QUORUM_REQUIRED
    return {
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "required": QUORUM_REQUIRED,
        "of": len(ORGAN_IDS),
        "liveCount": live_count,
        "reached": reached,
        "provenance": "LIVE"
        if reached or any(row["live"] for row in votes)
        else "UNAVAILABLE",
        "votes": votes,
    }
