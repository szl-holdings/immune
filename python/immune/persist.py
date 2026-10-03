"""Receipt-signing Ed25519 key and local runtime bundle."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
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
    """Persisted state exists but cannot be loaded; never bootstrap over it."""


class BundleSaveError(RuntimeError):
    """The runtime bundle was not committed to persistent storage."""


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Reject ambiguous persisted objects at every nesting level."""
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def load_bundle() -> dict[str, Any] | None:
    try:
        path = data_dir() / "runtime.json"
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError):
        raise BundleLoadError("RUNTIME_BUNDLE_LOAD_FAILED") from None
    try:
        restored = json.loads(raw, object_pairs_hook=_unique_json_object)
    except (ValueError, RecursionError):
        raise BundleLoadError("RUNTIME_BUNDLE_LOAD_FAILED") from None
    if not isinstance(restored, dict):
        raise BundleLoadError("RUNTIME_BUNDLE_SHAPE_INVALID")
    return restored


def save_bundle(bundle: dict[str, Any]) -> None:
    path = data_dir() / "runtime.json"
    pending: str | None = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", prefix=".runtime-", suffix=".tmp",
            dir=path.parent, delete=False,
        ) as stream:
            pending = stream.name
            stream.write(json.dumps(bundle))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
        pending = None
    except OSError:
        raise BundleSaveError("RUNTIME_BUNDLE_PERSIST_FAILED") from None
    finally:
        if pending is not None:
            try:
                os.unlink(pending)
            except OSError:
                pass
