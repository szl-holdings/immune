#!/usr/bin/env python3
"""Rebuild the active Command Centre manifest from its two-part receipt chain."""
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
TRUST_REVISION = "74b9c82538b4516deeacd2b440ad821a687f6ab5"
BASE_FILENAME = "HF_SPACE_CONSOLIDATION_PREDELETE_RECEIPT.json"
SUPPLEMENTAL_FILENAME = "HF_SPACE_CONSOLIDATION_SUPPLEMENTAL_RECEIPT.json"
MANIFEST_FILENAME = "manifest.json"
BASE_COUNT = 49
TOTAL_COUNT = 50
SUPPLEMENTAL_SOURCE = "SZLHOLDINGS/quant-curve"
REQUIRED_SOURCES = {
    "SZLHOLDINGS/david-leads",
    "SZLHOLDINGS/quant-curve",
    "SZLHOLDINGS/szl-command-lab",
}
ACTIVE_ORG = {
    "README", "a11oy", "aegis-assurance", "counsel", "david-leads",
    "finance", "killinchu", "lyte", "sentra", "terra",
    "vertical-services", "vessels",
}

TOKEN = os.environ["HF_TOKEN"]
api = HfApi(token=TOKEN)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def is_sha(value: object) -> bool:
    return isinstance(value, str) and len(value) == 40 and all(
        character in "0123456789abcdef" for character in value.lower()
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(filename: str, revision: str) -> tuple[dict[str, Any], Path]:
    path = Path(hf_hub_download(
        repo_id=COMMAND_REPO,
        repo_type="space",
        filename=filename,
        revision=revision,
        token=TOKEN,
        force_download=True,
    ))
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"{filename} is not a JSON object")
    return payload, path


def validate_base(receipt: dict[str, Any]) -> list[dict[str, Any]]:
    required = {
        "schema": "szl.hf-space-consolidation.predelete.v3",
        "status": "PRESERVED_AND_READY_FOR_EXACT_DELETE",
        "mode": "PRESERVE_AND_VERIFY_ONLY",
        "organization": ORG,
        "profile": PROFILE,
    }
    for key, expected in required.items():
        if receipt.get(key) != expected:
            raise RuntimeError(f"base receipt {key} mismatch")
    victims = receipt.get("victims")
    revisions = receipt.get("expected_source_revisions")
    records = receipt.get("consolidated")
    if not isinstance(victims, list) or len(victims) != BASE_COUNT:
        raise RuntimeError("base receipt must contain exactly 49 victims")
    if len(set(victims)) != BASE_COUNT:
        raise RuntimeError("base receipt contains duplicate victims")
    if not isinstance(revisions, dict) or set(revisions) != set(victims):
        raise RuntimeError("base receipt revision map does not match victims")
    if not isinstance(records, list) or len(records) != BASE_COUNT:
        raise RuntimeError("base receipt must contain exactly 49 records")
    if {item.get("source") for item in records if isinstance(item, dict)} != set(victims):
        raise RuntimeError("base record sources do not match victims")
    return [item for item in records if isinstance(item, dict)]


def validate_supplemental(receipt: dict[str, Any]) -> dict[str, Any]:
    required = {
        "schema": "szl.hf-space-consolidation.supplemental.v1",
        "status": "PRESERVED_AND_READY_FOR_EXACT_DELETE",
        "organization": ORG,
        "profile": PROFILE,
        "trust_revision": TRUST_REVISION,
        "effective_victim_count": TOTAL_COUNT,
    }
    for key, expected in required.items():
        if receipt.get(key) != expected:
            raise RuntimeError(f"supplemental receipt {key} mismatch")
    added = receipt.get("added_sources")
    if not isinstance(added, list) or len(added) != 1 or not isinstance(added[0], dict):
        raise RuntimeError("supplemental receipt must contain exactly one source record")
    record = added[0]
    if record.get("source") != SUPPLEMENTAL_SOURCE:
        raise RuntimeError("supplemental source is not quant-curve")
    return record


def validate_record(record: dict[str, Any], repo_files: set[str]) -> None:
    source = str(record.get("source") or "")
    revision = str(record.get("source_sha") or "")
    prefix = str(record.get("archive_prefix") or "").rstrip("/")
    files = record.get("files")
    if not source.startswith(ORG + "/") or not is_sha(revision):
        raise RuntimeError(f"invalid record identity: {source!r}")
    if not prefix.startswith("archive/"):
        raise RuntimeError(f"invalid archive prefix for {source}: {prefix!r}")
    if not isinstance(files, list) or not files:
        raise RuntimeError(f"empty file manifest for {source}")
    if int(record.get("file_count") or 0) != len(files):
        raise RuntimeError(f"file-count mismatch for {source}")
    missing = [
        f"{prefix}/{item.get('path')}"
        for item in files
        if isinstance(item, dict)
        and f"{prefix}/{item.get('path')}" not in repo_files
    ]
    if missing:
        raise RuntimeError(f"archive files missing for {source}: {missing[:5]}")


def stage_name(runtime: object) -> str:
    value = getattr(runtime, "stage", None)
    return str(getattr(value, "value", value) or "UNKNOWN").upper()


def wait_running(revision: str, seconds: int = 900) -> None:
    deadline = time.monotonic() + seconds
    restarted = False
    last = None
    while time.monotonic() < deadline:
        info = api.repo_info(repo_id=COMMAND_REPO, repo_type="space")
        current = str(info.sha or "")
        stage = stage_name(api.get_space_runtime(repo_id=COMMAND_REPO))
        private = bool(info.private)
        last = (current, stage, private)
        print(f"COMMAND CENTRE sha={current[:12]} stage={stage} private={private}", flush=True)
        if private:
            raise RuntimeError("Command Centre became private")
        if current == revision and stage == "RUNNING":
            return
        if current == revision and stage in {
            "PAUSED", "SLEEPING", "STOPPED", "RUNTIME_ERROR",
            "BUILD_ERROR", "CONFIG_ERROR",
        } and not restarted:
            api.restart_space(
                repo_id=COMMAND_REPO,
                factory_reboot=stage in {"RUNTIME_ERROR", "BUILD_ERROR", "CONFIG_ERROR"},
            )
            restarted = True
        time.sleep(10)
    raise TimeoutError(f"Command Centre did not become RUNNING: {last}")


def main() -> None:
    identity = api.whoami(token=TOKEN)
    identity_name = str(identity.get("name") or identity.get("fullname") or "")
    if identity_name.lower() != PROFILE:
        raise RuntimeError(f"wrong Hugging Face identity: {identity_name!r}")

    command = api.repo_info(repo_id=COMMAND_REPO, repo_type="space")
    current_revision = str(command.sha or "")
    if bool(command.private) or not is_sha(current_revision):
        raise RuntimeError("Command Centre is not public at an exact revision")

    base, base_path = load_json(BASE_FILENAME, TRUST_REVISION)
    supplemental, supplemental_path = load_json(SUPPLEMENTAL_FILENAME, current_revision)
    base_records = validate_base(base)
    supplemental_record = validate_supplemental(supplemental)

    by_source = {str(item["source"]): item for item in base_records}
    if SUPPLEMENTAL_SOURCE in by_source:
        raise RuntimeError("quant-curve unexpectedly exists in the 49-record trust anchor")
    by_source[SUPPLEMENTAL_SOURCE] = supplemental_record
    if len(by_source) != TOTAL_COUNT or not REQUIRED_SOURCES <= set(by_source):
        raise RuntimeError("combined receipt chain does not yield the required 50 records")

    repo_files = set(api.list_repo_files(
        repo_id=COMMAND_REPO,
        repo_type="space",
        revision=current_revision,
    ))
    prefixes: set[str] = set()
    for record in by_source.values():
        validate_record(record, repo_files)
        prefix = str(record["archive_prefix"]).rstrip("/")
        if prefix in prefixes:
            raise RuntimeError(f"duplicate archive prefix: {prefix}")
        prefixes.add(prefix)

    manifest, _ = load_json(MANIFEST_FILENAME, current_revision)
    existing = manifest.get("consolidated_spaces")
    if not isinstance(existing, list):
        raise RuntimeError("active manifest consolidated_spaces is not a list")
    expected_sources = set(by_source)
    existing_sources = {
        str(item.get("source") or "") for item in existing if isinstance(item, dict)
    }
    if len(existing) == TOTAL_COUNT and existing_sources == expected_sources:
        print(json.dumps({
            "status": "PASS",
            "state": "ALREADY_RECONSTRUCTED",
            "record_count": TOTAL_COUNT,
            "revision": current_revision,
        }, sort_keys=True), flush=True)
        return
    if existing:
        raise RuntimeError(f"refusing partial active manifest with {len(existing)} records")

    reconstructed_at = utc_now()
    updated = dict(manifest)
    updated.update({
        "schema": manifest.get("schema") or "szl.command-centre.inventory.v2",
        "generated_at": reconstructed_at,
        "organization": ORG,
        "profile": PROFILE,
        "protected_org_spaces": sorted(ACTIVE_ORG),
        "consolidated_spaces": [by_source[key] for key in sorted(by_source)],
        "manifest_reconstruction": {
            "schema": "szl.command-centre.manifest-reconstruction/v2",
            "status": "PASS",
            "reconstructed_at": reconstructed_at,
            "base_receipt": {
                "filename": BASE_FILENAME,
                "revision": TRUST_REVISION,
                "sha256": sha256(base_path),
                "record_count": BASE_COUNT,
            },
            "supplemental_receipt": {
                "filename": SUPPLEMENTAL_FILENAME,
                "revision": current_revision,
                "sha256": sha256(supplemental_path),
                "added_source": SUPPLEMENTAL_SOURCE,
            },
            "record_count_before": 0,
            "record_count_after": TOTAL_COUNT,
            "archived_source_files_changed": False,
            "workflow_run_id": os.environ.get("GITHUB_RUN_ID", ""),
            "workflow_source_revision": os.environ.get("GITHUB_SHA", ""),
        },
    })
    payload = (json.dumps(updated, indent=2, sort_keys=True) + "\n").encode("utf-8")
    commit = api.create_commit(
        repo_id=COMMAND_REPO,
        repo_type="space",
        operations=[CommitOperationAdd(
            path_in_repo=MANIFEST_FILENAME,
            path_or_fileobj=payload,
        )],
        commit_message="Reconstruct active 50-source manifest from two-part receipt chain",
    )
    revision = str(commit.oid)
    if not is_sha(revision):
        raise RuntimeError("invalid reconstruction commit revision")
    remote = Path(hf_hub_download(
        repo_id=COMMAND_REPO,
        repo_type="space",
        filename=MANIFEST_FILENAME,
        revision=revision,
        token=TOKEN,
        force_download=True,
    ))
    if sha256(remote) != hashlib.sha256(payload).hexdigest():
        raise RuntimeError("reconstructed manifest failed SHA-256 read-back")
    check = json.loads(remote.read_text(encoding="utf-8"))
    if len(check.get("consolidated_spaces") or []) != TOTAL_COUNT:
        raise RuntimeError("reconstructed manifest failed record-count read-back")
    wait_running(revision)
    print("COMMAND MANIFEST RECONSTRUCTION PASS " + json.dumps({
        "status": "PASS",
        "record_count": TOTAL_COUNT,
        "base_count": BASE_COUNT,
        "supplemental_source": SUPPLEMENTAL_SOURCE,
        "revision": revision,
        "archived_source_files_changed": False,
    }, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
