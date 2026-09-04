#!/usr/bin/env python3
"""Reconstruct the active Command Centre manifest from its immutable receipt.

The public archive trees and the 50-source preservation receipt remained intact,
but a later presentation commit reset ``manifest.json.consolidated_spaces`` to
an empty list. This repair copies the exact preserved records back from the
current immutable pre-delete receipt. It neither invents source metadata nor
modifies any archived source file.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from huggingface_hub import CommitOperationAdd, HfApi, hf_hub_download

PROFILE = "betterwithage"
ORG = "SZLHOLDINGS"
COMMAND_REPO = f"{PROFILE}/szl-command-centre"
MANIFEST_FILENAME = "manifest.json"
RECEIPT_FILENAME = "HF_SPACE_CONSOLIDATION_PREDELETE_RECEIPT.json"
EXPECTED_COUNT = 50
EXPECTED_ACTIVE_ORG = {
    "README",
    "a11oy",
    "aegis-assurance",
    "counsel",
    "david-leads",
    "finance",
    "killinchu",
    "lyte",
    "sentra",
    "terra",
    "vertical-services",
    "vessels",
}
REQUIRED_RETIRED_RECORDS = {
    "SZLHOLDINGS/david-leads",
    "SZLHOLDINGS/quant-curve",
    "SZLHOLDINGS/szl-command-lab",
}

TOKEN = os.environ["HF_TOKEN"]
api = HfApi(token=TOKEN)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def valid_sha(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 40
        and all(character in "0123456789abcdef" for character in value.lower())
    )


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(filename: str, revision: str) -> tuple[dict[str, Any], Path]:
    path = Path(
        hf_hub_download(
            repo_id=COMMAND_REPO,
            repo_type="space",
            filename=filename,
            revision=revision,
            token=TOKEN,
            force_download=True,
        )
    )
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{filename} is not a JSON object")
    return value, path


def stage_name(runtime: object) -> str:
    value = getattr(runtime, "stage", None)
    return str(getattr(value, "value", value) or "UNKNOWN").upper()


def wait_running(expected_revision: str, seconds: int = 900) -> None:
    deadline = time.monotonic() + seconds
    restarted = False
    last: tuple[str, str, bool] | None = None
    while time.monotonic() < deadline:
        info = api.repo_info(repo_id=COMMAND_REPO, repo_type="space")
        revision = str(info.sha or "")
        private = bool(info.private)
        stage = stage_name(api.get_space_runtime(repo_id=COMMAND_REPO))
        last = (revision, stage, private)
        print(
            f"COMMAND CENTRE sha={revision[:12]} stage={stage} private={private}",
            flush=True,
        )
        if private:
            raise RuntimeError("Command Centre became private")
        if revision == expected_revision and stage == "RUNNING":
            return
        if revision == expected_revision and stage in {
            "PAUSED",
            "SLEEPING",
            "STOPPED",
            "RUNTIME_ERROR",
            "BUILD_ERROR",
            "CONFIG_ERROR",
        } and not restarted:
            api.restart_space(
                repo_id=COMMAND_REPO,
                factory_reboot=stage
                in {"RUNTIME_ERROR", "BUILD_ERROR", "CONFIG_ERROR"},
            )
            restarted = True
        time.sleep(10)
    raise TimeoutError(f"Command Centre did not become RUNNING: {last}")


def validate_receipt(receipt: dict[str, Any], files: set[str]) -> list[dict[str, Any]]:
    required = {
        "schema": "szl.hf-space-consolidation.predelete.v3",
        "status": "PRESERVED_AND_READY_FOR_EXACT_DELETE",
        "mode": "PRESERVE_AND_VERIFY_ONLY",
        "organization": ORG,
        "profile": PROFILE,
    }
    for key, expected in required.items():
        if receipt.get(key) != expected:
            raise RuntimeError(
                f"preservation receipt {key} mismatch: "
                f"{receipt.get(key)!r} != {expected!r}"
            )

    victims = receipt.get("victims")
    revisions = receipt.get("expected_source_revisions")
    records_raw = receipt.get("consolidated")
    if not isinstance(victims, list) or len(victims) != EXPECTED_COUNT:
        raise RuntimeError("preservation receipt does not contain 50 victims")
    if len(set(victims)) != EXPECTED_COUNT:
        raise RuntimeError("preservation receipt contains duplicate victims")
    if not isinstance(revisions, dict) or set(revisions) != set(victims):
        raise RuntimeError("preservation revision map does not match victims")
    if not isinstance(records_raw, list) or len(records_raw) != EXPECTED_COUNT:
        raise RuntimeError("preservation receipt does not contain 50 records")
    records = [item for item in records_raw if isinstance(item, dict)]
    if len(records) != EXPECTED_COUNT:
        raise RuntimeError("preservation receipt contains a non-object record")

    sources = [str(item.get("source") or "") for item in records]
    if set(sources) != set(victims) or len(set(sources)) != EXPECTED_COUNT:
        raise RuntimeError("preservation record sources do not exactly match victims")
    missing_required = REQUIRED_RETIRED_RECORDS - set(sources)
    if missing_required:
        raise RuntimeError(
            f"preservation receipt lacks required records: {sorted(missing_required)}"
        )

    prefixes: set[str] = set()
    for record in records:
        source = str(record.get("source") or "")
        revision = str(record.get("source_sha") or "")
        prefix = str(record.get("archive_prefix") or "").rstrip("/")
        if not source.startswith(ORG + "/"):
            raise RuntimeError(f"invalid source ID: {source!r}")
        if revisions.get(source) != revision or not valid_sha(revision):
            raise RuntimeError(f"invalid frozen revision for {source}")
        if not prefix.startswith("archive/") or prefix in prefixes:
            raise RuntimeError(f"invalid or duplicate archive prefix for {source}: {prefix!r}")
        prefixes.add(prefix)
        if not any(path.startswith(prefix + "/") for path in files):
            raise RuntimeError(f"archive tree is missing for {source}: {prefix}")
        record_files = record.get("files")
        if not isinstance(record_files, list) or not record_files:
            raise RuntimeError(f"receipt file manifest is empty for {source}")
        if int(record.get("file_count") or 0) != len(record_files):
            raise RuntimeError(f"receipt file count mismatch for {source}")
    return records


def main() -> None:
    identity = api.whoami(token=TOKEN)
    identity_name = str(identity.get("name") or identity.get("fullname") or "")
    if identity_name.lower() != PROFILE:
        raise RuntimeError(
            f"wrong Hugging Face identity: expected {PROFILE}, got {identity_name!r}"
        )

    info = api.repo_info(repo_id=COMMAND_REPO, repo_type="space")
    current_revision = str(info.sha or "")
    if bool(info.private) or not valid_sha(current_revision):
        raise RuntimeError("Command Centre is not a public exact-revision Space")
    manifest, _ = load_json(MANIFEST_FILENAME, current_revision)
    current_records = manifest.get("consolidated_spaces")
    if not isinstance(current_records, list):
        raise RuntimeError("active manifest consolidated_spaces is not a list")

    repo_files = set(
        api.list_repo_files(
            repo_id=COMMAND_REPO,
            repo_type="space",
            revision=current_revision,
        )
    )
    receipt, receipt_path = load_json(RECEIPT_FILENAME, current_revision)
    records = validate_receipt(receipt, repo_files)

    if len(current_records) == EXPECTED_COUNT:
        current_sources = {
            str(item.get("source") or "")
            for item in current_records
            if isinstance(item, dict)
        }
        receipt_sources = {str(item["source"]) for item in records}
        if current_sources != receipt_sources:
            raise RuntimeError(
                "existing 50-record manifest does not match the preservation receipt"
            )
        print(
            "COMMAND MANIFEST ALREADY RECONSTRUCTED "
            + json.dumps(
                {
                    "status": "PASS",
                    "revision": current_revision,
                    "record_count": EXPECTED_COUNT,
                },
                sort_keys=True,
            ),
            flush=True,
        )
        return
    if current_records:
        raise RuntimeError(
            f"refusing non-empty partial manifest with {len(current_records)} records"
        )

    repaired = dict(manifest)
    repaired["generated_at"] = utc_now()
    repaired["organization"] = ORG
    repaired["profile"] = PROFILE
    repaired["protected_org_spaces"] = sorted(EXPECTED_ACTIVE_ORG)
    repaired["consolidated_spaces"] = records
    repaired["manifest_reconstruction"] = {
        "schema": "szl.command-centre.manifest-reconstruction/v1",
        "status": "PASS",
        "reconstructed_at": utc_now(),
        "source_receipt": RECEIPT_FILENAME,
        "source_receipt_revision": current_revision,
        "source_receipt_sha256": sha256_path(receipt_path),
        "record_count_before": 0,
        "record_count_after": EXPECTED_COUNT,
        "archived_source_files_changed": False,
        "workflow_run_id": os.environ.get("GITHUB_RUN_ID", ""),
        "workflow_source_revision": os.environ.get("GITHUB_SHA", ""),
    }
    payload = (json.dumps(repaired, indent=2, sort_keys=True) + "\n").encode("utf-8")
    commit = api.create_commit(
        repo_id=COMMAND_REPO,
        repo_type="space",
        operations=[
            CommitOperationAdd(
                path_in_repo=MANIFEST_FILENAME,
                path_or_fileobj=payload,
            )
        ],
        commit_message="Reconstruct active 50-source manifest from immutable receipt",
    )
    revision = str(commit.oid)
    if not valid_sha(revision):
        raise RuntimeError("manifest reconstruction returned an invalid revision")
    remote, _ = load_json(MANIFEST_FILENAME, revision)
    remote_payload = Path(
        hf_hub_download(
            repo_id=COMMAND_REPO,
            repo_type="space",
            filename=MANIFEST_FILENAME,
            revision=revision,
            token=TOKEN,
            force_download=True,
        )
    )
    if sha256_path(remote_payload) != sha256_bytes(payload):
        raise RuntimeError("reconstructed manifest failed SHA-256 read-back")
    remote_records = remote.get("consolidated_spaces")
    if not isinstance(remote_records, list) or len(remote_records) != EXPECTED_COUNT:
        raise RuntimeError("reconstructed manifest failed record-count read-back")
    wait_running(revision)
    print(
        "COMMAND MANIFEST RECONSTRUCTION PASS "
        + json.dumps(
            {
                "status": "PASS",
                "revision": revision,
                "record_count": EXPECTED_COUNT,
                "source_receipt_revision": current_revision,
                "archived_source_files_changed": False,
            },
            sort_keys=True,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
