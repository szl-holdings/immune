"""Reject ambiguous HTTP framing before parsing or acquiring the runtime."""
from __future__ import annotations

import io
import json
import socket
import threading
import unittest
from http.server import ThreadingHTTPServer
from http.client import HTTPMessage
from types import SimpleNamespace
from unittest.mock import Mock, patch

from immune.server import Handler, NexusValidationError


class FramingTests(unittest.TestCase):
    def _post(self, headers: list[str], body: bytes = b"") -> tuple[int, dict, bool]:
        errors = []

        class QuietServer(ThreadingHTTPServer):
            def handle_error(self, request, client_address):
                errors.append("handler exception")

        with patch("immune.server.get_runtime", return_value=object()) as runtime:
            server = QuietServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(
                target=lambda: server.serve_forever(poll_interval=0.01), daemon=True
            )
            thread.start()
            try:
                with socket.create_connection(server.server_address, timeout=2) as client:
                    request = "\r\n".join(
                        ["POST /framing-probe HTTP/1.0", "Host: localhost", *headers, "", ""]
                    ).encode("ascii")
                    client.sendall(request + body)
                    client.shutdown(socket.SHUT_WR)
                    chunks = []
                    while chunk := client.recv(65536):
                        chunks.append(chunk)
                response = b"".join(chunks)
                self.assertFalse(errors, "request must produce a JSON error, not crash")
                self.assertTrue(response, "request must receive an HTTP response")
                head, payload = response.split(b"\r\n\r\n", 1)
                return int(head.split(b" ", 2)[1]), json.loads(payload), runtime.called
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_invalid_framing_is_rejected_before_runtime_access(self):
        cases = [
            ["Content-Length: -1"],
            ["Content-Length: +2"],
            ["Content-Length: 1_0"],
            ["Content-Length: invalid"],
            ["Content-Length:"],
            ["Content-Length: 2", "Content-Length: 2"],
            ["Content-Length: 2", "Content-Length: 0"],
            ["Content-Length: 2, 2"],
            ["Transfer-Encoding: chunked"],
            ["Transfer-Encoding: chunked", "Content-Length: 2"],
        ]
        for headers in cases:
            with self.subTest(headers=headers):
                status, payload, runtime_called = self._post(headers, b"{}")
                self.assertEqual(status, 400)
                self.assertIn(payload["error"], {
                    "INVALID_CONTENT_LENGTH", "UNSUPPORTED_TRANSFER_ENCODING"
                })
                self.assertFalse(runtime_called)

    def test_negative_length_cannot_bypass_one_mib_bound(self):
        body = json.dumps({"data": "x" * 1_048_576}).encode("ascii")
        headers = HTTPMessage()
        headers.add_header("Content-Length", "-1")
        stream = Mock(wraps=io.BytesIO(body))
        request = SimpleNamespace(headers=headers, rfile=stream)
        with self.assertRaises(NexusValidationError) as rejected:
            Handler._read_json(request)
        self.assertEqual(rejected.exception.code, "INVALID_CONTENT_LENGTH")
        stream.read.assert_not_called()

    def test_oversize_decimal_is_rejected_without_integer_conversion_failure(self):
        for length in ("1048577", "9" * 5000):
            with self.subTest(length_digits=len(length)):
                status, payload, runtime_called = self._post([f"Content-Length: {length}"])
                self.assertEqual((status, payload["error"]), (400, "PAYLOAD_OVERSIZE"))
                self.assertFalse(runtime_called)

    def test_truncated_body_is_rejected_before_runtime_access(self):
        status, payload, runtime_called = self._post(["Content-Length: 3"], b"{}")
        self.assertEqual((status, payload["error"]), (400, "INVALID_CONTENT_LENGTH"))
        self.assertFalse(runtime_called)

    def test_existing_empty_and_decimal_requests_are_preserved(self):
        for headers, body in (
            ([], b""),
            (["Content-Length: 0"], b""),
            (["Content-Length: 2"], b"{}"),
            (["Content-Length: 0002"], b"{}"),
        ):
            with self.subTest(headers=headers):
                status, payload, runtime_called = self._post(headers, body)
                self.assertEqual((status, payload), (404, {"error": "not found"}))
                self.assertTrue(runtime_called)


if __name__ == "__main__":
    unittest.main()

