"""IMMUNE Python kernel — aligned with src/lib/immune (Doctrine v11)."""

from .canonical import canonical_bytes, hash_canonical, sha256_hex
from .huklla import HUKLLA_REGISTRY, evaluate_tripwires
from .mesh import mesh_from_surfaces
from .runtime import ImmuneRuntime, get_runtime
from .sentra import list_sentra_signatures, sentra_inspect

__all__ = [
    "ImmuneRuntime",
    "canonical_bytes",
    "evaluate_tripwires",
    "get_runtime",
    "hash_canonical",
    "HUKLLA_REGISTRY",
    "list_sentra_signatures",
    "mesh_from_surfaces",
    "sentra_inspect",
    "sha256_hex",
]
