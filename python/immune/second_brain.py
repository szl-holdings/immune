"""Second-brain 575-handle navigator + MEASURED silhouette. Matches src/lib/immune/second-brain.ts."""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timezone
from typing import Any

PRODUCTS = (
    "immune", "anatomy", "a11oy", "killinchu", "hatun-mcp", "szl-khipu", "khipu-lab",
    "szl-mesh", "lean-kernel", "lutar-lean", "szl-lambda-gate", "governed-receipt-spec",
    "szl-formula-ledger", "szl-forge", "szl-serve", "szl-lake", "szl-second-brain",
    "nexus", "counsel", "szl-sovereign-os", "ouroboros", "evidence-doctrine", "szl-kernels",
)
AXES = (
    "admission", "receipts", "yawar", "sentra", "huklla", "quorum", "lambda", "lean",
    "energy", "telemetry", "mesh", "airgap", "dsse", "slsa", "provenance", "hologram",
    "training", "silhouette", "retrieval", "organ", "heart", "brain", "skeleton",
    "circulatory", "nervous",
)
ORGAN_OF_AXIS = {
    "admission": "heart", "receipts": "circulatory", "yawar": "circulatory", "sentra": "heart",
    "huklla": "heart", "quorum": "skeleton", "lambda": "heart", "lean": "brain",
    "energy": "nervous", "telemetry": "nervous", "mesh": "skeleton", "airgap": "skeleton",
    "dsse": "circulatory", "slsa": "circulatory", "provenance": "nervous", "hologram": "brain",
    "training": "brain", "silhouette": "brain", "retrieval": "brain", "organ": "heart",
    "heart": "heart", "brain": "brain", "skeleton": "skeleton", "circulatory": "circulatory",
    "nervous": "nervous",
}
ORGAN_INDEX = {"heart": 0, "brain": 1, "skeleton": 2, "circulatory": 3, "nervous": 4}
DIM = 48
STEPS = 48

_CHUNKS: list[dict[str, str]] | None = None
_SILHOUETTE: dict[str, Any] | None = None


def _fnv(s: str) -> int:
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def _tokenize(text: str) -> list[str]:
    out: list[str] = []
    buf = []
    for ch in text.lower():
        if ch.isalnum():
            buf.append(ch)
        else:
            if len(buf) > 1:
                out.append("".join(buf))
            buf = []
    if len(buf) > 1:
        out.append("".join(buf))
    return out


def _embed(text: str) -> list[float]:
    v = [0.0] * DIM
    for tok in _tokenize(text):
        v[_fnv(tok) % DIM] += 1.0
    n = sum(x * x for x in v)
    s = math.sqrt(n) if n > 0 else 1.0
    return [x / s for x in v]


def get_chunks() -> list[dict[str, str]]:
    global _CHUNKS
    if _CHUNKS is not None:
        return _CHUNKS
    chunks: list[dict[str, str]] = []
    for product in PRODUCTS:
        for axis in AXES:
            organ = ORGAN_OF_AXIS[axis]
            idx = len(chunks) + 1
            handle = f"{product}.{axis}"
            chunks.append(
                {
                    "id": f"c{idx:03d}",
                    "handle": handle,
                    "organ": organ,
                    "product": product,
                    "axis": axis,
                    "text": f"{handle} is a SOFTWARE navigator handle over the {organ} organ. {product} exposes {axis} under Doctrine v11.",
                }
            )
    if len(chunks) != 575:
        raise RuntimeError(f"second-brain corpus must be 575, got {len(chunks)}")
    _CHUNKS = chunks
    return chunks


def search_brain(query: str, limit: int = 6) -> list[dict[str, Any]]:
    q = query.strip().lower()
    if len(q) < 2:
        return []
    qv = _embed(q)
    hits: list[dict[str, Any]] = []
    for chunk in get_chunks():
        ev = _embed(f"{chunk['handle']} {chunk['text']}")
        dot = sum(qv[i] * ev[i] for i in range(DIM))
        lexical = 0.15 if q in chunk["handle"] or q in chunk["text"].lower() else 0.0
        hits.append(
            {
                "id": chunk["id"],
                "handle": chunk["handle"],
                "organ": chunk["organ"],
                "score": round(dot + lexical, 3),
                "excerpt": chunk["text"][:180],
            }
        )
    hits.sort(key=lambda h: h["score"], reverse=True)
    return hits[:limit]


def _softmax(logits: list[float]) -> list[float]:
    m = max(logits)
    ex = [math.exp(x - m) for x in logits]
    s = sum(ex) or 1.0
    return [x / s for x in ex]


def train_silhouette() -> dict[str, Any]:
    global _SILHOUETTE
    chunks = get_chunks()
    samples = [(_embed(f"{c['handle']} {c['axis']} {c['organ']}"), ORGAN_INDEX[c["organ"]]) for c in chunks]
    w = [[0.0] * DIM for _ in range(5)]
    b = [0.0] * 5
    lr = 0.35

    def loss_of() -> float:
        total = 0.0
        for x, y in samples:
            logits = [b[k] + sum(w[k][i] * x[i] for i in range(DIM)) for k in range(5)]
            p = _softmax(logits)
            total += -math.log(max(p[y], 1e-9))
        return total / len(samples)

    initial = loss_of()
    for _ in range(STEPS):
        for x, y in samples:
            logits = [b[k] + sum(w[k][i] * x[i] for i in range(DIM)) for k in range(5)]
            p = _softmax(logits)
            for k in range(5):
                g = p[k] - (1.0 if k == y else 0.0)
                b[k] -= lr * g
                for i in range(DIM):
                    w[k][i] -= lr * g * x[i]
    final = loss_of()
    correct = 0
    for x, y in samples:
        logits = [b[k] + sum(w[k][i] * x[i] for i in range(DIM)) for k in range(5)]
        arg = max(range(5), key=lambda k: logits[k])
        if arg == y:
            correct += 1
    weight_bytes = "|".join(",".join(f"{n:.6f}" for n in row) for row in w).encode("utf-8")
    _SILHOUETTE = {
        "schema": "szl.second-brain.silhouette/v1",
        "kind": "MEASURED_SOFTWARE_SILHOUETTE",
        "notKhipu15B": True,
        "chunks": len(chunks),
        "steps": STEPS,
        "dim": DIM,
        "classes": 5,
        "initialLoss": round(initial, 4),
        "finalLoss": round(final, 4),
        "accuracy": round(correct / len(samples), 4),
        "weightHash": hashlib.sha256(weight_bytes).hexdigest(),
        "trainedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "provenance": "LIVE",
    }
    return _SILHOUETTE


def ensure_trained() -> dict[str, Any]:
    return _SILHOUETTE if _SILHOUETTE is not None else train_silhouette()


def brain_status() -> dict[str, Any]:
    trained = ensure_trained()
    return {
        "chunks": len(get_chunks()),
        "kind": "SOFTWARE navigator · handles only",
        "trained": trained,
        "href": "https://github.com/szl-holdings/szl-second-brain",
    }
