"""Read-only IMMUNE compatibility runtime; no privileged action authority."""

from __future__ import annotations

import base64
import threading
from datetime import datetime, timezone
from typing import Any

from .canonical import canonical_bytes, sha256_hex
from .huklla import evaluate_tripwires
from .persist import BundleLoadError, load_bundle, load_receipt_key, save_bundle
from .sentra import sentra_inspect

ACTION_ENVELOPE_VERSION = "immune.action.v2"

_RUNTIME: ImmuneRuntime | None = None
_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class ImmuneRuntime:
    def __init__(self) -> None:
        keys = load_receipt_key()
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
        self.ledger_load_failed = False
        self.booted = False

    def _sign(self, blob: bytes) -> str:
        if self.private_key is None:
            raise RuntimeError("RECEIPT_SIGNER_UNCONFIGURED")
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
        try:
            restored = load_bundle()
        except BundleLoadError:
            self.ledger_load_failed = True
            return
        if isinstance(restored, dict):
            # Historical public receipts remain readable across signer changes.
            # Never restore the legacy privileged state or authority receipts.
            ledger = restored.get("ledger")
            evidence = restored.get("evidence")
            if not isinstance(ledger, list):
                self.ledger_load_failed = True
                return
            self.ledger = ledger
            self.evidence = evidence if isinstance(evidence, list) else []

    def maybe_refresh(self) -> None:
        self.boot()

    def apply_action(self, action: dict[str, Any], actor: str) -> dict[str, Any]:
        del action, actor
        raise PermissionError(
            "EXTERNAL_ACTION_REQUIRED: Python compatibility kernel has no action private key; "
            "use the source-bound external operator against SZLHOLDINGS/immune"
        )

    def project(self) -> dict[str, Any]:
        authority = {
            "enabled": False,
            "version": ACTION_ENVELOPE_VERSION,
            "keyId": None,
            "audience": "hf-space:SZLHOLDINGS/immune",
            "source": {
                "repository": "szl-holdings/immune",
                "revision": None,
            },
            "externalOperator": True,
        }
        return {
            **self.state,
            "evidenceState": "UNAVAILABLE",
            "reason": "external v2 action authority is served only by the canonical TypeScript runtime",
            "validUntil": None,
            "authorityReceiptCount": 0,
            "authorityReceiptHash": None,
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
        authority_ready = (
            auth["evidenceState"] == "VERIFIED"
            and auth["mode"] == "PASS"
            and not auth["deadman"]
        )
        blockers: list[str] = []
        if not ledger["ok"]:
            blockers.append("RECEIPT_LEDGER_INTEGRITY_FAILED")
        elif ledger["count"] == 0:
            blockers.append("RECEIPT_LEDGER_EMPTY")
        if auth["evidenceState"] != "VERIFIED":
            blockers.append(f"ACTION_AUTHORITY_{auth['evidenceState']}")
        if auth["deadman"]:
            blockers.append("ACTION_AUTHORITY_DEADMAN")
        if auth["mode"] != "PASS" and auth["evidenceState"] == "VERIFIED":
            blockers.append(f"ACTION_AUTHORITY_{auth['mode']}")
        write_ready = runtime_ready and authority_ready
        return {
            "schema": "szl.immune-readiness/v1",
            "status": "READY"
            if write_ready
            else ("READ_ONLY" if runtime_ready else "NOT_READY"),
            "ready": write_ready,
            "runtime_ready": runtime_ready,
            "read_ready": runtime_ready,
            "authority_ready": authority_ready,
            "write_ready": write_ready,
            "blockers": blockers,
            "demo_operator": False,
            "live_operator": False,
            "external_operator": True,
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
        }
        if self.private_key is not None:
            receipt.update(
                {
                    "alg": "ed25519",
                    "sig": self._sign(blob),
                    "pub": self.public_key_b64,
                    "kid": self.key_id,
                }
            )
        self.ledger.append(receipt)
        self._persist()
        return receipt

    def verify_ledger(self) -> dict[str, Any]:
        if self.ledger_load_failed:
            return {
                "ok": False,
                "count": 0,
                "issues": [
                    {
                        "seq": None,
                        "kind": "load_failure",
                        "detail": "persisted receipt ledger is unreadable or malformed",
                    }
                ],
                "firstBadSeq": None,
            }
        issues: list[dict[str, Any]] = []
        prev_hash = "GENESIS"
        for i, entry in enumerate(self.ledger):
            expected = i + 1
            if entry.get("seq") != expected:
                issues.append(
                    {
                        "seq": entry.get("seq"),
                        "kind": "bad_sequence",
                        "detail": f"expected {expected}",
                    }
                )
            if entry.get("prevHash") != prev_hash:
                issues.append(
                    {
                        "seq": entry.get("seq"),
                        "kind": "bad_prev",
                        "detail": f"expected {prev_hash[:12]}",
                    }
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

    def run_cycle(
        self, actor: str, intent: str, extra: dict[str, Any] | None = None
    ) -> dict[str, Any]:
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
                "estate": "e7b04c982887ec1f",
                "poorest": "unmeasured",
                "energyClass": "UNAVAILABLE",
                "energy_j": None,
                "evidenceTier": "SOFTWARE_RECEIPT",
                "directive": "RELEASE",
                "claims": {"execution": "SOFTWARE", "identity": "MEASURED", "input": "MEASURED", "policy": "MEASURED"},
                "adjacent": ["TRACE", "AIREP", "R+2", "AIR", "SLSA", "PUNKGO"],
                "scope": "covers: SENTRA, YAWAR, HUKLLA, NEXUS organ · does-not-cover: TEE quotes, ATO, fold-38 · energy: UNAVAILABLE · tier: SOFTWARE_RECEIPT",
                "nexusOrgan": True,
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
        self.evidence.append(
            {"ts": _now_iso(), "cycleSeq": len(self.ledger), "fired": huklla}
        )
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
        return self.apply_action(
            {"type": "SET_MODE", "mode": mode, "tripwire": tripwire}, "external"
        )

    def reset(self) -> dict[str, Any]:
        return self.apply_action({"type": "RESET"}, "external")


def get_runtime() -> ImmuneRuntime:
    global _RUNTIME
    with _LOCK:
        if _RUNTIME is None:
            _RUNTIME = ImmuneRuntime()
            _RUNTIME.boot()
        return _RUNTIME
