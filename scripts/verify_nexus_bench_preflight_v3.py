# SPDX-License-Identifier: Apache-2.0
"""Correct the Bench source-binding gate while preserving the v2 preflight."""
from __future__ import annotations

import json
import time
from typing import Any

import verify_nexus_bench_preflight as base


def verify_bench() -> dict[str, Any]:
    """Validate the canonical structured deployment contract and live static files."""
    bench = base.api.space_info(base.BENCH, files_metadata=True)
    if bench.sdk != "static" or bench.private or base.stage(bench) != "RUNNING":
        raise RuntimeError("Bench is not a running public static Space")

    required = {"README.md", "index.html", "results.json", "deployment.json"}
    available = {item.rfilename for item in bench.siblings or []}
    if not required.issubset(available):
        raise RuntimeError(f"Bench files missing: {sorted(required - available)}")

    card = base.hub_bytes(base.BENCH, "README.md", bench.sha).decode(
        "utf-8", "replace"
    )
    for marker in ("title: SZL Bench Suite", "sdk: static", "app_file: index.html"):
        if marker not in card:
            raise RuntimeError(f"Bench card marker missing: {marker}")

    results_bytes = base.hub_bytes(base.BENCH, "results.json", bench.sha)
    deployment_bytes = base.hub_bytes(base.BENCH, "deployment.json", bench.sha)
    results_json = json.loads(results_bytes.decode())
    deployment_json = json.loads(deployment_bytes.decode())
    if not isinstance(results_json, dict) or not isinstance(deployment_json, dict):
        raise TypeError("Bench result and deployment artifacts must be JSON objects")

    expected_repositories = {
        "engine": "szl-holdings/frontier-bench",
        "retrieval": "szl-holdings/retrieval-bench",
        "quant": "szl-holdings/quant-curve",
    }
    revisions = {
        plane: base.github_main(repository)
        for plane, repository in expected_repositories.items()
    }

    def source_map(document: dict[str, Any], label: str) -> dict[str, dict[str, Any]]:
        rows = document.get("sources")
        if not isinstance(rows, list):
            raise TypeError(f"Bench {label} sources must be a list")
        mapped: dict[str, dict[str, Any]] = {}
        for row in rows:
            if not isinstance(row, dict):
                raise TypeError(f"Bench {label} source row must be an object")
            plane = str(row.get("plane") or "")
            if plane in mapped:
                raise RuntimeError(f"Bench {label} repeats source plane: {plane}")
            mapped[plane] = row
        return mapped

    deployment_sources = source_map(deployment_json, "deployment")
    result_sources = source_map(results_json, "results")
    for plane, repository in expected_repositories.items():
        for label, mapped in (
            ("deployment", deployment_sources),
            ("results", result_sources),
        ):
            row = mapped.get(plane)
            if row is None:
                raise RuntimeError(f"Bench {label} is missing source plane: {plane}")
            if row.get("repository") != repository:
                raise RuntimeError(
                    f"Bench {label} repository mismatch for {plane}: "
                    f"{row.get('repository')}"
                )
            if row.get("revision") != revisions[plane]:
                raise RuntimeError(
                    f"Bench {label} revision mismatch for {plane}: "
                    f"expected {revisions[plane]}, observed {row.get('revision')}"
                )
            receipt_hash = str(row.get("verified_results_sha256") or "")
            if len(receipt_hash) != 64:
                raise RuntimeError(
                    f"Bench {label} source receipt hash missing for {plane}"
                )

    deadline = time.monotonic() + 600
    live_state: dict[str, int] = {}
    while time.monotonic() < deadline:
        index_http, index_live = base.fetch(
            f"{base.BENCH_LIVE}/?revision={bench.sha}"
        )
        results_http, results_live = base.fetch(
            f"{base.BENCH_LIVE}/results.json?revision={bench.sha}"
        )
        deployment_http, deployment_live = base.fetch(
            f"{base.BENCH_LIVE}/deployment.json?revision={bench.sha}"
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
            and results_live == results_bytes
            and deployment_http == 200
            and deployment_live == deployment_bytes
        ):
            break
        time.sleep(10)
    else:
        raise RuntimeError(f"Bench static host did not converge: {live_state}")

    result_count = results_json.get("count")
    if not isinstance(result_count, int) or result_count < 0:
        raise RuntimeError("Bench result count is invalid")
    truth = deployment_json.get("truth")
    if not isinstance(truth, dict) or truth.get("results_are_measured_only") is not True:
        raise RuntimeError("Bench deployment is missing measured-only truth policy")

    return {
        "space_revision": bench.sha,
        "sdk": bench.sdk,
        "stage": base.stage(bench),
        "host": base.BENCH_LIVE,
        "source_revisions": revisions,
        "deployment_schema": deployment_json.get("schema"),
        "result_count": result_count,
        "results_sha256": base.digest(results_bytes),
        "deployment_sha256": base.digest(deployment_bytes),
        **live_state,
    }


base.verify_bench = verify_bench

if __name__ == "__main__":
    raise SystemExit(base.main())
