"""Stdlib HTTP — HF Space port 7860. Live operator, no demo default."""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .frontier import evaluate_frontier
from .organs import dashboard, local_organ_mesh
from .runtime import get_runtime
from .second_brain import search_brain
from .sentra import sentra_inspect

HTML = Path(__file__).resolve().parent.parent / "space" / "index.html"
SOURCE_REV = (
    os.environ.get("SOURCE_REVISION")
    or os.environ.get("GITHUB_SHA")
    or os.environ.get("SPACE_REPO_ID")
    or "UNSIGNED-honest"
)


def _json_bytes(payload: object) -> bytes:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: N802
        return

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw.decode() or "{}")
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            candidates = [
                HTML,
                Path("/app/index.html"),
                Path(__file__).resolve().parent.parent / "space" / "index.html",
                Path("index.html"),
            ]
            target = next((p for p in candidates if p.exists()), None)
            if target:
                self._send(200, target.read_bytes(), "text/html; charset=utf-8")
                return
            self._send(200, b"<html><body>IMMUNE python kernel</body></html>", "text/html; charset=utf-8")
            return
        if path in ("/health", "/healthz", "/readyz"):
            try:
                runtime = get_runtime()
                ready = runtime.readiness()
                snap = runtime.snapshot()
                body = {
                    **ready,
                    "ok": True,
                    "service": "immune-lattice",
                    "lambda_status": "Conjecture 1",
                    "energy": None,
                    "source": {
                        "repository": "szl-holdings/immune",
                        "revision": SOURCE_REV,
                        "channel": "python",
                        "alignment": "src/lib/immune",
                    },
                    "ledger": runtime.verify_ledger(),
                    "authority": {
                        "enabled": True,
                        "evidence_state": snap["evidenceState"],
                        "key_id": runtime.key_id,
                        "receipt_count": snap["authorityReceiptCount"],
                        "receipt_hash": snap["authorityReceiptHash"],
                        "live_operator": True,
                        "demo_operator": False,
                    },
                }
                self._send(200, _json_bytes(body), "application/json")
            except Exception as exc:
                self._send(
                    200,
                    _json_bytes(
                        {
                            "ok": True,
                            "service": "immune-lattice",
                            "channel": "python",
                            "honesty": "STRUCTURAL-ONLY",
                            "lambda_status": "Conjecture 1",
                            "energy": None,
                            "error": str(exc)[:200],
                        }
                    ),
                    "application/json",
                )
            return
        runtime = get_runtime()
        if path in ("/api/immune/state", "/api/immune/dashboard"):
            self._send(200, _json_bytes(dashboard()), "application/json")
            return
        if path == "/api/immune/organs":
            self._send(200, _json_bytes(local_organ_mesh()), "application/json")
            return
        if path == "/api/immune/ledger/latest":
            self._send(200, _json_bytes({"items": runtime.latest(25)}), "application/json")
            return
        if path == "/api/immune/ledger/verify":
            self._send(200, _json_bytes(runtime.verify_ledger()), "application/json")
            return
        if path == "/api/immune/evidence/latest":
            self._send(200, _json_bytes({"items": runtime.evidence_latest(25)}), "application/json")
            return
        if path == "/api/immune/brain":
            qs = parse_qs(parsed.query)
            q = (qs.get("q") or [""])[0]
            k = int((qs.get("k") or ["6"])[0] or 6)
            self._send(200, _json_bytes({"hits": search_brain(q, k), "q": q}), "application/json")
            return
        if path == "/api/chain":
            self._send(200, _json_bytes({"items": runtime.latest(25)}), "application/json")
            return
        self._send(404, b'{"error":"not found"}', "application/json")

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        data = self._read_json()
        runtime = get_runtime()
        if path == "/api/immune/cycle":
            actor = str(data.get("actor") or "immune:live-operator")
            intent = str(data.get("intent") or "")
            extra = data.get("agent") if isinstance(data.get("agent"), dict) else None
            self._send(200, _json_bytes(runtime.run_cycle(actor, intent, extra)), "application/json")
            return
        if path == "/api/immune/reset":
            self._send(200, _json_bytes(runtime.reset()), "application/json")
            return
        if path == "/api/immune/mode":
            mode = str(data.get("mode") or "PASS")
            trip = data.get("tripwire")
            self._send(200, _json_bytes(runtime.set_mode(mode, str(trip) if trip else None)), "application/json")
            return
        if path == "/api/immune/brain":
            q = str(data.get("q") or data.get("query") or "")
            k = int(data.get("k") or 6)
            self._send(200, _json_bytes({"hits": search_brain(q, k), "q": q}), "application/json")
            return
        if path in ("/api/immune/agent/frontier/evaluate", "/api/immune/frontier"):
            self._send(200, _json_bytes(evaluate_frontier(data)), "application/json")
            return
        if path == "/api/sentra":
            rec = sentra_inspect({"actor": "immune:live-operator", "intent": str(data.get("signal") or data.get("intent") or "")}, runtime.snapshot()["mode"])
            cycle = runtime.run_cycle("immune:live-operator", str(data.get("signal") or data.get("intent") or "sentra-admit"))
            self._send(200, _json_bytes({"ok": rec["accepted"], "decision": "ALLOW" if rec["accepted"] else "BLOCKED", "reason": rec["reason"], "receipt": cycle.get("receipt"), "sentra": rec}), "application/json")
            return
        if path == "/api/yawar":
            cycle = runtime.run_cycle("immune:live-operator", str(data.get("event") or "yawar-append"))
            self._send(200, _json_bytes({"ok": cycle["pass"], "decision": "SEALED" if cycle["pass"] else "REFUSED", "reason": cycle["sentra"]["reason"], "receipt": cycle.get("receipt")}), "application/json")
            return
        if path in ("/api/bind", "/api/canary"):
            label = str(data.get("engine") or data.get("id") or path.rsplit("/", 1)[-1])
            cycle = runtime.run_cycle("immune:live-operator", f"{path} {label}")
            self._send(200, _json_bytes({"ok": cycle["pass"], "decision": "SEALED" if cycle["pass"] else "REFUSED", "reason": cycle["sentra"]["reason"], "receipt": cycle.get("receipt")}), "application/json")
            return
        self._send(404, b'{"error":"not found"}', "application/json")


def main() -> None:
    get_runtime()
    port = int(os.environ.get("PORT", "7860"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"immune python kernel listening 0.0.0.0:{port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
