"""Qualify actual static delivery without starting an authority runtime."""
import hashlib
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from immune import presentation
from immune.server import Handler


class NativePresentationTests(unittest.TestCase):
    def test_every_closed_route_serves_exact_packaged_bytes_without_runtime_access(self):
        with patch("immune.server.get_runtime", side_effect=AssertionError("Static assets must not start the kernel")):
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                origin = f"http://127.0.0.1:{server.server_port}"
                for route, (name, mime) in presentation.ASSETS.items():
                    with self.subTest(route=route):
                        with urllib.request.urlopen(origin + route + "?native=1", timeout=3) as response:
                            self.assertEqual(response.status, 200)
                            self.assertEqual(response.headers["Content-Type"], mime)
                            self.assertEqual(response.headers["Cache-Control"], "no-store")
                            self.assertEqual(response.read(), (presentation.ROOT / name).read_bytes())
                for route in ["/assets/szl/missing.css", "/assets/szl/../server.py", "/assets/szl/%2e%2e/server.py"]:
                    with self.subTest(route=route), self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(origin + route, timeout=3)
                    self.assertEqual(error.exception.code, 404)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)

    def test_asset_reader_rejects_links_missing_files_and_oversize_files(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(presentation, "ROOT", Path(temporary)):
            root = Path(temporary)
            target = root / "szl-tokens.css"
            with self.assertRaises(OSError):
                presentation.read_asset("/assets/szl/szl-tokens.css")
            target.symlink_to(__file__)
            with self.assertRaises(OSError):
                presentation.read_asset("/assets/szl/szl-tokens.css")
            target.unlink()
            target.write_bytes(b"x" * (presentation.MAX_ASSET_BYTES + 1))
            with self.assertRaises(OSError):
                presentation.read_asset("/assets/szl/szl-tokens.css")
            with self.assertRaises(KeyError):
                presentation.read_asset("/assets/szl/../../server.py")

    def test_projection_binds_the_installed_subset_and_unchanged_upstream_manifest(self):
        expected = {
            "szl-tokens.css": "81f7c9baeef0b435e6e3f9d0c4e0d70e40fa17df5d1f30697f623cd3ef5f8eab",
            "SOURCE.json": "967a77235227f1d75852fb61873e46336e67403cbc0e7e12b141e31c83fbd93d",
            "szl-icon-32.svg": "6e2b7d72a3af3d9602b79de41df0194ede6496a9661f057108ec224c0efc92e6",
            "favicon.svg": "6e2dc7c9794dc452fbccb44ffadbd168c2584361904e8bcaeba542427d9e1a3a",
            "apple-touch-icon.png": "ddeb873e960f14c41078d82cad4f7bb5a40dca555867ac3c3fb869ce46bbef6c",
        }
        projection = json.loads((presentation.ROOT / "PROJECTION.json").read_bytes())
        self.assertEqual({a["installed_path"] for a in projection["assets"]}, set(expected))
        self.assertEqual(projection["repository"], "https://github.com/szl-holdings/szl-brand")
        self.assertIn("Unsigned projection metadata", projection["qualification"])
        for row in projection["assets"]:
            data = (presentation.ROOT / row["installed_path"]).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), expected[row["installed_path"]])
            self.assertEqual(row["sha256"], expected[row["installed_path"]])
            self.assertEqual(row["bytes"], len(data))
            frontend_asset = Path(__file__).resolve().parents[2] / "frontend/public/assets/szl" / row["installed_path"]
            self.assertEqual(frontend_asset.read_bytes(), data, "Both channels project the same approved native bytes")

    def test_actual_python_projection_is_carried_by_existing_publisher_and_source_stamp(self):
        from immune.source_identity import bundled_source, MAX_STAMP_BYTES
        checkout = Path(__file__).resolve().parents[2]
        sys.path.insert(0, str(checkout / "scripts"))
        import immune_publication_guard as guard
        uploads = {
            "Dockerfile": "python/space/Dockerfile",
            "requirements.txt": "python/requirements.txt",
            "README.md": "python/space/README.md",
            "server.py": "python/space/run.py",
            "index.html": "python/space/index.html",
            "nexus.html": "python/space/nexus.html",
        }
        for local in (checkout / "python/immune").rglob("*"):
            if local.is_file() and local.suffix != ".pyc" and "__pycache__" not in local.parts:
                uploads["immune/" + local.relative_to(checkout / "python/immune").as_posix()] = local.relative_to(checkout).as_posix()
        # Synthetic source identity exercises the immutable bundle contract only.
        frozen = guard.prepare_uploads("SZLHOLDINGS/immune-lattice", uploads, checkout, "a" * 40)
        stamp = frozen[guard.SOURCE_STAMP]
        self.assertLessEqual(len(stamp), MAX_STAMP_BYTES)
        declaration = json.loads(stamp)
        for name, _mime in presentation.ASSETS.values():
            remote = "immune/static/szl/" + name
            self.assertEqual(frozen[remote], (presentation.ROOT / name).read_bytes())
            self.assertEqual(declaration["files"][remote], hashlib.sha256(frozen[remote]).hexdigest())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, data in frozen.items():
                destination = root / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
            self.assertEqual(bundled_source(root)["evidence_class"], "DECLARED")
            (root / "immune/static/szl/surface.css").write_text("tampered")
            self.assertEqual(bundled_source(root)["evidence_class"], "UNKNOWN")


if __name__ == "__main__":
    unittest.main()
