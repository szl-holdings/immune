"""Canonical JSON + SHA-256. Matches src/lib/immune/canonical.ts."""

from __future__ import annotations

import hashlib
import json
from typing import Any

MAX_DEPTH = 32
MAX_BYTES = 1_048_576
MAX_FIELD_LEN = 65_536


class CanonicalError(ValueError):
    pass


def _canonicalize(value: Any, path: str, depth: int) -> Any:
    if depth > MAX_DEPTH:
        raise CanonicalError(f"max depth {MAX_DEPTH} exceeded at {path}")
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 2**53 - 1:
            raise CanonicalError(f"unsafe number at {path}: {value}")
        return value
    if isinstance(value, float):
        raise CanonicalError(f"unsafe number at {path}: {value}")
    if isinstance(value, str):
        if len(value) > MAX_FIELD_LEN:
            raise CanonicalError(f"string too long at {path}")
        return value
    if isinstance(value, list):
        return [_canonicalize(item, f"{path}[{i}]", depth + 1) for i, item in enumerate(value)]
    if isinstance(value, dict):
        out = {}
        for key in sorted(value.keys()):
            out[str(key)] = _canonicalize(value[key], f"{path}.{key}", depth + 1)
        return out
    raise CanonicalError(f"unsupported type {type(value).__name__} at {path}")


def canonical_bytes(payload: Any) -> bytes:
    blob = json.dumps(_canonicalize(payload, "$", 0), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(blob) > MAX_BYTES:
        raise CanonicalError(f"payload exceeds {MAX_BYTES} bytes")
    return blob


def sha256_hex(buf: bytes | str) -> str:
    data = buf.encode("utf-8") if isinstance(buf, str) else buf
    return hashlib.sha256(data).hexdigest()


def hash_canonical(payload: Any) -> tuple[str, bytes]:
    blob = canonical_bytes(payload)
    return sha256_hex(blob), blob
