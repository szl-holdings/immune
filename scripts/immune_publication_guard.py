# Copyright 2026 SZL Holdings — SPDX-License-Identifier: Apache-2.0
"""Mutation boundary for the EXISTING two-channel IMMUNE publication workflow.

Importing this module performs no provider operation. A returned commit identity
is not a live-deployment receipt. SDK-internal upload/retry behavior is separate
from the single create_commit invocation made here.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

SHA = re.compile(r"[0-9a-f]{40}")
MAX_FILES = 5000
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
SOURCE_STAMP = "immune/_source_identity.json"
SOURCE_SCHEMA = "szl.immune.bundled-source/v1"
SOURCE_REPOSITORY = "szl-holdings/immune"
RUNTIME_ROOT_FILES = frozenset({"server.py", "requirements.txt", "index.html", "nexus.html"})
MAX_SOURCE_STAMP_BYTES = 16 * 1024
CONTRACTS = {
    "SZLHOLDINGS/immune": {
        "root": "frontend/deploy",
        "prefix": "dist/",
        "prune_prefix": "dist/public/assets/",
        "root_files": frozenset({"Dockerfile", ".dockerignore", "README.md", "hf-deploy-manifest.json"}),
        "required": frozenset({"Dockerfile", ".dockerignore", "README.md", "dist/public/index.html", "dist/immune-server.js", "dist/hf-deploy-manifest.json", "hf-deploy-manifest.json"}),
    },
    "SZLHOLDINGS/immune-lattice": {
        "root": "python",
        "prefix": "immune/",
        "prune_prefix": "immune/",
        "root_files": frozenset({"Dockerfile", "requirements.txt", "README.md", "server.py", "index.html", "nexus.html"}),
        "required": frozenset({"Dockerfile", "requirements.txt", "README.md", "server.py", "index.html", "immune/__init__.py"}),
    },
}


class PublicationBoundaryError(RuntimeError):
    """A sanitized, non-authorizing failure; no raw provider exception text."""


def _is_reparse(path: Path) -> bool:
    info = path.lstat()
    return (
        stat.S_ISLNK(info.st_mode)
        or bool(getattr(info, "st_file_attributes", 0)
                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))
        or getattr(path, "is_junction", lambda: False)()
    )


def _sha(value: Any) -> str:
    if not isinstance(value, str) or SHA.fullmatch(value) is None or value == "0" * 40:
        raise PublicationBoundaryError("INVALID_REVISION")
    return value


def _path(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise PublicationBoundaryError("INVALID_PATH")
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts) or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise PublicationBoundaryError("INVALID_PATH")
    if any(c in value for c in "\\:\x00") or str(PurePosixPath(value)) != value:
        raise PublicationBoundaryError("INVALID_PATH")
    return value


def _contract(space: str) -> dict:
    if not isinstance(space, str) or space not in CONTRACTS:
        raise PublicationBoundaryError("UNSUPPORTED_SPACE")
    return CONTRACTS[space]


def observe_existing(api: Any, space: str) -> str:
    """No creation/visibility fallback, including on permission or network errors."""
    _contract(space)
    if getattr(api, "endpoint", None) != "https://huggingface.co":
        raise PublicationBoundaryError("UNEXPECTED_HUB_ENDPOINT")
    try:
        info = api.repo_info(repo_id=space, repo_type="space", revision="main")
    except Exception:
        raise PublicationBoundaryError("SPACE_OBSERVATION_UNAVAILABLE") from None
    if getattr(info, "id", None) != space or getattr(info, "private", None) is not False:
        raise PublicationBoundaryError("SPACE_IDENTITY_OR_VISIBILITY_MISMATCH")
    if getattr(info, "sdk", None) != "docker":
        raise PublicationBoundaryError("SPACE_SDK_MISMATCH")
    return _sha(getattr(info, "sha", None))


def freeze_uploads(space: str, uploads: Mapping[str, str], checkout: Path) -> dict[str, bytes]:
    """Read bounded regular files once; the bytes hashed are the bytes submitted."""
    spec = _contract(space)
    if not isinstance(uploads, dict) or not 0 < len(uploads) <= MAX_FILES:
        raise PublicationBoundaryError("INVALID_UPLOAD_SET")
    if not spec["required"].issubset(uploads):
        raise PublicationBoundaryError("INCOMPLETE_UPLOAD_SET")
    try:
        source_root = checkout.absolute()
        if any(_is_reparse(part) for part in reversed((source_root, *source_root.parents))):
            raise PublicationBoundaryError("INVALID_LOCAL_ROOT")
        root = source_root.resolve(strict=True)
    except OSError:
        raise PublicationBoundaryError("INVALID_LOCAL_ROOT") from None
    allowed_root = root / spec["root"]
    try:
        allowed_components = [part for part in reversed((allowed_root, *allowed_root.parents))
                              if part != root and part.is_relative_to(root)]
        if any(_is_reparse(part) for part in allowed_components):
            raise PublicationBoundaryError("INVALID_LOCAL_ROOT")
    except OSError:
        raise PublicationBoundaryError("INVALID_LOCAL_ROOT") from None
    if not allowed_root.is_dir():
        raise PublicationBoundaryError("INVALID_LOCAL_ROOT")
    frozen = {}
    total = 0
    for remote, local in sorted(uploads.items()):
        remote = _path(remote)
        if remote not in spec["root_files"] and not remote.startswith(spec["prefix"]):
            raise PublicationBoundaryError("UPLOAD_OUTSIDE_OWNED_SCOPE")
        if not isinstance(local, str):
            raise PublicationBoundaryError("INVALID_LOCAL_PATH")
        local = _path(local)
        p = root / local
        try:
            p.relative_to(allowed_root)
        except ValueError:
            raise PublicationBoundaryError("LOCAL_PATH_OUTSIDE_SOURCE") from None
        # Reject links and NTFS reparse points before opening the file. CI
        # checkout is trusted; this is not a concurrent filesystem sandbox.
        try:
            components = [part for part in reversed((p, *p.parents))
                          if part != root and part.is_relative_to(root)]
            if any(_is_reparse(part) for part in components):
                raise PublicationBoundaryError("LOCAL_SYMLINK")
            if not p.resolve(strict=True).is_relative_to(allowed_root.resolve(strict=True)):
                raise PublicationBoundaryError("LOCAL_PATH_OUTSIDE_SOURCE")
        except OSError:
            raise PublicationBoundaryError("LOCAL_FILE_UNAVAILABLE") from None
        try:
            before = p.stat()
            if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_FILE_BYTES:
                raise PublicationBoundaryError("LOCAL_FILE_BOUNDARY")
            with p.open("rb") as stream:
                data = stream.read(MAX_FILE_BYTES + 1)
            after = p.stat()
        except OSError:
            raise PublicationBoundaryError("LOCAL_FILE_UNAVAILABLE") from None
        if len(data) > MAX_FILE_BYTES or len(data) != before.st_size:
            raise PublicationBoundaryError("LOCAL_FILE_BOUNDARY")
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            raise PublicationBoundaryError("LOCAL_FILE_CHANGED")
        if remote in spec["required"] and not data:
            raise PublicationBoundaryError("EMPTY_REQUIRED_FILE")
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise PublicationBoundaryError("LOCAL_BUNDLE_TOO_LARGE")
        frozen[remote] = data
    return frozen


def prepare_uploads(space: str, uploads: dict[str, str], checkout: Path,
                    revision: str) -> dict[str, bytes]:
    """Add a Channel B declaration derived only from frozen upload bytes."""
    revision = _sha(revision)
    if space == "SZLHOLDINGS/immune-lattice" and SOURCE_STAMP in uploads:
        raise PublicationBoundaryError("SOURCE_STAMP_NOT_PUBLISHER_GENERATED")
    frozen = freeze_uploads(space, uploads, checkout)
    if space == "SZLHOLDINGS/immune-lattice":
        if len(frozen) >= MAX_FILES:
            raise PublicationBoundaryError("LOCAL_BUNDLE_TOO_LARGE")
        files = {
            name: hashlib.sha256(data).hexdigest()
            for name, data in frozen.items()
            if name.startswith("immune/") or name in RUNTIME_ROOT_FILES
        }
        declaration = {
            "schema": SOURCE_SCHEMA,
            "repository": SOURCE_REPOSITORY,
            "revision": revision,
            "files": files,
        }
        stamp = (
            json.dumps(declaration, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode("utf-8")
        if len(stamp) > MAX_SOURCE_STAMP_BYTES or sum(map(len, frozen.values())) + len(stamp) > MAX_TOTAL_BYTES:
            raise PublicationBoundaryError("SOURCE_STAMP_TOO_LARGE")
        frozen[SOURCE_STAMP] = stamp
    return frozen


def require_main_source(revision: str, checkout: Path,
                        uploads: Mapping[str, str] | None = None,
                        frozen: Mapping[str, bytes] | None = None) -> None:
    """Require the actual checkout and a fresh canonical main read, not an alias."""
    _sha(revision)
    if os.environ.get("GITHUB_REF") != "refs/heads/main" or os.environ.get("GITHUB_REPOSITORY") != "szl-holdings/immune":
        raise PublicationBoundaryError("SOURCE_NOT_CANONICAL_MAIN")
    git_env = {**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"}
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=checkout,
                              check=True, capture_output=True, text=True, timeout=10,
                              env=git_env).stdout.strip()
        remote = subprocess.run(["git", "ls-remote", "--exit-code", "https://github.com/szl-holdings/immune.git", "refs/heads/main"],
                                cwd=checkout, check=True, capture_output=True, text=True, timeout=30,
                                env=git_env).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        raise PublicationBoundaryError("SOURCE_READBACK_UNAVAILABLE") from None
    if head != revision or remote != revision + "\trefs/heads/main":
        raise PublicationBoundaryError("SOURCE_REVISION_MOVED")
    if uploads is not None:
        if frozen is None or not set(uploads).issubset(frozen):
            raise PublicationBoundaryError("SOURCE_UPLOAD_SET_MISMATCH")
        for remote_path, local_path in sorted(uploads.items()):
            try:
                committed = subprocess.run(
                    ["git", "cat-file", "blob", f"{revision}:{_path(local_path)}"],
                    cwd=checkout, check=True, capture_output=True, timeout=10,
                    env=git_env,
                ).stdout
            except (OSError, subprocess.TimeoutExpired):
                raise PublicationBoundaryError("SOURCE_READBACK_UNAVAILABLE") from None
            except subprocess.CalledProcessError:
                raise PublicationBoundaryError("SOURCE_BYTES_NOT_AT_REVISION") from None
            if committed != frozen[remote_path]:
                raise PublicationBoundaryError("SOURCE_BYTES_NOT_AT_REVISION")


def publish_existing(api: Any, space: str, uploads: dict[str, str], revision: str,
                     *, checkout: Path, receipt_path: Path) -> dict:
    """Use one SDK commit call guarded by the observed parent; never create a Space.

    The trusted caller chooses a fresh, local receipt path. It is not an HTTP or
    user-supplied route parameter. Existing receipts cannot be overwritten.
    """
    spec = _contract(space)
    revision = _sha(revision)
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    report = {"schema": "szl.immune.publication-boundary/v1", "space": space,
              "source_revision": revision, "live_verified": False,
              "create_commit_calls": 0, "state": "PREFLIGHT"}
    # Exclusive creation also prevents an accidental repeated call from silently
    # replacing the journal from an earlier uncertain mutation.
    with receipt_path.open("x", encoding="utf-8") as journal:
        def record(state: str) -> None:
            report.update(state=state, observed_at=datetime.now(timezone.utc).isoformat())
            journal.seek(0)
            journal.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
            journal.truncate()
            journal.flush()
            os.fsync(journal.fileno())

        record("PREFLIGHT")
        try:
            require_main_source(revision, checkout)
            frozen = prepare_uploads(space, uploads, checkout, revision)
            parent = observe_existing(api, space)
            try:
                names = api.list_repo_files(repo_id=space, repo_type="space", revision=parent)
            except Exception:
                raise PublicationBoundaryError("SPACE_TREE_UNAVAILABLE") from None
            if not isinstance(names, list) or len(names) > MAX_FILES:
                raise PublicationBoundaryError("INVALID_SPACE_TREE")
            names = [_path(name) for name in names]
            if len(set(names)) != len(names):
                raise PublicationBoundaryError("DUPLICATE_SPACE_PATH")
            # Only retired generated files in the declared namespace are pruned.
            # Root files absent from this upload, .gitattributes, .github, data,
            # weights and any other unowned namespace remain unchanged.
            stale = sorted(n for n in names if n not in frozen and n.startswith(spec["prune_prefix"]))
            preserved = sorted(n for n in names if n not in frozen and n not in stale)
            report.update(parent_commit=parent, deleted_owned_paths=stale,
                          preserved_unowned_paths=preserved,
                          upload_sha256={k: hashlib.sha256(v).hexdigest() for k, v in frozen.items()})
            from huggingface_hub import CommitOperationAdd, CommitOperationDelete
            operations = [CommitOperationAdd(path_in_repo=k, path_or_fileobj=v) for k, v in frozen.items()]
            operations += [CommitOperationDelete(path_in_repo=k) for k in stale]
            if space == "SZLHOLDINGS/immune-lattice":
                require_main_source(revision, checkout, uploads, frozen)
            else:
                require_main_source(revision, checkout)
            if observe_existing(api, space) != parent:
                raise PublicationBoundaryError("SPACE_REVISION_MOVED")
            record("ATTEMPT_JOURNALED")
            report["create_commit_calls"] = 1
            try:
                commit = api.create_commit(repo_id=space, repo_type="space", revision="main",
                                           parent_commit=parent, create_pr=False, run_as_future=False,
                                           operations=operations,
                                           commit_message=f"deploy: source-bound IMMUNE {revision}")
            except Exception:
                # Could have committed despite a lost response. No automatic
                # retry/rollback. Reconcile provider history before another run.
                raise PublicationBoundaryError("UNKNOWN_AFTER_ATTEMPT") from None
            try:
                report["hub_commit"] = _sha(getattr(commit, "oid", None))
            except PublicationBoundaryError:
                raise PublicationBoundaryError("UNKNOWN_AFTER_ATTEMPT") from None
            record("COMMITTED_LIVE_UNVERIFIED")
            return report
        except Exception as exc:
            code = str(exc) if isinstance(exc, PublicationBoundaryError) else "LOCAL_OR_SDK_BOUNDARY_FAILURE"
            report["error_code"] = code
            record("UNKNOWN_AFTER_ATTEMPT" if report["create_commit_calls"] else "BLOCKED_BEFORE_ATTEMPT")
            raise PublicationBoundaryError(code) from None
