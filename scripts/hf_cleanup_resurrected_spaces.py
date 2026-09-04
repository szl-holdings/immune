#!/usr/bin/env python3
"""Preserve and delete the two retired Spaces recreated after consolidation.

The active portfolio has 50 canonical retired records before David Leads is
removed. ``szl-command-lab`` already owns one of those records, so its current
Hub bytes replace that record's older snapshot. ``szl-constellation`` is a
retired alias/showcase, not a new canonical portfolio product; its exact bytes
are merged beneath the command-lab record. This keeps the active count stable:
50 before the David restoration rebalance, 49 after it.

Deletion happens only after remote SHA-256 read-back of every added byte and an
exact source-revision recheck. The script is idempotent once both duplicates are
absent.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from huggingface_hub import (
    CommitOperationAdd,
    CommitOperationDelete,
    HfApi,
    hf_hub_download,
    snapshot_download,
)

ORG = "SZLHOLDINGS"
PROFILE = "betterwithage"
COMMAND_REPO = f"{PROFILE}/szl-command-centre"
MANIFEST = "manifest.json"
RECEIPT = "HF_SPACE_RESURRECTION_CLEANUP_RECEIPT.json"
CANONICAL_SOURCE = f"{ORG}/szl-command-lab"
ALIAS_SOURCE = f"{ORG}/szl-constellation"
CANONICAL_PREFIX = "archive/szl-command-lab"
ALIAS_PREFIX = f"{CANONICAL_PREFIX}/_merged-retired/szl-constellation"
EXPECTED_RECORD_COUNT = 50
EXPECTED_ORG = {
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
ALLOWED_RESURRECTED = {"szl-command-lab", "szl-constellation"}

TOKEN = os.environ["HF_TOKEN"]
api = HfApi(token=TOKEN)


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def valid_sha(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 40
        and all(character in "0123456789abcdef" for character in value.lower())
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_lfs_pointer(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size > 4096:
        return False
    try:
        return path.read_bytes().startswith(
            b"version https://git-lfs.github.com/spec/v1"
        )
    except OSError:
        return False


def clean_snapshot(source: Path, destination: Path) -> dict[str, Any]:
    destination.mkdir(parents=True, exist_ok=True)
    files: list[dict[str, Any]] = []
    unresolved_lfs: list[dict[str, Any]] = []
    for item in sorted(source.rglob("*")):
        if not item.is_file():
            continue
        relative = item.relative_to(source)
        if any(part in {".git", ".cache", "__pycache__"} for part in relative.parts):
            continue
        target_relative = relative
        pointer_record: dict[str, Any] | None = None
        if relative.name == ".gitattributes":
            target_relative = relative.with_name("__gitattributes__.txt")
        elif is_lfs_pointer(item):
            target_relative = Path(str(relative) + ".lfs-pointer.json")
            pointer_record = {
                "record_type": "unresolved_git_lfs_pointer",
                "original_path": relative.as_posix(),
                "preserved_as": target_relative.as_posix(),
                "pointer": item.read_text("utf-8", errors="replace").strip(),
            }
            unresolved_lfs.append(pointer_record)
        target = destination / target_relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if pointer_record is None:
            shutil.copyfile(item, target)
        else:
            target.write_text(
                json.dumps(pointer_record, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        files.append(
            {
                "path": target_relative.as_posix(),
                "sha256": sha256(target),
                "bytes": target.stat().st_size,
            }
        )
    if not files:
        raise RuntimeError(f"refusing to preserve an empty snapshot: {source}")
    return {
        "files": files,
        "file_count": len(files),
        "bytes": sum(item["bytes"] for item in files),
        "unresolved_lfs": unresolved_lfs,
    }


def org_spaces() -> dict[str, object]:
    return {
        item.id.split("/", 1)[1]: item
        for item in api.list_spaces(author=ORG, full=True)
    }


def load_json(repo_id: str, filename: str, revision: str) -> dict[str, Any]:
    path = Path(
        hf_hub_download(
            repo_id=repo_id,
            repo_type="space",
            filename=filename,
            revision=revision,
            token=TOKEN,
            force_download=True,
        )
    )
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"{repo_id}/{filename} is not a JSON object")
    return payload


def snapshot_source(repo_id: str, root: Path) -> dict[str, Any]:
    info = api.repo_info(repo_id=repo_id, repo_type="space")
    revision = str(info.sha or "")
    if not valid_sha(revision):
        raise RuntimeError(f"source lacks an exact revision: {repo_id}")
    raw = root / "raw"
    clean = root / "clean"
    snapshot_download(
        repo_id=repo_id,
        repo_type="space",
        revision=revision,
        token=TOKEN,
        local_dir=raw,
        force_download=True,
    )
    result = clean_snapshot(raw, clean)
    result.update(
        {
            "source": repo_id,
            "source_sha": revision,
            "captured_at": now(),
            "private": bool(info.private),
            "sdk": getattr(info, "sdk", None),
            "clean_root": clean,
        }
    )
    return result


def operation_add_tree(
    root: Path,
    prefix: str,
) -> tuple[list[CommitOperationAdd], dict[str, str]]:
    operations: list[CommitOperationAdd] = []
    expected: dict[str, str] = {}
    for item in sorted(root.rglob("*")):
        if not item.is_file():
            continue
        relative = item.relative_to(root).as_posix()
        target = f"{prefix}/{relative}"
        operations.append(
            CommitOperationAdd(path_in_repo=target, path_or_fileobj=str(item))
        )
        expected[target] = sha256(item)
    return operations, expected


def verify_remote(
    revision: str,
    expected: dict[str, str],
) -> None:
    verify_root = Path(tempfile.mkdtemp(prefix="szl-hf-stray-verify-"))
    try:
        local = Path(
            snapshot_download(
                repo_id=COMMAND_REPO,
                repo_type="space",
                revision=revision,
                token=TOKEN,
                local_dir=verify_root,
                allow_patterns=sorted(expected),
                force_download=True,
            )
        )
        failures: list[str] = []
        for remote_path, expected_hash in expected.items():
            path = local / remote_path
            if not path.is_file():
                failures.append(f"missing:{remote_path}")
            elif sha256(path) != expected_hash:
                failures.append(f"hash:{remote_path}")
        if failures:
            raise RuntimeError(
                "Command Centre read-back failed: " + ", ".join(failures[:20])
            )
    finally:
        shutil.rmtree(verify_root, ignore_errors=True)


def wait_exact_org(checks: int = 6) -> None:
    for index in range(checks):
        observed = set(org_spaces())
        if observed != EXPECTED_ORG:
            raise RuntimeError(
                f"post-delete org drift on check {index + 1}: "
                f"{sorted(observed)} != {sorted(EXPECTED_ORG)}"
            )
        print(f"STABILIZATION {index + 1}/{checks} org=12", flush=True)
        if index + 1 < checks:
            time.sleep(5)


def main() -> None:
    identity = api.whoami(token=TOKEN)
    identity_name = str(identity.get("name") or identity.get("fullname") or "")
    if identity_name.lower() != PROFILE:
        raise RuntimeError(
            f"wrong Hugging Face identity: expected {PROFILE}, got {identity_name!r}"
        )

    before = org_spaces()
    names = set(before)
    missing = EXPECTED_ORG - names
    unexpected = names - EXPECTED_ORG
    if missing:
        raise RuntimeError(f"required active org Spaces are missing: {sorted(missing)}")
    if not unexpected:
        wait_exact_org()
        print("RESURRECTED SPACE CLEANUP ALREADY PASS", flush=True)
        return
    if not unexpected <= ALLOWED_RESURRECTED:
        raise RuntimeError(
            f"unapproved org Spaces exist: {sorted(unexpected - ALLOWED_RESURRECTED)}"
        )

    workspace = Path(tempfile.mkdtemp(prefix="szl-hf-stray-cleanup-"))
    try:
        snapshots: dict[str, dict[str, Any]] = {}
        for name in sorted(unexpected):
            snapshots[name] = snapshot_source(
                f"{ORG}/{name}", workspace / name
            )
            item = snapshots[name]
            print(
                f"CAPTURED {item['source']} sha={item['source_sha'][:12]} "
                f"files={item['file_count']} bytes={item['bytes']}",
                flush=True,
            )

        command_info = api.repo_info(repo_id=COMMAND_REPO, repo_type="space")
        command_before = str(command_info.sha or "")
        if bool(command_info.private) or not valid_sha(command_before):
            raise RuntimeError("Command Centre is not a public exact-revision Space")
        manifest = load_json(COMMAND_REPO, MANIFEST, command_before)
        records_raw = manifest.get("consolidated_spaces")
        if not isinstance(records_raw, list) or len(records_raw) != EXPECTED_RECORD_COUNT:
            raise RuntimeError(
                f"expected {EXPECTED_RECORD_COUNT} pre-rebalance records"
            )
        records = [item for item in records_raw if isinstance(item, dict)]
        if len(records) != len(records_raw):
            raise RuntimeError("manifest contains a non-object record")
        indexes = [
            index
            for index, item in enumerate(records)
            if item.get("source") == CANONICAL_SOURCE
        ]
        if len(indexes) != 1:
            raise RuntimeError(
                f"expected one {CANONICAL_SOURCE} record, found {len(indexes)}"
            )
        index = indexes[0]
        prior = dict(records[index])
        canonical = snapshots.get("szl-command-lab")
        alias = snapshots.get("szl-constellation")

        # If only the alias reappeared, retain the already-preserved canonical tree.
        operations: list[CommitOperationAdd | CommitOperationDelete] = []
        expected: dict[str, str] = {}
        current_files = set(
            api.list_repo_files(
                repo_id=COMMAND_REPO,
                repo_type="space",
                revision=command_before,
            )
        )
        if canonical is not None:
            old_files = sorted(
                path
                for path in current_files
                if path.startswith(CANONICAL_PREFIX + "/")
            )
            operations.extend(
                CommitOperationDelete(path_in_repo=path) for path in old_files
            )
            additions, hashes = operation_add_tree(
                canonical["clean_root"], CANONICAL_PREFIX
            )
            operations.extend(additions)
            expected.update(hashes)
            updated = dict(prior)
            updated.update(
                {
                    "source_sha": canonical["source_sha"],
                    "captured_at": canonical["captured_at"],
                    "file_count": canonical["file_count"],
                    "bytes": canonical["bytes"],
                    "files": canonical["files"],
                    "unresolved_lfs": canonical["unresolved_lfs"],
                    "classification": "CONSOLIDATED_UTILITY",
                    "archive_prefix": CANONICAL_PREFIX,
                    "previous_preserved_source_sha": prior.get("source_sha"),
                }
            )
        else:
            updated = dict(prior)

        merged_sources = [
            item
            for item in updated.get("merged_retired_sources", [])
            if isinstance(item, dict) and item.get("source") != ALIAS_SOURCE
        ]
        if alias is not None:
            additions, hashes = operation_add_tree(alias["clean_root"], ALIAS_PREFIX)
            operations.extend(additions)
            expected.update(hashes)
            merged_sources.append(
                {
                    "source": ALIAS_SOURCE,
                    "source_sha": alias["source_sha"],
                    "captured_at": alias["captured_at"],
                    "archive_prefix": ALIAS_PREFIX,
                    "file_count": alias["file_count"],
                    "bytes": alias["bytes"],
                    "unresolved_lfs": alias["unresolved_lfs"],
                    "classification": "MERGED_RETIRED_ALIAS",
                    "canonical_record": CANONICAL_SOURCE,
                    "reason": "Deprecated constellation showcase merged into the existing command-lab/Atlas archive family.",
                }
            )
        updated["merged_retired_sources"] = merged_sources
        updated["file_count"] = int(updated.get("file_count") or 0) + sum(
            int(item.get("file_count") or 0) for item in merged_sources
        )
        updated["bytes"] = int(updated.get("bytes") or 0) + sum(
            int(item.get("bytes") or 0) for item in merged_sources
        )
        records[index] = updated
        manifest["generated_at"] = now()
        manifest["consolidated_spaces"] = records
        manifest["resurrection_cleanup"] = {
            "schema": "szl.hf-resurrection-cleanup/v1",
            "canonical_record_count": len(records),
            "canonical_source_refreshed": canonical is not None,
            "merged_aliases": [item["source"] for item in merged_sources],
            "pending_deletion": [f"{ORG}/{name}" for name in sorted(unexpected)],
        }

        manifest_bytes = (
            json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        pre_receipt = {
            "schema": "szl.hf-resurrection-cleanup/v1",
            "status": "PRESERVED_READY_FOR_DELETE",
            "captured_at": now(),
            "identity": identity_name,
            "command_centre_revision_before": command_before,
            "expected_org_after": sorted(EXPECTED_ORG),
            "canonical_record_count_before_david_rebalance": len(records),
            "sources": {
                item["source"]: {
                    "source_sha": item["source_sha"],
                    "file_count": item["file_count"],
                    "bytes": item["bytes"],
                }
                for item in snapshots.values()
            },
            "canonical_archive_prefix": CANONICAL_PREFIX,
            "merged_alias_archive_prefix": ALIAS_PREFIX if alias else None,
            "workflow_run_id": os.environ.get("GITHUB_RUN_ID", ""),
            "workflow_source_revision": os.environ.get("GITHUB_SHA", ""),
        }
        receipt_bytes = (
            json.dumps(pre_receipt, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        operations.extend(
            [
                CommitOperationAdd(
                    path_in_repo=MANIFEST,
                    path_or_fileobj=manifest_bytes,
                ),
                CommitOperationAdd(
                    path_in_repo=RECEIPT,
                    path_or_fileobj=receipt_bytes,
                ),
            ]
        )
        expected[MANIFEST] = hashlib.sha256(manifest_bytes).hexdigest()
        expected[RECEIPT] = hashlib.sha256(receipt_bytes).hexdigest()
        commit = api.create_commit(
            repo_id=COMMAND_REPO,
            repo_type="space",
            operations=operations,
            commit_message="Preserve resurrected retired Spaces before exact deletion",
        )
        preserved_revision = str(commit.oid)
        if not valid_sha(preserved_revision):
            raise RuntimeError("Command Centre returned an invalid preservation revision")
        verify_remote(preserved_revision, expected)
        print(
            f"PRESERVATION VERIFIED revision={preserved_revision} "
            f"files={len(expected)}",
            flush=True,
        )

        # Freeze exact source revisions immediately before the delete boundary.
        current = org_spaces()
        if set(current) != names:
            raise RuntimeError("organization inventory changed during preservation")
        for name, snapshot in snapshots.items():
            actual = str(getattr(current[name], "sha", "") or "")
            if actual != snapshot["source_sha"]:
                raise RuntimeError(
                    f"{ORG}/{name} changed after preservation: "
                    f"{snapshot['source_sha']} -> {actual}"
                )

        deleted: list[str] = []
        for name in sorted(unexpected):
            repo_id = f"{ORG}/{name}"
            api.delete_repo(repo_id=repo_id, repo_type="space", missing_ok=False)
            deleted.append(repo_id)
            print(f"DELETED {repo_id}", flush=True)
        wait_exact_org()

        final_receipt = dict(pre_receipt)
        final_receipt.update(
            {
                "status": "PASS",
                "completed_at": now(),
                "preservation_revision": preserved_revision,
                "deleted": deleted,
                "org_names_after": sorted(org_spaces()),
                "stabilization_checks": 6,
                "canonical_record_count_before_david_rebalance": EXPECTED_RECORD_COUNT,
                "next_state": "RUN_DAVID_REBALANCE_TO_49",
            }
        )
        final_bytes = (
            json.dumps(final_receipt, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        final = api.create_commit(
            repo_id=COMMAND_REPO,
            repo_type="space",
            operations=[
                CommitOperationAdd(
                    path_in_repo=RECEIPT,
                    path_or_fileobj=final_bytes,
                )
            ],
            commit_message="Publish verified resurrected-Space deletion receipt",
        )
        final_revision = str(final.oid)
        if not valid_sha(final_revision):
            raise RuntimeError("invalid final cleanup receipt revision")
        verify_remote(
            final_revision,
            {RECEIPT: hashlib.sha256(final_bytes).hexdigest()},
        )
        print(
            "RESURRECTED SPACE CLEANUP PASS "
            + json.dumps(
                {
                    "status": "PASS",
                    "deleted": deleted,
                    "org_count": len(EXPECTED_ORG),
                    "canonical_record_count": EXPECTED_RECORD_COUNT,
                    "final_revision": final_revision,
                },
                sort_keys=True,
            ),
            flush=True,
        )
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    main()
