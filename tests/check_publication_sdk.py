# SPDX-License-Identifier: Apache-2.0
"""Qualify the installed publication SDK against the actual built upload bundles.

Offline recording-provider test. The actual Hub SDK constructs and hashes every
operation; no HTTP request, account mutation, or publication is permitted.
"""
from __future__ import annotations

import glob
import hashlib
import inspect
import json
import os
from pathlib import Path
import platform
import re
import sys
from importlib.metadata import version
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import immune_publication_guard as guard
from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi, SpaceInfo


def main() -> None:
    if version("huggingface_hub") != "1.23.0":
        raise RuntimeError("publication SDK does not match the existing production pin")
    source = os.environ.get("SOURCE_REVISION", "")
    if re.fullmatch(r"[0-9a-f]{40}", source) is None or source == "0" * 40:
        raise RuntimeError("full source identity is required")
    if platform.python_version_tuple()[:2] != ("3", "12"):
        raise RuntimeError("qualify the production Python 3.12 publisher")
    bundles = {
        "SZLHOLDINGS/immune": {
            "Dockerfile": "frontend/deploy/Dockerfile",
            ".dockerignore": "frontend/deploy/.dockerignore",
            "README.md": "frontend/deploy/README.md",
            "hf-deploy-manifest.json": "frontend/deploy/dist/hf-deploy-manifest.json",
        },
        "SZLHOLDINGS/immune-lattice": {
            "Dockerfile": "python/space/Dockerfile",
            "requirements.txt": "python/requirements.txt",
            "README.md": "python/space/README.md",
            "server.py": "python/space/run.py",
            "index.html": "python/space/index.html",
        },
    }
    for local in glob.glob("frontend/deploy/dist/**/*", recursive=True):
        if os.path.isfile(local):
            bundles["SZLHOLDINGS/immune"][os.path.relpath(local, "frontend/deploy").replace("\\", "/")] = local
    if Path("python/space/nexus.html").is_file():
        bundles["SZLHOLDINGS/immune-lattice"]["nexus.html"] = "python/space/nexus.html"
    for path in Path("python/immune").rglob("*"):
        if path.is_file() and path.suffix != ".pyc" and "__pycache__" not in path.parts:
            bundles["SZLHOLDINGS/immune-lattice"]["immune/" + path.relative_to("python/immune").as_posix()] = str(path)
    evidence = Path("reports/publication-sdk")
    evidence.mkdir(parents=True, exist_ok=True)
    summaries = []
    for index, (space, uploads) in enumerate(bundles.items()):
        api = HfApi(endpoint="https://huggingface.co", token=False)
        frozen = guard.freeze_uploads(space, uploads, ROOT)
        calls = []
        parent = "b" * 40
        result_sha = "c" * 40
        def record_commit(**kwargs):
            # Validate the *real installed SDK's* method signature and actual
            # operation classes; never call its network implementation.
            inspect.signature(HfApi.create_commit).bind(api, **kwargs)
            if kwargs["parent_commit"] != parent or kwargs["revision"] != "main":
                raise RuntimeError("mutation lost its revision binding")
            for operation in kwargs["operations"]:
                if not isinstance(operation, (CommitOperationAdd, CommitOperationDelete)):
                    raise RuntimeError("unexpected SDK operation")
                if isinstance(operation, CommitOperationAdd):
                    expected = frozen[operation.path_in_repo]
                    if operation.upload_info.size != len(expected):
                        raise RuntimeError("SDK upload size differs")
                    if operation.upload_info.sha256.hex() != hashlib.sha256(expected).hexdigest():
                        raise RuntimeError("SDK upload digest differs")
            calls.append(kwargs)
            return SimpleNamespace(oid=result_sha)
        info = SpaceInfo(id=space, private=False, sdk="docker", sha=parent)
        with patch.object(guard, "require_main_source"), \
             patch.object(api, "repo_info", return_value=info), \
             patch.object(api, "list_repo_files", return_value=[".gitattributes", "data/ledger.jsonl"]), \
             patch.object(api, "create_commit", side_effect=record_commit), \
             patch("httpx.Client.send", side_effect=RuntimeError("network forbidden in qualification")):
            receipt = guard.publish_existing(api, space, uploads, source, checkout=ROOT,
                                             receipt_path=evidence / f"channel-{index}-fixture.json")
        if len(calls) != 1 or receipt["live_verified"] is not False:
            raise RuntimeError("invalid recording-provider outcome")
        receipt.update(provider_mode="SYNTHETIC_RECORDING_NO_HTTP", actual_provider_mutations=0)
        (evidence / f"channel-{index}-fixture.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        summaries.append({"space": space, "bundle_files": len(frozen),
                          "bundle_bytes": sum(map(len, frozen.values())),
                          "upload_sha256": receipt["upload_sha256"]})
    report = {"schema": "szl.immune.native-sdk-qualification/v1", "source_revision": source,
              "python": platform.python_version(), "sdk": version("huggingface_hub"),
              "data_class": "REAL_BUILD_WITH_SYNTHETIC_PROVIDER_METADATA",
              "provider_mutations": 0, "live_verified": False, "status": "PASS", "channels": summaries}
    (evidence / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "channels"}, sort_keys=True))


if __name__ == "__main__":
    main()
