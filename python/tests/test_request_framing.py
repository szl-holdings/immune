"""Bounded HTTP body framing, using only synthetic in-memory/loopback input."""

from __future__ import annotations

import io
import json
import threading
import unittest
from email.message import Message
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch

from immune.nexus import NexusValidationError
from immune.server import Handler


class RequestFramingTests(unittest.TestCase):
    def handler(self, headers=(), body=b""):
        handler = Handler.__new__(Handler)
        handler.headers = Message()
        for key, value in headers:
            handler.headers[key] = value
        handler.rfile = io.BytesIO(body)
        return handler

    def test_invalid_lengths_are_rejected_before_reading(self):
        for value in ("-1", "+2", "2.0", "1e2", "1_0", "", "bogus", "\u0662", "2, 2"):
            with self.subTest(value=value):
                handler = self.handler([("Content-Length", value)])
                handler.rfile = Mock()
                with self.assertRaises(NexusValidationError) as caught:
                    handler._read_json()
                self.assertEqual(caught.exception.code, "INVALID_CONTENT_LENGTH")
                handler.rfile.read.assert_not_called()

    def test_oversize_lengths_are_rejected_before_integer_conversion_or_reading(self):
        for value in ("1048577", "9" * 5000, "0" * 5000 + "1048577"):
            with self.subTest(digits=len(value)):
                handler = self.handler([("Content-Length", value)])
                handler.rfile = Mock()
                with self.assertRaises(NexusValidationError) as caught:
                    handler._read_json()
                self.assertEqual(caught.exception.code, "PAYLOAD_OVERSIZE")
                handler.rfile.read.assert_not_called()

    def test_duplicate_lengths_and_transfer_codings_are_rejected_before_reading(self):
        for headers in (
            [("Content-Length", "2"), ("Content-Length", "2")],
            [("Content-Length", "2"), ("Content-Length", "9")],
            [("Transfer-Encoding", "chunked")],
            [("Content-Length", "0"), ("Transfer-Encoding", "gzip")],
        ):
            with self.subTest(headers=headers):
                handler = self.handler(headers)
                handler.rfile = Mock()
                with self.assertRaises(NexusValidationError):
                    handler._read_json()
                handler.rfile.read.assert_not_called()

    def test_truncated_valid_json_prefix_is_not_accepted(self):
        handler = self.handler([("Content-Length", "3")], b"{}")
        with self.assertRaises(NexusValidationError) as caught:
            handler._read_json()
        self.assertEqual(caught.exception.code, "INVALID_BODY_LENGTH")

    def test_valid_lengths_preserve_empty_and_inclusive_limit_behavior(self):
        for headers, body in (
            ([], b""),
            ([("Content-Length", "0")], b""),
            ([("Content-Length", " 0002 ")], b"{}"),
            ([("Content-Length", "0" * 5000 + "2")], b"{}"),
            ([("Content-Length", "1048576")], b"{}" + b" " * (1048576 - 2)),
        ):
            with self.subTest(size=len(body)):
                self.assertEqual(self.handler(headers, body)._read_json(), {})

    def test_negative_length_returns_json_without_body_or_runtime_access(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = HTTPConnection("127.0.0.1", server.server_address[1], timeout=1)
        runtime_patch = patch("immune.server.get_runtime", side_effect=AssertionError("runtime reached"))
        runtime = runtime_patch.start()
        try:
            connection.putrequest("POST", "/api/immune/cycle")
            connection.putheader("Content-Length", "-1")
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(json.loads(response.read())["error"], "INVALID_CONTENT_LENGTH")
            runtime.assert_not_called()
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            runtime_patch.stop()


if __name__ == "__main__":
    unittest.main()
