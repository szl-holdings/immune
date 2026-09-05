# SPDX-License-Identifier: Apache-2.0
"""Verify the preserved NEXUS, repaired Bench, and current IMMUNE runtime."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from huggingface_hub import HfApi, hf_hub_download

HF_TOKEN = os.environ["HF_TOKEN"]
KEEP = "betterwithage/nexus"
PROBE = "betterwithage/nexus-probe"
BENCH = "betterwithage/szl-bench-suite"
ARCHIVE = "archive/nexus-probe-consolidation-20260905.json"
TOPOLOGY = "CANONICAL_RUNTIME.json"
NEXUS_LIVE = "https://betterwithage-nexus.hf.space"
BENCH_LIVE = "https://betterwithage-szl-bench-suite.static.hf.space"
IMMUNE_LIVE = "https://szlholdings-immune.hf.space"
PROBE_FILES = [".gitattributes", "README.md", "index.html", "style.css"]
REPORT = Path("reports/nexus-bench-preflight.json")
api = HfApi(token=HF_TOKEN)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stage(info: Any) -> str:
    return str(getattr(getattr(info, "runtime", None), "stage", "") or "").upper()


def hub_bytes(repo_id: str, filename: str, revision: str) -> bytes:
    local = hf_hub_download(
        repo_id=repo_id,
        filename=filename,
        repo_type="space",
        revision=revision,
        token=HF_TOKEN,
    )
    return Path(local).read_bytes()


def fetch(
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    bearer: str | None = None,
    timeout: int = 45,
) -> tuple[int, bytes]:
    data = None if payload is None else json.dumps(payload).encode()
    headers = {
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": "szl-nexus-bench-preflight/2",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    request = urllib.request.Request(
        url,
        data=data,
        headers=headers,
        method="GET" if data is None else "POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status), response.read(4 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        return int(error.code), error.read(4 * 1024 * 1024)


def fetch_json(
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    bearer: str | None = None,
    timeout: int = 45,
) -> tuple[int, dict[str, Any]]:
    status, raw = fetch(url, payload=payload, bearer=bearer, timeout=timeout)
    decoded = json.loads(raw.decode())
    if not isinstance(decoded, dict):
        raise TypeError(f"{url} returned non-object JSON")
    return status, decoded


def private_nexus_probe() -> dict[str, Any]:
    health_http, health = fetch_json(NEXUS_LIVE + "/healthz", bearer=HF_TOKEN)
    analog_http, analog = fetch_json(
        NEXUS_LIVE + "/api/analog",
        bearer=HF_TOKEN,
        payload={"program": "lorenz", "steps": 64, "chaos": 0.45, "drive": 0.7},
        timeout=60,
    )
    if health_http != 200 or not health.get("ok"):
        raise RuntimeError("retained private NEXUS health failed")
    if analog_http != 200 or analog.get("program") != "lorenz":
        raise RuntimeError("retained private NEXUS Lorenz execution failed")
    if analog.get("honesty") != "MEASURED":
        raise RuntimeError("retained private NEXUS did not report measured execution")
    return {
        "health_http": health_http,
        "analog_http": analog_http,
        "program": analog.get("program"),
        "honesty": analog.get("honesty"),
    }


def verify_archive() -> dict[str, Any]:
    keep = api.space_info(KEEP, files_metadata=True)
    probe = api.space_info(PROBE, files_metadata=True)
    if keep.sdk != "docker" or not keep.private or stage(keep) != "RUNNING":
        raise RuntimeError("retained NEXUS is not a running private Docker Space")
    if probe.sdk != "static" or not probe.private:
        raise RuntimeError("Nexus Probe topology changed")
    observed_files = sorted(item.rfilename for item in probe.siblings or [])
    if observed_files != PROBE_FILES:
        raise RuntimeError(f"Nexus Probe file set changed: {observed_files}")

    archive_bytes = hub_bytes(KEEP, ARCHIVE, keep.sha)
    archive = json.loads(archive_bytes.decode())
    topology = json.loads(hub_bytes(KEEP, TOPOLOGY, keep.sha).decode())
    candidate = archive.get("candidate_for_retirement") or {}
    if candidate.get("repo_id") != PROBE:
        raise RuntimeError("archive does not authorize Nexus Probe")
    if candidate.get("revision") != probe.sha:
        raise RuntimeError("Nexus Probe moved after archival")
    if candidate.get("classification") != "UNMODIFIED_HUGGING_FACE_STATIC_STARTER":
        raise RuntimeError("archive does not classify Probe as an empty starter")
    if topology.get("canonical_public_runtime") != IMMUNE_LIVE + "/nexus.html":
        raise RuntimeError("retained NEXUS is not bound to IMMUNE")

    captured = candidate.get("files") or {}
    for filename in PROBE_FILES:
        observed = hub_bytes(PROBE, filename, probe.sha)
        record = captured.get(filename) or {}
        if record.get("sha256") != digest(observed):
            raise RuntimeError(f"archive hash mismatch: {filename}")
        if base64.b64decode(str(record.get("content_base64") or "")) != observed:
            raise RuntimeError(f"archive byte mismatch: {filename}")
    readme = hub_bytes(PROBE, "README.md", probe.sha).decode("utf-8", "replace")
    index = hub_bytes(PROBE, "index.html", probe.sha).decode("utf-8", "replace")
    if "Check out the configuration reference" not in readme:
        raise RuntimeError("Nexus Probe README is no longer the starter")
    if "Welcome to your static Space!" not in index:
        raise RuntimeError("Nexus Probe index is no longer the starter")

    return {
        "retained_revision": keep.sha,
        "probe_revision": probe.sha,
        "archive_sha256": digest(archive_bytes),
        "runtime": private_nexus_probe(),
    }


def github_main(repository: str) -> str:
    status, payload = fetch_json(
        f"https://api.github.com/repos/{repository}/commits/main"
    )
    revision = str(payload.get("sha") or "")
    if status != 200 or len(revision) != 40:
        raise RuntimeError(f"cannot resolve GitHub main: {repository}")
    return revision


def verify_bench() -> dict[str, Any]:
    bench = api.space_info(BENCH, files_metadata=True)
    if bench.sdk != "static" or bench.private or stage(bench) != "RUNNING":
        raise RuntimeError("Bench is not a running public static Space")
    required = {"README.md", "index.html", "results.json", "deployment.json"}
    available = {item.rfilename for item in bench.siblings or []}
    if not required.issubset(available):
        raise RuntimeError(f"Bench files missing: {sorted(required - available)}")

    card = hub_bytes(BENCH, "README.md", bench.sha).decode("utf-8", "replace")
    for marker in ("title: SZL Bench Suite", "sdk: static", "app_file: index.html"):
        if marker not in card:
            raise RuntimeError(f"Bench card marker missing: {marker}")
    results = hub_bytes(BENCH, "results.json", bench.sha)
    deployment = hub_bytes(BENCH, "deployment.json", bench.sha)
    json.loads(results.decode())
    deployment_json = json.loads(deployment.decode())
    deployment_text = deployment.decode("utf-8", "replace")

    sources = {
        "engine": "szl-holdings/frontier-bench",
        "retrieval": "szl-holdings/retrieval-bench",
        "quant": "szl-holdings/quant-curve",
    }
    revisions = {name: github_main(repo) for name, repo in sources.items()}
    for name, repository in sources.items():
        source = f"{repository}@{revisions[name]}"
        if source not in deployment_text:
            raise RuntimeError(f"Bench deployment is stale: {source}")

    deadline = time.monotonic() + 600
    live_state: dict[str, int] = {}
    while time.monotonic() < deadline:
        index_http, index_live = fetch(f"{BENCH_LIVE}/?revision={bench.sha}")
        results_http, results_live = fetch(
            f"{BENCH_LIVE}/results.json?revision={bench.sha}"
        )
        deployment_http, deployment_live = fetch(
            f"{BENCH_LIVE}/deployment.json?revision={bench.sha}"
        )
        live_state = {
            "index_http": index_http,
            "results_http": results_http,
            "deployment_http": deployment_http,
        }
        if (
            index_http == 200
            and b"SZL Bench Suite" in index_live
            and results_http == 200
            and results_live == results
            and deployment_http == 200
            and deployment_live == deployment
        ):
            break
        time.sleep(10)
    else:
        raise RuntimeError(f"Bench static host did not converge: {live_state}")

    return {
        "space_revision": bench.sha,
        "sdk": bench.sdk,
        "stage": stage(bench),
        "host": BENCH_LIVE,
        "source_revisions": revisions,
        "deployment_schema": deployment_json.get("schema"),
        "results_sha256": digest(results),
        "deployment_sha256": digest(deployment),
        **live_state,
    }


def verify_immune() -> dict[str, Any]:
    expected = os.environ["GITHUB_SHA"]
    deadline = time.monotonic() + 1200
    build: dict[str, Any] = {}
    ready: dict[str, Any] = {}
    nexus_status: dict[str, Any] = {}
    while time.monotonic() < deadline:
        build_http, build = fetch_json(IMMUNE_LIVE + "/api/build-info")
        ready_http, ready = fetch_json(IMMUNE_LIVE + "/readyz")
        status_http, nexus_status = fetch_json(
            IMMUNE_LIVE + "/api/immune/nexus/status"
        )
        source = str(
            build.get("source_revision")
            or (build.get("build") or {}).get("revision")
            or ""
        )
        if (
            build_http == 200
            and ready_http == 200
            and status_http == 200
            and source == expected
            and ready.get("ready")
            and ready.get("write_ready")
            and nexus_status.get("state") == "EXECUTABLE"
        ):
            break
        time.sleep(10)
    else:
        raise RuntimeError(f"IMMUNE did not converge to {expected}")

    request_id = "frontier-" + uuid.uuid4().hex[:20]
    execution_http, execution = fetch_json(
        IMMUNE_LIVE + "/api/immune/nexus/run",
        payload={
            "actor": "stephenlutar2-hash",
            "requestId": request_id,
            "program": "lorenz",
            "mode": "OP",
            "steps": 320,
            "dt": 0.01,
            "chaos": 0.45,
            "drive": 0.7,
            "seed": 0.2,
            "repeatEvery": 64,
        },
        timeout=90,
    )
    result = execution.get("result") or {}
    governed = execution.get("governed") or {}
    invariants = result.get("invariants") or {}
    if execution_http not in (200, 201) or not governed.get("pass"):
        raise RuntimeError("IMMUNE rejected the governed NEXUS execution")
    if not invariants.get("allHold"):
        raise RuntimeError("IMMUNE NEXUS invariants failed")
    if len(str(result.get("outputHash") or "")) != 64:
        raise RuntimeError("IMMUNE NEXUS output hash is missing")
    return {
        "source_revision": expected,
        "build_state": build.get("state"),
        "readiness": ready.get("status"),
        "nexus_state": nexus_status.get("state"),
        "execution_http": execution_http,
        "request_id": request_id,
        "input_hash": result.get("inputHash"),
        "output_hash": result.get("outputHash"),
        "receipt_hash": (governed.get("receipt") or {}).get("hash"),
        "invariants_hold": invariants.get("allHold"),
    }


def write_report(report: dict[str, Any]) -> None:
    report["finished_at"] = now()
    encoded = json.dumps(report, sort_keys=True, separators=(",", ":")).encode()
    report["report_sha256"] = digest(encoded)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"state": report["state"], "sha256": report["report_sha256"]}))


def main() -> int:
    print(f"::add-mask::{HF_TOKEN}")
    report: dict[str, Any] = {
        "schema": "szl.nexus-bench-preflight/v2",
        "state": "STARTED",
        "started_at": now(),
        "source_revision": os.environ["GITHUB_SHA"],
        "visibility_changed": False,
        "secret_values_recorded": False,
        "fabricated_measurements": False,
    }
    exit_code = 1
    try:
        identity = api.whoami()
        if identity.get("name") != "betterwithage":
            raise RuntimeError(f"unexpected HF identity: {identity.get('name')}")
        report["credential_identity"] = identity.get("name")
        report["nexus_archive"] = verify_archive()
        report["bench"] = verify_bench()
        report["immune"] = verify_immune()
        report["state"] = "ALL_GATES_PASS"
        exit_code = 0
    except Exception as error:
        report["state"] = "FAILED"
        report["error"] = f"{type(error).__name__}: {error}"[:1600]
        print("::error::" + report["error"])
    finally:
        write_report(report)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
