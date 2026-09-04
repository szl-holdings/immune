#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Apply exact, locally verified review repairs to IMMUNE NEXUS.

The transaction is source-only and fail-closed. It performs no provider,
network, visibility, billing, secret, hardware, or external-effector mutation.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import py_compile
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARTS = ROOT / "scripts" / ".immune-nexus-review-repair"
ARCHIVE_SHA256 = "a11888e732fadd8b001c94d607d1246ed295526028584628ff9de741c030fb63"
NEXUS_SOURCE_REVISION = "617fb49f061c9eb369c4d879a7c29af64c08e72e"

EXPECTED_BASE_BLOBS = {
    "server/routes/immune/nexus-engine.ts": "f93ceca1d53e38431ba804dc0b707c7751c1418b",
    "server/routes/immune/nexus.ts": "940126ed01df4123cd2e4e1e8c955bce6ad5cb2e",
    "tests/immune-nexus.test.ts": "f450400119ac215347a3345afb1254e0626756f4",
    "python/immune/nexus.py": "71cdc44597383047136421861c1642aff8a89413",
    "python/immune/server.py": "c842e343d3b851519fb083f769cf1b5e093ad54f",
    "python/tests/test_nexus.py": "b2582321537ac3172e51030b988272277009b334",
}
EXPECTED_TARGET_BLOBS = {
    "server/routes/immune/nexus-engine.ts": "cc0c6f01d19151f6216087ad071d97832502d2ae",
    "server/routes/immune/nexus.ts": "366902372f0fbc25835bfeaadccdeb33e7d75b77",
    "tests/immune-nexus.test.ts": "3731969eb39da15d7e105d72199d33c5ae28ee24",
    "python/immune/nexus.py": "52ca41e0a8a0edd938771c7e00009bb8551dffbd",
    "python/immune/nexus_commit.py": "6a97ec3852c7ec83efb61b0340706c5f742aa33e",
    "python/immune/server.py": "0c05efe1d5ac2b8878219e0e70ab40aa0f517e3c",
    "python/tests/test_nexus.py": "b2a8c91f36e4c6785c4f04ce2e51b4e7d6c53ca3",
}
TARGETS = set(EXPECTED_TARGET_BLOBS)
NEW_TARGET = "python/immune/nexus_commit.py"


def git_blob_sha(payload: bytes) -> str:
    header = b"blob " + str(len(payload)).encode("ascii") + b"\0"
    return hashlib.sha1(header + payload).hexdigest()


def normalized_name(member: tarfile.TarInfo) -> str:
    return member.name.removeprefix("./")


def main() -> None:
    for relative, expected in EXPECTED_BASE_BLOBS.items():
        target = ROOT / relative
        if not target.is_file():
            raise SystemExit(f"required base file absent: {relative}")
        observed = git_blob_sha(target.read_bytes())
        if observed != expected:
            raise SystemExit(
                f"base drift for {relative}: expected {expected}, observed {observed}"
            )
    if (ROOT / NEW_TARGET).exists():
        raise SystemExit(f"refusing to overwrite unexpected existing path: {NEW_TARGET}")

    parts = sorted(PARTS.glob("part-*.b64"))
    expected_names = [f"part-{index:02d}.b64" for index in range(6)]
    if [part.name for part in parts] != expected_names:
        raise SystemExit(
            f"payload part mismatch: expected={expected_names} "
            f"observed={[part.name for part in parts]}"
        )
    encoded = "".join(part.read_text(encoding="ascii").strip() for part in parts)
    payload = base64.b64decode(encoded, validate=True)
    observed_archive_sha = hashlib.sha256(payload).hexdigest()
    if observed_archive_sha != ARCHIVE_SHA256:
        raise SystemExit(
            f"archive digest mismatch: expected {ARCHIVE_SHA256}, "
            f"observed {observed_archive_sha}"
        )

    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        members = archive.getmembers()
        file_members = [member for member in members if member.isfile()]
        observed_targets = {normalized_name(member) for member in file_members}
        if observed_targets != TARGETS or len(file_members) != len(TARGETS):
            raise SystemExit(
                f"archive target mismatch: missing={sorted(TARGETS-observed_targets)} "
                f"extra={sorted(observed_targets-TARGETS)}"
            )
        for member in members:
            name = normalized_name(member)
            if (
                member.issym()
                or member.islnk()
                or name.startswith("/")
                or ".." in Path(name).parts
            ):
                raise SystemExit(f"unsafe archive member: {member.name}")
        for member in file_members:
            relative = normalized_name(member)
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit(f"unable to read archive member: {relative}")
            content = source.read()
            expected = EXPECTED_TARGET_BLOBS[relative]
            observed = git_blob_sha(content)
            if observed != expected:
                raise SystemExit(
                    f"target blob mismatch for {relative}: expected {expected}, "
                    f"observed {observed}"
                )
            destination = ROOT / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)

    for relative, expected in EXPECTED_TARGET_BLOBS.items():
        observed = git_blob_sha((ROOT / relative).read_bytes())
        if observed != expected:
            raise SystemExit(
                f"post-write blob mismatch for {relative}: expected {expected}, "
                f"observed {observed}"
            )

    for relative in (
        "python/immune/nexus.py",
        "python/immune/nexus_commit.py",
        "python/immune/server.py",
        "python/tests/test_nexus.py",
    ):
        py_compile.compile(str(ROOT / relative), doraise=True)

    engine = (ROOT / "server/routes/immune/nexus-engine.ts").read_text(encoding="utf-8")
    route = (ROOT / "server/routes/immune/nexus.ts").read_text(encoding="utf-8")
    python_engine = (ROOT / "python/immune/nexus.py").read_text(encoding="utf-8")
    python_commit = (ROOT / "python/immune/nexus_commit.py").read_text(encoding="utf-8")
    tests = (ROOT / "tests/immune-nexus.test.ts").read_text(encoding="utf-8")
    python_tests = (ROOT / "python/tests/test_nexus.py").read_text(encoding="utf-8")

    assertions = {
        "source_revision_ts": NEXUS_SOURCE_REVISION in engine,
        "source_revision_python": NEXUS_SOURCE_REVISION in python_engine,
        "non_finite_output_ts": "NON_FINITE_OUTPUT" in engine,
        "non_finite_output_python": "NON_FINITE_OUTPUT" in python_engine,
        "strict_numeric_types_python": "INVALID_NUMBER_TYPE" in python_engine,
        "serialized_ts_commit": "NexusCommitSerializer" in route,
        "serialized_python_commit": "_NEXUS_COMMIT_LOCK" in python_commit,
        "overflow_regression_ts": "1e308" in tests,
        "strict_numeric_regression_python": "INVALID_NUMBER_TYPE" in python_tests,
        "threaded_collision_regression_python": "ThreadPoolExecutor" in python_tests,
    }
    failed = sorted(key for key, value in assertions.items() if not value)
    if failed:
        raise SystemExit(f"review repair assertion(s) failed: {failed}")

    print(
        json.dumps(
            {
                "schema": "szl.immune-nexus-review-repair/v1",
                "status": "APPLIED",
                "archive_sha256": observed_archive_sha,
                "target_count": len(TARGETS),
                "assertions": assertions,
                "provider_mutation_performed": False,
                "network_action_performed": False,
                "external_effectors_enabled": False,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
