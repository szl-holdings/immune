"""Five-organ mesh from this live process. Matches src/lib/immune/organs.ts."""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError

from .mesh import mesh_from_surfaces
from .runtime import get_runtime
from .second_brain import brain_status

# Estate surfaces other than this process are only reported as LIVE/TRAINED
# when a bounded probe actually observed them. Results are cached so request
# handling never fans out to the estate more than once per TTL.
ESTATE_PROBE_ENV = "IMMUNE_ESTATE_PROBE"
PROBE_TIMEOUT_SECONDS = 3.0
PROBE_TTL_SECONDS = 45.0
PROBE_MAX_BYTES = 256 * 1024
PROBE_HELPER = Path(__file__).with_name("_probe_http.py")

ESTATE_PROBES: tuple[dict[str, str], ...] = (
    {
        "id": "a11oy",
        "title": "a11oy",
        "role": "governed command center",
        "href": "https://huggingface.co/spaces/SZLHOLDINGS/a11oy",
        "probe": "https://szlholdings-a11oy.hf.space/api/a11oy/healthz",
        "kind": "space",
        "readyStage": "LIVE",
    },
    {
        "id": "killinchu",
        "title": "killinchu",
        "role": "field fusion",
        "href": "https://huggingface.co/spaces/SZLHOLDINGS/killinchu",
        "probe": "https://szlholdings-killinchu.hf.space/healthz",
        "kind": "space",
        "readyStage": "LIVE",
    },
    {
        "id": "khipu",
        "title": "SZL-Khipu-1.5B",
        "role": "trained sovereign agent",
        "href": "https://huggingface.co/SZLHOLDINGS/SZL-Khipu-1.5B",
        "probe": "https://huggingface.co/api/models/SZLHOLDINGS/SZL-Khipu-1.5B",
        "kind": "model",
        "model": "SZLHOLDINGS/SZL-Khipu-1.5B",
        "readyStage": "TRAINED",
    },
)

_PROBE_LOCK = threading.Lock()
_PROBE_CACHE: dict[str, Any] = {"expires": 0.0, "rows": None}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _probe_enabled() -> bool:
    value = os.environ.get(ESTATE_PROBE_ENV, "1").strip().lower()
    return value not in {"0", "false", "no", "off"}


def reset_estate_probe_cache() -> None:
    with _PROBE_LOCK:
        _PROBE_CACHE["expires"] = 0.0
        _PROBE_CACHE["rows"] = None


def _fetch_json(url: str, timeout: float) -> tuple[int, Any]:
    # Socket timeouts do not bound DNS or a continuously trickling response.
    # The whole fetch runs in a child killed and reaped on deadline, so a
    # blocked peer cannot indefinitely hold the estate cache refresh lock.
    result = subprocess.run(
        [sys.executable, "-I", str(PROBE_HELPER), url, str(timeout), str(PROBE_MAX_BYTES)],
        capture_output=True,
        check=True,
        timeout=timeout,
    )
    response = json.loads(result.stdout)
    if "error" in response:
        raise ValueError(response["error"])
    return int(response["status"]), response["body"]


def _accept(spec: dict[str, str], status: int, body: Any) -> str | None:
    """Return None when the observation proves readiness, else the reason."""
    if status != 200:
        return f"HTTP {status}"
    if not isinstance(body, dict):
        return "HTTP 200 · body is not a JSON object"
    if spec["kind"] == "space":
        if body.get("status") != "ok":
            return f"HTTP 200 · status={body.get('status')!r}"
        organ = body.get("organ")
        if organ is not None and organ != spec["id"]:
            return f"HTTP 200 · organ={organ!r} does not match {spec['id']!r}"
        if spec["id"] == "a11oy":
            # Its health route reports service faults separately from
            # operational readiness. Process liveness is never a ready vote.
            readiness = body.get("operational_readiness")
            if (
                not isinstance(readiness, dict)
                or readiness.get("ready") is not True
                or readiness.get("status") != "READY"
            ):
                return "HTTP 200 · operational readiness is not READY"
        return None
    if body.get("id") != spec["model"]:
        return f"HTTP 200 · id={body.get('id')!r} does not match {spec['model']!r}"
    if body.get("private") is not False or body.get("disabled"):
        return "HTTP 200 · model is not public"
    siblings = body.get("siblings") or []
    has_weights = any(
        str((row or {}).get("rfilename", "")).endswith(".safetensors")
        for row in siblings
        if isinstance(row, dict)
    )
    if not has_weights:
        return "HTTP 200 · no safetensors weights listed"
    return None


def _row(spec: dict[str, str], **fields: Any) -> dict[str, Any]:
    row = {
        "id": spec["id"],
        "title": spec["title"],
        "role": spec["role"],
        "href": spec["href"],
    }
    row.update(fields)
    return row


def _probe(spec: dict[str, str]) -> dict[str, Any]:
    try:
        status, body = _fetch_json(spec["probe"], PROBE_TIMEOUT_SECONDS)
        reason = _accept(spec, status, body)
    except HTTPError as exc:
        reason = f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001 - any failure is UNAVAILABLE
        reason = type(exc).__name__
    observed_at = _utc_now()
    if reason is None:
        return _row(
            spec,
            stage=spec["readyStage"],
            provenance="OBSERVED",
            detail=f"GET {spec['probe']} → 200 · probed by this process",
            observedAt=observed_at,
        )
    return _row(
        spec,
        stage="UNAVAILABLE",
        provenance="UNAVAILABLE",
        detail=f"GET {spec['probe']} failed: {reason}",
        observedAt=observed_at,
    )


def _unobserved(spec: dict[str, str]) -> dict[str, Any]:
    return _row(
        spec,
        stage="UNOBSERVED",
        provenance="REFERENCE",
        detail=f"not observed · estate probe disabled ({ESTATE_PROBE_ENV}=0)",
        observedAt=_utc_now(),
    )


def observe_estate() -> list[dict[str, Any]]:
    if not _probe_enabled():
        return [_unobserved(spec) for spec in ESTATE_PROBES]
    with _PROBE_LOCK:
        cached = _PROBE_CACHE["rows"]
        if cached is not None and _PROBE_CACHE["expires"] > time.monotonic():
            return copy.deepcopy(cached)
        with ThreadPoolExecutor(max_workers=len(ESTATE_PROBES)) as pool:
            rows = list(pool.map(_probe, ESTATE_PROBES))
        _PROBE_CACHE["rows"] = rows
        _PROBE_CACHE["expires"] = time.monotonic() + PROBE_TTL_SECONDS
        return copy.deepcopy(rows)


def local_estate() -> list[dict[str, Any]]:
    now = _utc_now()
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
        *observe_estate(),
    ]


def local_organ_mesh() -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    brain = brain_status()
    runtime = get_runtime()
    snap = runtime.snapshot()
    ready = runtime.readiness()
    evidence_state = str(snap.get("evidenceState") or "UNAVAILABLE")
    live_mode = (
        str(snap.get("mode") or "UNAVAILABLE")
        if evidence_state == "VERIFIED"
        else evidence_state
    )
    estate = local_estate()
    khipu = next(row for row in estate if row["id"] == "khipu")
    organs = [
        {
            "id": "heart",
            "title": "HEART",
            "quechua": "YUYAY",
            "role": "trust gate · SENTRA",
            "status": "READY" if ready["write_ready"] else ready["status"],
            "honesty": "LIVE",
            "provenance": "LIVE",
            "detail": f"Immune {ready['status']} · write_ready={ready['write_ready']} · mode {live_mode}",
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
            "status": khipu["stage"],
            "honesty": khipu["provenance"],
            "provenance": khipu["provenance"],
            "detail": khipu["detail"],
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
            "detail": f"mode {live_mode} · receipts {runtime.ledger_count()} · receipt-signing kid {runtime.key_id}",
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
            "href": "https://a-11-oy.com/immune",
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
            "keyPurpose": "RECEIPT_SIGNING_ONLY",
            "provenance": "LIVE",
            "href": "https://huggingface.co/spaces/SZLHOLDINGS/immune",
        },
        "anatomy": {
            "stage": "UNAVAILABLE",
            "provenance": "REFERENCE",
            "href": "https://huggingface.co/spaces/SZLHOLDINGS/immune",
            "detail": "Hub Space SZLHOLDINGS/anatomy is not a public product. Nervous lineage is this process + Channel A.",
        },
        "khipu": {
            "id": "SZLHOLDINGS/SZL-Khipu-1.5B",
            "stage": khipu["stage"],
            "provenance": khipu["provenance"],
            "href": khipu["href"],
            "detail": khipu["detail"],
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
        "mesh": mesh_from_surfaces(estate),
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
            "outputs": [
                "ALLOW_OBSERVE",
                "REVIEW_REQUIRED",
                "QUARANTINE_RECOMMENDED",
                "WITHHOLD",
            ],
            "invariant": "executable:false",
        },
    }
