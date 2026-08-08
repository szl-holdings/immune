"""Fail-closed restart contract for an exact Hugging Face Space revision."""

from __future__ import annotations

import re
from typing import Any


class RestartContractError(RuntimeError):
    """Raised before a restart when the governed target cannot be proven."""


_REPO_ID = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
_REVISION = re.compile(r"[0-9a-f]{40}")


def _stage_name(runtime: Any) -> str:
    stage = getattr(runtime, "stage", None)
    return str(getattr(stage, "value", stage))


def restart_if_paused(
    repo_id: str,
    expected_revision: str,
    token: str,
    *,
    api: Any | None = None,
) -> bool:
    """Restart only a paused Space still bound to the expected immutable revision."""

    if not _REPO_ID.fullmatch(repo_id):
        raise RestartContractError("invalid Hugging Face Space repository id")
    if not _REVISION.fullmatch(expected_revision):
        raise RestartContractError("expected revision must be an exact lowercase SHA")
    if not token:
        raise RestartContractError("HF_TOKEN is required to restart a paused Space")

    if api is None:
        from huggingface_hub import HfApi

        api = HfApi(token=token)

    info = api.space_info(repo_id)
    runtime = api.get_space_runtime(repo_id)
    stage = _stage_name(runtime)
    current_revision = str(getattr(info, "sha", ""))
    if current_revision != expected_revision:
        raise RestartContractError(
            "refusing to restart a Space that advanced after publication: "
            f"expected={expected_revision!r} current={current_revision!r}"
        )
    if stage != "PAUSED":
        print(
            "Space restart not required:",
            repo_id,
            expected_revision,
            stage,
        )
        return False

    restarted = api.restart_space(repo_id=repo_id, token=token)
    print(
        "Restart requested for exact paused Space:",
        repo_id,
        expected_revision,
        _stage_name(restarted),
    )
    return True
