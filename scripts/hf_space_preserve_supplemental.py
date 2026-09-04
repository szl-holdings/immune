#!/usr/bin/env python3
"""Preserve any post-snapshot non-flagship Spaces before final deletion.

The original 49-Space preservation receipt is an immutable trust anchor. If a
new non-protected Space appears after that snapshot, this script snapshots it at
an exact revision, sanitizes unresolved Git LFS pointers, appends its source tree
to the public Command Centre, publishes a new receipt that contains the original
receipt as an unchanged subset, verifies every uploaded byte, and exports the
new receipt revision/count for the exact deletion finalizer.

No organization or creator-profile Space is deleted by this script.
"""
from __future__ import annotations

import copy
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
    HfApi,
    hf_hub_download,
    snapshot_download,
)

ORG = "SZLHOLDINGS"
PROFILE = "betterwithage"
COMMAND_REPO = f"{PROFILE}/szl-command-centre"
TRUST_REVISION = "74b9c82538b4516deeacd2b440ad821a687f6ab5"
PREDELETE_FILENAME = "HF_SPACE_CONSOLIDATION_PREDELETE_RECEIPT.json"
SUPPLEMENTAL_FILENAME = "HF_SPACE_CONSOLIDATION_SUPPLEMENTAL_RECEIPT.json"
MANIFEST_FILENAME = "manifest.json"
MAX_NEW_SPACES_PER_RUN = 20

PROTECTED = {
    "README",
    "a11oy",
    "aegis-assurance",
    "counsel",
    "finance",
    "killinchu",
    "lyte",
    "sentra",
    "terra",
    "vertical-services",
    "vessels",
}

TOKEN = os.environ["HF_TOKEN"]
api = HfApi(token=TOKEN)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_full_revision(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 40
        and all(character in "0123456789abcdef" for character in value.lower())
    )


def stage_name(runtime: object) -> str:
    value = getattr(runtime, "stage", None)
    return str(getattr(value, "value", value) or "UNKNOWN").upper()


def wait_running(repo_id: str, expected_revision: str, seconds: int = 900) -> None:
    deadline = time.monotonic() + seconds
    restarted = False
    last: tuple[str, str, bool] | None = None
    while time.monotonic() < deadline:
        info = api.repo_info(repo_id=repo_id, repo_type="space")
        revision = str(getattr(info, "sha", "") or "")
        private = bool(getattr(info, "private", False))
        stage = stage_name(api.get_space_runtime(repo_id=repo_id))
        last = (revision, stage, private)
        print(
            f"COMMAND CENTRE sha={revision[:12]} stage={stage} private={private}",
            flush=True,
        )
        if private:
            raise RuntimeError(f"{repo_id} became private")
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
                repo_id=repo_id,
                factory_reboot=stage
                in {"RUNTIME_ERROR", "BUILD_ERROR", "CONFIG_ERROR"},
            )
            restarted = True
        time.sleep(10)
    raise TimeoutError(f"{repo_id} did not become RUNNING: {last}")


def load_json(repo_id: str, filename: str, revision: str) -> tuple[dict, Path]:
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
    return payload, path


def current_org_spaces() -> dict[str, object]:
    return {
        item.id.split("/", 1)[1]: item
        for item in api.list_spaces(author=ORG, full=True)
    }


def is_lfs_pointer(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size > 4096:
        return False
    try:
        content = path.read_bytes()
    except OSError:
        return False
    return content.startswith(b"version https://git-lfs.github.com/spec/v1")


def sanitize_tree(source: Path, destination: Path) -> dict[str, Any]:
    destination.mkdir(parents=True, exist_ok=True)
    files: list[dict[str, Any]] = []
    unresolved_lfs: list[dict[str, str]] = []

    for src in sorted(source.rglob("*")):
        if src.is_dir():
            continue
        rel = src.relative_to(source)
        if (
            ".git" in rel.parts
            or ".cache" in rel.parts
            or "__pycache__" in rel.parts
        ):
            continue

        target_rel = rel
        pointer_record: dict[str, str] | None = None
        if rel.name == ".gitattributes":
            target_rel = rel.with_name("__gitattributes__.txt")
        elif is_lfs_pointer(src):
            target_rel = Path(str(rel) + ".lfs-pointer.json")
            pointer_record = {
                "record_type": "unresolved_git_lfs_pointer",
                "original_path": rel.as_posix(),
                "preserved_as": target_rel.as_posix(),
                "pointer": src.read_text("utf-8", errors="replace").strip(),
            }
            unresolved_lfs.append(pointer_record)

        dst = destination / target_rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if pointer_record is None:
            shutil.copyfile(src, dst)
        else:
            dst.write_text(
                json.dumps(pointer_record, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        files.append(
            {
                "path": target_rel.as_posix(),
                "sha256": sha256_path(dst),
                "bytes": dst.stat().st_size,
            }
        )

    if not files:
        raise RuntimeError(f"refusing to preserve an empty source tree: {source}")
    return {
        "files": files,
        "unresolved_lfs": unresolved_lfs,
        "file_count": len(files),
        "bytes": sum(int(item["bytes"]) for item in files),
    }


def validate_receipt_shape(receipt: dict, *, label: str) -> None:
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
                f"{label} receipt {key} mismatch: "
                f"{receipt.get(key)!r} != {expected!r}"
            )

    victims = receipt.get("victims")
    revisions = receipt.get("expected_source_revisions")
    consolidated = receipt.get("consolidated")
    remaining = receipt.get("remaining_org_spaces")
    if not isinstance(victims, list) or len(set(victims)) != len(victims):
        raise RuntimeError(f"{label} receipt has an invalid victim list")
    if not isinstance(revisions, dict) or set(revisions) != set(victims):
        raise RuntimeError(f"{label} receipt revision map does not match victims")
    if not isinstance(consolidated, list) or len(consolidated) != len(victims):
        raise RuntimeError(f"{label} receipt consolidated list does not match victims")
    if not isinstance(remaining, list) or len(set(remaining)) != len(remaining):
        raise RuntimeError(f"{label} receipt has an invalid org inventory")

    victim_names = {str(item).split("/", 1)[1] for item in victims}
    if any(not str(item).startswith(ORG + "/") for item in victims):
        raise RuntimeError(f"{label} receipt contains a victim outside {ORG}")
    if victim_names & PROTECTED:
        raise RuntimeError(f"{label} receipt overlaps the protected set")
    if set(remaining) != PROTECTED | victim_names:
        raise RuntimeError(f"{label} receipt inventory is not protected plus victims")
    sources = {
        item.get("source")
        for item in consolidated
        if isinstance(item, dict) and isinstance(item.get("source"), str)
    }
    if sources != set(victims):
        raise RuntimeError(f"{label} receipt consolidated sources do not match victims")
    for repo_id, revision in revisions.items():
        if not is_full_revision(revision):
            raise RuntimeError(f"{label} receipt has an invalid revision for {repo_id}")


def validate_current_is_anchored(trusted: dict, current: dict) -> None:
    validate_receipt_shape(trusted, label="immutable")
    validate_receipt_shape(current, label="current")

    trusted_victims = set(trusted["victims"])
    current_victims = set(current["victims"])
    if not trusted_victims <= current_victims:
        raise RuntimeError("current receipt dropped an immutable victim")

    trusted_revisions = trusted["expected_source_revisions"]
    current_revisions = current["expected_source_revisions"]
    for repo_id in trusted_victims:
        if current_revisions.get(repo_id) != trusted_revisions.get(repo_id):
            raise RuntimeError(f"current receipt changed frozen revision for {repo_id}")

    trusted_records = {
        item["source"]: item
        for item in trusted["consolidated"]
        if isinstance(item, dict) and isinstance(item.get("source"), str)
    }
    current_records = {
        item["source"]: item
        for item in current["consolidated"]
        if isinstance(item, dict) and isinstance(item.get("source"), str)
    }
    immutable_fields = (
        "source_sha",
        "archive_prefix",
        "file_count",
        "bytes",
        "classification",
    )
    for repo_id, trusted_record in trusted_records.items():
        current_record = current_records.get(repo_id)
        if current_record is None:
            raise RuntimeError(f"current receipt dropped archive record for {repo_id}")
        for field in immutable_fields:
            if current_record.get(field) != trusted_record.get(field):
                raise RuntimeError(
                    f"current receipt changed {field} for immutable source {repo_id}"
                )


def prepare_source_record(
    *,
    name: str,
    info: object,
    workspace: Path,
) -> tuple[dict[str, Any], Path]:
    repo_id = f"{ORG}/{name}"
    source_revision = str(getattr(info, "sha", "") or "")
    if not is_full_revision(source_revision):
        raise RuntimeError(f"{repo_id} lacks an exact source revision")

    raw = workspace / name / "raw"
    clean = workspace / name / "clean"
    raw.parent.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=repo_id,
        repo_type="space",
        token=TOKEN,
        revision=source_revision,
        local_dir=raw,
        force_download=True,
    )
    manifest = sanitize_tree(raw, clean)
    archive_prefix = f"archive/{name}"
    record: dict[str, Any] = {
        **manifest,
        "source": repo_id,
        "source_sha": source_revision,
        "captured_at": utc_now(),
        "visibility": (
            "private" if bool(getattr(info, "private", False)) else "public"
        ),
        "sdk": getattr(info, "sdk", None),
        "destination": f"{COMMAND_REPO}/tree/main/{archive_prefix}",
        "archive_prefix": archive_prefix,
        "classification": "CONSOLIDATED_UTILITY",
        "preservation_reason": "POST_SNAPSHOT_NON_FLAGSHIP",
    }
    return record, clean


def build_updated_manifest(
    *,
    current_manifest: dict | None,
    updated_receipt: dict,
    new_records: list[dict[str, Any]],
) -> dict:
    manifest = copy.deepcopy(current_manifest) if current_manifest else {}
    manifest["schema"] = manifest.get("schema") or "szl.command-centre.inventory.v2"
    manifest["generated_at"] = utc_now()
    manifest["organization"] = ORG
    manifest["profile"] = PROFILE
    manifest["protected_org_spaces"] = sorted(PROTECTED)
    manifest["consolidated_spaces"] = updated_receipt["consolidated"]
    manifest.setdefault("creative_profile_spaces", [])
    manifest["supplemental_preservation"] = {
        "trust_revision": TRUST_REVISION,
        "added_sources": [item["source"] for item in new_records],
        "effective_victim_count": len(updated_receipt["victims"]),
        "observed_at": utc_now(),
    }
    return manifest


def verify_uploaded_files(
    *,
    revision: str,
    records: list[dict[str, Any]],
    receipt_bytes: bytes,
    supplemental_bytes: bytes,
    manifest_bytes: bytes,
) -> None:
    for record in records:
        prefix = str(record["archive_prefix"]).rstrip("/")
        for item in record["files"]:
            filename = f"{prefix}/{item['path']}"
            remote = Path(
                hf_hub_download(
                    repo_id=COMMAND_REPO,
                    repo_type="space",
                    filename=filename,
                    revision=revision,
                    token=TOKEN,
                    force_download=True,
                )
            )
            if sha256_path(remote) != item["sha256"]:
                raise RuntimeError(f"remote hash mismatch for {filename}")

    expected_files = {
        PREDELETE_FILENAME: receipt_bytes,
        SUPPLEMENTAL_FILENAME: supplemental_bytes,
        MANIFEST_FILENAME: manifest_bytes,
    }
    for filename, expected in expected_files.items():
        remote = Path(
            hf_hub_download(
                repo_id=COMMAND_REPO,
                repo_type="space",
                filename=filename,
                revision=revision,
                token=TOKEN,
                force_download=True,
            )
        )
        if sha256_path(remote) != sha256_bytes(expected):
            raise RuntimeError(f"remote read-back mismatch for {filename}")


def export_effective_state(*, revision: str, victim_count: int) -> None:
    if not is_full_revision(revision):
        raise RuntimeError(f"cannot export invalid receipt revision: {revision!r}")
    if victim_count <= 0:
        raise RuntimeError("cannot export a non-positive victim count")
    values = {
        "HF_EFFECTIVE_PREDELETE_REVISION": revision,
        "HF_EFFECTIVE_VICTIM_COUNT": str(victim_count),
    }
    env_path = os.environ.get("GITHUB_ENV")
    if env_path:
        with Path(env_path).open("a", encoding="utf-8") as handle:
            for key, value in values.items():
                handle.write(f"{key}={value}\n")
    print("EFFECTIVE PRESERVATION " + json.dumps(values, sort_keys=True), flush=True)


def main() -> None:
    identity = api.whoami(token=TOKEN)
    identity_name = str(identity.get("name") or identity.get("fullname") or "")
    if identity_name.lower() != PROFILE:
        raise RuntimeError(
            f"wrong Hugging Face identity: expected {PROFILE}, got {identity_name!r}"
        )

    trusted, trusted_path = load_json(
        COMMAND_REPO,
        PREDELETE_FILENAME,
        TRUST_REVISION,
    )
    command_info = api.repo_info(repo_id=COMMAND_REPO, repo_type="space")
    current_revision = str(getattr(command_info, "sha", "") or "")
    if not is_full_revision(current_revision):
        raise RuntimeError("Command Centre lacks an exact current revision")
    if bool(getattr(command_info, "private", False)):
        raise RuntimeError("Command Centre is not public")

    current, current_path = load_json(
        COMMAND_REPO,
        PREDELETE_FILENAME,
        current_revision,
    )
    validate_current_is_anchored(trusted, current)

    spaces = current_org_spaces()
    current_names = set(spaces)
    missing_protected = PROTECTED - current_names
    if missing_protected:
        raise RuntimeError(
            f"protected org Spaces are missing: {sorted(missing_protected)}"
        )

    known_victim_names = {
        repo_id.split("/", 1)[1] for repo_id in current["victims"]
    }
    new_names = sorted(current_names - PROTECTED - known_victim_names)
    if len(new_names) > MAX_NEW_SPACES_PER_RUN:
        raise RuntimeError(
            f"refusing an unexpected supplemental set of {len(new_names)} Spaces"
        )

    if not new_names:
        print(
            "NO SUPPLEMENTAL SPACES; using current anchored receipt "
            f"{current_revision}",
            flush=True,
        )
        export_effective_state(
            revision=current_revision,
            victim_count=len(current["victims"]),
        )
        return

    workspace = Path(tempfile.mkdtemp(prefix="hf-supplemental-preserve-"))
    try:
        existing_prefixes = {
            str(item["archive_prefix"])
            for item in current["consolidated"]
            if isinstance(item, dict) and item.get("archive_prefix")
        }
        new_records: list[dict[str, Any]] = []
        clean_roots: dict[str, Path] = {}
        for name in new_names:
            record, clean = prepare_source_record(
                name=name,
                info=spaces[name],
                workspace=workspace,
            )
            if record["archive_prefix"] in existing_prefixes:
                raise RuntimeError(
                    f"archive prefix collision for {record['source']}: "
                    f"{record['archive_prefix']}"
                )
            existing_prefixes.add(record["archive_prefix"])
            new_records.append(record)
            clean_roots[record["source"]] = clean
            print(
                f"STAGED {record['source']} sha={record['source_sha'][:12]} "
                f"files={record['file_count']} bytes={record['bytes']}",
                flush=True,
            )

        updated = copy.deepcopy(current)
        victim_ids = set(updated["victims"])
        revisions = dict(updated["expected_source_revisions"])
        consolidated_by_source = {
            item["source"]: item
            for item in updated["consolidated"]
            if isinstance(item, dict) and isinstance(item.get("source"), str)
        }
        for record in new_records:
            source = record["source"]
            victim_ids.add(source)
            revisions[source] = record["source_sha"]
            consolidated_by_source[source] = record

        updated["victims"] = sorted(victim_ids)
        updated["expected_source_revisions"] = {
            key: revisions[key] for key in sorted(revisions)
        }
        updated["consolidated"] = [
            consolidated_by_source[key] for key in sorted(consolidated_by_source)
        ]
        updated["remaining_org_spaces"] = sorted(
            PROTECTED | {repo_id.split("/", 1)[1] for repo_id in victim_ids}
        )
        updated["supplemented_at"] = utc_now()
        updated["trust_anchor"] = {
            "repo_id": COMMAND_REPO,
            "revision": TRUST_REVISION,
            "filename": PREDELETE_FILENAME,
            "sha256": sha256_path(trusted_path),
        }
        supplemental_runs = list(updated.get("supplemental_runs") or [])
        supplemental_runs.append(
            {
                "observed_at": utc_now(),
                "workflow_run_id": os.environ.get("GITHUB_RUN_ID", ""),
                "added_sources": [record["source"] for record in new_records],
                "effective_victim_count": len(victim_ids),
            }
        )
        updated["supplemental_runs"] = supplemental_runs
        validate_current_is_anchored(trusted, updated)

        supplemental = {
            "schema": "szl.hf-space-consolidation.supplemental.v1",
            "status": "PRESERVED_AND_READY_FOR_EXACT_DELETE",
            "observed_at": utc_now(),
            "organization": ORG,
            "profile": PROFILE,
            "trust_revision": TRUST_REVISION,
            "previous_effective_revision": current_revision,
            "previous_receipt_sha256": sha256_path(current_path),
            "added_sources": new_records,
            "effective_victim_count": len(victim_ids),
            "workflow_run_id": os.environ.get("GITHUB_RUN_ID", ""),
            "workflow_source_revision": os.environ.get("GITHUB_SHA", ""),
        }

        current_manifest: dict | None
        try:
            current_manifest, _ = load_json(
                COMMAND_REPO,
                MANIFEST_FILENAME,
                current_revision,
            )
        except Exception:
            current_manifest = None
        updated_manifest = build_updated_manifest(
            current_manifest=current_manifest,
            updated_receipt=updated,
            new_records=new_records,
        )

        receipt_bytes = (
            json.dumps(updated, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        supplemental_bytes = (
            json.dumps(supplemental, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        manifest_bytes = (
            json.dumps(updated_manifest, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")

        operations: list[CommitOperationAdd] = []
        for record in new_records:
            clean = clean_roots[record["source"]]
            prefix = str(record["archive_prefix"]).rstrip("/")
            for item in record["files"]:
                operations.append(
                    CommitOperationAdd(
                        path_in_repo=f"{prefix}/{item['path']}",
                        path_or_fileobj=str(clean / item["path"]),
                    )
                )
        operations.extend(
            [
                CommitOperationAdd(
                    path_in_repo=PREDELETE_FILENAME,
                    path_or_fileobj=receipt_bytes,
                ),
                CommitOperationAdd(
                    path_in_repo=SUPPLEMENTAL_FILENAME,
                    path_or_fileobj=supplemental_bytes,
                ),
                CommitOperationAdd(
                    path_in_repo=MANIFEST_FILENAME,
                    path_or_fileobj=manifest_bytes,
                ),
            ]
        )

        commit = api.create_commit(
            repo_id=COMMAND_REPO,
            repo_type="space",
            operations=operations,
            commit_message=(
                "Preserve post-snapshot non-flagship Spaces: "
                + ", ".join(new_names)
            ),
        )
        effective_revision = str(commit.oid)
        if not is_full_revision(effective_revision):
            raise RuntimeError(
                f"supplemental preservation returned invalid revision: "
                f"{effective_revision!r}"
            )

        verify_uploaded_files(
            revision=effective_revision,
            records=new_records,
            receipt_bytes=receipt_bytes,
            supplemental_bytes=supplemental_bytes,
            manifest_bytes=manifest_bytes,
        )
        wait_running(COMMAND_REPO, effective_revision)

        for record in new_records:
            source_info = api.repo_info(
                repo_id=record["source"],
                repo_type="space",
            )
            observed = str(getattr(source_info, "sha", "") or "")
            if observed != record["source_sha"]:
                raise RuntimeError(
                    f"source changed during supplemental preservation: "
                    f"{record['source']} {record['source_sha']} -> {observed}"
                )

        print(
            "SUPPLEMENTAL PRESERVATION VERIFIED "
            + json.dumps(
                {
                    "revision": effective_revision,
                    "added_sources": [record["source"] for record in new_records],
                    "effective_victim_count": len(victim_ids),
                },
                sort_keys=True,
            ),
            flush=True,
        )
        export_effective_state(
            revision=effective_revision,
            victim_count=len(victim_ids),
        )
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    main()
