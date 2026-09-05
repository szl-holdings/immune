#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Delete only the exact archived Nexus Probe and re-prove retained NEXUS."""
from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.utils import RepositoryNotFoundError

TOKEN = os.environ["HF_TOKEN"]
KEEP = "betterwithage/nexus"
PROBE = "betterwithage/nexus-probe"
ARCHIVE = "archive/nexus-probe-consolidation-20260905.json"
LIVE = "https://betterwithage-nexus.hf.space"
REPORT = Path("reports/nexus-probe-deletion.json")
api = HfApi(token=TOKEN)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_json(path: str) -> tuple[int, dict]:
    req = urllib.request.Request(
        LIVE + path,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Cache-Control": "no-cache",
            "User-Agent": "szl-nexus-probe-finalizer/1",
        },
    )
    with urllib.request.urlopen(req, timeout=45) as response:
        return response.status, json.loads(response.read(2_000_000).decode())


def main() -> int:
    print(f"::add-mask::{TOKEN}")
    identity = api.whoami()
    if identity.get("name") != "betterwithage":
        raise SystemExit("wrong Hugging Face identity")

    keep = api.space_info(KEEP)
    archive_path = hf_hub_download(
        KEEP,
        ARCHIVE,
        repo_type="space",
        revision=keep.sha,
        token=TOKEN,
    )
    archive = json.loads(Path(archive_path).read_text())
    candidate = archive["candidate_for_retirement"]
    if candidate["repo_id"] != PROBE:
        raise SystemExit("archive does not authorize this target")
    expected_sha = candidate["revision"]
    if candidate["classification"] != "UNMODIFIED_HUGGING_FACE_STATIC_STARTER":
        raise SystemExit("archive classification is not deletable")

    probe = api.space_info(PROBE)
    if probe.sha != expected_sha:
        raise SystemExit(f"probe moved: expected {expected_sha}, observed {probe.sha}")
    if probe.sdk != "static" or not probe.private:
        raise SystemExit("probe topology changed after archive")

    api.delete_repo(PROBE, repo_type="space")
    try:
        api.space_info(PROBE)
    except RepositoryNotFoundError:
        deleted = True
    else:
        deleted = False
    if not deleted:
        raise SystemExit("provider still resolves Nexus Probe")

    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        keep_after = api.space_info(KEEP)
        stage = str(getattr(getattr(keep_after, "runtime", None), "stage", "") or "").upper()
        if keep_after.sha == keep.sha and stage == "RUNNING":
            break
        time.sleep(10)
    else:
        raise SystemExit("retained NEXUS did not remain RUNNING")

    status, health = get_json("/healthz")
    if status != 200 or not health.get("ok"):
        raise SystemExit("retained NEXUS health failed after deletion")

    report = {
        "schema": "szl.nexus-probe-deletion/v1",
        "state": "DELETED_AND_RETAINED_RUNTIME_VERIFIED",
        "deleted_repo": PROBE,
        "deleted_revision": expected_sha,
        "retained_repo": KEEP,
        "retained_revision": keep.sha,
        "retained_health_http": status,
        "deleted_at": now(),
        "credential_identity": identity.get("name"),
        "secret_values_recorded": False,
        "visibility_changed": False,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
