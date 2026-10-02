"""Keep the three-target preservation receipt exact and non-destructive."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs" / "hf-space-retirement"
ARCHIVE = EVIDENCE / "packet8-source-archive-04ac800.json"
PREDELETE = EVIDENCE / "immune-124-predelete-2026-10-02.json"

EXPECTED = {
    "SZLHOLDINGS/terra-assurance": (
        "5aa7cd88a00b0a957fbb955760c4d1e064760eab",
        "SZLHOLDINGS/terra",
    ),
    "SZLHOLDINGS/counsel-assurance": (
        "5d6d27cb9e6dac966b96b4a28371be7a214c4e44",
        "SZLHOLDINGS/counsel",
    ),
    "SZLHOLDINGS/puriq-markets": (
        "18112a2d2d804a959bf794acc6993b1ec9565209",
        "SZLHOLDINGS/finance",
    ),
}


def test_predelete_receipt_is_bound_to_exact_three_sources() -> None:
    archive_bytes = ARCHIVE.read_bytes().replace(b"\r\n", b"\n")
    archive = json.loads(archive_bytes)
    receipt = json.loads(PREDELETE.read_text(encoding="utf-8"))

    assert archive["source_sha"] == "04ac8001a5a54c7a10b046a28dd2aba0a91874b0"
    assert archive["active_space_writers"] == 0
    assert archive["provider_mutations"] == 0
    assert archive["provider_deletion_claimed"] is False
    assert receipt["packet8_source_commit"] == archive["source_sha"]
    assert receipt["packet8_source_archive_path"] == ARCHIVE.relative_to(ROOT).as_posix()
    assert receipt["packet8_source_archive_sha256"] == hashlib.sha256(archive_bytes).hexdigest()
    assert receipt["claim"] == "PRIVATE_SOURCE_BYTES_MATCH_GITHUB_GENERATED_ARCHIVE"
    assert receipt["provider_mutations"] == 0
    assert receipt["provider_deletions"] == 0

    archived = {item["space_id"]: item for item in archive["archives"]}
    targets = {item["source"]: item for item in receipt["targets"]}
    assert set(targets) == set(EXPECTED)
    for source, (revision, replacement) in EXPECTED.items():
        target = targets[source]
        assert target["source_revision"] == revision
        assert target["source_private"] is True
        assert target["source_runtime_stage"] == "PAUSED"
        assert target["source_secret_count"] == 0
        assert target["source_variable_count"] == 0
        assert target["replacement"] == replacement
        assert target["replacement_private"] is False
        assert target["replacement_runtime_stage"] == "RUNNING"
        assert target["replacement_root_http_status"] == 200

        observed_files = {item["path"]: item for item in target["files"]}
        archived_files = {item["path"]: item for item in archived[source]["files"]}
        assert set(observed_files) == set(archived_files) | {".gitattributes"}
        for path, archived_file in archived_files.items():
            observed = observed_files[path]
            assert observed["bytes"] == archived_file["bytes"]
            assert observed["sha256"] == archived_file["sha256"]
        attrs = observed_files[".gitattributes"]
        assert attrs["same_as_replacement"] is True
        assert attrs["bytes"] == 1519
        assert attrs["sha256"] == "11ad7efa24975ee4b0c3c3a38ed18737f0658a5f75a0a96787b576a78a023361"

    assert receipt["exclusion"]["repo"] == "SZLHOLDINGS/immune-lattice"
    assert receipt["exclusion"]["private"] is False
    assert receipt["exclusion"]["runtime_stage"] == "RUNNING"
