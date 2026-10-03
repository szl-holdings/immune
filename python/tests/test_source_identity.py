"""Source declarations are observations of a flattened bundle, not authority."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from immune.source_identity import ROOT_FILES, SCHEMA, STAMP, bundled_source

REVISION = "a" * 40


class BundledSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "immune").mkdir()
        for name in (*ROOT_FILES, "immune/server.py", "immune/runtime.py"):
            path = self.root / name
            path.write_bytes(f"source:{name}\n".encode())
        self.stamp = self.root / "immune" / STAMP

    def claim(self) -> dict:
        names = (*ROOT_FILES, "immune/server.py", "immune/runtime.py")
        return {
            "schema": SCHEMA,
            "repository": "szl-holdings/immune",
            "revision": REVISION,
            "files": {
                name: hashlib.sha256((self.root / name).read_bytes()).hexdigest()
                for name in names
            },
        }

    def write_claim(self, claim: dict) -> None:
        self.stamp.write_text(json.dumps(claim), encoding="utf-8")

    def test_valid_declaration_reports_source_without_authority(self) -> None:
        self.write_claim(self.claim())
        raw = self.stamp.read_bytes()
        result = bundled_source(self.root)
        self.assertEqual(result["revision"], REVISION)
        self.assertEqual(result["evidence_class"], "DECLARED")
        self.assertEqual(result["manifest_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(self.stamp.read_bytes(), raw)

    def test_missing_and_malformed_declarations_remain_unknown(self) -> None:
        self.assertEqual(bundled_source(self.root)["evidence_class"], "UNKNOWN")
        for raw in (
            b"{",
            b'{"schema":"x","schema":"y"}',
            b'{"schema":NaN}',
            b"x" * (16 * 1024 + 1),
        ):
            with self.subTest(raw=raw[:32]):
                self.stamp.write_bytes(raw)
                result = bundled_source(self.root)
                self.assertEqual(result["evidence_class"], "UNKNOWN")
                self.assertIsNone(result["revision"])

    def test_wrong_repo_revision_digest_and_stale_files_remain_unknown(self) -> None:
        for field, value in (
            ("repository", "another/immune"),
            ("revision", "short"),
            ("revision", "0" * 40),
        ):
            with self.subTest(field=field, value=value):
                claim = self.claim()
                claim[field] = value
                self.write_claim(claim)
                self.assertEqual(bundled_source(self.root)["evidence_class"], "UNKNOWN")
        claim = self.claim()
        claim["files"]["server.py"] = "0" * 64
        self.write_claim(claim)
        self.assertEqual(bundled_source(self.root)["evidence_class"], "UNKNOWN")
        self.write_claim(self.claim())
        (self.root / "immune" / "runtime.py").write_bytes(b"changed after stamp")
        self.assertEqual(bundled_source(self.root)["evidence_class"], "UNKNOWN")
        (self.root / "immune" / "extra.py").write_bytes(b"unstamped file")
        self.assertEqual(bundled_source(self.root)["evidence_class"], "UNKNOWN")

    def test_mutable_environment_cannot_supply_missing_source_identity(self) -> None:
        with patch.dict(os.environ, {"SOURCE_REVISION": REVISION,
                                   "GITHUB_SHA": REVISION,
                                   "SPACE_REPO_ID": "SZLHOLDINGS/immune-lattice"}):
            self.assertEqual(bundled_source(self.root), {
                "revision": None,
                "evidence_class": "UNKNOWN",
                "manifest_sha256": None,
            })

    def test_junction_or_symlink_escape_is_rejected_before_external_read(self) -> None:
        bundle = self.root / "bundle"
        package = bundle / "immune"
        package.mkdir(parents=True)
        names = (*ROOT_FILES, "immune/server.py", "immune/runtime.py")
        for name in names:
            target = bundle / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((self.root / name).read_bytes())
        outside = self.root / "outside"
        outside.mkdir()
        canary = outside / "canary.py"
        canary.write_bytes(b"external canary must never be opened")
        link = package / "junction"
        if os.name == "nt":
            created = subprocess.run(
                ["cmd.exe", "/c", "mklink", "/J", str(link), str(outside)],
                capture_output=True, text=True,
            )
            if created.returncode:
                self.skipTest("NTFS junction creation unavailable")
        else:
            link.symlink_to(outside, target_is_directory=True)
        try:
            claim = {
                "schema": SCHEMA,
                "repository": "szl-holdings/immune",
                "revision": REVISION,
                "files": {
                    name: hashlib.sha256((bundle / name).read_bytes()).hexdigest()
                    for name in names
                },
            }
            claim["files"]["immune/junction/canary.py"] = hashlib.sha256(canary.read_bytes()).hexdigest()
            (package / STAMP).write_text(json.dumps(claim), encoding="utf-8")
            original_open = Path.open

            def guarded_open(path, *args, **kwargs):
                if path.resolve() == canary.resolve():
                    self.fail("source verifier opened escaped canary")
                return original_open(path, *args, **kwargs)

            with patch.object(Path, "open", guarded_open):
                self.assertEqual(bundled_source(bundle)["evidence_class"], "UNKNOWN")
        finally:
            if os.name == "nt":
                link.rmdir()
            else:
                link.unlink()


if __name__ == "__main__":
    unittest.main()
