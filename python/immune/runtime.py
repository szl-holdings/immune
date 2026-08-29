"""Live IMMUNE runtime. Matches src/lib/immune/runtime.ts."""

from __future__ import annotations

import base64
import hashlib
import threading
import time
from datetime import datetime, timezone
from typing import Any

from .canonical import canonical_bytes, sha256_hex
from .huklla import evaluate_tripwires
from .persist import OPERATOR_ACTOR, load_bundle, load_or_create_operator_key, save_bundle
from .sentra import sentra_inspect

ACTION_ENVELOPE_VERSION = "immune.action.v1"
MAX_ACTION_LIFETIME_MS = 12 * 60_000
MAX_EVIDENCE_AGE_MS = 12 * 60_000
REFRESH_LEAD_MS = 90_000
HEARTBEAT_S = 40

_RUNTIME: ImmuneRuntime | None = None
_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _request_id(prefix: str) -> str:
    stamp = format(int(time.time() * 1000), "x")
    nonce = hashlib.sha256(f"{time.time_ns()}".encode()).hexdigest()[:8]
    return f"{prefix}-{stamp}-{nonce}"


class ImmuneRuntime:
    def __init__(self) -> None:
        keys = load_or_create_operator_key()
        self.private_key = keys["privateKey"]
        self.public_key_b64 = keys["publicKeyB64"]
        self.key_id = keys["keyId"]
        self.state: dict[str, Any] = {
            "mode": "SENTRA_REJECT",
            "tripwire": None,
            "deadman": False,
            "updatedAt": None,
            "requestId": None,
            "revision": 0,
        }
        self.authority_receipts: list[dict[str, Any]] = []
        self.ledger: list[dict[str, Any]] = []
        self.evidence: list[dict[str, Any]] = []
        self.booted = False
        self._heartbeat: threading.Timer | None = None

    def _sign(self, blob: bytes) -> str:
        return base64.b64encode(self.private_key.sign(blob)).decode("ascii")

    def _persist(self) -> None:
        save_bundle(
            {
                "keyId": self.key_id,
                "publicKeyB64": self.public_key_b64,
                "state": self.state,
                "authorityReceipts": self.authority_receipts,
                "ledger": self.ledger,
                "evidence": self.evidence,
            }
        )

    def boot(self) -> None:
        if self.booted:
            return
        self.booted = True
        restored = load_bundle()
        if restored and restored.get("keyId") == self.key_id and restored.get("ledger"):
            self.state = restored["state"]
            self.authority_receipts = restored.get("authorityReceipts") or []
            self.ledger = restored.get("ledger") or []
            self.evidence = restored.get("evidence") or []
        else:
            self.apply_action({"type": "SET_MODE", "mode": "PASS"}, OPERATOR_ACTOR)
            self.append_receipt(
                {
                    "actor": "immune:boot",
                    "intent": "seal live-operator genesis PASS",
                    "mode": "PASS",
                    "sentraAccepted": True,
                    "sentraSignature": "intent.required",
                    "authorityKeyId": self.key_id,
                    "authorityRevision": self.state["revision"],
                    "authorityRequestId": self.state.get("requestId") or "",
                    "authorityReceiptHash": (self.authority_receipts[-1]["receiptHash"] if self.authority_receipts else ""),
                    "agentJson": "",
                }
            )
        self._arm_heartbeat()

    def _arm_heartbeat(self) -> None:
        if self._heartbeat is not None:
            return

        def beat() -> None:
            try:
                self.maybe_refresh()
            except Exception:
                pass
            self._heartbeat = None
            self._arm_heartbeat()

        self._heartbeat = threading.Timer(HEARTBEAT_S, beat)
        self._heartbeat.daemon = True
        self._heartbeat.start()

    def _valid_until_ms(self) -> int:
        updated = self.state.get("updatedAt")
        if not updated:
            return 0
        try:
            updated_ms = int(datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return 0
        return min(updated_ms + MAX_EVIDENCE_AGE_MS, updated_ms + MAX_ACTION_LIFETIME_MS)

    def maybe_refresh(self) -> None:
        self.boot()
        if self.state.get("deadman"):
            return
        remaining = self._valid_until_ms() - _now_ms()
        if remaining > REFRESH_LEAD_MS:
            return
        mode = "PASS" if self.state.get("mode") == "DEADMAN" else self.state.get("mode") or "PASS"
        self.apply_action({"type": "SET_MODE", "mode": mode, "tripwire": None}, OPERATOR_ACTOR)

    def apply_action(self, action: dict[str, Any], actor: str) -> dict[str, Any]:
        self.boot()
        now = _now_ms()
        issued_at = _now_iso()
        expires_at = datetime.fromtimestamp((now + MAX_ACTION_LIFETIME_MS - 15_000) / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        unsigned = {
            "version": ACTION_ENVELOPE_VERSION,
            "requestId": _request_id("act"),
            "issuedAt": issued_at,
            "expiresAt": expires_at,
            "actor": actor,
            "keyId": self.key_id,
            "action": action,
        }
        blob = canonical_bytes(unsigned)
        envelope_digest = sha256_hex(blob)
        seq = len(self.authority_receipts) + 1
        previous_hash = self.authority_receipts[-1]["receiptHash"] if self.authority_receipts else "GENESIS"
        result = self._result_for(action, issued_at, unsigned["requestId"], seq)
        receipt_without_hash = {
            "seq": seq,
            "requestId": unsigned["requestId"],
            "envelopeDigest": envelope_digest,
            "previousHash": previous_hash,
            "issuedAt": issued_at,
            "appliedAt": issued_at,
            "actor": actor,
            "action": action,
            "result": result,
        }
        receipt_hash = sha256_hex(canonical_bytes(receipt_without_hash))
        self.authority_receipts.append({**receipt_without_hash, "receiptHash": receipt_hash})
        self.state = result
        self._persist()
        return self.project()

    def _result_for(self, action: dict[str, Any], issued_at: str, request_id: str, revision: int) -> dict[str, Any]:
        if action.get("type") == "RESET":
            return {
                "mode": "PASS",
                "tripwire": None,
                "deadman": False,
                "updatedAt": issued_at,
                "requestId": request_id,
                "revision": revision,
            }
        mode = action.get("mode") or "PASS"
        return {
            "mode": mode,
            "tripwire": action.get("tripwire") or "T07" if mode == "DEADMAN" else None,
            "deadman": mode == "DEADMAN",
            "updatedAt": issued_at,
            "requestId": request_id,
            "revision": revision,
        }

    def project(self) -> dict[str, Any]:
        latest = self.authority_receipts[-1] if self.authority_receipts else None
        authority = {
            "enabled": True,
            "version": ACTION_ENVELOPE_VERSION,
            "keyId": self.key_id,
            "demoOperator": False,
            "liveOperator": True,
        }
        if not latest or not self.state.get("updatedAt"):
            return {
                **self.state,
                "evidenceState": "UNAVAILABLE",
                "reason": "no verified signed action receipt exists",
                "validUntil": None,
                "authorityReceiptCount": 0,
                "authorityReceiptHash": None,
                "authority": authority,
            }
        valid_until = self._valid_until_ms()
        stale = valid_until <= _now_ms()
        return {
            **self.state,
            "evidenceState": "STALE" if stale else "VERIFIED",
            "reason": (
                "latest signed action receipt is outside its signed validity window"
                if stale
                else "signed live-operator action and receipt chain verified"
            ),
            "validUntil": datetime.fromtimestamp(valid_until / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            "authorityReceiptCount": len(self.authority_receipts),
            "authorityReceiptHash": latest["receiptHash"],
            "authority": authority,
        }

    def snapshot(self) -> dict[str, Any]:
        self.maybe_refresh()
        return self.project()

    def readiness(self) -> dict[str, Any]:
        self.maybe_refresh()
        auth = self.project()
        ledger = self.verify_ledger()
        runtime_ready = bool(ledger["ok"] and ledger["count"] > 0)
        authority_ready = auth["evidenceState"] == "VERIFIED" and auth["mode"] == "PASS" and not auth["deadman"]
        blockers: list[str] = []
        if not runtime_ready:
            blockers.append("RECEIPT_LEDGER_INTEGRITY_FAILED")
        if auth["evidenceState"] != "VERIFIED":
            blockers.append(f"ACTION_AUTHORITY_{auth['evidenceState']}")
        if auth["deadman"]:
            blockers.append("ACTION_AUTHORITY_DEADMAN")
        if auth["mode"] != "PASS" and auth["evidenceState"] == "VERIFIED":
            blockers.append(f"ACTION_AUTHORITY_{auth['mode']}")
        write_ready = runtime_ready and authority_ready
        return {
            "schema": "szl.immune-readiness/v1",
            "status": "READY" if write_ready else ("READ_ONLY" if runtime_ready else "NOT_READY"),
            "ready": write_ready,
            "runtime_ready": runtime_ready,
            "read_ready": runtime_ready,
            "authority_ready": authority_ready,
            "write_ready": write_ready,
            "blockers": blockers,
            "demo_operator": False,
            "live_operator": True,
        }

    def append_receipt(self, payload: dict[str, Any]) -> dict[str, Any]:
        seq = len(self.ledger) + 1
        prev_hash = self.ledger[-1]["hash"] if self.ledger else "GENESIS"
        ts = _now_iso()
        hashed_view = {"seq": seq, "ts": ts, "prevHash": prev_hash, "payload": payload}
        blob = canonical_bytes(hashed_view)
        digest = sha256_hex(blob)
        receipt = {
            "seq": seq,
            "ts": ts,
            "prevHash": prev_hash,
            "hash": digest,
            "payload": payload,
            "alg": "ed25519",
            "sig": self._sign(blob),
            "pub": self.public_key_b64,
            "kid": self.key_id,
        }
        self.ledger.append(receipt)
        self._persist()
        return receipt

    def verify_ledger(self) -> dict[str, Any]:
        issues: list[dict[str, Any]] = []
        prev_hash = "GENESIS"
        for i, entry in enumerate(self.ledger):
            expected = i + 1
            if entry.get("seq") != expected:
                issues.append({"seq": entry.get("seq"), "kind": "bad_sequence", "detail": f"expected {expected}"})
            if entry.get("prevHash") != prev_hash:
                issues.append(
                    {"seq": entry.get("seq"), "kind": "bad_prev", "detail": f"expected {prev_hash[:12]}"}
                )
            recomputed = sha256_hex(
                canonical_bytes(
                    {
                        "seq": entry["seq"],
                        "ts": entry["ts"],
                        "prevHash": entry["prevHash"],
                        "payload": entry["payload"],
                    }
                )
            )
            if recomputed != entry.get("hash"):
                issues.append(
                    {
                        "seq": entry.get("seq"),
                        "kind": "bad_hash",
                        "detail": f"stored {str(entry.get('hash'))[:12]} recomputed {recomputed[:12]}",
                    }
                )
            prev_hash = entry.get("hash") or prev_hash
        return {
            "ok": len(issues) == 0,
            "count": len(self.ledger),
            "issues": issues,
            "firstBadSeq": issues[0]["seq"] if issues else None,
        }

    def latest(self, limit: int = 25) -> list[dict[str, Any]]:
        return list(reversed(self.ledger[-limit:]))

    def evidence_latest(self, limit: int = 25) -> list[dict[str, Any]]:
        return list(reversed(self.evidence[-limit:]))

    def ledger_count(self) -> int:
        return len(self.ledger)

    def last_hash(self) -> str | None:
        return self.ledger[-1]["hash"] if self.ledger else None

    def run_cycle(self, actor: str, intent: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        self.maybe_refresh()
        ready = self.readiness()
        auth = self.project()
        inspected: dict[str, Any] = {"actor": actor, "intent": intent}
        if extra:
            inspected["agent"] = extra
        sentra = sentra_inspect(inspected, auth["mode"])
        receipt = None
        payload_bytes = 0
        passed = False
        if not auth["deadman"] and sentra["accepted"] and ready["write_ready"]:
            payload = {
                "actor": actor,
                "intent": intent,
                "mode": auth["mode"],
                "sentraAccepted": True,
                "sentraSignature": sentra.get("signatureMatched") or "intent.required",
                "authorityKeyId": self.key_id,
                "authorityRevision": auth["revision"],
                "authorityRequestId": auth.get("requestId") or "",
                "authorityReceiptHash": auth.get("authorityReceiptHash") or "",
                "agentJson": __import__("json").dumps(extra) if extra else "",
            }
            payload_bytes = len(canonical_bytes({"payload": payload}))
            receipt = self.append_receipt(payload)
            passed = True
        elif not ready["write_ready"] and sentra["accepted"] and not auth["deadman"]:
            sentra["accepted"] = False
            sentra["reason"] = f"write not ready: {', '.join(ready['blockers'])}"
            sentra["signatureMatched"] = "guard.write-readiness"

        huklla = evaluate_tripwires(
            {
                "mode": auth["mode"],
                "selectedTripwire": auth.get("tripwire"),
                "sentraAccepted": sentra["accepted"],
                "payloadBytes": payload_bytes,
                "receiptWritten": receipt is not None,
            }
        )
        self.evidence.append({"ts": _now_iso(), "cycleSeq": len(self.ledger), "fired": huklla})
        self._persist()
        return {
            "pass": passed,
            "mode": auth["mode"],
            "deadman": auth["deadman"],
            "sentra": sentra,
            "huklla": huklla,
            "receipt": receipt,
            "ledgerCount": len(self.ledger),
            "lastHash": self.last_hash(),
        }

    def set_mode(self, mode: str, tripwire: str | None = None) -> dict[str, Any]:
        if mode == "DEADMAN" and not tripwire:
            tripwire = "T07"
        if mode != "DEADMAN":
            tripwire = None
        return self.apply_action({"type": "SET_MODE", "mode": mode, "tripwire": tripwire}, OPERATOR_ACTOR)

    def reset(self) -> dict[str, Any]:
        return self.apply_action({"type": "RESET"}, OPERATOR_ACTOR)


def get_runtime() -> ImmuneRuntime:
    global _RUNTIME
    with _LOCK:
        if _RUNTIME is None:
            _RUNTIME = ImmuneRuntime()
            _RUNTIME.boot()
        return _RUNTIME
