"""Read-only, self-consistent identity of a flattened Channel B source bundle.

This is a publisher declaration, not an authority receipt or deployment proof.
"""

from __future__ import annotations

import hashlib
import json
import re
import stat
from pathlib import Path

SCHEMA = "szl.immune.bundled-source/v1"
REPOSITORY = "szl-holdings/immune"
STAMP = "_source_identity.json"
ROOT_FILES = ("server.py", "requirements.txt", "index.html", "nexus.html")
MAX_STAMP_BYTES = 16 * 1024
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_FILES = 5000
REVISION = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")


def _unique_pairs(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate source declaration key")
        result[key] = value
    return result


def _invalid_constant(_: str) -> None:
    raise ValueError("nonfinite source declaration value")


def _is_reparse(path: Path) -> bool:
    info = path.lstat()
    return (
        stat.S_ISLNK(info.st_mode)
        or bool(getattr(info, "st_file_attributes", 0)
                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))
        or getattr(path, "is_junction", lambda: False)()
    )


def _bundle_root(root: Path) -> Path:
    absolute = root.absolute()
    if any(_is_reparse(part) for part in reversed((absolute, *absolute.parents))):
        raise ValueError("source bundle root is a link or reparse point")
    return absolute.resolve(strict=True)


def _runtime_files(root: Path) -> dict[str, str]:
    package = root / "immune"
    if _is_reparse(package) or not package.is_dir() \
            or not package.resolve(strict=True).is_relative_to(root):
        raise ValueError("source package unavailable")
    paths = [root / name for name in ROOT_FILES]
    pending = [package]
    while pending:
        directory = pending.pop()
        for path in directory.iterdir():
            # Check before is_dir/rglob/open: NTFS junctions are not symlinks.
            if _is_reparse(path) or not path.resolve(strict=True).is_relative_to(root):
                raise ValueError("source path escapes bundle")
            if path.name == "__pycache__" and path.is_dir():
                continue
            if path == package / STAMP or (path.suffix == ".pyc" and path.is_file()):
                continue
            if path.is_dir():
                pending.append(path)
            elif path.is_file():
                paths.append(path)
            else:
                raise ValueError("source file unavailable")
            if len(paths) + len(pending) > MAX_FILES:
                raise ValueError("source bundle too large")
    digests = {}
    for path in paths:
        if _is_reparse(path) or not path.resolve(strict=True).is_relative_to(root) \
                or not path.is_file():
            raise ValueError("source file unavailable")
        with path.open("rb") as stream:
            data = stream.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("source file too large")
        digests[path.relative_to(root).as_posix()] = hashlib.sha256(data).hexdigest()
    return digests


def bundled_source(root: Path | None = None) -> dict[str, str | None]:
    """Return DECLARED only when the in-image declaration matches every file.

    Unknown or malformed declarations never borrow mutable environment values.
    """
    result: dict[str, str | None] = {
        "revision": None, "evidence_class": "UNKNOWN", "manifest_sha256": None,
    }
    try:
        root = _bundle_root(root if root is not None else Path(__file__).resolve().parents[1])
        package = root / "immune"
        if _is_reparse(package) or not package.is_dir() \
                or not package.resolve(strict=True).is_relative_to(root):
            return result
        stamp = package / STAMP
        if _is_reparse(stamp) or not stamp.resolve(strict=True).is_relative_to(root) \
                or not stamp.is_file():
            return result
        with stamp.open("rb") as stream:
            raw = stream.read(MAX_STAMP_BYTES + 1)
        if len(raw) > MAX_STAMP_BYTES:
            return result
        claim = json.loads(raw, object_pairs_hook=_unique_pairs,
                           parse_constant=_invalid_constant)
        if not isinstance(claim, dict) or set(claim) != {
            "schema", "repository", "revision", "files"
        }:
            return result
        if claim["schema"] != SCHEMA or claim["repository"] != REPOSITORY:
            return result
        revision = claim["revision"]
        if not isinstance(revision, str) or REVISION.fullmatch(revision) is None \
                or revision == "0" * 40:
            return result
        files = claim["files"]
        if not isinstance(files, dict) or not files or len(files) > MAX_FILES:
            return result
        if any(not isinstance(name, str) or not isinstance(digest, str)
               or DIGEST.fullmatch(digest) is None for name, digest in files.items()):
            return result
        if files != _runtime_files(root):
            return result
    except (OSError, UnicodeError, ValueError, TypeError, RecursionError):
        return result
    return {
        "revision": revision,
        "evidence_class": "DECLARED",
        "manifest_sha256": hashlib.sha256(raw).hexdigest(),
    }
