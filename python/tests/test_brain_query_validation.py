"""Bound read-only second-brain search results and reject malformed limits."""
from __future__ import annotations

import json
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from immune.server import Handler


class BrainQueryLimitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.worker = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.worker.join(timeout=2)

    def probe(self, query: str) -> tuple[int, dict]:
        conn = HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=5)
        try:
            with patch("immune.server.get_runtime", return_value=object()):
                conn.request("GET", "/api/immune/brain?" + query)
                response = conn.getresponse()
                return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_normal_and_maximum_result_counts(self) -> None:
        for k, expected in ((6, 6), (25, 25)):
            with self.subTest(k=k):
                status, data = self.probe(f"q=immune&k={k}")
                self.assertEqual(status, 200)
                self.assertEqual(len(data["hits"]), expected)
                self.assertEqual(data["q"], "immune")

    def test_bad_and_negative_limits_fail_closed(self) -> None:
        for k in ("not-a-number", "-1", "0", "2.0", "%2B2"):
            with self.subTest(k=k):
                status, data = self.probe(f"q=immune&k={k}")
                self.assertEqual(status, 400)
                self.assertEqual(data["error"], "INVALID_RESULT_LIMIT")

    def test_oversize_and_duplicate_limits_fail_closed(self) -> None:
        for query in ("q=immune&k=26", "q=immune&k=9000000",
                      "q=immune&k=2&k=5"):
            with self.subTest(query=query):
                status, data = self.probe(query)
                self.assertEqual(status, 400)
                self.assertEqual(data["error"], "INVALID_RESULT_LIMIT")


if __name__ == "__main__":
    unittest.main()
