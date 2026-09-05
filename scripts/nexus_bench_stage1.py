#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Archive the empty Nexus Probe, repair Bench, and verify current IMMUNE.

Deletion is intentionally performed by a separate exact-SHA finalizer only
after this script completes every preservation and runtime gate.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi, hf_hub_download

TOKEN = os.environ["HF_TOKEN"]
KEEP = "betterwithage/nexus"
PROBE = "betterwithage/nexus-probe"
BENCH = "betterwithage/szl-bench-suite"
IMMUNE_LIVE = "https://szlholdings-immune.hf.space"
BENCH_LIVE = "https://betterwithage-szl-bench-suite.hf.space"
NEXUS_LIVE = "https://betterwithage-nexus.hf.space"
REPORT = Path("reports/nexus-bench-stage1.json")
EXPECTED_PROBE_FILES = [".gitattributes", "README.md", "index.html", "style.css"]
api = HfApi(token=TOKEN)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(args: list[str], cwd: Path | None = None) -> str:
    completed = subprocess.run(
        args,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    print(completed.stdout, end="")
    return completed.stdout


def get_json(url: str, token: str | None = None) -> tuple[int, Any]:
    headers = {"Cache-Control": "no-cache", "User-Agent": "szl-nexus-bench-stage1/1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=45) as response:
        return response.status, json.loads(response.read(4_000_000).decode())


def post_json(url: str, payload: dict[str, Any], token: str | None = None) -> tuple[int, Any]:
    headers = {
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "User-Agent": "szl-nexus-bench-stage1/1",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.status, json.loads(response.read(4_000_000).decode())


def stage(info: Any) -> str:
    return str(getattr(getattr(info, "runtime", None), "stage", "") or "").upper()


def wait_space(repo_id: str, revision: str, sdk: str, seconds: int = 900) -> Any:
    deadline = time.monotonic() + seconds
    latest = None
    while time.monotonic() < deadline:
        latest = api.space_info(repo_id)
        if latest.sha == revision and latest.sdk == sdk and stage(latest) == "RUNNING":
            return latest
        time.sleep(10)
    raise TimeoutError(
        f"{repo_id} failed convergence: sha={getattr(latest,'sha',None)} "
        f"sdk={getattr(latest,'sdk',None)} stage={stage(latest)}"
    )


def probe_private_nexus() -> dict[str, Any]:
    health_status, health = get_json(NEXUS_LIVE + "/healthz", TOKEN)
    analog_status, analog = post_json(
        NEXUS_LIVE + "/api/analog",
        {"program": "lorenz", "steps": 64, "chaos": 0.45, "drive": 0.7},
        TOKEN,
    )
    if health_status != 200 or not health.get("ok"):
        raise RuntimeError("private NEXUS health failed")
    if analog_status != 200 or analog.get("program") != "lorenz":
        raise RuntimeError("private NEXUS analog execution failed")
    return {
        "health_http": health_status,
        "analog_http": analog_status,
        "program": analog.get("program"),
        "honesty": analog.get("honesty"),
    }


def archive_probe(report: dict[str, Any]) -> None:
    keep = api.space_info(KEEP, files_metadata=True)
    probe = api.space_info(PROBE, files_metadata=True)
    if keep.sdk != "docker" or not keep.private:
        raise RuntimeError("retained NEXUS topology changed")
    if probe.sdk != "static" or not probe.private:
        raise RuntimeError("Nexus Probe topology changed")

    files = sorted(item.rfilename for item in probe.siblings or [])
    if files != EXPECTED_PROBE_FILES:
        raise RuntimeError(f"Nexus Probe is not the expected starter: {files}")

    captured: dict[str, Any] = {}
    for sibling in probe.siblings or []:
        local = hf_hub_download(
            PROBE,
            sibling.rfilename,
            repo_type="space",
            revision=probe.sha,
            token=TOKEN,
        )
        data = Path(local).read_bytes()
        captured[sibling.rfilename] = {
            "bytes": len(data),
            "sha256": sha(data),
            "blob_id": getattr(sibling, "blob_id", None),
            "content_base64": base64.b64encode(data).decode(),
        }
    readme = base64.b64decode(captured["README.md"]["content_base64"]).decode()
    index = base64.b64decode(captured["index.html"]["content_base64"]).decode()
    if "Check out the configuration reference" not in readme:
        raise RuntimeError("Nexus Probe README is no longer the starter")
    if "Welcome to your static Space!" not in index:
        raise RuntimeError("Nexus Probe index is no longer the starter")

    runtime_before = probe_private_nexus()
    keep_readme_path = hf_hub_download(
        KEEP,
        "README.md",
        repo_type="space",
        revision=keep.sha,
        token=TOKEN,
    )
    keep_readme = Path(keep_readme_path).read_text(encoding="utf-8")
    notice = (
        "\n> **Canonical topology.** This private Space preserves the original NEXUS "
        "MK-II instrument. The public governed runtime is "
        "[IMMUNE / NEXUS](https://szlholdings-immune.hf.space/nexus.html). "
        "The empty `betterwithage/nexus-probe` starter is archived below and "
        "retired only after the public runtimes pass.\n"
    )
    if "**Canonical topology.**" not in keep_readme:
        boundary = keep_readme.find("\n---\n", 4)
        if boundary < 0:
            raise RuntimeError("retained NEXUS card has no YAML boundary")
        keep_readme = keep_readme[: boundary + 5] + notice + keep_readme[boundary + 5 :]

    receipt = {
        "schema": "szl.hf.nexus-consolidation/v1",
        "captured_at": now(),
        "decision": "RETIRE_UNMODIFIED_STARTER_KEEP_REAL_NEXUS_AND_IMMUNE_RUNTIME",
        "canonical_public_runtime": IMMUNE_LIVE + "/nexus.html",
        "canonical_sources": ["szl-holdings/nexus", "szl-holdings/immune"],
        "preserved": {
            "repo_id": KEEP,
            "revision_before_archive": keep.sha,
            "sdk": keep.sdk,
            "private": keep.private,
        },
        "candidate_for_retirement": {
            "repo_id": PROBE,
            "revision": probe.sha,
            "sdk": probe.sdk,
            "private": probe.private,
            "classification": "UNMODIFIED_HUGGING_FACE_STATIC_STARTER",
            "files": captured,
        },
        "secret_values_recorded": False,
        "visibility_changed": False,
    }
    receipt_bytes = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode()
    topology_bytes = (
        json.dumps(
            {
                "schema": "szl.nexus.runtime-topology/v1",
                "canonical_public_runtime": IMMUNE_LIVE + "/nexus.html",
                "canonical_api": IMMUNE_LIVE + "/api/immune/nexus",
                "private_preservation_space": KEEP,
                "duplicate_probe": PROBE,
                "truth": "MEASURED_SOFTWARE_SIMULATION",
                "energy": "UNAVAILABLE",
                "uniqueness": "Conjecture 1 OPEN",
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode()
    operations = [
        CommitOperationAdd("README.md", io.BytesIO(keep_readme.encode())),
        CommitOperationAdd("CANONICAL_RUNTIME.json", io.BytesIO(topology_bytes)),
        CommitOperationAdd(
            "archive/nexus-probe-consolidation-20260905.json",
            io.BytesIO(receipt_bytes),
        ),
    ]
    commit = api.create_commit(
        KEEP,
        operations=operations,
        repo_type="space",
        parent_commit=keep.sha,
        commit_message="ops: archive Nexus Probe before exact retirement",
        commit_description="Preserve the starter bytes and bind the real private NEXUS mirror to IMMUNE.",
    )
    keep_after = commit.oid
    wait_space(KEEP, keep_after, "docker")
    for name, expected in (
        ("README.md", keep_readme.encode()),
        ("CANONICAL_RUNTIME.json", topology_bytes),
        ("archive/nexus-probe-consolidation-20260905.json", receipt_bytes),
    ):
        local = hf_hub_download(
            KEEP,
            name,
            repo_type="space",
            revision=keep_after,
            token=TOKEN,
        )
        if Path(local).read_bytes() != expected:
            raise RuntimeError(f"NEXUS archive readback failed: {name}")

    report["nexus"] = {
        "keep": KEEP,
        "keep_revision_before": keep.sha,
        "keep_revision_after": keep_after,
        "probe": PROBE,
        "probe_revision": probe.sha,
        "receipt_sha256": sha(receipt_bytes),
        "runtime_before": runtime_before,
        "runtime_after_archive": probe_private_nexus(),
    }


def repair_bench(report: dict[str, Any]) -> None:
    work = Path(tempfile.mkdtemp(prefix="szl-bench-stage1-"))
    try:
        repos = {
            "engine": ("szl-holdings/frontier-bench", work / "engine"),
            "retrieval": ("szl-holdings/retrieval-bench", work / "retrieval"),
            "quant": ("szl-holdings/quant-curve", work / "quant"),
        }
        revisions: dict[str, str] = {}
        for key, (name, path) in repos.items():
            run(["git", "clone", "--quiet", f"https://github.com/{name}.git", str(path)])
            revisions[key] = run(["git", "rev-parse", "HEAD"], path).strip()

        engine = repos["engine"][1]
        (engine / "inputs").mkdir(exist_ok=True)
        os.symlink(repos["retrieval"][1], engine / "inputs" / "retrieval-bench")
        os.symlink(repos["quant"][1], engine / "inputs" / "quant-curve")
        receipts = sorted((engine / "receipts").glob("*.json"))
        run(["python", "verify/verifier.py", *[str(p.relative_to(engine)) for p in receipts]], engine)
        run(["python", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"], engine)
        (engine / "build").mkdir(exist_ok=True)
        run(["python", "tools/sync_results.py", "receipts", "build/engine.json", "engine"], engine)
        run([
            "python", "tools/sync_results.py", "inputs/retrieval-bench/receipts",
            "build/retrieval.json", "retrieval",
        ], engine)
        run([
            "python", "tools/sync_results.py", "inputs/quant-curve/receipts",
            "build/quant.json", "quant",
        ], engine)
        run([
            "python", "tools/merge_results.py",
            "--output", "site/results.json",
            "--deployment-output", "site/deployment.json",
            "--input", "engine=build/engine.json",
            "--input", "retrieval=build/retrieval.json",
            "--input", "quant=build/quant.json",
            "--source", f"engine=szl-holdings/frontier-bench@{revisions['engine']}",
            "--source", f"retrieval=szl-holdings/retrieval-bench@{revisions['retrieval']}",
            "--source", f"quant=szl-holdings/quant-curve@{revisions['quant']}",
        ], engine)

        site = engine / "site"
        card = (site / "README.md").read_text()
        if not card.startswith("---\n") or "sdk: static" not in card:
            raise RuntimeError("Bench card is missing static Space metadata")
        info = api.space_info(BENCH, files_metadata=True)
        files = sorted(path for path in site.rglob("*") if path.is_file())
        keep = {path.relative_to(site).as_posix() for path in files}
        operations: list[Any] = [
            CommitOperationAdd(path.relative_to(site).as_posix(), str(path))
            for path in files
        ]
        for remote in sorted(set(api.list_repo_files(BENCH, repo_type="space")) - keep - {".gitattributes"}):
            operations.append(CommitOperationDelete(remote))
        commit = api.create_commit(
            BENCH,
            operations=operations,
            repo_type="space",
            parent_commit=info.sha,
            commit_message="fix: publish source-bound consolidated Bench Suite",
        )
        after = commit.oid
        try:
            api.restart_space(BENCH, factory_reboot=True)
        except Exception:
            pass
        observed = wait_space(BENCH, after, "static")
        if observed.private:
            raise RuntimeError("Bench unexpectedly became private")

        for name in ("README.md", "index.html", "results.json", "deployment.json"):
            local = hf_hub_download(
                BENCH,
                name,
                repo_type="space",
                revision=after,
                token=TOKEN,
            )
            if Path(local).read_bytes() != (site / name).read_bytes():
                raise RuntimeError(f"Bench Hub readback failed: {name}")
        req = urllib.request.Request(
            BENCH_LIVE + f"/?source_verify={after}",
            headers={"Cache-Control": "no-cache", "User-Agent": "szl-bench-stage1/1"},
        )
        with urllib.request.urlopen(req, timeout=45) as response:
            body = response.read(2_000_000).decode("utf-8", "replace")
            status = response.status
        if status != 200 or "SZL Bench Suite" not in body:
            raise RuntimeError("Bench live identity failed")

        report["bench"] = {
            "state": "RUNNING_SOURCE_BOUND",
            "revision_before": info.sha,
            "revision_after": after,
            "sdk": observed.sdk,
            "stage": stage(observed),
            "live_http": status,
            "source_revisions": revisions,
            "results_sha256": sha((site / "results.json").read_bytes()),
            "deployment_sha256": sha((site / "deployment.json").read_bytes()),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


def verify_current_immune(report: dict[str, Any]) -> None:
    expected = os.environ["GITHUB_SHA"]
    deadline = time.monotonic() + 1200
    build = ready = status = None
    while time.monotonic() < deadline:
        try:
            _, build = get_json(IMMUNE_LIVE + "/api/build-info")
            _, ready = get_json(IMMUNE_LIVE + "/readyz")
            _, status = get_json(IMMUNE_LIVE + "/api/immune/nexus/status")
            observed = str(build.get("source_revision") or (build.get("build") or {}).get("revision") or "")
            if observed == expected and ready.get("ready") and ready.get("write_ready") and status.get("state") == "EXECUTABLE":
                break
        except Exception:
            pass
        time.sleep(10)
    else:
        raise RuntimeError(f"IMMUNE did not converge to {expected}")

    request_id = "frontier-" + uuid.uuid4().hex[:20]
    run_status, execution = post_json(
        IMMUNE_LIVE + "/api/immune/nexus/run",
        {
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
    )
    result = execution.get("result") or {}
    governed = execution.get("governed") or {}
    if run_status not in (200, 201) or not governed.get("pass") or not (result.get("invariants") or {}).get("allHold"):
        raise RuntimeError("IMMUNE governed NEXUS run failed")
    report["immune"] = {
        "state": "CURRENT_AND_EXECUTABLE",
        "source_revision": expected,
        "build_state": build.get("state"),
        "readiness": ready.get("status"),
        "nexus_state": status.get("state"),
        "run_http": run_status,
        "request_id": request_id,
        "input_hash": result.get("inputHash"),
        "output_hash": result.get("outputHash"),
        "receipt_hash": (governed.get("receipt") or {}).get("hash"),
    }


def main() -> int:
    print(f"::add-mask::{TOKEN}")
    identity = api.whoami()
    if identity.get("name") != "betterwithage":
        raise SystemExit(f"wrong HF identity: {identity.get('name')}")
    report: dict[str, Any] = {
        "schema": "szl.nexus-bench-stage1/v1",
        "started_at": now(),
        "credential_identity": identity.get("name"),
        "secret_values_recorded": False,
        "visibility_changed": False,
    }
    archive_probe(report)
    repair_bench(report)
    verify_current_immune(report)
    report["state"] = "PRESERVED_REPAIRED_AND_VERIFIED"
    report["finished_at"] = now()
    encoded = json.dumps(report, sort_keys=True, separators=(",", ":")).encode()
    report["report_sha256"] = sha(encoded)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"state": report["state"], "report_sha256": report["report_sha256"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
