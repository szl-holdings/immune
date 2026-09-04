"""Stdlib HTTP — HF Space port 7860. Live operator, no demo default."""

from __future__ import annotations

import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .frontier import evaluate_frontier
from .nexus import (
    NEXUS_RUN_SCHEMA,
    NEXUS_SOURCE_REVISION,
    NexusValidationError,
    nexus_input_hash,
    normalize_nexus_input,
    nexus_status,
    run_nexus,
    verify_nexus_run,
)
from .organs import dashboard, local_organ_mesh
from .runtime import get_runtime
from .second_brain import search_brain
from .sentra import sentra_inspect

HTML = Path(__file__).resolve().parent.parent / "space" / "index.html"
NEXUS_HTML = Path(__file__).resolve().parent.parent / "space" / "nexus.html"
SOURCE_REV = (
    os.environ.get("SOURCE_REVISION")
    or os.environ.get("GITHUB_SHA")
    or os.environ.get("SPACE_REPO_ID")
    or "UNSIGNED-honest"
)
_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")


def _json_bytes(payload: object) -> bytes:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _nexus_catalog() -> dict:
    return {
        "schema": "szl.immune-nexus-catalog/v1",
        "sourceRevision": NEXUS_SOURCE_REVISION,
        "programs": [
            {"id": "lorenz", "label": "LRNZ", "job": "chaotic attractor stress surface"},
            {"id": "harmonic", "label": "HARM", "job": "bounded oscillator and sign-change witness"},
            {"id": "vanderpol", "label": "VDP", "job": "nonlinear self-excited oscillator"},
            {"id": "duffing", "label": "DFFG", "job": "forced nonlinear counterfactual"},
            {"id": "lotka", "label": "LTKA", "job": "coupled population dynamics"},
            {
                "id": "nemo",
                "label": "NEMO",
                "job": "five-organ AdEx software simulation with WILLAY optical field",
            },
        ],
        "modes": [
            {"id": "IC", "job": "return a deterministic initial condition"},
            {"id": "OP", "job": "integrate the selected program"},
            {"id": "HALT", "job": "freeze and return the supplied state"},
            {"id": "REP", "job": "integrate with bounded deterministic reseeding"},
        ],
    }


def _extract_nexus_payload(receipt: dict) -> dict | None:
    payload = receipt.get("payload")
    if not isinstance(payload, dict):
        return None
    agent_json = payload.get("agentJson")
    if not isinstance(agent_json, str) or not agent_json:
        return None
    try:
        extra = json.loads(agent_json)
    except (TypeError, ValueError):
        return None
    if not isinstance(extra, dict) or not isinstance(extra.get("nexus"), dict):
        return None
    return extra["nexus"]


def _find_nexus_receipt(runtime, request_id: str) -> tuple[dict, dict] | None:
    for receipt in runtime.latest(runtime.ledger_count()):
        nexus = _extract_nexus_payload(receipt)
        if nexus and nexus.get("requestId") == request_id:
            return receipt, nexus
    return None


def _compact_nexus_receipt(request_id: str, result: dict) -> dict:
    return {
        "schema": "szl.immune-nexus-receipt/v1",
        "requestId": request_id,
        "inputHash": result["inputHash"],
        "outputHash": result["outputHash"],
        "sourceRevision": NEXUS_SOURCE_REVISION,
        "execution": {
            "program": result["execution"]["program"],
            "mode": result["execution"]["mode"],
            "stepsExecuted": result["execution"]["stepsExecuted"],
            "repeatCount": result["execution"]["repeatCount"],
            "externalCalls": 0,
            "externalEffectors": False,
            "truth": "MEASURED_SOFTWARE_SIMULATION",
        },
        "invariantsHold": bool(result.get("invariants", {}).get("allHold")),
        "energy": "UNAVAILABLE",
        "uniqueness": "Conjecture 1 OPEN",
    }


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

    def _json(self, code: int, payload: object) -> None:
        self._send(code, _json_bytes(payload), "application/json")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_048_576:
            raise NexusValidationError("PAYLOAD_OVERSIZE", "request body exceeds 1 MiB")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw.decode() or "{}")
            if not isinstance(data, dict):
                raise NexusValidationError("INVALID_REQUEST", "request body must be a JSON object")
            return data
        except UnicodeDecodeError as error:
            raise NexusValidationError("INVALID_JSON", "request body is not UTF-8") from error
        except json.JSONDecodeError as error:
            raise NexusValidationError("INVALID_JSON", "request body is not valid JSON") from error

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
            target = next((candidate for candidate in candidates if candidate.exists()), None)
            if target:
                self._send(200, target.read_bytes(), "text/html; charset=utf-8")
                return
            self._send(
                200,
                b"<html><body>IMMUNE python kernel</body></html>",
                "text/html; charset=utf-8",
            )
            return
        if path == "/nexus.html":
            candidates = [
                NEXUS_HTML,
                Path("/app/nexus.html"),
                Path("nexus.html"),
            ]
            target = next((candidate for candidate in candidates if candidate.exists()), None)
            if target:
                self._send(200, target.read_bytes(), "text/html; charset=utf-8")
                return
            self._json(404, {"error": "NEXUS_UI_NOT_BUNDLED"})
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
                    "nexus": nexus_status(),
                }
                self._json(200, body)
            except Exception as exc:
                self._json(
                    200,
                    {
                        "ok": True,
                        "service": "immune-lattice",
                        "channel": "python",
                        "honesty": "STRUCTURAL-ONLY",
                        "lambda_status": "Conjecture 1",
                        "energy": None,
                        "error": str(exc)[:200],
                        "nexus": {"state": "UNAVAILABLE"},
                    },
                )
            return
        runtime = get_runtime()
        if path in ("/api/immune/state", "/api/immune/dashboard"):
            self._json(200, dashboard())
            return
        if path == "/api/immune/organs":
            self._json(200, local_organ_mesh())
            return
        if path == "/api/immune/ledger/latest":
            self._json(200, {"items": runtime.latest(25)})
            return
        if path == "/api/immune/ledger/verify":
            self._json(200, runtime.verify_ledger())
            return
        if path == "/api/immune/evidence/latest":
            self._json(200, {"items": runtime.evidence_latest(25)})
            return
        if path == "/api/immune/brain":
            qs = parse_qs(parsed.query)
            q = (qs.get("q") or [""])[0]
            k = int((qs.get("k") or ["6"])[0] or 6)
            self._json(200, {"hits": search_brain(q, k), "q": q})
            return
        if path == "/api/immune/nexus/status":
            self._json(200, {**nexus_status(), "immuneReadiness": runtime.readiness()})
            return
        if path == "/api/immune/nexus/catalog":
            self._json(200, _nexus_catalog())
            return
        if path.startswith("/api/immune/nexus/receipts/"):
            request_id = path.rsplit("/", 1)[-1]
            if not _REQUEST_ID.fullmatch(request_id):
                self._json(400, {"error": "INVALID_REQUEST_ID"})
                return
            found = _find_nexus_receipt(runtime, request_id)
            if not found:
                self._json(404, {"error": "NEXUS_RECEIPT_NOT_FOUND", "requestId": request_id})
                return
            receipt, nexus = found
            self._json(
                200,
                {
                    "schema": "szl.immune-nexus-receipt-read/v1",
                    "requestId": request_id,
                    "nexus": nexus,
                    "receipt": receipt,
                },
            )
            return
        if path == "/api/chain":
            self._json(200, {"items": runtime.latest(25)})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            data = self._read_json()
        except NexusValidationError as error:
            self._json(400, {"error": error.code, "detail": str(error)})
            return
        runtime = get_runtime()
        if path == "/api/immune/cycle":
            actor = str(data.get("actor") or "immune:live-operator")
            intent = str(data.get("intent") or "")
            extra = data.get("agent") if isinstance(data.get("agent"), dict) else None
            self._json(200, runtime.run_cycle(actor, intent, extra))
            return
        if path == "/api/immune/reset":
            self._json(200, runtime.reset())
            return
        if path == "/api/immune/mode":
            mode = str(data.get("mode") or "PASS")
            trip = data.get("tripwire")
            self._json(200, runtime.set_mode(mode, str(trip) if trip else None))
            return
        if path == "/api/immune/brain":
            q = str(data.get("q") or data.get("query") or "")
            k = int(data.get("k") or 6)
            self._json(200, {"hits": search_brain(q, k), "q": q})
            return
        if path in ("/api/immune/agent/frontier/evaluate", "/api/immune/frontier"):
            self._json(200, evaluate_frontier(data))
            return
        if path == "/api/immune/nexus/verify":
            expected = data.pop("expectedOutputHash", None)
            try:
                proof = verify_nexus_run(data, str(expected or ""))
            except NexusValidationError as error:
                self._json(400, {"error": error.code, "detail": str(error)})
                return
            self._json(200 if proof["verified"] else 409, proof)
            return
        if path == "/api/immune/nexus/run":
            allowed = {
                "actor",
                "requestId",
                "program",
                "mode",
                "steps",
                "dt",
                "chaos",
                "drive",
                "seed",
                "repeatEvery",
                "state",
                "axes",
            }
            extras = sorted(set(data) - allowed)
            if extras:
                self._json(400, {"error": "UNSUPPORTED_FIELD", "detail": extras})
                return
            actor = str(data.pop("actor", "")).strip()
            request_id = str(data.pop("requestId", "")).strip()
            if not 1 <= len(actor) <= 256:
                self._json(400, {"error": "INVALID_ACTOR"})
                return
            if not _REQUEST_ID.fullmatch(request_id):
                self._json(400, {"error": "INVALID_REQUEST_ID"})
                return
            try:
                input_payload = normalize_nexus_input(data)
            except NexusValidationError as error:
                self._json(400, {"error": error.code, "detail": str(error)})
                return
            ready = runtime.readiness()
            if not ready["write_ready"]:
                self._json(
                    503,
                    {
                        "error": "WRITE_NOT_READY",
                        "blockers": ready["blockers"],
                        "computationPerformed": False,
                    },
                )
                return
            intent = f"nexus.simulate:{input_payload['program']}:{input_payload['mode']}"
            authority = runtime.snapshot()
            preflight = sentra_inspect(
                {
                    "actor": actor,
                    "intent": intent,
                    "nexus": {
                        "requestId": request_id,
                        "program": input_payload["program"],
                        "mode": input_payload["mode"],
                        "steps": input_payload["steps"],
                    },
                },
                authority["mode"],
            )
            if authority["deadman"] or not preflight["accepted"]:
                self._json(
                    409,
                    {
                        "error": "DEADMAN_ACTIVE" if authority["deadman"] else "SENTRA_REJECTED",
                        "sentra": preflight,
                        "computationPerformed": False,
                    },
                )
                return
            presented_input_hash = nexus_input_hash(input_payload)
            existing = _find_nexus_receipt(runtime, request_id)
            if existing:
                stored_receipt, stored_nexus = existing
                stored_actor = str((stored_receipt.get("payload") or {}).get("actor") or "")
                if stored_actor != actor or stored_nexus.get("inputHash") != presented_input_hash:
                    self._json(
                        409,
                        {
                            "error": "NEXUS_REQUEST_ID_COLLISION",
                            "requestId": request_id,
                            "storedInputHash": stored_nexus.get("inputHash"),
                            "presentedInputHash": presented_input_hash,
                            "computationPerformed": False,
                        },
                    )
                    return
            try:
                result = run_nexus(input_payload)
            except NexusValidationError as error:
                self._json(400, {"error": error.code, "detail": str(error)})
                return
            if not result["invariants"]["allHold"]:
                self._json(500, {"error": "NEXUS_INVARIANT_FAILURE", "result": result})
                return
            if existing:
                stored_receipt, stored_nexus = existing
                if stored_nexus.get("outputHash") != result["outputHash"]:
                    self._json(
                        500,
                        {
                            "error": "NEXUS_DETERMINISM_DIVERGENCE",
                            "requestId": request_id,
                            "storedOutputHash": stored_nexus.get("outputHash"),
                            "observedOutputHash": result["outputHash"],
                        },
                    )
                    return
                self._json(
                    200,
                    {
                        "schema": NEXUS_RUN_SCHEMA,
                        "replayed": True,
                        "requestId": request_id,
                        "result": result,
                        "governed": {
                            "pass": True,
                            "receipt": stored_receipt,
                            "sentra": preflight,
                        },
                    },
                )
                return
            receipt_payload = _compact_nexus_receipt(request_id, result)
            governed = runtime.run_cycle(actor, intent, {"nexus": receipt_payload})
            if not governed["pass"] or not governed["receipt"]:
                self._json(
                    409,
                    {
                        "error": "NEXUS_GOVERNANCE_REJECTED",
                        "computationPerformed": True,
                        "externalEffectPerformed": False,
                        "result": result,
                        "governed": governed,
                    },
                )
                return
            self._json(
                201,
                {
                    "schema": NEXUS_RUN_SCHEMA,
                    "replayed": False,
                    "requestId": request_id,
                    "result": result,
                    "governed": governed,
                },
            )
            return
        if path == "/api/sentra":
            rec = sentra_inspect(
                {
                    "actor": "immune:live-operator",
                    "intent": str(data.get("signal") or data.get("intent") or ""),
                },
                runtime.snapshot()["mode"],
            )
            cycle = runtime.run_cycle(
                "immune:live-operator",
                str(data.get("signal") or data.get("intent") or "sentra-admit"),
            )
            self._json(
                200,
                {
                    "ok": rec["accepted"],
                    "decision": "ALLOW" if rec["accepted"] else "BLOCKED",
                    "reason": rec["reason"],
                    "receipt": cycle.get("receipt"),
                    "sentra": rec,
                },
            )
            return
        if path == "/api/yawar":
            cycle = runtime.run_cycle(
                "immune:live-operator", str(data.get("event") or "yawar-append")
            )
            self._json(
                200,
                {
                    "ok": cycle["pass"],
                    "decision": "SEALED" if cycle["pass"] else "REFUSED",
                    "reason": cycle["sentra"]["reason"],
                    "receipt": cycle.get("receipt"),
                },
            )
            return
        if path in ("/api/bind", "/api/canary"):
            label = str(data.get("engine") or data.get("id") or path.rsplit("/", 1)[-1])
            cycle = runtime.run_cycle("immune:live-operator", f"{path} {label}")
            self._json(
                200,
                {
                    "ok": cycle["pass"],
                    "decision": "SEALED" if cycle["pass"] else "REFUSED",
                    "reason": cycle["sentra"]["reason"],
                    "receipt": cycle.get("receipt"),
                },
            )
            return
        self._json(404, {"error": "not found"})


def main() -> None:
    get_runtime()
    port = int(os.environ.get("PORT", "7860"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"immune python kernel listening 0.0.0.0:{port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
