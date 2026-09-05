# SPDX-License-Identifier: Apache-2.0
"""Prove retained NEXUS, Bench, and IMMUNE after Nexus Probe retirement."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from huggingface_hub import HfApi
from huggingface_hub.utils import RepositoryNotFoundError

HF_TOKEN = os.environ["HF_TOKEN"]
NEXUS_LIVE = "https://betterwithage-nexus.hf.space"
BENCH_LIVE = "https://betterwithage-szl-bench-suite.static.hf.space"
IMMUNE_LIVE = "https://szlholdings-immune.hf.space"
PREFLIGHT = Path("reports/nexus-bench-preflight.json")
REPORT = Path("reports/nexus-bench-postdelete.json")
api = HfApi(token=HF_TOKEN)


def fetch(
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    bearer: str | None = None,
) -> tuple[int, bytes]:
    data = None if payload is None else json.dumps(payload).encode()
    headers = {
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": "szl-nexus-bench-postdelete/1",
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
        with urllib.request.urlopen(request, timeout=60) as response:
            return int(response.status), response.read(4 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        return int(error.code), error.read(4 * 1024 * 1024)


def fetch_json(
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    bearer: str | None = None,
) -> tuple[int, dict[str, Any]]:
    status, raw = fetch(url, payload=payload, bearer=bearer)
    decoded = json.loads(raw.decode())
    if not isinstance(decoded, dict):
        raise TypeError(f"{url} returned non-object JSON")
    return status, decoded


def main() -> int:
    print(f"::add-mask::{HF_TOKEN}")
    preflight = json.loads(PREFLIGHT.read_text())
    keep_revision = preflight["nexus_archive"]["retained_revision"]
    expected_source = os.environ["GITHUB_SHA"]

    try:
        api.space_info("betterwithage/nexus-probe")
    except RepositoryNotFoundError:
        probe_deleted = True
    else:
        probe_deleted = False
    if not probe_deleted:
        raise RuntimeError("Nexus Probe still resolves")

    keep = api.space_info("betterwithage/nexus")
    keep_stage = str(
        getattr(getattr(keep, "runtime", None), "stage", "") or ""
    ).upper()
    if keep.sha != keep_revision or keep_stage != "RUNNING":
        raise RuntimeError("retained NEXUS changed or stopped")

    health_http, health = fetch_json(NEXUS_LIVE + "/healthz", bearer=HF_TOKEN)
    nemo_http, nemo = fetch_json(
        NEXUS_LIVE + "/api/analog",
        bearer=HF_TOKEN,
        payload={"program": "nemo", "steps": 80, "chaos": 0.45, "drive": 1.0},
    )
    if health_http != 200 or not health.get("ok"):
        raise RuntimeError("retained NEXUS health failed")
    if nemo_http != 200 or nemo.get("program") != "nemo":
        raise RuntimeError("retained NEXUS NEMO execution failed")
    if nemo.get("honesty") != "MEASURED":
        raise RuntimeError("retained NEXUS NEMO execution was not measured")

    bench_http, bench_body = fetch(BENCH_LIVE + "/")
    results_http, _ = fetch(BENCH_LIVE + "/results.json")
    deployment_http, _ = fetch(BENCH_LIVE + "/deployment.json")
    if bench_http != 200 or b"SZL Bench Suite" not in bench_body:
        raise RuntimeError("Bench failed after Probe retirement")
    if results_http != 200 or deployment_http != 200:
        raise RuntimeError("Bench artifacts failed after Probe retirement")

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
    if build_http != 200 or source != expected_source:
        raise RuntimeError("IMMUNE source drifted after Probe retirement")
    if ready_http != 200 or not ready.get("ready") or not ready.get("write_ready"):
        raise RuntimeError("IMMUNE readiness failed after Probe retirement")
    if status_http != 200 or nexus_status.get("state") != "EXECUTABLE":
        raise RuntimeError("IMMUNE NEXUS stopped after Probe retirement")

    report = {
        "schema": "szl.nexus-bench-postdelete/v1",
        "state": "CONVERGED_AND_PROBE_RETIRED",
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "probe_deleted": True,
        "retained_nexus_revision": keep.sha,
        "retained_nexus_health_http": health_http,
        "retained_nexus_nemo_http": nemo_http,
        "bench_http": bench_http,
        "bench_results_http": results_http,
        "bench_deployment_http": deployment_http,
        "immune_source_revision": source,
        "immune_readiness": ready.get("status"),
        "immune_nexus_state": nexus_status.get("state"),
        "visibility_changed": False,
        "secret_values_recorded": False,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
