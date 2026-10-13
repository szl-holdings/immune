"""Five-organ mesh from this live process.

This module was originally written to mirror a TypeScript module at
``src/lib/immune/organs.ts``. That module is not in this repository, so parity
with it is not checked or asserted here; this file is the reference.

Estate organs other than this process are observed through a fixed, reviewed
target map. Each target is bound to the readiness contract its owner actually
publishes, and a row may claim a ready stage only when that contract is
satisfied with explicit, correctly typed evidence. URLs found in response
bodies are never followed.

Refresh is bounded end to end by a monotonic deadline that covers process
spawn, DNS, connect, TLS, read, coordination and cleanup. The shared state lock
is held only for short bookkeeping, never while waiting on workers; one
refresh is in flight at a time; the executor is shut down without waiting; and
a probe that finishes after its deadline or after a newer refresh is discarded.
"""

from __future__ import annotations

import copy
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import wait as wait_futures
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError

from .mesh import mesh_from_surfaces
from .runtime import get_runtime
from .second_brain import brain_status

ESTATE_PROBE_ENV = "IMMUNE_ESTATE_PROBE"
# One budget for the whole refresh as seen by a request: spawning the isolated
# fetch process, DNS, connect, TLS, read, coordination and executor cleanup.
PROBE_DEADLINE_SECONDS = 3.0
PROBE_TTL_SECONDS = 45.0
PROBE_MAX_BYTES = 256 * 1024
# Hard cap on probe workers alive at once, including workers whose refresh
# already closed at its deadline but whose isolated fetch is still being reaped.
PROBE_MAX_OUTSTANDING_WORKERS = 4
# Closing a refresh may wait this long past the deadline for the bookkeeping
# lock, which is otherwise held only for microseconds. A request therefore
# completes within PROBE_DEADLINE_SECONDS + PROBE_LOCK_GRACE_SECONDS.
PROBE_LOCK_GRACE_SECONDS = 0.25
PROBE_HELPER = Path(__file__).with_name("_probe_http.py")

A11OY_CONTRACT = "a11oy.operational_readiness"
KHIPU_CONTRACT = "hf.model.weight_inventory"
KILLINCHU_NO_CONTRACT = (
    "killinchu publishes no whole-organ operational-readiness contract: "
    "/healthz and /api/killinchu/healthz return a fixed status=ok liveness/service "
    "envelope, and /readyz reports only canonical receipt-ledger readiness"
)
# Hub weight inventory supports exactly this claim and nothing stronger: it does
# not prove training, intact or loadable bytes, inference or measured quality.
# The stage is deliberately absent from mesh.READY_STAGES, so it never votes.
KHIPU_EVIDENCE_STAGE = "WEIGHTS_LISTED"

# Fixed, reviewed target map. "probe" is None when the organ has no readiness
# contract this process can bind to; such an organ is never fetched or counted.
ESTATE_PROBES: tuple[dict[str, Any], ...] = (
    {
        "id": "a11oy",
        "title": "a11oy",
        "role": "governed command center",
        "href": "https://huggingface.co/spaces/SZLHOLDINGS/a11oy",
        "probe": "https://szlholdings-a11oy.hf.space/api/a11oy/healthz",
        "contract": A11OY_CONTRACT,
        "readyStage": "READY",
    },
    {
        "id": "killinchu",
        "title": "killinchu",
        "role": "field fusion",
        "href": "https://huggingface.co/spaces/SZLHOLDINGS/killinchu",
        "probe": None,
        "contract": None,
        "nonVotingReason": KILLINCHU_NO_CONTRACT,
    },
    {
        "id": "khipu",
        "title": "SZL-Khipu-1.5B",
        "role": "sovereign agent model",
        "href": "https://huggingface.co/SZLHOLDINGS/SZL-Khipu-1.5B",
        "probe": "https://huggingface.co/api/models/SZLHOLDINGS/SZL-Khipu-1.5B",
        "contract": KHIPU_CONTRACT,
        "model": "SZLHOLDINGS/SZL-Khipu-1.5B",
        "readyStage": KHIPU_EVIDENCE_STAGE,
    },
)

# Injectable clock for the deadline, TTL and late-completion decisions.
_monotonic: Callable[[], float] = time.monotonic

_STATE_LOCK = threading.Lock()
_STATE: dict[str, Any] = {
    "rows": None,
    "expires": 0.0,
    "generation": 0,
    "committed": 0,
    "inflight": None,
    "outstanding": 0,
}
_REASON_LIMIT = 160
_SHA = re.compile(r"[0-9a-f]{40}")


class _LockTimeout(Exception):
    pass


class _Refresh:
    """One bounded estate refresh. Mutated only under _STATE_LOCK."""

    def __init__(self, generation: int, started: float, deadline: float) -> None:
        self.generation = generation
        self.started = started
        self.deadline = deadline
        self.results: dict[str, dict[str, Any]] = {}
        self.closed = False
        self.cancelled = False
        self.rows: list[dict[str, Any]] | None = None
        self.done = threading.Event()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _short(value: Any) -> str:
    text = repr(value)
    return text if len(text) <= _REASON_LIMIT else text[: _REASON_LIMIT - 1] + "…"


def _probe_enabled() -> bool:
    value = os.environ.get(ESTATE_PROBE_ENV, "1").strip().lower()
    return value not in {"0", "false", "no", "off"}


def _acquire(deadline: float) -> None:
    if not _STATE_LOCK.acquire(timeout=max(0.0, deadline - _monotonic())):
        raise _LockTimeout


def reset_estate_probe_cache() -> None:
    """Drop cached rows and cancel any in-flight refresh.

    A cancelled refresh can no longer commit, and its late results are dropped.
    """
    with _STATE_LOCK:
        inflight = _STATE["inflight"]
        if inflight is not None and not inflight.closed:
            inflight.closed = True
            inflight.cancelled = True
        _STATE["generation"] += 1
        _STATE["committed"] = _STATE["generation"]
        _STATE["rows"] = None
        _STATE["expires"] = 0.0
        _STATE["inflight"] = None
    if inflight is not None:
        inflight.done.set()


def outstanding_estate_workers() -> int:
    with _STATE_LOCK:
        return int(_STATE["outstanding"])


def _fetch_json(url: str, timeout: float) -> tuple[int, Any]:
    # Socket timeouts do not bound DNS or a continuously trickling response.
    # The whole fetch runs in a child that is killed and reaped at the timeout,
    # so the worker thread that waits on it terminates within the budget.
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


def _assess_a11oy(body: dict[str, Any]) -> tuple[str | None, str]:
    """a11oy GET /api/a11oy/healthz: whole-organ operational readiness.

    The producer reports service health in ``status`` and capability plus
    service readiness in ``operational_readiness``. Only an explicit boolean
    ``ready: true`` with READY status, matching identity and scope, no service
    blockers and consistent frontier capability evidence is a ready vote.
    """
    scope = body.get("scope")
    if scope == "PROCESS_LIVENESS":
        return "scope=PROCESS_LIVENESS · process liveness is not operational readiness", ""
    service = body.get("service")
    if service != "a11oy":
        return f"identity service={_short(service)} is not 'a11oy'", ""
    if scope != "SERVICE_HEALTH":
        return f"scope={_short(scope)} is not the a11oy SERVICE_HEALTH contract", ""
    readiness = body.get("operational_readiness")
    if not isinstance(readiness, dict):
        return "operational_readiness is missing or not an object", ""
    if readiness.get("scope") != "FRONTIER_CAPABILITIES_AND_SERVICE_HEALTH":
        return f"operational_readiness.scope={_short(readiness.get('scope'))} is unexpected", ""
    ready = readiness.get("ready")
    if type(ready) is not bool:
        return f"operational_readiness.ready={_short(ready)} is not a boolean", ""
    if not ready:
        return f"operational_readiness.ready=false · status={_short(readiness.get('status'))}", ""
    if readiness.get("status") != "READY":
        return f"operational_readiness.status={_short(readiness.get('status'))} contradicts ready=true", ""
    # A service blocker means the producer itself saw a fault; ready=true beside
    # one is contradictory evidence and never votes.
    blockers = readiness.get("service_blockers")
    if not isinstance(blockers, list):
        return "operational_readiness.service_blockers is missing or not a list", ""
    if blockers:
        return f"service_blockers={_short(blockers)} · non-voting despite ready=true", ""
    degraded = body.get("degraded_reasons")
    if not isinstance(degraded, list) or degraded:
        return f"degraded_reasons={_short(degraded)} contradicts ready=true", ""
    if body.get("status") != "ok":
        return f"status={_short(body.get('status'))} contradicts ready=true", ""
    frontier = readiness.get("frontier")
    if not isinstance(frontier, dict) or frontier.get("ready") is not True:
        return "frontier capability evidence does not confirm ready=true", ""
    blocked = frontier.get("blocked_tiles")
    if not isinstance(blocked, list) or blocked:
        return f"frontier.blocked_tiles={_short(blocked)} contradicts ready=true", ""
    return None, "operational_readiness READY · service a11oy · no service blockers"


def _is_weight_file(name: str) -> bool:
    base = name.rsplit("/", 1)[-1].lower()
    return base.endswith(".safetensors") and len(base) > len(".safetensors")


def _assess_khipu(spec: dict[str, Any], body: dict[str, Any]) -> tuple[str | None, str]:
    """Hub model API: public, enabled, revision-bound weight inventory only."""
    if body.get("id") != spec["model"]:
        return f"id={_short(body.get('id'))} does not match {spec['model']!r}", ""
    if body.get("private") is not False:
        return f"private={_short(body.get('private'))} · not a public model", ""
    if body.get("disabled") is not False:
        return f"disabled={_short(body.get('disabled'))} · must be present and false", ""
    sha = body.get("sha")
    if not isinstance(sha, str) or not _SHA.fullmatch(sha):
        return f"revision sha={_short(sha)} is missing or malformed", ""
    siblings = body.get("siblings")
    if not isinstance(siblings, list) or not siblings:
        return "sibling inventory is missing or empty", ""
    names: list[str] = []
    for entry in siblings:
        name = entry.get("rfilename") if isinstance(entry, dict) else None
        if not isinstance(name, str) or not name.strip():
            return f"sibling inventory has a malformed entry {_short(entry)}", ""
        names.append(name)
    weights = [name for name in names if _is_weight_file(name)]
    if not weights:
        return "no .safetensors weight file in the sibling inventory", ""
    return None, (
        f"{len(weights)} .safetensors weight file(s) listed at revision {sha} · "
        "inventory does not prove training, loadable bytes or inference · "
        "not quorum-eligible"
    )


def _assess(spec: dict[str, Any], status: int, body: Any) -> tuple[str | None, str]:
    """Return (None, evidence) when the bound contract is satisfied, else (reason, "")."""
    if status != 200:
        return f"HTTP {status}", ""
    if not isinstance(body, dict):
        return "HTTP 200 · body is not a JSON object", ""
    if spec.get("contract") == A11OY_CONTRACT:
        reason, evidence = _assess_a11oy(body)
    elif spec.get("contract") == KHIPU_CONTRACT:
        reason, evidence = _assess_khipu(spec, body)
    else:
        return "no readiness contract is bound to this target", ""
    return (f"HTTP 200 · {reason}" if reason else None), evidence


def _accept(spec: dict[str, Any], status: int, body: Any) -> str | None:
    """Return None when the observation satisfies the bound contract, else the reason."""
    return _assess(spec, status, body)[0]


def _row(spec: dict[str, Any], **fields: Any) -> dict[str, Any]:
    row = {
        "id": spec["id"],
        "title": spec["title"],
        "role": spec["role"],
        "href": spec["href"],
    }
    row.update(fields)
    return row


def _unavailable(spec: dict[str, Any], reason: str) -> dict[str, Any]:
    return _row(
        spec,
        stage="UNAVAILABLE",
        provenance="UNAVAILABLE",
        detail=f"GET {spec['probe']} not counted: {reason}",
        observedAt=_utc_now(),
    )


def _non_voting(spec: dict[str, Any]) -> dict[str, Any]:
    return _row(
        spec,
        stage="NO_READINESS_CONTRACT",
        provenance="REFERENCE",
        detail=f"not probed · {spec['nonVotingReason']} · non-voting (fail closed)",
        observedAt=None,
    )


def _unobserved(spec: dict[str, Any]) -> dict[str, Any]:
    return _row(
        spec,
        stage="UNOBSERVED",
        provenance="REFERENCE",
        detail=f"not observed · estate probe disabled ({ESTATE_PROBE_ENV}=0)",
        observedAt=_utc_now(),
    )


def _observe(spec: dict[str, Any], deadline: float) -> dict[str, Any]:
    remaining = deadline - _monotonic()
    if remaining <= 0:
        return _unavailable(spec, "deadline exhausted before the request started")
    evidence = ""
    body: Any = None
    try:
        status, body = _fetch_json(spec["probe"], remaining)
        reason, evidence = _assess(spec, status, body)
    except HTTPError as exc:
        reason = f"HTTP {exc.code}"
    except subprocess.TimeoutExpired:
        reason = f"deadline exceeded ({PROBE_DEADLINE_SECONDS:g} s end-to-end budget)"
    except Exception as exc:  # noqa: BLE001 - any failure is UNAVAILABLE
        reason = type(exc).__name__
    if _monotonic() > deadline:
        reason = f"completed after the {PROBE_DEADLINE_SECONDS:g} s deadline"
    if reason is not None:
        return _unavailable(spec, reason)
    row = _row(
        spec,
        stage=spec["readyStage"],
        provenance="OBSERVED",
        detail=f"GET {spec['probe']} → 200 · {evidence} · probed by this process",
        observedAt=_utc_now(),
    )
    if spec.get("contract") == KHIPU_CONTRACT:
        # Bound to the exact revision the inventory was listed at.
        row["revision"] = body["sha"]
    return row


def _record(refresh: _Refresh, spec: dict[str, Any], row: dict[str, Any]) -> None:
    with _STATE_LOCK:
        # A closed (finished, expired or cancelled) refresh accepts nothing, and
        # a result that arrives after the deadline can never become ready.
        if refresh.closed or _monotonic() > refresh.deadline:
            return
        refresh.results[spec["id"]] = row


def _release_worker() -> None:
    with _STATE_LOCK:
        _STATE["outstanding"] -= 1


def _worker(refresh: _Refresh, spec: dict[str, Any]) -> None:
    try:
        try:
            row = _observe(spec, refresh.deadline)
        except Exception as exc:  # noqa: BLE001 - a failed worker is UNAVAILABLE
            row = _unavailable(spec, f"probe worker failed: {type(exc).__name__}")
        _record(refresh, spec, row)
    finally:
        _release_worker()


def _rows_for(refresh: _Refresh) -> list[dict[str, Any]]:
    rows = []
    for spec in ESTATE_PROBES:
        if spec.get("probe") is None:
            rows.append(_non_voting(spec))
        else:
            rows.append(
                refresh.results.get(spec["id"])
                or _unavailable(
                    spec,
                    f"no result within the {PROBE_DEADLINE_SECONDS:g} s end-to-end deadline",
                )
            )
    return rows


def _close_locked(refresh: _Refresh) -> None:
    """Freeze a refresh exactly once; commit it unless something newer exists.

    Caller holds _STATE_LOCK and must set ``refresh.done`` after releasing it.
    """
    if refresh.closed:
        return
    refresh.closed = True
    refresh.rows = _rows_for(refresh)
    if refresh.generation > _STATE["committed"]:
        _STATE["committed"] = refresh.generation
        _STATE["rows"] = refresh.rows
        # Evidence ages from when the refresh started, never from when it closed.
        _STATE["expires"] = refresh.started + PROBE_TTL_SECONDS
    if _STATE["inflight"] is refresh:
        _STATE["inflight"] = None


def _close(refresh: _Refresh) -> None:
    try:
        _acquire(_monotonic() + PROBE_LOCK_GRACE_SECONDS)
    except _LockTimeout:
        return
    try:
        _close_locked(refresh)
    finally:
        _STATE_LOCK.release()
    refresh.done.set()


def _run_refresh(refresh: _Refresh) -> None:
    probed = [spec for spec in ESTATE_PROBES if spec.get("probe") is not None]
    pool = ThreadPoolExecutor(
        max_workers=max(1, len(probed)), thread_name_prefix="immune-estate-probe"
    )
    futures = []
    try:
        for spec in probed:
            with _STATE_LOCK:
                outstanding = _STATE["outstanding"]
                admitted = outstanding < PROBE_MAX_OUTSTANDING_WORKERS
                if admitted:
                    _STATE["outstanding"] = outstanding + 1
            if not admitted:
                _record(refresh, spec, _unavailable(
                    spec,
                    f"probe not started: {outstanding} probe workers still outstanding "
                    f"(cap {PROBE_MAX_OUTSTANDING_WORKERS})",
                ))
                continue
            try:
                future = pool.submit(_worker, refresh, spec)
            except Exception as exc:  # noqa: BLE001 - e.g. no thread could start
                _release_worker()
                _record(refresh, spec, _unavailable(
                    spec, f"probe worker could not start: {type(exc).__name__}"
                ))
                continue
            # A queued future cancelled at shutdown never runs _worker.
            future.add_done_callback(lambda f: f.cancelled() and _release_worker())
            futures.append(future)
        if futures:
            wait_futures(futures, timeout=max(0.0, refresh.deadline - _monotonic()))
    finally:
        # Never wait for workers here: request latency is bounded by the
        # deadline, and each isolated fetch is killed at its own timeout.
        pool.shutdown(wait=False, cancel_futures=True)
        _close(refresh)


def _bounded_failure(reason: str) -> list[dict[str, Any]]:
    return [
        _non_voting(spec) if spec.get("probe") is None else _unavailable(spec, reason)
        for spec in ESTATE_PROBES
    ]


def observe_estate() -> list[dict[str, Any]]:
    if not _probe_enabled():
        return [_unobserved(spec) for spec in ESTATE_PROBES]
    request_deadline = _monotonic() + PROBE_DEADLINE_SECONDS
    try:
        _acquire(request_deadline)
    except _LockTimeout:
        return _bounded_failure("estate state lock was not available within the deadline")
    abandoned = None
    try:
        now = _monotonic()
        refresh = _STATE["inflight"]
        if refresh is not None and not refresh.closed and now >= refresh.deadline:
            # Its closer never ran. Freeze what arrived before its deadline; it
            # is committed only as evidence aged from its own start.
            _close_locked(refresh)
            abandoned = refresh
        if _STATE["rows"] is not None and _STATE["expires"] > now:
            return copy.deepcopy(_STATE["rows"])
        refresh = _STATE["inflight"]
        leader = refresh is None or refresh.closed
        if leader:
            _STATE["generation"] += 1
            refresh = _Refresh(_STATE["generation"], now, request_deadline)
            _STATE["inflight"] = refresh
    finally:
        _STATE_LOCK.release()
        if abandoned is not None:
            abandoned.done.set()
    if leader:
        _run_refresh(refresh)
    else:
        # Single flight: wait for the shared refresh, never past this request's
        # deadline. If its leader stalled, close it here once its deadline passed.
        refresh.done.wait(timeout=max(0.0, min(refresh.deadline, request_deadline) - _monotonic()))
        if not refresh.done.is_set() and _monotonic() >= refresh.deadline:
            _close(refresh)
    if refresh.cancelled:
        return _bounded_failure("estate refresh was cancelled before it completed")
    rows = refresh.rows
    if rows is None:
        return _bounded_failure(
            f"estate refresh did not complete within the {PROBE_DEADLINE_SECONDS:g} s deadline"
        )
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


def local_organ_mesh(estate: list[dict[str, Any]] | None = None) -> dict[str, Any]:
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
    if estate is None:
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
            "role": "quorum · agent model weights",
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
            "revision": khipu.get("revision"),
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
        # One estate observation per dashboard read: both projections agree and
        # the request waits on at most one bounded refresh.
        "organs": local_organ_mesh(estate),
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
