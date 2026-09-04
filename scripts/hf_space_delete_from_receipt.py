#!/usr/bin/env python3
"""Delete exactly the verified non-flagship Hugging Face Spaces.

The mutation boundary is bound to an immutable pre-delete receipt stored at a
specific revision of betterwithage/szl-command-centre. The transaction refuses
new Spaces, changed source revisions, protected-name overlap, unhealthy public
copies, or the wrong authenticated identity. It is safely resumable if a Hub
API interruption occurs after some approved victims have already been removed.
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download

ORG = "SZLHOLDINGS"
PROFILE = "betterwithage"
COMMAND_REPO = f"{PROFILE}/szl-command-centre"
PREDELETE_REVISION = "a98ce6b66987a4e4dbd1d132936a8e03feedcde2"
PREDELETE_FILENAME = "HF_SPACE_CONSOLIDATION_PREDELETE_RECEIPT.json"
FINAL_FILENAME = "HF_SPACE_CONSOLIDATION_FINAL_RECEIPT.json"
EXPECTED_VICTIM_COUNT = 49
PROTECTED = {
    "README",
    "a11oy",
    "aegis-assurance",
    "counsel",
    "finance",
    "killinchu",
    "lyte",
    "sentra",
    "terra",
    "vertical-services",
    "vessels",
}
EXPECTED_CREATIVE = {
    "betterwithage/anatomy",
    "betterwithage/cosmos",
    "betterwithage/holographic",
    "betterwithage/szl-atelier",
    "betterwithage/yarqa",
}

TOKEN = os.environ["HF_TOKEN"]
api = HfApi(token=TOKEN)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stage_name(runtime: object) -> str:
    value = getattr(runtime, "stage", None)
    return str(getattr(value, "value", value) or "UNKNOWN").upper()


def current_spaces() -> dict[str, object]:
    return {
        item.id.split("/", 1)[1]: item
        for item in api.list_spaces(author=ORG, full=True)
    }


def require_public_running(repo_id: str) -> str:
    info = api.repo_info(repo_id=repo_id, repo_type="space")
    if bool(getattr(info, "private", False)):
        raise RuntimeError(f"required destination is private: {repo_id}")
    revision = str(getattr(info, "sha", "") or "")
    if len(revision) != 40:
        raise RuntimeError(f"required destination lacks exact revision: {repo_id}")
    stage = stage_name(api.get_space_runtime(repo_id=repo_id))
    if stage != "RUNNING":
        raise RuntimeError(f"required destination is not RUNNING: {repo_id}={stage}")
    return revision


def get_json(url: str, timeout: int = 25) -> dict:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "szl-hf-receipt-delete/1.0"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"unexpected HTTP {response.status} from {url}")
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise RuntimeError(f"non-object JSON from {url}")
    return payload


def verify_anatomy_live(expected_hf_revision: str) -> dict:
    base = "https://betterwithage-anatomy.hf.space"
    health = get_json(base + "/healthz")
    version = get_json(base + "/version?refresh=1")
    source = get_json(base + "/.well-known/szl-source.json?refresh=1")
    brain = get_json(base + "/api/anatomy/v1/brain/health?refresh=1")
    if health.get("transport_state") != "REACHABLE":
        raise RuntimeError("Living Anatomy transport is not REACHABLE")
    if brain.get("ready") is not True or brain.get("chunk_count") != 575:
        raise RuntimeError("Living Anatomy public Second Brain contract is not ready")
    if brain.get("private_graph_nodes_loaded") != 0:
        raise RuntimeError("Living Anatomy exposed private Second Brain nodes")
    if brain.get("content_access") != "HANDLES_ONLY":
        raise RuntimeError("Living Anatomy Second Brain is not handles-only")
    if version.get("deploymentRevision") != expected_hf_revision:
        raise RuntimeError("Living Anatomy runtime revision does not match Hub revision")
    git_sha = str(version.get("gitSha") or "")
    brain_sha = str(version.get("secondBrainSourceRevision") or "")
    if len(git_sha) != 40 or len(brain_sha) != 40:
        raise RuntimeError("Living Anatomy lacks exact source-bound revisions")
    deployment = source.get("deployment") or {}
    source_block = source.get("source") or {}
    if deployment.get("hf_revision") != expected_hf_revision:
        raise RuntimeError("Living Anatomy source receipt has the wrong Hub revision")
    if source_block.get("commit") != git_sha:
        raise RuntimeError("Living Anatomy source receipt has the wrong Git revision")
    return {
        "hub_revision": expected_hf_revision,
        "git_revision": git_sha,
        "second_brain_revision": brain_sha,
        "chunk_count": 575,
        "content_access": "HANDLES_ONLY",
    }


def load_predelete_receipt() -> tuple[dict, Path]:
    path = Path(
        hf_hub_download(
            repo_id=COMMAND_REPO,
            repo_type="space",
            filename=PREDELETE_FILENAME,
            revision=PREDELETE_REVISION,
            token=TOKEN,
            force_download=True,
        )
    )
    receipt = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(receipt, dict):
        raise RuntimeError("pre-delete receipt is not a JSON object")
    return receipt, path


def validate_receipt(receipt: dict) -> tuple[set[str], dict[str, str], set[str]]:
    required = {
        "schema": "szl.hf-space-consolidation.predelete.v3",
        "status": "PRESERVED_AND_READY_FOR_EXACT_DELETE",
        "mode": "PRESERVE_AND_VERIFY_ONLY",
        "organization": ORG,
        "profile": PROFILE,
    }
    for key, expected in required.items():
        if receipt.get(key) != expected:
            raise RuntimeError(
                f"pre-delete receipt {key} mismatch: {receipt.get(key)!r} != {expected!r}"
            )

    victims_list = receipt.get("victims")
    if not isinstance(victims_list, list) or len(victims_list) != EXPECTED_VICTIM_COUNT:
        raise RuntimeError("pre-delete receipt does not contain exactly 49 victims")
    victims = set(victims_list)
    if len(victims) != EXPECTED_VICTIM_COUNT:
        raise RuntimeError("pre-delete receipt contains duplicate victims")
    if any(not item.startswith(ORG + "/") for item in victims):
        raise RuntimeError("pre-delete receipt contains a victim outside SZLHOLDINGS")
    victim_names = {item.split("/", 1)[1] for item in victims}
    if victim_names & PROTECTED:
        raise RuntimeError(
            f"pre-delete receipt overlaps protected names: {sorted(victim_names & PROTECTED)}"
        )

    expected_revisions = receipt.get("expected_source_revisions")
    if not isinstance(expected_revisions, dict) or set(expected_revisions) != victims:
        raise RuntimeError("pre-delete source revision map does not exactly match victims")
    for repo_id, revision in expected_revisions.items():
        if not isinstance(revision, str) or len(revision) != 40:
            raise RuntimeError(f"invalid source revision for {repo_id}: {revision!r}")

    remaining_list = receipt.get("remaining_org_spaces")
    if not isinstance(remaining_list, list):
        raise RuntimeError("pre-delete receipt lacks remaining_org_spaces")
    receipt_names = set(remaining_list)
    if len(receipt_names) != len(remaining_list):
        raise RuntimeError("pre-delete receipt contains duplicate org Space names")
    if receipt_names != PROTECTED | victim_names:
        raise RuntimeError("pre-delete org inventory is not protected plus exact victims")

    creative = {
        item.get("destination")
        for item in receipt.get("creative", [])
        if isinstance(item, dict) and isinstance(item.get("destination"), str)
    }
    if not EXPECTED_CREATIVE <= creative:
        raise RuntimeError(
            f"pre-delete receipt lacks required creative destinations: "
            f"{sorted(EXPECTED_CREATIVE - creative)}"
        )
    return victims, expected_revisions, receipt_names


def upload_and_verify_final_receipt(receipt: dict) -> str:
    local = Path("/tmp/HF_SPACE_CONSOLIDATION_FINAL_RECEIPT.json")
    local.write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    local_hash = sha256(local)
    commit = api.upload_file(
        repo_id=COMMAND_REPO,
        repo_type="space",
        path_or_fileobj=str(local),
        path_in_repo=FINAL_FILENAME,
        commit_message="Publish final verified SZL organization Space deletion receipt",
    )
    revision = str(commit.oid)
    if len(revision) != 40:
        raise RuntimeError(f"final receipt upload returned invalid revision: {revision!r}")
    remote = Path(
        hf_hub_download(
            repo_id=COMMAND_REPO,
            repo_type="space",
            filename=FINAL_FILENAME,
            revision=revision,
            token=TOKEN,
            force_download=True,
        )
    )
    if sha256(remote) != local_hash:
        raise RuntimeError("final deletion receipt failed remote SHA-256 read-back")
    return revision


def main() -> None:
    identity = api.whoami(token=TOKEN)
    identity_name = str(identity.get("name") or identity.get("fullname") or "")
    if identity_name.lower() != PROFILE:
        raise RuntimeError(
            f"wrong Hugging Face identity: expected {PROFILE}, got {identity_name!r}"
        )

    receipt, receipt_path = load_predelete_receipt()
    victims, expected_revisions, receipt_names = validate_receipt(receipt)
    victim_names = {item.split("/", 1)[1] for item in victims}

    destination_revisions = {
        COMMAND_REPO: require_public_running(COMMAND_REPO),
    }
    if destination_revisions[COMMAND_REPO] != PREDELETE_REVISION:
        raise RuntimeError(
            "Command Centre moved after the immutable pre-delete receipt; refusing deletion"
        )
    for repo_id in sorted(EXPECTED_CREATIVE):
        destination_revisions[repo_id] = require_public_running(repo_id)
    anatomy_evidence = verify_anatomy_live(
        destination_revisions["betterwithage/anatomy"]
    )

    before = current_spaces()
    current_names = set(before)
    if not PROTECTED <= current_names:
        raise RuntimeError(
            f"protected org Spaces are missing: {sorted(PROTECTED - current_names)}"
        )
    if not current_names <= receipt_names:
        raise RuntimeError(
            f"new org Spaces appeared after preservation: {sorted(current_names - receipt_names)}"
        )
    already_absent = sorted(victim_names - current_names)
    for name in sorted(victim_names & current_names):
        repo_id = f"{ORG}/{name}"
        actual_revision = str(getattr(before[name], "sha", "") or "")
        expected_revision = expected_revisions[repo_id]
        if actual_revision != expected_revision:
            raise RuntimeError(
                f"source changed after preservation: {repo_id} "
                f"{expected_revision} -> {actual_revision}"
            )

    deleted_now: list[str] = []
    for repo_id in sorted(victims):
        name = repo_id.split("/", 1)[1]
        if name not in before:
            print(f"ALREADY ABSENT {repo_id}", flush=True)
            continue
        api.delete_repo(repo_id=repo_id, repo_type="space", missing_ok=False)
        deleted_now.append(repo_id)
        print(f"DELETED {repo_id}", flush=True)

    remaining = current_spaces()
    remaining_names = set(remaining)
    if remaining_names != PROTECTED:
        raise RuntimeError(
            f"postcondition failed: remaining={sorted(remaining_names)} "
            f"expected={sorted(PROTECTED)}"
        )

    completed_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    final = {
        "schema": "szl.hf-space-consolidation.final.v1",
        "status": "PASS",
        "completed_at": completed_at,
        "organization": ORG,
        "profile": PROFILE,
        "predelete_receipt": {
            "repo_id": COMMAND_REPO,
            "revision": PREDELETE_REVISION,
            "filename": PREDELETE_FILENAME,
            "sha256": sha256(receipt_path),
        },
        "deleted": sorted(victims),
        "deleted_now": deleted_now,
        "already_absent_on_resume": [f"{ORG}/{name}" for name in already_absent],
        "deleted_count": len(victims),
        "retained": [f"{ORG}/{name}" for name in sorted(PROTECTED)],
        "retained_count": len(PROTECTED),
        "creative_destinations": {
            repo_id: destination_revisions[repo_id]
            for repo_id in sorted(EXPECTED_CREATIVE)
        },
        "living_anatomy_evidence": anatomy_evidence,
        "command_centre_revision_before_final_receipt": PREDELETE_REVISION,
        "workflow_run_id": os.environ.get("GITHUB_RUN_ID", ""),
        "workflow_source_revision": os.environ.get("GITHUB_SHA", ""),
    }
    final_revision = upload_and_verify_final_receipt(final)
    final["final_receipt_revision"] = final_revision
    print(
        "FINAL DELETE RECEIPT "
        + json.dumps(
            {
                "status": "PASS",
                "deleted_count": len(victims),
                "retained": sorted(PROTECTED),
                "creative": sorted(EXPECTED_CREATIVE),
                "command_centre": COMMAND_REPO,
                "final_receipt_revision": final_revision,
            },
            sort_keys=True,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
