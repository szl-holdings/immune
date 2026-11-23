"""Fail-closed public source declaration GET; never infer authority from a Space."""
from __future__ import annotations

import json
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from immune.server import Handler


class BuildInfoContract(unittest.TestCase):
    def probe(self, declared_source: dict) -> tuple[int, dict, dict]:
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        conn = HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=2)
        try:
            with (
                patch("immune.server.get_runtime", side_effect=AssertionError("runtime accessed")) as runtime,
                patch("immune.server.bundled_source", return_value=declared_source) as identity,
            ):
                conn.request("GET", "/api/build-info")
                response = conn.getresponse()
                result = (
                    response.status,
                    dict(response.getheaders()),
                    json.loads(response.read()),
                )
                runtime.assert_not_called()
                identity.assert_called_once_with()
                return result
        finally:
            conn.close()
            httpd.shutdown()
            httpd.server_close()
            worker.join(timeout=2)

    def test_declared_identity_is_not_runtime_or_authority_proof(self):
        status, headers, data = self.probe({
            "revision": "a" * 40,
            "evidence_class": "DECLARED",
            "manifest_sha256": "b" * 64,
        })
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(data["schema"], "szl.immune-lattice.build-info/v1")
        self.assertEqual(data["source_repository"], "szl-holdings/immune")
        self.assertEqual(data["source_revision"], "a" * 40)
        self.assertEqual(data["evidence_class"], "DECLARED")
        self.assertEqual(data["manifest_sha256"], "b" * 64)
        self.assertIs(data["deployment_verified"], False)
        self.assertIs(data["action_authority"], False)

    def test_missing_declaration_refuses_to_mint_identity(self):
        status, headers, data = self.probe({
            "revision": None,
            "evidence_class": "UNKNOWN",
            "manifest_sha256": None,
        })
        self.assertEqual(status, 503)
        self.assertEqual(data["source_revision"], None)
        self.assertEqual(data["evidence_class"], "UNKNOWN")
        self.assertEqual(data["manifest_sha256"], None)
        self.assertIs(data["deployment_verified"], False)
        self.assertIs(data["action_authority"], False)


if __name__ == "__main__":
    unittest.main()
