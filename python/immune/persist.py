"""Live-operator Ed25519 key + runtime bundle. Matches src/lib/immune/persist.ts."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_der_private_key,
)

OPERATOR_ACTOR = "immune:live-operator"


def data_dir() -> Path:
    return Path(os.environ.get("IMMUNE_DATA_DIR") or Path.cwd() / "data" / "immune")


def _try_write(path: Path, body: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    except OSError:
        pass


def load_or_create_operator_key() -> dict[str, Any]:
    key_path = data_dir() / "operator.json"
    try:
        if key_path.exists():
            raw = json.loads(key_path.read_text(encoding="utf-8"))
            der = base64.b64decode(raw["pkcs8"])
            private_key = load_der_private_key(der, password=None)
            return {
                "privateKey": private_key,
                "publicKeyB64": raw["publicKeyB64"],
                "keyId": raw["keyId"],
            }
    except Exception:
        pass

    private_key = Ed25519PrivateKey.generate()
    public_raw = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    public_key_b64 = base64.b64encode(public_raw).decode("ascii")
    key_id = hashlib.sha256(public_raw).hexdigest()[:16]
    pkcs8 = private_key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())
    _try_write(
        key_path,
        json.dumps({"pkcs8": base64.b64encode(pkcs8).decode("ascii"), "publicKeyB64": public_key_b64, "keyId": key_id}),
    )
    return {"privateKey": private_key, "publicKeyB64": public_key_b64, "keyId": key_id}


def load_bundle() -> dict[str, Any] | None:
    try:
        path = data_dir() / "runtime.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def save_bundle(bundle: dict[str, Any]) -> None:
    _try_write(data_dir() / "runtime.json", json.dumps(bundle))
