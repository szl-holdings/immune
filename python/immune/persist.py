"""Receipt-signing Ed25519 key and local runtime bundle."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
    load_der_private_key,
)


def data_dir() -> Path:
    return Path(os.environ.get("IMMUNE_DATA_DIR") or Path.cwd() / "data" / "immune")


def _try_write(path: Path, body: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    except OSError:
        pass


def load_receipt_key() -> dict[str, Any]:
    """Use only the existing YAWAR secret; never create or copy private keys."""
    absent = {"privateKey": None, "publicKeyB64": None, "keyId": None}
    configured = os.environ.get("IMMUNE_SIGNING_KEY")
    if not configured:
        return absent
    try:
        raw = base64.b64decode(configured, validate=True)
        private_key = (
            Ed25519PrivateKey.from_private_bytes(raw)
            if len(raw) == 32
            else load_der_private_key(raw, password=None)
        )
        if not isinstance(private_key, Ed25519PrivateKey):
            return absent
        public_raw = private_key.public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw
        )
        return {
            "privateKey": private_key,
            "publicKeyB64": base64.b64encode(public_raw).decode("ascii"),
            "keyId": hashlib.sha256(public_raw).hexdigest()[:16],
        }
    except (TypeError, ValueError, UnsupportedAlgorithm):
        return absent


class BundleLoadError(RuntimeError):
    """Persisted runtime state exists but cannot be trusted."""


def load_bundle() -> dict[str, Any] | None:
    path = data_dir() / "runtime.json"
    if not path.exists():
        return None
    try:
        bundle = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BundleLoadError("persisted runtime bundle is unreadable or malformed") from exc
    if not isinstance(bundle, dict):
        raise BundleLoadError("persisted runtime bundle must be a JSON object")
    return bundle


def save_bundle(bundle: dict[str, Any]) -> None:
    _try_write(data_dir() / "runtime.json", json.dumps(bundle))
