#!/usr/bin/env python3
"""Restore David Leads as a flagship and rebalance the public HF archive.

The operation is ordered to avoid data loss:

1. Require the authoritative ``SZLHOLDINGS/david-leads`` Space to be public,
   RUNNING, source-bound to the current GitHub main revision, and carrying its
   exact release receipt.
2. Load the current public Command Centre inventory.
3. Remove only the preserved ``archive/david-leads`` tree from the active
   archive, leaving all historical Hugging Face revisions and receipts intact.
4. Publish an active 49-source manifest, refreshed public UI, topology record,
   and a read-back-verified rebalance receipt.
5. Require the organization estate to equal the 12 approved flagship,
   vertical, shared-infrastructure, and front-door Spaces exactly.

The script is idempotent. A completed topology is verified and returned without
creating another commit.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from huggingface_hub import (
    CommitOperationAdd,
    CommitOperationDelete,
    HfApi,
    hf_hub_download,
)

ORG = "SZLHOLDINGS"
PROFILE = "betterwithage"
DAVID_NAME = "david-leads"
DAVID_REPO = f"{ORG}/{DAVID_NAME}"
DAVID_GITHUB_REPO = "szl-holdings/david-leads"
DAVID_BASE_URL = "https://szlholdings-david-leads.hf.space"
COMMAND_REPO = f"{PROFILE}/szl-command-centre"
MANIFEST_FILENAME = "manifest.json"
TOPOLOGY_FILENAME = "HF_SPACE_TOPOLOGY.json"
REBALANCE_FILENAME = "HF_SPACE_PORTFOLIO_REBALANCE_RECEIPT.json"
HISTORICAL_RECEIPTS = (
    "HF_SPACE_CONSOLIDATION_PREDELETE_RECEIPT.json",
    "HF_SPACE_CONSOLIDATION_SUPPLEMENTAL_RECEIPT.json",
    "HF_SPACE_CONSOLIDATION_FINAL_RECEIPT.json",
)
EXPECTED_RETIRED_COUNT = 49
EXPECTED_ORG = {
    "README",
    "a11oy",
    "aegis-assurance",
    "counsel",
    "david-leads",
    "finance",
    "killinchu",
    "lyte",
    "sentra",
    "terra",
    "vertical-services",
    "vessels",
}
PUBLIC_SURFACES = {
    "betterwithage/anatomy",
    "betterwithage/cosmos",
    COMMAND_REPO,
}
RETIRED_PROFILE_MIRRORS = {
    "betterwithage/holographic",
    "betterwithage/szl-atelier",
    "betterwithage/yarqa",
}

TOKEN = os.environ["HF_TOKEN"]
api = HfApi(token=TOKEN)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def is_full_revision(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 40
        and all(character in "0123456789abcdef" for character in value.lower())
    )


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


def list_spaces(author: str) -> dict[str, object]:
    return {
        item.id.split("/", 1)[1]: item
        for item in api.list_spaces(author=author, full=True)
    }


def get_json(url: str, timeout: int = 25) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "szl-hf-david-rebalance/1.0"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"unexpected HTTP {response.status} from {url}")
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise RuntimeError(f"non-object JSON from {url}")
    return payload


def current_github_main_revision() -> str:
    payload = get_json(
        f"https://api.github.com/repos/{DAVID_GITHUB_REPO}/commits/main"
    )
    revision = str(payload.get("sha") or "").lower()
    if not is_full_revision(revision):
        raise RuntimeError("GitHub returned an invalid David Leads main revision")
    return revision


def load_hf_json(
    repo_id: str,
    filename: str,
    revision: str,
) -> tuple[dict[str, Any], Path]:
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


def optional_hf_json(
    repo_id: str,
    filename: str,
    revision: str,
) -> dict[str, Any] | None:
    try:
        payload, _ = load_hf_json(repo_id, filename, revision)
        return payload
    except Exception:
        return None


def wait_public_running(
    repo_id: str,
    *,
    expected_revision: str | None = None,
    timeout_seconds: int = 1200,
) -> str:
    deadline = time.monotonic() + timeout_seconds
    restarted = False
    last: tuple[str, str, bool] | None = None
    while time.monotonic() < deadline:
        try:
            info = api.repo_info(repo_id=repo_id, repo_type="space")
            revision = str(getattr(info, "sha", "") or "")
            private = bool(getattr(info, "private", False))
            stage = stage_name(api.get_space_runtime(repo_id=repo_id))
            last = (revision, stage, private)
            print(
                f"SURFACE {repo_id} sha={revision[:12]} "
                f"stage={stage} private={private}",
                flush=True,
            )
            if private:
                raise RuntimeError(f"required public Space is private: {repo_id}")
            if not is_full_revision(revision):
                raise RuntimeError(f"Space lacks an exact revision: {repo_id}")
            if expected_revision is not None and revision != expected_revision:
                time.sleep(10)
                continue
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
        except RuntimeError:
            raise
        except Exception as error:
            print(
                f"WAITING {repo_id}: {type(error).__name__}: {error}",
                flush=True,
            )
        time.sleep(10)
    raise TimeoutError(f"{repo_id} did not become public/RUNNING: {last}")


def verify_david_live(timeout_seconds: int = 1800) -> dict[str, Any]:
    expected_source = current_github_main_revision()
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    restarted = False

    while time.monotonic() < deadline:
        try:
            info = api.repo_info(repo_id=DAVID_REPO, repo_type="space")
            hub_revision = str(getattr(info, "sha", "") or "")
            private = bool(getattr(info, "private", False))
            stage = stage_name(api.get_space_runtime(repo_id=DAVID_REPO))
            print(
                f"DAVID {hub_revision[:12]} stage={stage} "
                f"private={private} expected_git={expected_source[:12]}",
                flush=True,
            )
            if private:
                raise RuntimeError("David Leads flagship Space is private")
            if stage in {"RUNTIME_ERROR", "BUILD_ERROR", "CONFIG_ERROR"}:
                if not restarted:
                    api.restart_space(repo_id=DAVID_REPO, factory_reboot=True)
                    restarted = True
                time.sleep(10)
                continue
            if stage != "RUNNING" or not is_full_revision(hub_revision):
                time.sleep(10)
                continue

            health = get_json(DAVID_BASE_URL + "/healthz")
            ready = get_json(DAVID_BASE_URL + "/readyz")
            build = get_json(DAVID_BASE_URL + "/api/build-info")
            build_revision = str((build.get("build") or {}).get("revision") or "")
            source_revision = str(build.get("source_revision") or "")
            release_receipt = build.get("release_receipt") or {}
            if build_revision != expected_source:
                raise RuntimeError(
                    "David Leads runtime build revision is not current GitHub main"
                )
            if source_revision != expected_source:
                raise RuntimeError(
                    "David Leads source revision is not current GitHub main"
                )
            if build.get("receipt_minted") is not True:
                raise RuntimeError("David Leads release receipt is not minted")
            if not isinstance(release_receipt, dict) or not release_receipt:
                raise RuntimeError("David Leads release receipt is missing")

            evidence = {
                "repo_id": DAVID_REPO,
                "hub_revision": hub_revision,
                "source_revision": expected_source,
                "stage": stage,
                "private": private,
                "health": health,
                "ready": ready,
                "receipt_state": release_receipt.get("state"),
                "attestation_id": release_receipt.get("attestation_id"),
                "subject_sha256": release_receipt.get("subject_sha256"),
            }
            print(
                "DAVID FLAGSHIP VERIFIED "
                + json.dumps(
                    {
                        "hub_revision": hub_revision,
                        "source_revision": expected_source,
                        "receipt_minted": True,
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
            return evidence
        except Exception as error:
            last_error = error
            print(
                f"DAVID VERIFY RETRY {type(error).__name__}: {error}",
                flush=True,
            )
            time.sleep(10)

    raise RuntimeError("David Leads did not become fully attested") from last_error


def record_source(record: dict[str, Any]) -> str:
    return str(record.get("source") or "")


def record_prefix(record: dict[str, Any]) -> str:
    return str(record.get("archive_prefix") or "").rstrip("/")


def validate_active_records(records: list[dict[str, Any]]) -> None:
    if len(records) != EXPECTED_RETIRED_COUNT:
        raise RuntimeError(
            f"active retired archive must contain {EXPECTED_RETIRED_COUNT} "
            f"records, found {len(records)}"
        )
    sources = [record_source(record) for record in records]
    prefixes = [record_prefix(record) for record in records]
    if any(not source.startswith(ORG + "/") for source in sources):
        raise RuntimeError("active archive contains a source outside SZLHOLDINGS")
    if DAVID_REPO in sources:
        raise RuntimeError("David Leads remains classified as retired")
    if len(set(sources)) != EXPECTED_RETIRED_COUNT:
        raise RuntimeError("active archive contains duplicate source IDs")
    if any(not prefix.startswith("archive/") for prefix in prefixes):
        raise RuntimeError("active archive contains an invalid archive prefix")
    if len(set(prefixes)) != EXPECTED_RETIRED_COUNT:
        raise RuntimeError("active archive contains duplicate archive prefixes")


def build_readme() -> str:
    return """---
title: SZL Command Centre — Retired Systems Archive
emoji: 🛰️
colorFrom: gray
colorTo: indigo
sdk: static
app_file: index.html
pinned: true
license: apache-2.0
short_description: Forty-nine retired systems preserved in one public archive
---

# SZL Command Centre

The active public archive for **49 retired SZL Holdings Spaces**. Their source
snapshots remain consolidated here with exact revisions and integrity metadata.

David Leads has been restored to `SZLHOLDINGS/david-leads` as an active
flagship and is no longer part of the retired archive. Living Anatomy and Cosmos
remain independently runnable creative surfaces on the `betterwithage` profile.

Historical consolidation receipts are retained unchanged. The current topology
is recorded in `HF_SPACE_TOPOLOGY.json`, and the restoration transaction is
recorded in `HF_SPACE_PORTFOLIO_REBALANCE_RECEIPT.json`.
"""


def build_index(records: list[dict[str, Any]], completed_at: str) -> str:
    cards: list[str] = []
    for record in sorted(records, key=lambda item: record_source(item).lower()):
        source = record_source(record)
        name = source.split("/", 1)[1]
        prefix = record_prefix(record)
        file_count = int(record.get("file_count") or 0)
        byte_count = int(record.get("bytes") or 0)
        revision = str(record.get("source_sha") or "")
        classification = str(record.get("classification") or "RETIRED_SYSTEM")
        cards.append(
            f"""<article class="card module" data-name="{html.escape(name.lower())}">
              <div class="eyebrow">{html.escape(classification.replace('_', ' '))}</div>
              <h3>{html.escape(name.replace('-', ' ').title())}</h3>
              <p>{file_count} files · {byte_count:,} bytes preserved</p>
              <div class="sha">SOURCE {html.escape(revision[:12])}</div>
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
:root{{--bg:#05070c;--panel:#0b101b;--line:#263249;--text:#edf4ff;--muted:#91a0b8;--glow:#76e7ff;--violet:#a58bff;--green:#7fffd4}}
*{{box-sizing:border-box}}
body{{margin:0;background:radial-gradient(circle at 72% 0,#17233b 0,transparent 35%),var(--bg);color:var(--text);font:15px/1.6 Inter,ui-sans-serif,system-ui,sans-serif}}
main{{width:min(1180px,calc(100% - 32px));margin:auto;padding:64px 0 96px}}
nav{{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:58px;color:var(--muted);font-size:12px;letter-spacing:.14em;text-transform:uppercase}}
.pulse{{width:9px;height:9px;border-radius:50%;display:inline-block;background:var(--green);box-shadow:0 0 18px var(--green);margin-right:10px}}
h1{{font-size:clamp(44px,8vw,94px);line-height:.96;letter-spacing:-.06em;margin:0;max-width:950px}}
.lede{{max-width:780px;color:var(--muted);font-size:clamp(17px,2vw,22px);margin:26px 0 38px}}
.metrics{{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:54px}}
.metric{{border:1px solid var(--line);border-radius:999px;padding:8px 13px;color:var(--muted);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}}
section{{margin-top:54px}}
.label{{font-size:11px;letter-spacing:.18em;color:var(--glow);text-transform:uppercase;margin-bottom:16px}}
.grid{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}}
.card{{min-height:230px;padding:24px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(145deg,rgba(19,28,46,.88),rgba(8,12,21,.94));display:flex;flex-direction:column;transition:.2s transform,.2s border-color}}
.card:hover{{transform:translateY(-3px);border-color:#5878a6}}
.feature{{min-height:250px;box-shadow:inset 0 1px 0 rgba(118,231,255,.28)}}
.flagship{{box-shadow:inset 0 1px 0 rgba(127,255,212,.36)}}
.eyebrow,.sha{{font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.12em;color:var(--muted)}}
h2{{font-size:31px;letter-spacing:-.04em;margin:30px 0 8px}}
h3{{font-size:22px;letter-spacing:-.03em;margin:25px 0 8px}}
.card p{{color:var(--muted);margin:0 0 24px}}
.sha{{margin-top:auto}}
a{{color:var(--text);text-decoration:none;margin-top:15px}}
a:hover{{color:var(--glow)}}
.search{{width:100%;margin:4px 0 18px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:#090e18;color:var(--text);font:15px inherit}}
.hidden{{display:none}}
footer{{margin-top:72px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);display:flex;justify-content:space-between;gap:16px}}
@media(max-width:860px){{.grid{{grid-template-columns:1fr 1fr}}}}
@media(max-width:560px){{main{{padding-top:32px}}nav,footer{{align-items:flex-start;flex-direction:column}}.grid{{grid-template-columns:1fr}}.card{{min-height:210px}}}}
@media(prefers-reduced-motion:reduce){{*{{scroll-behavior:auto!important;transition:none!important}}}}
</style>
</head>
<body><main>
<nav><span><i class="pulse"></i>SZL / CREATOR PROFILE</span><span>REBALANCED {html.escape(completed_at[:10])}</span></nav>
<h1>Forty-nine retired systems.<br>One public archive.</h1>
<p class="lede">David Leads is back in the SZL Holdings flagship estate. Everything still retired remains consolidated here—searchable, source-bound, and preserved without Space sprawl.</p>
<div class="metrics"><span class="metric">49 RETIRED SOURCES</span><span class="metric">1 CONSOLIDATED ARCHIVE</span><span class="metric">12 ORG FLAGSHIP/VERTICAL SURFACES</span><span class="metric">2 RUNNABLE CREATIVE SURFACES</span></div>
<section><div class="label">Active portfolio</div><div class="grid">
<article class="card feature flagship"><div class="eyebrow">RESTORED ORG FLAGSHIP</div><h2>David Leads</h2><p>Evidence-backed broker research and governed lead intelligence.</p><a target="_blank" rel="noopener" href="https://huggingface.co/spaces/SZLHOLDINGS/david-leads">Open flagship →</a></article>
<article class="card feature"><div class="eyebrow">PUBLIC CREATIVE SURFACE</div><h2>Living Anatomy</h2><p>Operational living-system interface with the public Second Brain projection.</p><a target="_blank" rel="noopener" href="https://huggingface.co/spaces/betterwithage/anatomy">Open Anatomy →</a></article>
<article class="card feature"><div class="eyebrow">PUBLIC CREATIVE SURFACE</div><h2>Cosmos</h2><p>The independently runnable creative Cosmos experience.</p><a target="_blank" rel="noopener" href="https://huggingface.co/spaces/betterwithage/cosmos">Open Cosmos →</a></article>
</div></section>
<section><div class="label">Preserved source vault</div><input id="search" class="search" type="search" aria-label="Filter retired modules" placeholder="Filter 49 retired modules…"><div id="modules" class="grid">{''.join(cards)}</div></section>
<footer><span>Proof before pitch.</span><a href="./HF_SPACE_TOPOLOGY.json">Open active topology →</a></footer>
</main>
<script>
const input=document.getElementById('search');
const cards=[...document.querySelectorAll('.module')];
input.addEventListener('input',()=>{{const q=input.value.trim().toLowerCase();cards.forEach(card=>card.classList.toggle('hidden',q&&!card.dataset.name.includes(q)));}});
</script>
</body></html>"""


def build_topology(
    *,
    completed_at: str,
    records: list[dict[str, Any]],
    command_revision_before: str,
    david_evidence: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema": "szl.hf-space-topology/v2",
        "status": "PASS",
        "completed_at": completed_at,
        "organization": {
            "owner": ORG,
            "policy": "FLAGSHIPS_VERTICALS_SHARED_INFRA_ONLY",
            "retained_names": sorted(EXPECTED_ORG),
            "retained_count": len(EXPECTED_ORG),
            "restored_flagships": [DAVID_REPO],
        },
        "creator_profile": {
            "owner": PROFILE,
            "migrated_portfolio_policy": "THREE_SURFACES_MAX",
            "migrated_surfaces": sorted(PUBLIC_SURFACES),
            "migrated_surface_count": len(PUBLIC_SURFACES),
            "retired_standalone_surfaces": sorted(RETIRED_PROFILE_MIRRORS),
        },
        "archive": {
            "repo_id": COMMAND_REPO,
            "active_retired_source_count": len(records),
            "active_retired_sources": sorted(record_source(item) for item in records),
            "restored_source_removed": DAVID_REPO,
            "command_revision_before_rebalance": command_revision_before,
            "historical_receipts_retained": list(HISTORICAL_RECEIPTS),
        },
        "david_leads": {
            "repo_id": DAVID_REPO,
            "hub_revision": david_evidence["hub_revision"],
            "source_revision": david_evidence["source_revision"],
            "release_receipt_state": david_evidence["receipt_state"],
        },
    }


def verify_org_and_profile() -> dict[str, Any]:
    org = list_spaces(ORG)
    org_names = set(org)
    if org_names != EXPECTED_ORG:
        raise RuntimeError(
            f"organization topology mismatch: {sorted(org_names)} != "
            f"{sorted(EXPECTED_ORG)}"
        )

    profile = list_spaces(PROFILE)
    profile_ids = {f"{PROFILE}/{name}" for name in profile}
    missing = PUBLIC_SURFACES - profile_ids
    resurrected = RETIRED_PROFILE_MIRRORS & profile_ids
    if missing:
        raise RuntimeError(f"required public surfaces are missing: {sorted(missing)}")
    if resurrected:
        raise RuntimeError(
            f"retired profile mirrors reappeared: {sorted(resurrected)}"
        )

    runtime: dict[str, dict[str, Any]] = {}
    for repo_id in sorted(PUBLIC_SURFACES):
        revision = wait_public_running(repo_id, timeout_seconds=600)
        runtime[repo_id] = {"revision": revision, "stage": "RUNNING"}
    return {
        "org_names": sorted(org_names),
        "org_count": len(org_names),
        "public_surfaces": sorted(PUBLIC_SURFACES),
        "runtime": runtime,
    }


def verify_command_state(
    *,
    revision: str,
    records: list[dict[str, Any]],
    expected_payloads: dict[str, bytes],
) -> None:
    files = set(
        api.list_repo_files(
            repo_id=COMMAND_REPO,
            repo_type="space",
            revision=revision,
        )
    )
    if any(path.startswith("archive/david-leads/") for path in files):
        raise RuntimeError("David Leads files remain in the active retired archive")
    for record in records:
        prefix = record_prefix(record) + "/"
        if not any(path.startswith(prefix) for path in files):
            raise RuntimeError(f"active archive tree is missing: {prefix}")
    for filename, expected in expected_payloads.items():
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
    wait_public_running(
        COMMAND_REPO,
        expected_revision=revision,
        timeout_seconds=900,
    )


def main() -> None:
    identity = api.whoami(token=TOKEN)
    identity_name = str(identity.get("name") or identity.get("fullname") or "")
    if identity_name.lower() != PROFILE:
        raise RuntimeError(
            f"wrong Hugging Face identity: expected {PROFILE}, got {identity_name!r}"
        )

    david_evidence = verify_david_live()
    estate_before = verify_org_and_profile()
    command_before = wait_public_running(COMMAND_REPO)
    manifest, _ = load_hf_json(
        COMMAND_REPO,
        MANIFEST_FILENAME,
        command_before,
    )
    records_raw = manifest.get("consolidated_spaces")
    if not isinstance(records_raw, list):
        raise RuntimeError("Command Centre manifest lacks consolidated_spaces")
    records = [item for item in records_raw if isinstance(item, dict)]
    if len(records) != len(records_raw):
        raise RuntimeError("Command Centre manifest contains a non-object record")

    david_records = [item for item in records if record_source(item) == DAVID_REPO]
    active_records = [item for item in records if record_source(item) != DAVID_REPO]
    validate_active_records(active_records)

    files_before = set(
        api.list_repo_files(
            repo_id=COMMAND_REPO,
            repo_type="space",
            revision=command_before,
        )
    )
    david_files = sorted(
        path for path in files_before if path.startswith("archive/david-leads/")
    )
    prior_receipt = optional_hf_json(
        COMMAND_REPO,
        REBALANCE_FILENAME,
        command_before,
    )

    if not david_records and not david_files:
        if (
            prior_receipt is not None
            and prior_receipt.get("status") == "PASS"
            and prior_receipt.get("retired_source_count")
            == EXPECTED_RETIRED_COUNT
        ):
            verify_org_and_profile()
            print(
                "ALREADY REBALANCED "
                + json.dumps(
                    {
                        "status": "PASS",
                        "org_count": len(EXPECTED_ORG),
                        "retired_source_count": EXPECTED_RETIRED_COUNT,
                        "public_surfaces": sorted(PUBLIC_SURFACES),
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
            return
        raise RuntimeError(
            "David Leads is absent from the archive but no valid rebalance "
            "receipt exists"
        )

    if len(david_records) != 1:
        raise RuntimeError(
            f"expected one David Leads archive record, found {len(david_records)}"
        )
    if not david_files:
        raise RuntimeError("David Leads archive record exists but its files are missing")
    if len(records) != EXPECTED_RETIRED_COUNT + 1:
        raise RuntimeError(
            f"expected 50 pre-rebalance records, found {len(records)}"
        )

    completed_at = utc_now()
    updated_manifest = dict(manifest)
    updated_manifest["generated_at"] = completed_at
    updated_manifest["protected_org_spaces"] = sorted(EXPECTED_ORG)
    updated_manifest["consolidated_spaces"] = active_records
    creative = updated_manifest.get("creative_profile_spaces")
    if isinstance(creative, list):
        updated_manifest["creative_profile_spaces"] = [
            item
            for item in creative
            if isinstance(item, dict)
            and item.get("destination")
            in {"betterwithage/anatomy", "betterwithage/cosmos"}
        ]
    updated_manifest["active_portfolio"] = {
        "schema": "szl.command-centre.active-portfolio/v1",
        "status": "PASS",
        "updated_at": completed_at,
        "retired_source_count": EXPECTED_RETIRED_COUNT,
        "restored_flagships": [DAVID_REPO],
        "public_surfaces": sorted(PUBLIC_SURFACES),
        "historical_consolidation_receipts_retained": list(HISTORICAL_RECEIPTS),
    }

    topology = build_topology(
        completed_at=completed_at,
        records=active_records,
        command_revision_before=command_before,
        david_evidence=david_evidence,
    )
    payloads = {
        "README.md": build_readme().encode("utf-8"),
        "index.html": build_index(active_records, completed_at).encode("utf-8"),
        MANIFEST_FILENAME: (
            json.dumps(updated_manifest, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8"),
        TOPOLOGY_FILENAME: (
            json.dumps(topology, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8"),
    }

    operations: list[CommitOperationAdd | CommitOperationDelete] = [
        CommitOperationDelete(path_in_repo=path) for path in david_files
    ]
    operations.extend(
        CommitOperationAdd(path_in_repo=path, path_or_fileobj=data)
        for path, data in payloads.items()
    )
    staged = api.create_commit(
        repo_id=COMMAND_REPO,
        repo_type="space",
        operations=operations,
        commit_message=(
            "Restore David Leads flagship and rebalance active archive to 49"
        ),
    )
    content_revision = str(staged.oid)
    if not is_full_revision(content_revision):
        raise RuntimeError(
            f"Command Centre returned invalid content revision: {content_revision!r}"
        )
    verify_command_state(
        revision=content_revision,
        records=active_records,
        expected_payloads=payloads,
    )

    estate_after = verify_org_and_profile()
    david_after = verify_david_live(timeout_seconds=600)
    receipt = {
        "schema": "szl.hf-space-portfolio-rebalance/v1",
        "status": "PASS",
        "completed_at": completed_at,
        "organization": ORG,
        "profile": PROFILE,
        "restored_flagship": DAVID_REPO,
        "david_leads": david_after,
        "retired_source_count_before": len(records),
        "retired_source_count": len(active_records),
        "retired_sources": sorted(record_source(item) for item in active_records),
        "removed_archive_prefix": "archive/david-leads",
        "removed_archive_file_count": len(david_files),
        "command_centre_revision_before": command_before,
        "command_centre_content_revision": content_revision,
        "historical_receipts_retained": list(HISTORICAL_RECEIPTS),
        "estate_before": estate_before,
        "estate_after": estate_after,
        "workflow_run_id": os.environ.get("GITHUB_RUN_ID", ""),
        "workflow_source_revision": os.environ.get("GITHUB_SHA", ""),
    }
    receipt_bytes = (
        json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    finalized = api.create_commit(
        repo_id=COMMAND_REPO,
        repo_type="space",
        operations=[
            CommitOperationAdd(
                path_in_repo=REBALANCE_FILENAME,
                path_or_fileobj=receipt_bytes,
            )
        ],
        commit_message="Publish verified David Leads restoration receipt",
    )
    receipt_revision = str(finalized.oid)
    if not is_full_revision(receipt_revision):
        raise RuntimeError(
            f"Command Centre returned invalid receipt revision: {receipt_revision!r}"
        )
    verify_command_state(
        revision=receipt_revision,
        records=active_records,
        expected_payloads={REBALANCE_FILENAME: receipt_bytes},
    )

    final_estate = verify_org_and_profile()
    print(
        "DAVID RESTORATION AND 49-SOURCE REBALANCE PASS "
        + json.dumps(
            {
                "status": "PASS",
                "org_count": final_estate["org_count"],
                "retained_org_names": final_estate["org_names"],
                "restored_flagship": DAVID_REPO,
                "retired_source_count": EXPECTED_RETIRED_COUNT,
                "public_surfaces": sorted(PUBLIC_SURFACES),
                "command_centre_revision": receipt_revision,
            },
            sort_keys=True,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
