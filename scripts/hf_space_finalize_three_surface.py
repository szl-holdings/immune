#!/usr/bin/env python3
"""Finalize the SZL Hugging Face portfolio into a three-surface topology.

The destructive boundary is bound to the immutable preservation receipt emitted
by the successful preservation run. The transaction is resumable and refuses to
proceed if a protected Space is missing, a source revision changed, the archive
is incomplete, the authenticated identity is wrong, or Living Anatomy is not
source-bound with its public Second Brain projection.

Final topology
--------------
SZLHOLDINGS organization:
  Flagships, verticals, shared vertical infrastructure, and the hidden README.

betterwithage migrated portfolio:
  1. anatomy             -- runnable creative experience
  2. cosmos              -- runnable creative experience
  3. szl-command-centre  -- searchable archive and launcher for everything else
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from huggingface_hub import CommitOperationAdd, HfApi, hf_hub_download

ORG = "SZLHOLDINGS"
PROFILE = "betterwithage"
COMMAND_REPO = f"{PROFILE}/szl-command-centre"
PREDELETE_REVISION = "74b9c82538b4516deeacd2b440ad821a687f6ab5"
PREDELETE_FILENAME = "HF_SPACE_CONSOLIDATION_PREDELETE_RECEIPT.json"
FINAL_RECEIPT_FILENAME = "HF_SPACE_CONSOLIDATION_FINAL_RECEIPT.json"
FINAL_TOPOLOGY_FILENAME = "HF_SPACE_TOPOLOGY.json"
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

PUBLIC_KEEP = {
    "betterwithage/anatomy",
    "betterwithage/cosmos",
    COMMAND_REPO,
}

PUBLIC_RETIRE = {
    "betterwithage/holographic",
    "betterwithage/szl-atelier",
    "betterwithage/yarqa",
}

EXPECTED_CREATIVE_IN_RECEIPT = {
    "betterwithage/anatomy",
    "betterwithage/cosmos",
    "betterwithage/holographic",
    "betterwithage/szl-atelier",
    "betterwithage/yarqa",
}

TOKEN = os.environ["HF_TOKEN"]
api = HfApi(token=TOKEN)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stage_name(runtime: object) -> str:
    value = getattr(runtime, "stage", None)
    return str(getattr(value, "value", value) or "UNKNOWN").upper()


def repo_info_optional(repo_id: str) -> object | None:
    try:
        return api.repo_info(repo_id=repo_id, repo_type="space")
    except Exception:
        return None


def list_spaces(author: str) -> dict[str, object]:
    return {
        item.id.split("/", 1)[1]: item
        for item in api.list_spaces(author=author, full=True)
    }


def ensure_public_running(
    repo_id: str,
    *,
    expected_revision: str | None = None,
    timeout_seconds: int = 900,
) -> str:
    deadline = time.monotonic() + timeout_seconds
    restarted = False
    last: tuple[str, str, bool] | None = None
    while time.monotonic() < deadline:
        info = api.repo_info(repo_id=repo_id, repo_type="space")
        revision = str(getattr(info, "sha", "") or "")
        private = bool(getattr(info, "private", False))
        stage = stage_name(api.get_space_runtime(repo_id=repo_id))
        last = (revision, stage, private)
        print(
            f"SURFACE {repo_id} sha={revision[:12]} stage={stage} private={private}",
            flush=True,
        )
        if private:
            raise RuntimeError(f"required public surface is private: {repo_id}")
        if len(revision) != 40:
            raise RuntimeError(f"required surface lacks an exact revision: {repo_id}")
        if expected_revision is not None and revision != expected_revision:
            raise RuntimeError(
                f"surface revision mismatch for {repo_id}: "
                f"expected {expected_revision}, observed {revision}"
            )
        if stage == "RUNNING":
            return revision
        if stage in {
            "PAUSED",
            "SLEEPING",
            "STOPPED",
            "RUNTIME_ERROR",
            "BUILD_ERROR",
            "CONFIG_ERROR",
        } and not restarted:
            api.restart_space(
                repo_id=repo_id,
                factory_reboot=stage
                in {"RUNTIME_ERROR", "BUILD_ERROR", "CONFIG_ERROR"},
            )
            restarted = True
        time.sleep(10)
    raise TimeoutError(f"{repo_id} did not become RUNNING: {last}")


def get_json(url: str, timeout: int = 25) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "szl-hf-three-surface-finalizer/1.0"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"unexpected HTTP {response.status} from {url}")
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise RuntimeError(f"non-object JSON from {url}")
    return payload


def load_hf_json(repo_id: str, filename: str, revision: str) -> tuple[dict, Path]:
    path = Path(
        hf_hub_download(
            repo_id=repo_id,
            repo_type="space",
            filename=filename,
            revision=revision,
            token=TOKEN,
            force_download=True,
        )
    )
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"{repo_id}/{filename} is not a JSON object")
    return payload, path


def validate_predelete_receipt(
    receipt: dict,
) -> tuple[set[str], dict[str, str], set[str], list[dict]]:
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
                f"pre-delete receipt {key} mismatch: "
                f"{receipt.get(key)!r} != {expected!r}"
            )

    victims_raw = receipt.get("victims")
    if not isinstance(victims_raw, list) or len(victims_raw) != EXPECTED_VICTIM_COUNT:
        raise RuntimeError("pre-delete receipt must contain exactly 49 victims")
    victims = set(victims_raw)
    if len(victims) != EXPECTED_VICTIM_COUNT:
        raise RuntimeError("pre-delete receipt contains duplicate victims")
    if any(not item.startswith(ORG + "/") for item in victims):
        raise RuntimeError("pre-delete receipt contains a victim outside SZLHOLDINGS")

    victim_names = {item.split("/", 1)[1] for item in victims}
    overlap = victim_names & PROTECTED
    if overlap:
        raise RuntimeError(f"receipt overlaps protected Spaces: {sorted(overlap)}")

    expected_revisions = receipt.get("expected_source_revisions")
    if not isinstance(expected_revisions, dict) or set(expected_revisions) != victims:
        raise RuntimeError("source-revision map does not exactly match the victim set")
    for repo_id, revision in expected_revisions.items():
        if (
            not isinstance(revision, str)
            or len(revision) != 40
            or any(character not in "0123456789abcdef" for character in revision.lower())
        ):
            raise RuntimeError(f"invalid frozen revision for {repo_id}: {revision!r}")

    remaining_raw = receipt.get("remaining_org_spaces")
    if not isinstance(remaining_raw, list):
        raise RuntimeError("pre-delete receipt lacks remaining_org_spaces")
    receipt_names = set(remaining_raw)
    if len(receipt_names) != len(remaining_raw):
        raise RuntimeError("pre-delete receipt contains duplicate org Space names")
    if receipt_names != PROTECTED | victim_names:
        raise RuntimeError("receipt inventory is not protected plus exact victims")

    creative = {
        item.get("destination")
        for item in receipt.get("creative", [])
        if isinstance(item, dict) and isinstance(item.get("destination"), str)
    }
    missing_creative = EXPECTED_CREATIVE_IN_RECEIPT - creative
    if missing_creative:
        raise RuntimeError(
            f"pre-delete receipt lacks creative destinations: {sorted(missing_creative)}"
        )

    consolidated = receipt.get("consolidated")
    if not isinstance(consolidated, list) or len(consolidated) != EXPECTED_VICTIM_COUNT:
        raise RuntimeError("pre-delete receipt must describe all 49 consolidated trees")
    sources = {
        item.get("source")
        for item in consolidated
        if isinstance(item, dict) and isinstance(item.get("source"), str)
    }
    if sources != victims:
        raise RuntimeError("consolidated source inventory does not match victims")
    prefixes = [
        item.get("archive_prefix")
        for item in consolidated
        if isinstance(item, dict)
    ]
    if any(not isinstance(prefix, str) or not prefix.startswith("archive/") for prefix in prefixes):
        raise RuntimeError("one or more consolidated trees lack a valid archive prefix")
    if len(set(prefixes)) != EXPECTED_VICTIM_COUNT:
        raise RuntimeError("archive prefixes are not unique")

    return victims, expected_revisions, receipt_names, consolidated


def verify_archive_tree(consolidated: list[dict]) -> dict[str, int]:
    files = api.list_repo_files(
        repo_id=COMMAND_REPO,
        repo_type="space",
        revision=PREDELETE_REVISION,
    )
    file_set = set(files)
    counts: dict[str, int] = {}
    for item in consolidated:
        source = str(item["source"])
        prefix = str(item["archive_prefix"]).rstrip("/") + "/"
        count = sum(path.startswith(prefix) for path in file_set)
        if count <= 0:
            raise RuntimeError(f"consolidated archive is empty for {source}: {prefix}")
        declared = int(item.get("file_count") or 0)
        if declared <= 0:
            raise RuntimeError(f"receipt declares an empty source tree for {source}")
        counts[source] = count
    print(
        f"ARCHIVE VERIFIED sources={len(counts)} files={len(file_set)}",
        flush=True,
    )
    return counts


def verify_anatomy_live(expected_hf_revision: str) -> dict[str, Any]:
    base = "https://betterwithage-anatomy.hf.space"
    health = get_json(base + "/healthz")
    version = get_json(base + "/version?refresh=1")
    source = get_json(base + "/.well-known/szl-source.json?refresh=1")
    brain = get_json(base + "/api/anatomy/v1/brain/health?refresh=1")
    search = get_json(
        base
        + "/api/anatomy/v1/brain/search"
        + "?q=governed%20receipts%20living%20anatomy&k=3"
    )

    if health.get("transport_state") != "REACHABLE":
        raise RuntimeError("Living Anatomy transport is not REACHABLE")
    if brain.get("ready") is not True or brain.get("chunk_count") != 575:
        raise RuntimeError("Living Anatomy public Second Brain is not ready at 575 chunks")
    if brain.get("private_graph_nodes_loaded") != 0:
        raise RuntimeError("Living Anatomy loaded private Second Brain graph nodes")
    if brain.get("content_access") != "HANDLES_ONLY":
        raise RuntimeError("Living Anatomy Second Brain is not handles-only")
    if search.get("ready") is not True or not search.get("handles"):
        raise RuntimeError("Living Anatomy Second Brain retrieval is not operational")
    if any("text" in handle for handle in search.get("handles", [])):
        raise RuntimeError("Living Anatomy search returned private/full text")
    if version.get("deploymentRevision") != expected_hf_revision:
        raise RuntimeError("Living Anatomy runtime revision does not match Hub revision")

    git_sha = str(version.get("gitSha") or "")
    brain_sha = str(version.get("secondBrainSourceRevision") or "")
    deployment = source.get("deployment") or {}
    source_block = source.get("source") or {}
    if len(git_sha) != 40 or len(brain_sha) != 40:
        raise RuntimeError("Living Anatomy lacks exact source-bound revisions")
    if deployment.get("hf_revision") != expected_hf_revision:
        raise RuntimeError("Living Anatomy source receipt has the wrong Hub revision")
    if source_block.get("commit") != git_sha:
        raise RuntimeError("Living Anatomy source receipt has the wrong Git revision")

    evidence = {
        "hub_revision": expected_hf_revision,
        "git_revision": git_sha,
        "second_brain_revision": brain_sha,
        "chunk_count": 575,
        "private_graph_nodes_loaded": 0,
        "content_access": "HANDLES_ONLY",
        "retrieval_handles": len(search.get("handles", [])),
    }
    print("LIVING ANATOMY VERIFIED " + json.dumps(evidence, sort_keys=True), flush=True)
    return evidence


def completed_receipt_if_valid() -> dict | None:
    try:
        receipt, _ = load_hf_json(COMMAND_REPO, FINAL_RECEIPT_FILENAME, "main")
    except Exception:
        return None
    if receipt.get("schema") != "szl.hf-space-consolidation.final.v2":
        return None
    if receipt.get("status") != "PASS":
        return None
    if set(receipt.get("retained_names", [])) != PROTECTED:
        return None
    if set(receipt.get("public_migrated_surfaces", [])) != PUBLIC_KEEP:
        return None
    return receipt


def verify_final_topology(*, stabilization_checks: int = 4) -> dict[str, Any]:
    observations = []
    for index in range(stabilization_checks):
        org_spaces = list_spaces(ORG)
        org_names = set(org_spaces)
        profile_spaces = list_spaces(PROFILE)
        profile_ids = {f"{PROFILE}/{name}" for name in profile_spaces}
        observation = {
            "check": index + 1,
            "org_names": sorted(org_names),
            "migrated_present": sorted(PUBLIC_KEEP & profile_ids),
            "retired_present": sorted(PUBLIC_RETIRE & profile_ids),
        }
        observations.append(observation)
        if org_names != PROTECTED:
            raise RuntimeError(
                f"organization postcondition failed: {sorted(org_names)} != "
                f"{sorted(PROTECTED)}"
            )
        if not PUBLIC_KEEP <= profile_ids:
            raise RuntimeError(
                f"public migrated surfaces missing: {sorted(PUBLIC_KEEP - profile_ids)}"
            )
        if PUBLIC_RETIRE & profile_ids:
            raise RuntimeError(
                f"retired standalone profile Spaces remain: "
                f"{sorted(PUBLIC_RETIRE & profile_ids)}"
            )
        if index + 1 < stabilization_checks:
            time.sleep(10)
    return {
        "checks": observations,
        "retained_org_names": sorted(PROTECTED),
        "migrated_public_surfaces": sorted(PUBLIC_KEEP),
        "retired_public_surfaces": sorted(PUBLIC_RETIRE),
    }


def build_readme() -> str:
    return """---
title: SZL Command Centre
emoji: 🛰️
colorFrom: gray
colorTo: indigo
sdk: static
app_file: index.html
pinned: true
license: apache-2.0
short_description: Three public surfaces; every experiment preserved
---

# SZL Command Centre

The public SZL experimental portfolio is intentionally limited to three migrated
surfaces: **Living Anatomy**, **Cosmos**, and this **Command Centre**.

The SZLHOLDINGS organization contains only flagships, operating verticals,
shared vertical infrastructure, and its hidden organization front door.
Everything removed from the organization is preserved under `archive/` at an
exact source revision with SHA-256 evidence in the preservation and final
receipts.

- `HF_SPACE_CONSOLIDATION_PREDELETE_RECEIPT.json` — immutable preservation set
- `HF_SPACE_CONSOLIDATION_FINAL_RECEIPT.json` — completed deletion receipt
- `HF_SPACE_TOPOLOGY.json` — machine-readable final topology
- `manifest.json` — original preservation inventory
"""


def build_index(consolidated: list[dict], completed_at: str) -> str:
    standalone = [
        (
            "Living Anatomy",
            "Runnable governed-AI anatomy with the public Second Brain projection.",
            "https://huggingface.co/spaces/betterwithage/anatomy",
            "ANATOMY / SECOND BRAIN",
        ),
        (
            "Cosmos",
            "Runnable creative systems experience preserved on the creator profile.",
            "https://huggingface.co/spaces/betterwithage/cosmos",
            "COSMOS / CREATIVE",
        ),
    ]
    standalone_cards = "".join(
        f"""<article class="card feature">
          <div class="eyebrow">{html.escape(label)}</div>
          <h2>{html.escape(title)}</h2>
          <p>{html.escape(description)}</p>
          <a target="_blank" rel="noopener" href="{html.escape(url)}">Open Space →</a>
        </article>"""
        for title, description, url, label in standalone
    )

    archive_cards = []
    for item in sorted(consolidated, key=lambda row: str(row["source"]).lower()):
        source_id = str(item["source"])
        slug = source_id.split("/", 1)[1]
        prefix = str(item["archive_prefix"])
        classification = str(item.get("classification") or "CONSOLIDATED_UTILITY")
        archive_cards.append(
            f"""<article class="card module" data-name="{html.escape(slug.lower())}">
              <div class="eyebrow">{html.escape(classification.replace('_', ' '))}</div>
              <h3>{html.escape(slug.replace('-', ' ').title())}</h3>
              <p>{int(item.get('file_count') or 0)} files · {int(item.get('bytes') or 0):,} bytes</p>
              <div class="sha">SOURCE {html.escape(str(item.get('source_sha') or '')[:12])}</div>
              <a target="_blank" rel="noopener" href="https://huggingface.co/spaces/{PROFILE}/szl-command-centre/tree/main/{html.escape(prefix)}">Browse preserved source →</a>
            </article>"""
        )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>SZL Command Centre</title>
<style>
:root{{--bg:#05070c;--panel:#0b101b;--line:#27344a;--text:#edf4ff;--muted:#93a1b8;--glow:#76e7ff;--violet:#a58bff}}
*{{box-sizing:border-box}}
body{{margin:0;background:radial-gradient(circle at 72% 0,#17243e 0,transparent 35%),var(--bg);color:var(--text);font:15px/1.6 Inter,ui-sans-serif,system-ui,sans-serif}}
main{{width:min(1180px,calc(100% - 32px));margin:auto;padding:64px 0 96px}}
nav,footer{{display:flex;justify-content:space-between;gap:16px;color:var(--muted);font-size:12px;letter-spacing:.13em;text-transform:uppercase}}
nav{{align-items:center;margin-bottom:60px}} footer{{margin-top:72px;padding-top:20px;border-top:1px solid var(--line)}}
.pulse{{width:9px;height:9px;border-radius:50%;display:inline-block;background:var(--glow);box-shadow:0 0 18px var(--glow);margin-right:10px}}
h1{{font-size:clamp(46px,8vw,96px);line-height:.94;letter-spacing:-.06em;margin:0;max-width:920px}}
.lede{{max-width:760px;color:var(--muted);font-size:clamp(17px,2vw,22px);margin:28px 0 52px}}
.metrics{{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:54px}}
.metric{{border:1px solid var(--line);border-radius:999px;padding:8px 13px;color:var(--muted);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}}
section{{margin-top:54px}} .label{{font-size:11px;letter-spacing:.18em;color:var(--glow);text-transform:uppercase;margin-bottom:16px}}
.grid{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}}
.card{{min-height:230px;padding:24px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(145deg,rgba(19,28,46,.88),rgba(8,12,21,.94));display:flex;flex-direction:column;transition:.2s transform,.2s border-color}}
.card:hover{{transform:translateY(-3px);border-color:#5878a6}} .feature{{min-height:270px;box-shadow:inset 0 1px 0 rgba(118,231,255,.28)}}
.eyebrow,.sha{{font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.12em;color:var(--muted)}}
h2{{font-size:31px;letter-spacing:-.04em;margin:30px 0 8px}} h3{{font-size:22px;letter-spacing:-.03em;margin:25px 0 8px}}
.card p{{color:var(--muted);margin:0 0 24px}} .sha{{margin-top:auto}} a{{color:var(--text);text-decoration:none;margin-top:15px}} a:hover{{color:var(--glow)}}
.search{{width:100%;margin:4px 0 18px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:#090e18;color:var(--text);font:15px inherit}}
.hidden{{display:none}}
@media(max-width:860px){{.grid{{grid-template-columns:1fr 1fr}}}}
@media(max-width:560px){{main{{padding-top:32px}}nav,footer{{align-items:flex-start;flex-direction:column}}.grid{{grid-template-columns:1fr}}.card{{min-height:210px}}}}
@media(prefers-reduced-motion:reduce){{*{{scroll-behavior:auto!important;transition:none!important}}}}
</style>
</head>
<body><main>
<nav><span><i class="pulse"></i>SZL / CREATOR PROFILE</span><span>FINALIZED {html.escape(completed_at[:10])}</span></nav>
<h1>Three surfaces.<br>Zero sprawl.</h1>
<p class="lede">Living Anatomy and Cosmos remain independently runnable. Every other experiment, benchmark, utility, and retired interface is preserved here at an exact source revision.</p>
<div class="metrics"><span class="metric">2 RUNNABLE CREATIVE SPACES</span><span class="metric">1 CONSOLIDATED COMMAND CENTRE</span><span class="metric">49 ORG SPACES PRESERVED + REMOVED</span><span class="metric">11 ORG FLAGSHIP/VERTICAL SURFACES RETAINED</span></div>
<section><div class="label">Runnable creative surfaces</div><div class="grid">{standalone_cards}</div></section>
<section><div class="label">Preserved source vault</div><input id="search" class="search" type="search" aria-label="Filter preserved modules" placeholder="Filter 49 preserved modules…"><div id="modules" class="grid">{''.join(archive_cards)}</div></section>
<footer><span>Proof before pitch.</span><a href="./HF_SPACE_TOPOLOGY.json">Open final topology →</a></footer>
</main>
<script>
const input=document.getElementById('search');
const cards=[...document.querySelectorAll('.module')];
input.addEventListener('input',()=>{{const q=input.value.trim().toLowerCase();cards.forEach(card=>card.classList.toggle('hidden',q&&!card.dataset.name.includes(q)));}});
</script>
</body></html>"""


def publish_final_state(
    *,
    final_receipt: dict,
    topology: dict,
    consolidated: list[dict],
) -> str:
    completed_at = str(final_receipt["completed_at"])
    payloads = {
        "README.md": build_readme().encode("utf-8"),
        "index.html": build_index(consolidated, completed_at).encode("utf-8"),
        FINAL_RECEIPT_FILENAME: (
            json.dumps(final_receipt, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8"),
        FINAL_TOPOLOGY_FILENAME: (
            json.dumps(topology, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8"),
    }
    operations = [
        CommitOperationAdd(path_in_repo=path, path_or_fileobj=data)
        for path, data in payloads.items()
    ]
    commit = api.create_commit(
        repo_id=COMMAND_REPO,
        repo_type="space",
        operations=operations,
        commit_message="Finalize three-surface SZL public portfolio",
    )
    revision = str(commit.oid)
    if len(revision) != 40:
        raise RuntimeError(f"final Command Centre commit returned {revision!r}")

    for filename, expected in payloads.items():
        remote = Path(
            hf_hub_download(
                repo_id=COMMAND_REPO,
                repo_type="space",
                filename=filename,
                revision=revision,
                token=TOKEN,
                force_download=True,
            )
        )
        if sha256_path(remote) != sha256_bytes(expected):
            raise RuntimeError(f"remote read-back mismatch for {filename}")

    ensure_public_running(COMMAND_REPO, expected_revision=revision)
    return revision


def main() -> None:
    identity = api.whoami(token=TOKEN)
    identity_name = str(identity.get("name") or identity.get("fullname") or "")
    if identity_name.lower() != PROFILE:
        raise RuntimeError(
            f"wrong Hugging Face identity: expected {PROFILE}, got {identity_name!r}"
        )

    already_complete = completed_receipt_if_valid()
    if already_complete is not None:
        verify_final_topology(stabilization_checks=1)
        print(
            "ALREADY FINALIZED "
            + json.dumps(
                {
                    "status": "PASS",
                    "retained": sorted(PROTECTED),
                    "public_migrated_surfaces": sorted(PUBLIC_KEEP),
                },
                sort_keys=True,
            ),
            flush=True,
        )
        return

    receipt, receipt_path = load_hf_json(
        COMMAND_REPO,
        PREDELETE_FILENAME,
        PREDELETE_REVISION,
    )
    victims, expected_revisions, receipt_names, consolidated = (
        validate_predelete_receipt(receipt)
    )
    victim_names = {repo_id.split("/", 1)[1] for repo_id in victims}

    command_before = ensure_public_running(COMMAND_REPO)
    current_receipt, current_receipt_path = load_hf_json(
        COMMAND_REPO,
        PREDELETE_FILENAME,
        "main",
    )
    if sha256_path(current_receipt_path) != sha256_path(receipt_path):
        raise RuntimeError("current Command Centre preservation receipt differs from immutable receipt")
    if current_receipt != receipt:
        raise RuntimeError("current and immutable preservation receipt objects differ")

    archive_counts = verify_archive_tree(consolidated)

    anatomy_revision = ensure_public_running("betterwithage/anatomy")
    cosmos_revision = ensure_public_running("betterwithage/cosmos")
    anatomy_evidence = verify_anatomy_live(anatomy_revision)

    retired_profile_revisions: dict[str, str | None] = {}
    for repo_id in sorted(PUBLIC_RETIRE):
        info = repo_info_optional(repo_id)
        retired_profile_revisions[repo_id] = (
            str(getattr(info, "sha", "") or "") if info is not None else None
        )

    before = list_spaces(ORG)
    current_names = set(before)
    if not PROTECTED <= current_names:
        raise RuntimeError(
            f"protected org Spaces missing before deletion: {sorted(PROTECTED - current_names)}"
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

    deleted_org_now: list[str] = []
    for repo_id in sorted(victims):
        name = repo_id.split("/", 1)[1]
        if name not in before:
            print(f"ALREADY ABSENT {repo_id}", flush=True)
            continue
        api.delete_repo(repo_id=repo_id, repo_type="space", missing_ok=False)
        deleted_org_now.append(repo_id)
        print(f"DELETED {repo_id}", flush=True)

    after_org = list_spaces(ORG)
    if set(after_org) != PROTECTED:
        raise RuntimeError(
            f"organization postcondition failed after delete: {sorted(after_org)}"
        )

    deleted_profile_now: list[str] = []
    already_absent_profile: list[str] = []
    for repo_id in sorted(PUBLIC_RETIRE):
        if repo_info_optional(repo_id) is None:
            already_absent_profile.append(repo_id)
            print(f"ALREADY ABSENT {repo_id}", flush=True)
            continue
        api.delete_repo(repo_id=repo_id, repo_type="space", missing_ok=False)
        deleted_profile_now.append(repo_id)
        print(f"DELETED {repo_id}", flush=True)

    ensure_public_running("betterwithage/anatomy", expected_revision=anatomy_revision)
    ensure_public_running("betterwithage/cosmos", expected_revision=cosmos_revision)

    completed_at = utc_now()
    topology = {
        "schema": "szl.hf-space-topology/v1",
        "status": "PASS",
        "completed_at": completed_at,
        "organization": {
            "owner": ORG,
            "policy": "FLAGSHIPS_VERTICALS_SHARED_INFRA_ONLY",
            "retained_names": sorted(PROTECTED),
            "retained_count": len(PROTECTED),
        },
        "creator_profile": {
            "owner": PROFILE,
            "migrated_portfolio_policy": "THREE_SURFACES_MAX",
            "migrated_surfaces": sorted(PUBLIC_KEEP),
            "migrated_surface_count": len(PUBLIC_KEEP),
            "retired_standalone_surfaces": sorted(PUBLIC_RETIRE),
        },
        "archive": {
            "repo_id": COMMAND_REPO,
            "predelete_revision": PREDELETE_REVISION,
            "preserved_source_count": len(consolidated),
            "source_file_counts": archive_counts,
        },
    }

    final_receipt = {
        "schema": "szl.hf-space-consolidation.final.v2",
        "status": "PASS",
        "completed_at": completed_at,
        "organization": ORG,
        "profile": PROFILE,
        "predelete_receipt": {
            "repo_id": COMMAND_REPO,
            "revision": PREDELETE_REVISION,
            "filename": PREDELETE_FILENAME,
            "sha256": sha256_path(receipt_path),
        },
        "command_centre_revision_before_finalize": command_before,
        "deleted_org_spaces": sorted(victims),
        "deleted_org_now": deleted_org_now,
        "already_absent_org_on_resume": [
            f"{ORG}/{name}" for name in already_absent
        ],
        "deleted_org_count": len(victims),
        "retained_names": sorted(PROTECTED),
        "retained_count": len(PROTECTED),
        "public_migrated_surfaces": sorted(PUBLIC_KEEP),
        "public_retired_surfaces": sorted(PUBLIC_RETIRE),
        "deleted_profile_now": deleted_profile_now,
        "already_absent_profile_on_resume": already_absent_profile,
        "retired_profile_revisions": retired_profile_revisions,
        "living_anatomy_evidence": anatomy_evidence,
        "cosmos_revision": cosmos_revision,
        "archive_verified_source_count": len(archive_counts),
        "workflow_run_id": os.environ.get("GITHUB_RUN_ID", ""),
        "workflow_source_revision": os.environ.get("GITHUB_SHA", ""),
    }

    final_revision = publish_final_state(
        final_receipt=final_receipt,
        topology=topology,
        consolidated=consolidated,
    )

    stable = verify_final_topology(stabilization_checks=4)
    print(
        "FINAL THREE-SURFACE RECEIPT "
        + json.dumps(
            {
                "status": "PASS",
                "deleted_org_count": len(victims),
                "retained_org_names": sorted(PROTECTED),
                "public_migrated_surfaces": sorted(PUBLIC_KEEP),
                "retired_profile_surfaces": sorted(PUBLIC_RETIRE),
                "command_centre_revision": final_revision,
                "stabilization_checks": len(stable["checks"]),
            },
            sort_keys=True,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
