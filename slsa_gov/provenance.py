"""SLSA v1.0-shaped provenance records with fail-closed validation (propose-only).

PASS_STRUCTURAL means digests and fields are well-formed - it is
structural validation only, explicitly NOT verification, NOT
signature validation, and NOT SLSA level certification. Any record embedding SIGNED or VERIFIED claims is rejected
fail-closed: a broken oracle is a fault, not a pass, and self-asserted
signing is provenance laundering. Signature binding is OWNER_GATED and
never claimed in this module: the stdlib offers no signature verification
and the estate signing mint is the only path to verified provenance.

Propose-only, unsigned; merges are owned by the estate signature wall.
No status claims are made about any other pull request.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
FORBIDDEN_CLAIM_TOKENS = ("SIGNED", "VERIFIED")

PASS_STRUCTURAL = "PASS_STRUCTURAL"
REJECTED = "REJECTED"


class ProvenanceError(ValueError):
    """A provenance structure is malformed."""


@dataclass
class Material:
    """A digest-pinned build input."""

    name: str
    sha256: str

    def __post_init__(self):
        if not self.name or not isinstance(self.name, str):
            raise ProvenanceError("material name must be a non-empty string")
        if not SHA256_RE.match(self.sha256 or ""):
            raise ProvenanceError("material %r must pin a 64-hex sha256 digest" % self.name)


@dataclass
class BuildDefinition:
    builder: str
    build_type: str
    materials: List[Material]

    def __post_init__(self):
        if not self.builder or not isinstance(self.builder, str):
            raise ProvenanceError("builder must be a non-empty string")
        if not self.build_type or not isinstance(self.build_type, str):
            raise ProvenanceError("build_type must be a non-empty string")
        if not self.materials:
            raise ProvenanceError("at least one digest-pinned material is required")
        for m in self.materials:
            if not isinstance(m, Material):
                raise ProvenanceError("materials must be Material instances")


@dataclass
class BuildRun:
    environment: str
    started_ts: float
    finished_ts: float

    def __post_init__(self):
        if not self.environment or not isinstance(self.environment, str):
            raise ProvenanceError("environment must be a non-empty string")
        if self.started_ts < 0 or self.finished_ts < self.started_ts:
            raise ProvenanceError("run timestamps must satisfy 0 <= started <= finished")


@dataclass
class ProvenanceRecord:
    definition: BuildDefinition
    run: BuildRun
    claims: Dict[str, object] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "status": "PROPOSAL_UNSIGNED",
            "signature_binding": "OWNER_GATED",
            "claims": dict(self.claims),
            "definition": {
                "builder": self.definition.builder,
                "build_type": self.definition.build_type,
                "materials": [{"name": m.name, "sha256": m.sha256} for m in self.definition.materials],
            },
            "run": {"environment": self.run.environment, "started_ts": self.run.started_ts,
                    "finished_ts": self.run.finished_ts},
        }


@dataclass
class ValVerdict:
    result: str
    reason: str

    def as_dict(self) -> dict:
        return {"result": self.result, "reason": self.reason}


def validate_record(record) -> ValVerdict:
    """Structural validation fail-closed on from the start.

    - wrong type or malformed structure -> raises (caller fail-closes)
    - claims containing SIGNED/VERIFIED tokens -> REJECTED (no exceptions,
      self-asserted trust is never accepted)
    - otherwise -> PASS_STRUCTURAL (explicitly NOT verification)
    """
    if not isinstance(record, ProvenanceRecord):
        raise ProvenanceError("validate_record requires a ProvenanceRecord")
    for key, value in (record.claims or {}).items():
        blob = "%s %r" % (key, value)
        for token in FORBIDDEN_CLAIM_TOKENS:
            if token in blob.upper():
                return ValVerdict(REJECTED,
                                  "claim %r embeds %s: self-asserted trust rejected fail-closed; "
                                  "signature binding is OWNER_GATED (estate signing mint)" % (key, token))
    return ValVerdict(PASS_STRUCTURAL,
                      "structural validation only - NOT verification; record is PROPOSAL_UNSIGNED")
