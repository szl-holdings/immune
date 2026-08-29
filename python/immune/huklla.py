"""HUKLLA tripwires T01–T10. Matches src/lib/immune/huklla.ts."""

from __future__ import annotations

from typing import Any

HUKLLA_REGISTRY: list[dict[str, str]] = [
    {"id": "T01", "name": "intent.unsigned", "severity": "high", "description": "Intent missing required signature fields"},
    {"id": "T02", "name": "actor.unknown", "severity": "medium", "description": "Actor is not in the allow-list"},
    {"id": "T03", "name": "rate.exceeded", "severity": "medium", "description": "Cycle rate exceeded operator budget"},
    {"id": "T04", "name": "payload.oversize", "severity": "high", "description": "Canonical payload exceeded 1MB"},
    {"id": "T05", "name": "egress.unauthorized", "severity": "critical", "description": "Outbound egress to non-allowlisted host"},
    {"id": "T06", "name": "ledger.divergence", "severity": "critical", "description": "Ledger hash chain disagrees with recomputed chain"},
    {"id": "T07", "name": "deadman.engaged", "severity": "critical", "description": "DEADMAN freeze is active — refuse all writes"},
    {"id": "T08", "name": "sentra.bypass", "severity": "critical", "description": "Receipt produced without SENTRA acceptance"},
    {"id": "T09", "name": "clock.skew", "severity": "low", "description": "System clock skew vs NTP exceeds threshold"},
    {"id": "T10", "name": "evidence.gap", "severity": "high", "description": "HUKLLA evidence chain has a gap vs cycle counter"},
]


def evaluate_tripwires(ctx: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = [
        {"id": t["id"], "name": t["name"], "severity": t["severity"], "fired": False} for t in HUKLLA_REGISTRY
    ]
    index = {row["id"]: row for row in out}

    def fire(tid: str, detail: str) -> None:
        row = index.get(tid)
        if row:
            row["fired"] = True
            row["detail"] = detail

    mode = ctx.get("mode")
    if mode == "DEADMAN":
        fire("T07", "operator engaged DEADMAN freeze")
        selected = ctx.get("selectedTripwire")
        if selected and selected != "T07":
            sel = next((t for t in HUKLLA_REGISTRY if t["id"] == selected), None)
            if sel:
                fire(sel["id"], f"operator-staged tripwire: {sel['description']}")
    if mode == "SENTRA_REJECT" and not ctx.get("sentraAccepted"):
        fire("T01", "SENTRA rejected the intent — no signature match")
    if int(ctx.get("payloadBytes") or 0) > 1_048_576:
        fire("T04", f"payload {ctx.get('payloadBytes')} bytes")
    if not ctx.get("sentraAccepted") and ctx.get("receiptWritten"):
        fire("T08", "receipt persisted without SENTRA acceptance")
    return out
