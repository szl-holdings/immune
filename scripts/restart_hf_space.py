"""Explicit repository-level restart contract for a Hugging Face Space."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any


class RestartContractError(RuntimeError):
    """Raised before a restart when repository-level authority is incomplete."""


_REPO_ID = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")


@dataclass(frozen=True)
class RestartEvidence:
    """Non-secret observation of one explicitly authorized restart request."""

    repo_id: str
    restarted: bool
    before_revision: str
    before_stage: str
    after_revision: str
    after_stage: str

    def as_dict(self) -> dict[str, str | bool]:
        return asdict(self)


def _stage_name(runtime: Any) -> str:
    stage = getattr(runtime, "stage", None)
    return str(getattr(stage, "value", stage))


def restart_repository_space(
    repo_id: str,
    confirmation: str,
    token: str,
    *,
    api: Any | None = None,
) -> RestartEvidence:
    """Restart a paused Space under explicit repository-level authorization.

    Hugging Face exposes a repository-scoped restart mutation with no revision or
    stage precondition.  This helper therefore does not pretend that a preceding
    read can authorize an exact-revision mutation.  The caller must explicitly
    authorize restarting the repository as it exists at mutation time; exact
    source identity is verified separately after the restart.
    """

    if not _REPO_ID.fullmatch(repo_id):
        raise RestartContractError("invalid Hugging Face Space repository id")
    required_confirmation = f"restart repository {repo_id}"
    if confirmation != required_confirmation:
        raise RestartContractError(
            "repository-level restart confirmation must equal "
            f"{required_confirmation!r}"
        )
    if not token:
        raise RestartContractError("HF_TOKEN is required to restart a Space")

    if api is None:
        from huggingface_hub import HfApi

        api = HfApi(token=token)

    before_info = api.space_info(repo_id)
    before_runtime = api.get_space_runtime(repo_id)
    before_stage = _stage_name(before_runtime)
    before_revision = str(getattr(before_info, "sha", ""))
    if before_stage != "PAUSED":
        print(
            "Repository-level Space restart not required:",
            repo_id,
            before_revision,
            before_stage,
        )
        return RestartEvidence(
            repo_id=repo_id,
            restarted=False,
            before_revision=before_revision,
            before_stage=before_stage,
            after_revision=before_revision,
            after_stage=before_stage,
        )

    # This call is intentionally authorized for the repository, not for the
    # preceding revision/stage observation: the provider has no conditional
    # restart API.  A later exact-source attestation remains mandatory.
    api.restart_space(repo_id=repo_id, token=token)
    after_info = api.space_info(repo_id)
    after_runtime = api.get_space_runtime(repo_id)
    after_revision = str(getattr(after_info, "sha", ""))
    after_stage = _stage_name(after_runtime)
    print(
        "Repository-level Space restart requested:",
        repo_id,
        before_revision,
        before_stage,
        "->",
        after_revision,
        after_stage,
    )
    return RestartEvidence(
        repo_id=repo_id,
        restarted=True,
        before_revision=before_revision,
        before_stage=before_stage,
        after_revision=after_revision,
        after_stage=after_stage,
    )
