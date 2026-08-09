"""Fail-closed Hugging Face Space operational-state classification."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


class SpaceOperationalBlocker(RuntimeError):
    """Raised when provider state makes exact runtime attestation impossible."""


_REVISION = re.compile(r"[0-9a-f]{40}")
_QUOTA = re.compile(r"\bquota\s+exceeded\b", re.IGNORECASE)


@dataclass(frozen=True)
class SpaceObservation:
    expected_revision: str
    observed_revision: str
    stage: str
    provider_error: str

    @property
    def revision_matches(self) -> bool:
        return self.observed_revision == self.expected_revision


def _clean_provider_error(value: Any) -> str:
    return " ".join(str(value or "").split())[:500]


def inspect_space_state(payload: Any, expected_revision: str) -> SpaceObservation:
    """Return truthful state or raise an immutable terminal blocker.

    Revision mismatch alone can be transient immediately after publication and
    remains visible through ``revision_matches``.  A paused runtime or an
    explicit provider quota error cannot converge without a separate external
    state change, so those states terminate the deployment immediately.  This
    function performs no provider mutation.
    """

    if not _REVISION.fullmatch(expected_revision):
        raise SpaceOperationalBlocker(
            "HF_SPACE_STATE_INVALID: expected revision is not an exact SHA"
        )
    if not isinstance(payload, dict):
        raise SpaceOperationalBlocker(
            "HF_SPACE_STATE_INVALID: provider payload is not an object"
        )
    runtime = payload.get("runtime")
    if not isinstance(runtime, dict):
        raise SpaceOperationalBlocker(
            "HF_SPACE_STATE_INVALID: provider runtime is unavailable"
        )

    observed_revision = str(payload.get("sha") or "")
    stage = str(runtime.get("stage") or "")
    provider_error = _clean_provider_error(runtime.get("errorMessage"))
    if not _REVISION.fullmatch(observed_revision) or not stage:
        raise SpaceOperationalBlocker(
            "HF_SPACE_STATE_INVALID: provider revision or stage is unavailable"
        )

    observation = SpaceObservation(
        expected_revision=expected_revision,
        observed_revision=observed_revision,
        stage=stage,
        provider_error=provider_error,
    )
    detail = (
        f"expected={expected_revision} observed={observed_revision} "
        f"stage={stage} provider_error={provider_error or '<none>'}"
    )
    if _QUOTA.search(provider_error):
        raise SpaceOperationalBlocker(f"HF_SPACE_QUOTA_EXCEEDED: {detail}")
    if stage == "PAUSED":
        raise SpaceOperationalBlocker(f"HF_SPACE_PAUSED: {detail}")
    return observation
