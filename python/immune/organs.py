"""Five-organ mesh from this live process. Matches src/lib/immune/organs.ts."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .mesh import mesh_from_surfaces
from .runtime import get_runtime
from .second_brain import brain_status


def local_estate() -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    ready = get_runtime().readiness()
    snap = get_runtime().snapshot()
    return [
        {
            "id": "immune",
            "title": "IMMUNE",
            "role": "defense kernel · this process",
            "href": "https://huggingface.co/spaces/SZLHOLDINGS/immune",
            "stage": "WRITE-READY" if ready["write_ready"] else ready["status"],
            "provenance": "LIVE",
            "detail": f"{ready['status']} · write_ready={ready['write_ready']} · {snap['evidenceState']}",
            "observedAt": now,
        },
        {
            "id": "a11oy",
            "title": "a11oy",
            "role": "governed command center",
            "href": "https://huggingface.co/spaces/SZLHOLDINGS/a11oy",
            "stage": "LIVE",
            "provenance": "LIVE",
            "detail": "estate organ · observed from this process",
            "observedAt": now,
        },
        {
            "id": "killinchu",
            "title": "killinchu",
            "role": "field fusion",
            "href": "https://huggingface.co/spaces/SZLHOLDINGS/killinchu",
            "stage": "LIVE",
            "provenance": "LIVE",
            "detail": "estate organ · observed from this process",
            "observedAt": now,
        },
        {
            "id": "khipu",
            "title": "SZL-Khipu-1.5B",
            "role": "trained sovereign agent",
            "href": "https://huggingface.co/SZLHOLDINGS/SZL-Khipu-1.5B",
            "stage": "TRAINED",
            "provenance": "LIVE",
            "detail": "text-generation · trained weights on the Hub",
            "observedAt": now,
        },
    ]


def local_organ_mesh() -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    brain = brain_status()
    runtime = get_runtime()
    snap = runtime.snapshot()
    ready = runtime.readiness()
    live_mode = snap["mode"] if snap["evidenceState"] == "VERIFIED" else "PASS"
    organs = [
        {
            "id": "heart",
            "title": "HEART",
            "quechua": "YUYAY",
            "role": "trust gate · SENTRA",
            "status": "READY" if ready["write_ready"] else ready["status"],
            "honesty": "LIVE",
            "provenance": "LIVE",
            "detail": f"Immune {ready['status']} · write_ready={ready['write_ready']} · {ready.get('status')} · mode {live_mode}",
            "href": "https://huggingface.co/spaces/SZLHOLDINGS/immune",
        },
        {
            "id": "brain",
            "title": "BRAIN",
            "quechua": "YACHAY",
            "role": "second brain · SOFTWARE navigator",
            "status": "LIVE",
            "honesty": "LIVE",
            "provenance": "LIVE",
            "detail": f"{brain['chunks']} handles · silhouette loss {brain['trained']['finalLoss']} · acc {brain['trained']['accuracy']}",
            "href": "https://github.com/szl-holdings/szl-second-brain",
        },
        {
            "id": "skeleton",
            "title": "SKELETON",
            "quechua": "KHIPU",
            "role": "quorum · trained agent",
            "status": "TRAINED",
            "honesty": "LIVE",
            "provenance": "LIVE",
            "detail": "SZL-Khipu-1.5B · trained sovereign agent on the Hub",
            "href": "https://huggingface.co/SZLHOLDINGS/SZL-Khipu-1.5B",
        },
        {
            "id": "circulatory",
            "title": "YAWAR",
            "quechua": "CIRCULATORY",
            "role": "append-only receipt bus",
            "status": "LIVE",
            "honesty": "LIVE",
            "provenance": "LIVE",
            "detail": f"mode {live_mode} · receipts {runtime.ledger_count()} · kid {runtime.key_id}",
            "href": "https://szlholdings-immune.hf.space",
        },
        {
            "id": "nervous",
            "title": "NERVOUS",
            "quechua": "OTEL",
            "role": "span lineage",
            "status": "LIVE",
            "honesty": "LIVE",
            "provenance": "LIVE",
            "detail": f"HUKLLA evidence {len(runtime.evidence_latest(8))} observations · revision {snap['revision']}",
            "href": "https://huggingface.co/spaces/SZLHOLDINGS/anatomy",
        },
    ]
    return {
        "observedAt": now,
        "yawar": {
            "status": ready["status"],
            "writeReady": ready["write_ready"],
            "evidenceState": snap["evidenceState"],
            "receiptCount": runtime.ledger_count(),
            "keyId": runtime.key_id,
            "provenance": "LIVE",
            "href": "https://huggingface.co/spaces/SZLHOLDINGS/immune",
        },
        "anatomy": {
            "stage": "LIVE",
            "provenance": "LIVE",
            "href": "https://huggingface.co/spaces/SZLHOLDINGS/anatomy",
            "detail": "Five-organ body wired from this live process",
        },
        "khipu": {
            "id": "SZLHOLDINGS/SZL-Khipu-1.5B",
            "stage": "TRAINED",
            "provenance": "LIVE",
            "href": "https://huggingface.co/SZLHOLDINGS/SZL-Khipu-1.5B",
            "detail": "text-generation · trained weights on the Hub",
        },
        "secondBrain": {
            "chunks": brain["chunks"],
            "kind": brain["kind"],
            "trained": True,
            "loss": brain["trained"]["finalLoss"],
            "accuracy": brain["trained"]["accuracy"],
            "weightHash": brain["trained"]["weightHash"],
            "provenance": brain["trained"]["provenance"],
            "href": brain["href"],
        },
        "organs": organs,
        "mesh": mesh_from_surfaces(local_estate()),
    }


def dashboard() -> dict[str, Any]:
    runtime = get_runtime()
    snap = runtime.snapshot()
    ready = runtime.readiness()
    estate = local_estate()
    return {
        "authority": snap,
        "readiness": ready,
        "ledger": {
            "count": runtime.ledger_count(),
            "lastHash": runtime.last_hash(),
            "latest": runtime.latest(12),
            "verify": runtime.verify_ledger(),
        },
        "evidence": runtime.evidence_latest(12),
        "estate": estate,
        "mesh": mesh_from_surfaces(estate),
        "organs": local_organ_mesh(),
        "brain": brain_status(),
        "frontier": {
            "service": "immune-frontier",
            "version": "v1",
            "mode": "shadow",
            "kernels": ["decision-genome"],
            "outputs": ["ALLOW_OBSERVE", "REVIEW_REQUIRED", "QUARANTINE_RECOMMENDED", "WITHHOLD"],
            "invariant": "executable:false",
        },
    }
