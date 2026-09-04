#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Apply the exact, locally parity-tested IMMUNE NEXUS source payload.

The payload contains bounded deterministic software only. It performs no
provider mutation, external effect, arbitrary command, URL, or network action.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import py_compile
import shutil
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARTS = ROOT / "scripts" / ".immune-nexus-payload"
EXPECTED_BASE_BLOBS = {
    "package.json": "6723a0f6f3926123b7c3f4fd672df94bd8722f34",
    "server/routes/immune/index.ts": "7a2ebc0b754960e5a74f0d49bafa84380b916705",
    "python/immune/server.py": "cacc5998d114145d46bfb33ea30b86a6fd4b9ae6",
}
TARGETS = {
    "package.json",
    "server/routes/immune/index.ts",
    "server/routes/immune/nexus-engine.ts",
    "server/routes/immune/nexus.ts",
    "tests/immune-nexus.test.ts",
    "python/immune/nexus.py",
    "python/immune/server.py",
    "python/tests/test_nexus.py",
    "frontend/public/nexus.html",
    "python/space/nexus.html",
    "contracts/immune-nexus.v1.json",
    "contracts/immune-nexus-parity-v1.json",
    "docs/IMMUNE_NEXUS_CONSOLIDATION.md",
    "docs/receipts/immune-nexus-source-import-20260904.json",
}
NEW_TARGETS = TARGETS - set(EXPECTED_BASE_BLOBS)
SOURCE_REVISION = "617fb49f061c9eb369c4d879a7c29af64c08e72e"


def git_blob_sha(payload: bytes) -> str:
    header = b"blob " + str(len(payload)).encode("ascii") + b"\0"
    return hashlib.sha1(header + payload).hexdigest()


def safe_members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    members = archive.getmembers()
    names = {member.name.removeprefix("./") for member in members if member.isfile()}
    if names != TARGETS:
        raise SystemExit(
            f"payload target mismatch: missing={sorted(TARGETS-names)} extra={sorted(names-TARGETS)}"
        )
    for member in members:
        name = member.name.removeprefix("./")
        if member.issym() or member.islnk() or name.startswith("/") or ".." in Path(name).parts:
            raise SystemExit(f"unsafe payload member: {member.name}")
    return members


def main() -> None:
    for relative, expected in EXPECTED_BASE_BLOBS.items():
        path = ROOT / relative
        if not path.is_file():
            raise SystemExit(f"required base file absent: {relative}")
        observed = git_blob_sha(path.read_bytes())
        if observed != expected:
            raise SystemExit(
                f"base drift for {relative}: expected {expected}, observed {observed}"
            )
    for relative in NEW_TARGETS:
        if (ROOT / relative).exists():
            raise SystemExit(f"refusing to overwrite unexpected existing path: {relative}")

    parts = sorted(PARTS.glob("part-*.b64"))
    if len(parts) != 8:
        raise SystemExit(f"expected 8 payload parts, observed {len(parts)}")
    encoded = "".join(part.read_text(encoding="ascii").strip() for part in parts)
    payload = base64.b64decode(encoded, validate=True)
    payload_sha = hashlib.sha256(payload).hexdigest()

    with tempfile.TemporaryDirectory(prefix="immune-nexus-") as temporary:
        stage = Path(temporary)
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
            archive.extractall(stage, members=safe_members(archive), filter="data")
        for relative in sorted(TARGETS):
            source = stage / relative
            destination = ROOT / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)

    for relative in (
        "package.json",
        "contracts/immune-nexus.v1.json",
        "contracts/immune-nexus-parity-v1.json",
        "docs/receipts/immune-nexus-source-import-20260904.json",
    ):
        value = json.loads((ROOT / relative).read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise SystemExit(f"JSON root is not an object: {relative}")

    for relative in ("python/immune/nexus.py", "python/immune/server.py"):
        py_compile.compile(str(ROOT / relative), doraise=True)

    for relative in ("server/routes/immune/nexus-engine.ts", "python/immune/nexus.py"):
        if SOURCE_REVISION not in (ROOT / relative).read_text(encoding="utf-8"):
            raise SystemExit(f"NEXUS source revision absent: {relative}")

    print(
        json.dumps(
            {
                "status": "IMMUNE_NEXUS_SOURCE_TRANSACTION_APPLIED",
                "payload_sha256": payload_sha,
                "target_count": len(TARGETS),
                "provider_mutation_performed": False,
                "external_effectors_enabled": False,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
