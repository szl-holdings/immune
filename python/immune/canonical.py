"""Canonical JSON + SHA-256. Matches src/lib/immune/canonical.ts."""

from __future__ import annotations

import hashlib
import json
import math
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


# ---------------------------------------------------------------------------
# szl.immune.canonical/v2 -- strict, versioned profile shared with
# server/routes/immune/canonical.ts (canonicalBytesV2). Legacy canonical_bytes
# above is frozen for existing records; v2 is for new records only.
# Shared vectors: contracts/immune-canonical-v2-vectors.json.
# ---------------------------------------------------------------------------

CANONICAL_V2_PROFILE = "szl.immune.canonical/v2"
_SAFE_INTEGER = 2**53 - 1


class CanonicalV2Error(CanonicalError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _v2_string(value: str, path: str, what: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise CanonicalV2Error("lone_surrogate", f"lone surrogate in {what} at {path}") from None
    # Length is counted in UTF-16 code units to match the TypeScript profile.
    if len(value.encode("utf-16-le")) // 2 > MAX_FIELD_LEN:
        raise CanonicalV2Error("too_long", f"{what} too long at {path}")
    return json.dumps(value, ensure_ascii=False)


def _v2_integer(value: int, path: str) -> str:
    if abs(value) > _SAFE_INTEGER:
        raise CanonicalV2Error("unsafe_integer", f"unsafe integer at {path}")
    return str(int(value))


def _v2_encode(value: Any, path: str, depth: int) -> str:
    if depth > MAX_DEPTH:
        raise CanonicalV2Error("depth", f"max depth {MAX_DEPTH} exceeded at {path}")
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return _v2_integer(value, path)
    if isinstance(value, float):
        # JSON numbers are values: 1.0 == 1 and -0.0 == 0, as in the JS number model.
        if not math.isfinite(value) or not value.is_integer():
            raise CanonicalV2Error("non_integer", f"non-integer number at {path}")
        return _v2_integer(int(value), path)
    if isinstance(value, str):
        return _v2_string(value, path, "string")
    if isinstance(value, list):
        return "[" + ",".join(_v2_encode(item, f"{path}[{i}]", depth + 1) for i, item in enumerate(value)) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise CanonicalV2Error("unsupported_type", f"non-string key at {path}")
            if key == "__proto__":
                raise CanonicalV2Error("proto_key", f"own __proto__ key rejected at {path}")
            _v2_string(key, path, "key")
        parts = []
        # UTF-16-BE byte order equals UTF-16 code unit order (the TS sort order).
        for key in sorted(value, key=lambda k: k.encode("utf-16-be")):
            parts.append(_v2_string(key, path, "key") + ":" + _v2_encode(value[key], f"{path}.{key}", depth + 1))
        return "{" + ",".join(parts) + "}"
    raise CanonicalV2Error("unsupported_type", f"unsupported type {type(value).__name__} at {path}")


def canonical_bytes_v2(payload: Any) -> bytes:
    blob = _v2_encode(payload, "$", 0).encode("utf-8")
    if len(blob) > MAX_BYTES:
        raise CanonicalV2Error("too_large", f"payload exceeds {MAX_BYTES} bytes")
    return blob


def hash_canonical_v2(payload: Any) -> tuple[str, bytes, str]:
    blob = canonical_bytes_v2(payload)
    return sha256_hex(blob), blob, CANONICAL_V2_PROFILE
