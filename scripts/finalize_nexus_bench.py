#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Finalize the already-preserved NEXUS and repaired Bench topology.

The prior bounded run archived every byte of the untouched Nexus Probe inside
the retained private NEXUS Space and published the canonical Bench bundle. This
operator independently re-verifies those artifacts, waits for the current
IMMUNE deployment, proves a governed NEXUS run, then deletes only the exact
archived Probe revision. No visibility changes are permitted.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.utils import RepositoryNotFoundError

HF_TOKEN = os.environ["HF_TOKEN"]
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
KEEP = "betterwithage/nexus"
PROBE = "betterwithage/nexus-probe"
BENCH = "betterwithage/szl-bench-suite"
ARCHIVE = "archive/nexus-probe-consolidation-20260905.json"
TOPOLOGY = "CANONICAL_RUNTIME.json"
NEXUS_LIVE = "https://betterwithage-nexus.hf.space"
BENCH_LIVE = "https://betterwithage-szl-bench-suite.static.hf.space"
IMMUNE_LIVE = "https://szlholdings-immune.hf.space"
EXPECTED_PROBE_FILES = [".gitattributes", "README.md", "index.html", "style.css"]
REPORT = Path("reports/nexus-bench-final-convergence.json")
api = HfApi(token=HF_TOKEN)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def redact(message: str) -> str:
    clean = message.replace(HF_TOKEN, "[REDACTED]")
    if GITHUB_TOKEN:
        clean = clean.replace(GITHUB_TOKEN, "[REDACTED]")
    return clean[:1600]


def http_bytes(
    url: str,
    *,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    timeout: int = 45,
) -> tuple[int, bytes]:
    data = None if payload is None else json.dumps(payload).encode()
    headers = {
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": "szl-nexus-bench-finalizer/1",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
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


def http_json(
    url: str,
    *,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    timeout: int = 45,
) -> tuple[int, dict[str, Any]]:
    status, raw = http_bytes(url, token=token, payload=payload, timeout=timeout)
    try:
        decoded = json.loads(raw.decode())
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{url} returned non-JSON HTTP {status}") from error
    if not isinstance(decoded, dict):
        raise RuntimeError(f"{url} returned a non-object JSON payload")
    return status, decoded


def hub_bytes(repo_id: str, filename: str, revision: str) -> bytes:
    local = hf_hub_download(
        repo_id=repo_id,
        filename=filename,
        repo_type="space",
        revision=revision,
        token=HF_TOKEN,
    )
    return Path(local).read_bytes()


def runtime_stage(info: Any) -> str:
    return str(getattr(getattr(info, "runtime", None), "stage", "") or "").upper()


def probe_private_nexus() -> dict[str, Any]:
    health_status, health = http_json(NEXUS_LIVE + "/healthz", token=HF_TOKEN)
    analog_status, analog = http_json(
        NEXUS_LIVE + "/api/analog",
        token=HF_TOKEN,
        payload={"program": "lorenz", "steps": 64, "chaos": 0.45, "drive": 0.7},
        timeout=60,
    )
    if health_status != 200 or not health.get("ok"):
        raise RuntimeError("retained private NEXUS health probe failed")
    if analog_status != 200 or analog.get("program") != "lorenz":
        raise RuntimeError("retained private NEXUS analog execution failed")
    if analog.get("honesty") != "MEASURED":
        raise RuntimeError("retained private NEXUS did not report measured execution")
    return {
        "health_http": health_status,
        "analog_http": analog_status,
        "program": analog.get("program"),
        "honesty": analog.get("honesty"),
    }


def verify_archive() -> dict[str, Any]:
    keep = api.space_info(KEEP, files_metadata=True)
    probe = api.space_info(PROBE, files_metadata=True)
    if keep.sdk != "docker" or not keep.private or runtime_stage(keep) != "RUNNING":
        raise RuntimeError("retained NEXUS is not a running private Docker Space")
    if probe.sdk != "static" or not probe.private:
        raise RuntimeError("Nexus Probe topology changed before retirement")

    probe_files = sorted(item.rfilename for item in probe.siblings or [])
    if probe_files != EXPECTED_PROBE_FILES:
        raise RuntimeError(f"Nexus Probe file set changed: {probe_files}")

    archive = json.loads(hub_bytes(KEEP, ARCHIVE, keep.sha).decode())
    topology = json.loads(hub_bytes(KEEP, TOPOLOGY, keep.sha).decode())
    candidate = archive.get("candidate_for_retirement") or {}
    if candidate.get("repo_id") != PROBE:
        raise RuntimeError("preservation receipt does not authorize the Probe target")
    if candidate.get("revision") != probe.sha:
        raise RuntimeError("Nexus Probe revision moved after preservation")
    if candidate.get("classification") != "UNMODIFIED_HUGGING_FACE_STATIC_STARTER":
        raise RuntimeError("preservation receipt does not classify Probe as empty starter")
    if topology.get("canonical_public_runtime") != IMMUNE_LIVE + "/nexus.html":
        raise RuntimeError("retained NEXUS topology does not bind to IMMUNE")

    captured = candidate.get("files") or {}
    for filename in EXPECTED_PROBE_FILES:
        record = captured.get(filename) or {}
        observed = hub_bytes(PROBE, filename, probe.sha)
        if record.get("sha256") != digest(observed):
            raise RuntimeError(f"preserved SHA-256 mismatch for {filename}")
        encoded = str(record.get("content_base64") or "")
        if base64.b64decode(encoded) != observed:
            raise RuntimeError(f"preserved byte content mismatch for {filename}")

    readme = hub_bytes(PROBE, "README.md", probe.sha).decode("utf-8", "replace")
    index = hub_bytes(PROBE, "index.html", probe.sha).decode("utf-8", "replace")
    if "Check out the configuration reference" not in readme:
        raise RuntimeError("Nexus Probe README is no longer the untouched starter")
    if "Welcome to your static Space!" not in index:
        raise RuntimeError("Nexus Probe index is no longer the untouched starter")

    return {
        "keep_revision": keep.sha,
        "probe_revision": probe.sha,
        "receipt_sha256": digest(hub_bytes(KEEP, ARCHIVE, keep.sha)),
        "runtime": probe_private_nexus(),
    }


def github_main_sha(repository: str) -> str:
    status, payload = http_json(
        f"https://api.github.com/repos/{repository}/commits/main",
        token=GITHUB_TOKEN or None,
    )
    revision = str(payload.get("sha") or "")
    if status != 200 or len(revision) != 40:
        raise RuntimeError(f"GitHub main resolution failed for {repository}")
    return revision


def wait_static_readback(
    revision: str,
    expected_index: bytes,
    expected_results: bytes,
    expected_deployment: bytes,
) -> dict[str, Any]:
    deadline = time.monotonic() + 600
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        index_status, index_body = http_bytes(f"{BENCH_LIVE}/?source_verify={revision}")
        results_status, results_body = http_bytes(
            f"{BENCH_LIVE}/results.json?source_verify={revision}"
        )
        deployment_status, deployment_body = http_bytes(
            f"{BENCH_LIVE}/deployment.json?source_verify={revision}"
        )
        last = {
            "index_http": index_status,
            "results_http": results_status,
            "deployment_http": deployment_status,
        }
        if (
            index_status == 200
            and b"SZL Bench Suite" in index_body
            and index_body == expected_index
            and results_status == 200
            and results_body == expected_results
            and deployment_status == 200
            and deployment_body == expected_deployment
        ):
            return last
        time.sleep(10)
    raise RuntimeError(f"Bench static host did not converge: {last}")


def verify_bench() -> dict[str, Any]:
    bench = api.space_info(BENCH, files_metadata=True)
    if bench.sdk != "static" or bench.private or runtime_stage(bench) != "RUNNING":
        raise RuntimeError("Bench is not a running public static Space")

    required = ["README.md", "index.html", "results.json", "deployment.json"]
    files = {item.rfilename for item in bench.siblings or []}
    missing = sorted(set(required) - files)
    if missing:
        raise RuntimeError(f"Bench is missing required files: {missing}")

    card = hub_bytes(BENCH, "README.md", bench.sha).decode("utf-8", "replace")
    index = hub_bytes(BENCH, "index.html", bench.sha)
    results = hub_bytes(BENCH, "results.json", bench.sha)
    deployment = hub_bytes(BENCH, "deployment.json", bench.sha)
    if not card.startswith("---\n"):
        raise RuntimeError("Bench card lacks top-of-file YAML")
    for marker in ("title: SZL Bench Suite", "sdk: static", "app_file: index.html"):
        if marker not in card:
            raise RuntimeError(f"Bench card lacks required marker: {marker}")
    json.loads(results.decode())
    deployment_json = json.loads(deployment.decode())

    sources = {
        "engine": "szl-holdings/frontier-bench",
        "retrieval": "szl-holdings/retrieval-bench",
        "quant": "szl-holdings/quant-curve",
    }
    current_revisions = {name: github_main_sha(repo) for name, repo in sources.items()}
    deployment_text = deployment.decode("utf-8", "replace")
    for name, repository in sources.items():
        expected = f"{repository}@{current_revisions[name]}"
        if expected not in deployment_text:
            raise RuntimeError(f"Bench deployment is stale or unbound: {expected}")

    live = wait_static_readback(bench.sha, index, results, deployment)
    return {
        "space_revision": bench.sha,
        "sdk": bench.sdk,
        "stage": runtime_stage(bench),
        "host": BENCH_LIVE,
        "source_revisions": current_revisions,
        "result_count": len(json.loads(results.decode())),
        "deployment_schema": deployment_json.get("schema"),
        "results_sha256": digest(results),
        "deployment_sha256": digest(deployment),
        **live,
    }


def verify_current_immune() -> dict[str, Any]:
    expected = os.environ["GITHUB_SHA"]
    deadline = time.monotonic() + 1200
    build: dict[str, Any] = {}
    ready: dict[str, Any] = {}
    nexus_status: dict[str, Any] = {}
    while time.monotonic() < deadline:
        build_http, build = http_json(IMMUNE_LIVE + "/api/build-info")
        ready_http, ready = http_json(IMMUNE_LIVE + "/readyz")
        status_http, nexus_status = http_json(IMMUNE_LIVE + "/api/immune/nexus/status")
        source_revision = str(
            build.get("source_revision") or (build.get("build") or {}).get("revision") or ""
        )
        if (
            build_http == 200
            and ready_http == 200
            and status_http == 200
            and source_revision == expected
            and ready.get("ready")
            and ready.get("write_ready")
            and nexus_status.get("state") == "EXECUTABLE"
        ):
            break
        time.sleep(10)
    else:
        raise RuntimeError(f"IMMUNE did not converge to source revision {expected}")

    request_id = "frontier-" + uuid.uuid4().hex[:20]
    execution_http, execution = http_json(
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
        raise RuntimeError("IMMUNE NEXUS invariants did not hold")
    output_hash = str(result.get("outputHash") or "")
    if len(output_hash) != 64:
        raise RuntimeError("IMMUNE NEXUS output hash is missing")

    return {
        "source_revision": expected,
        "build_state": build.get("state"),
        "readiness": ready.get("status"),
        "nexus_state": nexus_status.get("state"),
        "execution_http": execution_http,
        "request_id": request_id,
        "input_hash": result.get("inputHash"),
        "output_hash": output_hash,
        "receipt_hash": (governed.get("receipt") or {}).get("hash"),
        "invariants_hold": invariants.get("allHold"),
    }


def delete_exact_probe(archive: dict[str, Any]) -> dict[str, Any]:
    probe = api.space_info(PROBE)
    if probe.sha != archive["probe_revision"]:
        raise RuntimeError("Nexus Probe moved between verification and deletion")
    if probe.sdk != "static" or not probe.private:
        raise RuntimeError("Nexus Probe topology changed before deletion")

    api.delete_repo(repo_id=PROBE, repo_type="space")
    try:
        api.space_info(PROBE)
    except RepositoryNotFoundError:
        deleted = True
    else:
        deleted = False
    if not deleted:
        raise RuntimeError("Hugging Face still resolves Nexus Probe after deletion")

    keep = api.space_info(KEEP)
    if keep.sha != archive["keep_revision"] or runtime_stage(keep) != "RUNNING":
        raise RuntimeError("retained NEXUS changed or stopped after Probe deletion")
    return {
        "deleted_repo": PROBE,
        "deleted_revision": archive["probe_revision"],
        "deleted_verified": True,
        "retained_repo": KEEP,
        "retained_revision": keep.sha,
        "retained_runtime": probe_private_nexus(),
    }


def write_report(report: dict[str, Any]) -> None:
    report["finished_at"] = now()
    encoded = json.dumps(report, sort_keys=True, separators=(",", ":")).encode()
    report["report_sha256"] = digest(encoded)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "state": report.get("state"),
                "report_sha256": report["report_sha256"],
            },
            sort_keys=True,
        )
    )


def main() -> int:
    print(f"::add-mask::{HF_TOKEN}")
    if GITHUB_TOKEN:
        print(f"::add-mask::{GITHUB_TOKEN}")
    report: dict[str, Any] = {
        "schema": "szl.nexus-bench-final-convergence/v1",
        "started_at": now(),
        "state": "STARTED",
        "visibility_changed": False,
        "secret_values_recorded": False,
        "fabricated_measurements": False,
    }
    exit_code = 1
    try:
        identity = api.whoami()
        if identity.get("name") != "betterwithage":
            raise RuntimeError(f"unexpected Hugging Face identity: {identity.get('name')}")
        report["credential_identity"] = identity.get("name")
        archive = verify_archive()
        report["nexus_archive"] = archive
        report["bench"] = verify_bench()
        report["immune"] = verify_current_immune()
        report["probe_retirement"] = delete_exact_probe(archive)
        report["state"] = "CONVERGED"
        exit_code = 0
    except Exception as error:
        report["state"] = "FAILED"
        report["error"] = redact(f"{type(error).__name__}: {error}")
        print("::error::" + report["error"])
    finally:
        write_report(report)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
