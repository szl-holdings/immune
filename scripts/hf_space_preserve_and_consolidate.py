#!/usr/bin/env python3
"""Preserve and verify all non-flagship SZLHOLDINGS Spaces before deletion.

This phase is intentionally non-destructive to the organization. It migrates
creative experiences to the public creator profile, consolidates every other
non-flagship source tree into one public Command Centre, performs remote
read-back and SHA-256 verification, then publishes an exact pre-delete receipt.
"""
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download

ORG = "SZLHOLDINGS"
PROFILE = "betterwithage"
COMMAND_REPO = f"{PROFILE}/szl-command-centre"

# Org front door: only canonical flagships and operating verticals remain.
PROTECTED = {
    "a11oy",
    "killinchu",
    "lyte",
    "terra",
    "sentra",
    "vessels",
    "counsel",
    "prism-counsel",
    "finance",
    "puriq-finance",
    "aegis",
    "aegis-assurance",
    "vertical-services",
    "README",  # hidden Hugging Face organization front door
}

# Creative experiences belong on Stephen's public profile, not the company org.
CREATIVE_SOURCES = {
    "anatomy": "https://github.com/szl-holdings/anatomy.git",
    "cosmos": "https://github.com/szl-holdings/cosmos.git",
}
CREATIVE_ORG_ALIASES = {
    "anatomy",
    "living-anatomy",
    "yarqa",
    "cosmos",
    "anatomy-cosmos",
    "holographic",
    "szl-atelier",
}

TOKEN = os.environ["HF_TOKEN"]
api = HfApi(token=TOKEN)
now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

def log(message: str) -> None:
    print(message, flush=True)

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def is_lfs_pointer(path: Path) -> bool:
    if path.name.endswith(".lfs-pointer.txt"):
        return False
    if not path.is_file() or path.stat().st_size > 4096:
        return False
    try:
        head = path.read_bytes()
    except OSError:
        return False
    return head.startswith(b"version https://git-lfs.github.com/spec/v1")

def sanitize_tree(source: Path, destination: Path) -> dict:
    """Copy source bytes without .git metadata or dangerous unresolved LFS pointers."""
    destination.mkdir(parents=True, exist_ok=True)
    files = []
    unresolved_lfs = []
    for src in sorted(source.rglob("*")):
        if src.is_dir():
            continue
        rel = src.relative_to(source)
        if ".git" in rel.parts or ".cache" in rel.parts or "__pycache__" in rel.parts:
            continue
        target_rel = rel
        if rel.name == ".gitattributes":
            target_rel = rel.with_name("__gitattributes__.txt")
        elif is_lfs_pointer(src):
            target_rel = Path(str(rel) + ".lfs-pointer.txt")
            unresolved_lfs.append({
                "original_path": rel.as_posix(),
                "preserved_as": target_rel.as_posix(),
                "pointer": src.read_text("utf-8", errors="replace").strip(),
            })
        dst = destination / target_rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        files.append({
            "path": target_rel.as_posix(),
            "sha256": sha256(dst),
            "bytes": dst.stat().st_size,
        })
    return {
        "files": files,
        "unresolved_lfs": unresolved_lfs,
        "file_count": len(files),
        "bytes": sum(item["bytes"] for item in files),
    }

def clone_github(url: str, destination: Path) -> str:
    clone_env = dict(os.environ)
    clone_env["GIT_LFS_SKIP_SMUDGE"] = "1"
    subprocess.run(
        ["git", "clone", "--depth", "1", url, str(destination)],
        check=True,
        env=clone_env,
    )
    pull_env = dict(os.environ)
    pull_env["GIT_LFS_SKIP_SMUDGE"] = "0"
    subprocess.run(
        ["git", "-C", str(destination), "lfs", "pull"],
        check=False,
        env=pull_env,
    )
    revision = subprocess.check_output(
        ["git", "-C", str(destination), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    shutil.rmtree(destination / ".git", ignore_errors=True)
    return revision

def prepare_creator_source(root: Path, slug: str, revision: str) -> None:
    """Make the creator-profile deployment self-consistent and runnable."""
    if slug == "anatomy":
        materializer = root / "scripts" / "materialize_second_brain.py"
        if not materializer.is_file():
            raise RuntimeError("Living Anatomy materializer is missing")
        subprocess.run(
            [
                "python",
                str(materializer),
                "--output",
                str(root / ".runtime" / "second-brain"),
            ],
            check=True,
            cwd=root,
            env=dict(os.environ),
        )

    old_id = f"SZLHOLDINGS/{slug}"
    new_id = f"{PROFILE}/{slug}"
    replacements = {
        old_id: new_id,
        f"https://szlholdings-{slug}.hf.space":
            f"https://betterwithage-{slug}.hf.space",
        f"szlholdings-{slug}.hf.space":
            f"betterwithage-{slug}.hf.space",
    }
    for path in sorted(root.rglob("*")):
        if not path.is_file() or ".git" in path.parts or path.stat().st_size > 2_000_000:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        updated = text
        for old, new in replacements.items():
            updated = updated.replace(old, new)
        if updated != text:
            path.write_text(updated, encoding="utf-8")

    dependency = {}
    brain_source = root / ".runtime" / "second-brain" / "source.json"
    if brain_source.is_file():
        data = json.loads(brain_source.read_text(encoding="utf-8"))
        dependency["second_brain"] = {
            "source_repository": data.get("source_repository"),
            "source_revision": data.get("source_revision"),
            "public_chunk_count": data.get("public_chunk_count"),
            "corpus_sha256": data.get("corpus_sha256"),
            "authority_state": "READ_ONLY",
            "content_access": "HANDLES_ONLY",
        }
    deploy = {
        "schema": "szl.hf-deploy-manifest/v1",
        "source_repository": f"szl-holdings/{slug}",
        "source_revision": revision,
        "source_path": "",
        "destination": {
            "repo_id": f"{PROFILE}/{slug}",
            "repo_type": "space",
            "mode": "creator-profile",
            "visibility": "public",
            "lifecycle": "PUBLIC_CREATIVE",
        },
        "dependencies": dependency,
        "workflow_run_id": os.environ.get("GITHUB_RUN_ID", ""),
    }
    (root / "hf-deploy-manifest.json").write_text(
        json.dumps(deploy, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

def ensure_public_space(repo_id: str, sdk: str = "docker") -> None:
    try:
        api.repo_info(repo_id=repo_id, repo_type="space")
    except Exception:
        api.create_repo(
            repo_id=repo_id,
            repo_type="space",
            private=False,
            space_sdk=sdk,
            exist_ok=True,
        )
    api.update_repo_settings(
        repo_id=repo_id,
        repo_type="space",
        private=False,
    )

def stage_name(runtime: object) -> str:
    value = getattr(runtime, "stage", None)
    return str(getattr(value, "value", value) or "UNKNOWN").upper()

def wait_space_running(repo_id: str, target_sha: str, seconds: int = 900) -> None:
    import time
    deadline = time.monotonic() + seconds
    restarted = False
    last = None
    while time.monotonic() < deadline:
        info = api.repo_info(repo_id=repo_id, repo_type="space")
        runtime = api.get_space_runtime(repo_id=repo_id)
        stage = stage_name(runtime)
        current_sha = str(getattr(info, "sha", "") or "")
        last = (current_sha, stage, bool(getattr(info, "private", False)))
        log(f"RUNTIME {repo_id} sha={current_sha[:12]} stage={stage}")
        if bool(getattr(info, "private", False)):
            api.update_repo_settings(
                repo_id=repo_id,
                repo_type="space",
                private=False,
            )
        if current_sha == target_sha and stage == "RUNNING":
            return
        if current_sha == target_sha and stage in {
            "PAUSED",
            "SLEEPING",
            "STOPPED",
            "RUNTIME_ERROR",
            "BUILD_ERROR",
            "CONFIG_ERROR",
        } and not restarted:
            api.restart_space(
                repo_id=repo_id,
                factory_reboot=stage in {
                    "RUNTIME_ERROR",
                    "BUILD_ERROR",
                    "CONFIG_ERROR",
                },
            )
            restarted = True
        time.sleep(10)
    raise TimeoutError(f"{repo_id} did not become RUNNING at {target_sha}: {last}")

def verify_remote_tree(repo_id: str, expected: list[dict]) -> None:
    verify_dir = Path(tempfile.mkdtemp(prefix="verify-"))
    try:
        local = Path(snapshot_download(
            repo_id=repo_id,
            repo_type="space",
            token=TOKEN,
            local_dir=verify_dir,
            force_download=True,
        ))
        failures = []
        for item in expected:
            path = local / item["path"]
            if not path.is_file():
                failures.append(f"missing:{item['path']}")
                continue
            actual = sha256(path)
            if actual != item["sha256"]:
                failures.append(f"hash:{item['path']}")
        if failures:
            raise RuntimeError(
                f"remote verification failed for {repo_id}: {failures[:20]}"
            )
    finally:
        shutil.rmtree(verify_dir, ignore_errors=True)

def upload_exact(repo_id: str, folder: Path, manifest: dict, message: str) -> str:
    expected = manifest["files"]
    if not expected:
        raise RuntimeError(f"refusing empty upload to {repo_id}")
    api.upload_folder(
        repo_id=repo_id,
        repo_type="space",
        folder_path=str(folder),
        commit_message=message,
        ignore_patterns=[".git/**", "**/.git/**"],
    )
    verify_remote_tree(repo_id, expected)
    target_sha = str(api.repo_info(repo_id=repo_id, repo_type="space").sha)
    if len(target_sha) != 40:
        raise RuntimeError(f"invalid remote revision for {repo_id}: {target_sha!r}")
    wait_space_running(repo_id, target_sha)
    return target_sha

def source_snapshot(repo_id: str, destination: Path) -> tuple[str, dict]:
    info_before = api.repo_info(repo_id=repo_id, repo_type="space")
    source_sha = info_before.sha
    raw = destination / "raw"
    clean = destination / "clean"
    snapshot_download(
        repo_id=repo_id,
        repo_type="space",
        token=TOKEN,
        revision=source_sha,
        local_dir=raw,
        force_download=True,
    )
    manifest = sanitize_tree(raw, clean)
    manifest.update({
        "source": repo_id,
        "source_sha": source_sha,
        "captured_at": now,
        "visibility": "private" if bool(getattr(info_before, "private", False)) else "public",
        "sdk": getattr(info_before, "sdk", None),
    })
    return source_sha, manifest

def current_spaces(author: str) -> dict[str, object]:
    return {
        item.id.split("/", 1)[1]: item
        for item in api.list_spaces(author=author, full=True)
    }

identity = api.whoami(token=TOKEN)
identity_name = str(identity.get("name") or identity.get("fullname") or "")
if identity_name.lower() != PROFILE.lower():
    raise SystemExit(
        f"wrong HF credential identity: expected {PROFILE}, got {identity_name!r}"
    )

workspace = Path(tempfile.mkdtemp(prefix="szl-hf-consolidate-"))
receipt = {
    "schema": "szl.hf-space-consolidation.predelete.v3",
    "started_at": now,
    "organization": ORG,
    "profile": PROFILE,
    "protected": sorted(PROTECTED),
    "creative": [],
    "consolidated": [],
    "deleted": [],
    "mode": "PRESERVE_AND_VERIFY_ONLY",
}

try:
    # 1. Publish the creative experiences from their GitHub sources of truth.
    for slug, url in CREATIVE_SOURCES.items():
        repo_root = workspace / "creative-src" / slug
        clean_root = workspace / "creative-clean" / slug
        repo_root.parent.mkdir(parents=True, exist_ok=True)
        revision = clone_github(url, repo_root)
        prepare_creator_source(repo_root, slug, revision)
        creative_manifest = sanitize_tree(repo_root, clean_root)
        creative_manifest.update({
            "source": url,
            "source_sha": revision,
            "captured_at": now,
            "destination": f"{PROFILE}/{slug}",
        })
        # Preserve proof of the move inside the destination itself.
        proof = clean_root / "MIGRATION_RECEIPT.json"
        proof.write_text(
            json.dumps(creative_manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        creative_manifest["files"].append({
            "path": "MIGRATION_RECEIPT.json",
            "sha256": sha256(proof),
            "bytes": proof.stat().st_size,
        })
        creative_manifest["file_count"] = len(creative_manifest["files"])
        creative_manifest["bytes"] = sum(x["bytes"] for x in creative_manifest["files"])
        destination = f"{PROFILE}/{slug}"
        ensure_public_space(destination, sdk="docker")
        destination_sha = upload_exact(
            destination,
            clean_root,
            creative_manifest,
            f"Move {slug} to public creator profile ({revision[:12]})",
        )
        creative_manifest["destination_sha"] = destination_sha
        receipt["creative"].append(creative_manifest)
        log(f"CREATIVE VERIFIED {destination} @ {revision[:12]}")

    # 2. Capture every non-flagship org Space. Creative aliases get their own
    #    public-profile destination; all other utilities go into one command centre.
    initial = current_spaces(ORG)
    non_flagships = sorted(set(initial) - PROTECTED)
    command_stage = workspace / "command-centre"
    archive_root = command_stage / "archive"
    archive_root.mkdir(parents=True, exist_ok=True)
    source_shas = {}

    for slug in non_flagships:
        source_id = f"{ORG}/{slug}"
        temp = workspace / "org-snapshots" / slug
        temp.mkdir(parents=True, exist_ok=True)
        source_sha, source_manifest = source_snapshot(source_id, temp)
        source_shas[slug] = source_sha

        archive_prefix = (
            f"archive/creative-org-mirrors/{slug}"
            if slug in CREATIVE_ORG_ALIASES
            else f"archive/{slug}"
        )
        destination = command_stage / archive_prefix
        shutil.copytree(temp / "clean", destination, dirs_exist_ok=True)
        source_manifest["destination"] = f"{COMMAND_REPO}/tree/main/{archive_prefix}"
        source_manifest["archive_prefix"] = archive_prefix
        source_manifest["classification"] = (
            "CREATIVE_ORG_MIRROR"
            if slug in CREATIVE_ORG_ALIASES
            else "CONSOLIDATED_UTILITY"
        )
        receipt["consolidated"].append(source_manifest)
        log(
            f"ARCHIVED LOCALLY {source_id} files={source_manifest['file_count']} "
            f"bytes={source_manifest['bytes']}"
        )

        # Aliases without a GitHub source of truth are also made runnable as-is.
        if slug in CREATIVE_ORG_ALIASES and slug not in CREATIVE_SOURCES:
            destination_id = f"{PROFILE}/{slug}"
            clean = temp / "clean"
            source_manifest["profile_destination"] = destination_id
            sdk = source_manifest.get("sdk") or "docker"
            ensure_public_space(destination_id, sdk=sdk)
            destination_sha = upload_exact(
                destination_id,
                clean,
                source_manifest,
                f"Move {source_id} to public creator profile",
            )
            creative_copy = dict(source_manifest)
            creative_copy["destination"] = destination_id
            creative_copy["destination_sha"] = destination_sha
            receipt["creative"].append(creative_copy)
            log(f"CREATIVE VERIFIED {source_id} -> {destination_id}")

    # 3. Generate the single public archive/launcher Space.
    inventory = {
        "schema": "szl.command-centre.inventory.v2",
        "generated_at": now,
        "organization": ORG,
        "profile": PROFILE,
        "protected_org_spaces": sorted(PROTECTED & set(initial)),
        "consolidated_spaces": receipt["consolidated"],
        "creative_profile_spaces": [
            {
                "source": item["source"],
                "destination": item["destination"],
                "source_sha": item["source_sha"],
                "file_count": item["file_count"],
                "bytes": item["bytes"],
                "unresolved_lfs": item["unresolved_lfs"],
            }
            for item in receipt["creative"]
        ],
    }
    (command_stage / "manifest.json").write_text(
        json.dumps(inventory, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    readme = """---
title: SZL Command Centre
emoji: 🛰️
colorFrom: gray
colorTo: indigo
sdk: static
app_file: index.html
pinned: true
license: apache-2.0
short_description: One public launcher and preserved source vault for SZL experiments
---

# SZL Command Centre

One personal-profile surface for experiments, benchmarks, demos, and preserved
source that do not belong in the SZL Holdings flagship organization.

Every archived source tree is stored under `archive/` with a SHA-256 manifest.
Creative experiences remain separately runnable on the public creator profile.
"""
    (command_stage / "README.md").write_text(readme, encoding="utf-8")

    cards = []
    for item in receipt["consolidated"]:
        slug = item["source"].split("/", 1)[1]
        cards.append(
            f"""<article class="card">
              <div class="eyebrow">{html.escape(item["classification"].replace("_", " "))}</div>
              <h2>{html.escape(slug.replace("-", " ").title())}</h2>
              <p>{item["file_count"]} files · {item["bytes"]:,} bytes preserved</p>
              <div class="sha">SOURCE {html.escape(item["source_sha"][:12])}</div>
              <a target="_blank" rel="noopener" href="https://huggingface.co/spaces/{PROFILE}/szl-command-centre/tree/main/{html.escape(item['archive_prefix'])}">Browse source archive →</a>
            </article>"""
        )
    creative_cards = []
    seen_creative = set()
    for item in receipt["creative"]:
        destination = item["destination"]
        if destination in seen_creative:
            continue
        seen_creative.add(destination)
        slug = destination.split("/", 1)[1]
        creative_cards.append(
            f"""<article class="card creative">
              <div class="eyebrow">PUBLIC CREATIVE SPACE</div>
              <h2>{html.escape(slug.replace("-", " ").title())}</h2>
              <p>Runnable experience moved out of the company organization.</p>
              <div class="sha">SOURCE {html.escape(item["source_sha"][:12])}</div>
              <a target="_blank" rel="noopener" href="https://huggingface.co/spaces/{html.escape(destination)}">Open Space →</a>
            </article>"""
        )

    index = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>SZL Command Centre</title>
<style>
:root{{--bg:#05070c;--panel:#0b101b;--line:#263249;--text:#edf4ff;--muted:#91a0b8;--glow:#76e7ff;--violet:#a58bff}}
*{{box-sizing:border-box}} body{{margin:0;background:radial-gradient(circle at 70% 0,#17233b 0,transparent 34%),var(--bg);color:var(--text);font:15px/1.6 Inter,ui-sans-serif,system-ui,sans-serif}}
main{{width:min(1180px,calc(100% - 32px));margin:auto;padding:72px 0 96px}}
nav{{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:64px;color:var(--muted);font-size:12px;letter-spacing:.14em;text-transform:uppercase}}
.pulse{{width:9px;height:9px;border-radius:50%;display:inline-block;background:var(--glow);box-shadow:0 0 18px var(--glow);margin-right:10px}}
h1{{font-size:clamp(44px,8vw,96px);line-height:.95;letter-spacing:-.06em;margin:0;max-width:900px}}
.lede{{max-width:720px;color:var(--muted);font-size:clamp(17px,2vw,22px);margin:28px 0 56px}}
section{{margin-top:56px}} .label{{font-size:11px;letter-spacing:.18em;color:var(--glow);text-transform:uppercase;margin-bottom:16px}}
.grid{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}}
.card{{min-height:250px;padding:25px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(145deg,rgba(19,28,46,.86),rgba(8,12,21,.92));display:flex;flex-direction:column;transition:.2s transform,.2s border-color}}
.card:hover{{transform:translateY(-3px);border-color:#54719d}} .card.creative{{box-shadow:inset 0 1px 0 rgba(165,139,255,.28)}}
.eyebrow,.sha{{font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.12em;color:var(--muted)}} h2{{font-size:25px;letter-spacing:-.03em;margin:28px 0 8px}}
.card p{{color:var(--muted);margin:0 0 24px}} .sha{{margin-top:auto}} a{{color:var(--text);text-decoration:none;margin-top:15px}} a:hover{{color:var(--glow)}}
footer{{margin-top:72px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);display:flex;justify-content:space-between;gap:16px}}
@media(max-width:860px){{.grid{{grid-template-columns:1fr 1fr}}}} @media(max-width:560px){{main{{padding-top:32px}}nav,footer{{align-items:flex-start;flex-direction:column}}.grid{{grid-template-columns:1fr}}.card{{min-height:220px}}}}
@media(prefers-reduced-motion:reduce){{*{{scroll-behavior:auto!important;transition:none!important}}}}
</style>
</head>
<body><main>
<nav><span><i class="pulse"></i>SZL / CREATOR PROFILE</span><span>VERIFIED {html.escape(now[:10])}</span></nav>
<h1>One front door.<br>Nothing lost.</h1>
<p class="lede">Flagship products stay focused in the SZL Holdings organization. Experiments and utilities are preserved here with source revisions and integrity manifests.</p>
<section><div class="label">Creative experiences</div><div class="grid">{''.join(creative_cards) or '<p>No creative migrations in this run.</p>'}</div></section>
<section><div class="label">Consolidated source vault</div><div class="grid">{''.join(cards) or '<p>The org contains only flagships.</p>'}</div></section>
<footer><span>Proof before pitch.</span><a href="./manifest.json">Open machine-readable inventory →</a></footer>
</main></body></html>"""
    (command_stage / "index.html").write_text(index, encoding="utf-8")

    command_manifest = sanitize_tree(command_stage, workspace / "command-upload")
    ensure_public_space(COMMAND_REPO, sdk="static")
    command_sha = upload_exact(
        COMMAND_REPO,
        workspace / "command-upload",
        command_manifest,
        "Consolidate non-flagship SZL Spaces into one verified public surface",
    )
    receipt["command_centre_revision"] = command_sha
    log(f"COMMAND CENTRE VERIFIED {COMMAND_REPO} @ {command_sha[:12]}")

    # 4. No-delete boundary: recheck every source revision and the full org set.
    before_delete = current_spaces(ORG)
    if set(before_delete) != set(initial):
        raise RuntimeError(
            "org inventory changed during migration; refusing deletion: "
            f"initial={sorted(initial)} current={sorted(before_delete)}"
        )
    for slug, expected_sha in source_shas.items():
        actual_sha = api.repo_info(
            repo_id=f"{ORG}/{slug}",
            repo_type="space",
        ).sha
        if actual_sha != expected_sha:
            raise RuntimeError(
                f"{ORG}/{slug} changed during migration "
                f"({expected_sha} -> {actual_sha}); refusing deletion"
            )

    # 5. Publish an exact pre-delete receipt. This phase performs no org deletion.
    remaining = current_spaces(ORG)
    receipt["completed_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    receipt["remaining_org_spaces"] = sorted(remaining)
    receipt["victims"] = [f"{ORG}/{slug}" for slug in non_flagships]
    receipt["expected_source_revisions"] = {
        f"{ORG}/{slug}": source_shas[slug] for slug in non_flagships
    }
    receipt["status"] = "PRESERVED_AND_READY_FOR_EXACT_DELETE"
    receipt_path = workspace / "HF_SPACE_CONSOLIDATION_PREDELETE_RECEIPT.json"
    receipt_path.write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    final_commit = api.upload_file(
        repo_id=COMMAND_REPO,
        repo_type="space",
        path_or_fileobj=str(receipt_path),
        path_in_repo="HF_SPACE_CONSOLIDATION_PREDELETE_RECEIPT.json",
        commit_message="Publish verified pre-delete Space consolidation receipt",
    )
    final_sha = str(final_commit.oid)
    if len(final_sha) != 40:
        raise RuntimeError(f"invalid final command-centre revision: {final_sha!r}")
    final_receipt_local = Path(snapshot_download(
        repo_id=COMMAND_REPO,
        repo_type="space",
        token=TOKEN,
        revision=final_sha,
        allow_patterns=["HF_SPACE_CONSOLIDATION_PREDELETE_RECEIPT.json"],
        force_download=True,
    )) / "HF_SPACE_CONSOLIDATION_PREDELETE_RECEIPT.json"
    if not final_receipt_local.is_file() or sha256(final_receipt_local) != sha256(receipt_path):
        raise RuntimeError("pre-delete command-centre receipt failed remote read-back")
    wait_space_running(COMMAND_REPO, final_sha)
    log("PREDELETE RECEIPT " + json.dumps({
        "status": receipt["status"],
        "victim_count": len(receipt["victims"]),
        "remaining_org_spaces": receipt["remaining_org_spaces"],
        "creative_destinations": sorted({
            item["destination"] for item in receipt["creative"]
        }),
        "command_centre": COMMAND_REPO,
        "command_centre_revision": final_sha,
    }, sort_keys=True))
finally:
    shutil.rmtree(workspace, ignore_errors=True)
