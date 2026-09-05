#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""One-shot patch for idempotent NEXUS and Bench convergence."""
from __future__ import annotations

from pathlib import Path


TARGET = Path("scripts/nexus_bench_stage1.py")


def replace_exact(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one replacement target, found {count}")
    return text.replace(old, new, 1)


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")

    text = replace_exact(
        text,
        "import time\nimport urllib.request\nimport uuid\n",
        "import time\nimport urllib.error\nimport urllib.request\nimport uuid\n",
        "urllib error import",
    )

    text = replace_exact(
        text,
        '''def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(args: list[str], cwd: Path | None = None) -> str:
''',
        '''def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def persist_report(report: dict[str, Any]) -> str:
    """Write a secret-free self-hashed receipt, including partial failures."""

    snapshot = dict(report)
    snapshot.pop("report_sha256", None)
    encoded = json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode()
    digest = sha(encoded)
    snapshot["report_sha256"] = digest
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\\n")
    report["report_sha256"] = digest
    return digest


def run(args: list[str], cwd: Path | None = None) -> str:
''',
        "partial receipt helper",
    )

    text = replace_exact(
        text,
        '''def stage(info: Any) -> str:
    return str(getattr(getattr(info, "runtime", None), "stage", "") or "").upper()


def wait_space(repo_id: str, revision: str, sdk: str, seconds: int = 900) -> Any:
''',
        '''def stage(info: Any) -> str:
    return str(getattr(getattr(info, "runtime", None), "stage", "") or "").upper()


_SPACE_HOST = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.hf\\.space$")
_TRANSIENT_LIVE_HTTP = frozenset({404, 408, 425, 429, 500, 502, 503, 504})


def space_origin(info: Any, repo_id: str) -> str:
    """Return only the provider-declared HTTPS hf.space origin."""

    raw = str(getattr(info, "subdomain", "") or "").strip().lower().rstrip("/")
    if raw.startswith("http://"):
        raise RuntimeError("insecure Space subdomain scheme")
    if raw.startswith("https://"):
        raw = raw.removeprefix("https://").rstrip("/")
    if not raw:
        raw = repo_id.lower().replace("/", "-")
    if not raw.endswith(".hf.space"):
        raw += ".hf.space"
    if not _SPACE_HOST.fullmatch(raw):
        raise RuntimeError(f"unexpected Hugging Face Space subdomain: {raw}")
    return "https://" + raw


def wait_live_identity(
    repo_id: str,
    revision: str,
    marker: str,
    *,
    attempts: int = 90,
    delay: float = 10.0,
    opener: Any = None,
    sleeper: Any = None,
) -> dict[str, Any]:
    """Bound transient edge propagation and require exact branded identity."""

    if attempts < 1:
        raise ValueError("attempts must be positive")
    open_url = opener or urllib.request.urlopen
    sleep = sleeper or time.sleep
    last: dict[str, Any] = {"http": None, "origin": None, "error": None}
    for attempt in range(1, attempts + 1):
        info = api.space_info(repo_id)
        origin = space_origin(info, repo_id)
        request = urllib.request.Request(
            origin + f"/?source_verify={revision}",
            headers={"Cache-Control": "no-cache", "User-Agent": "szl-bench-stage1/2"},
        )
        try:
            with open_url(request, timeout=45) as response:
                body = response.read(2_000_000).decode("utf-8", "replace")
                status = int(response.status)
            last = {"http": status, "origin": origin, "error": None}
            if status == 200 and marker in body:
                return {**last, "attempts": attempt}
            if status not in _TRANSIENT_LIVE_HTTP:
                raise RuntimeError(f"unexpected Bench live HTTP status: {status}")
        except urllib.error.HTTPError as exc:
            last = {"http": exc.code, "origin": origin, "error": type(exc).__name__}
            if exc.code not in _TRANSIENT_LIVE_HTTP:
                raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = {"http": None, "origin": origin, "error": type(exc).__name__}
        if attempt < attempts:
            sleep(delay)
    raise TimeoutError(
        "Bench live identity did not converge: "
        + json.dumps(last, sort_keys=True, separators=(",", ":"))
    )


def hub_site_matches(
    repo_id: str,
    revision: str,
    site: Path,
    expected_paths: set[str],
) -> bool:
    """Return true only when the complete tracked static payload is byte-identical."""

    remote = set(api.list_repo_files(repo_id, repo_type="space")) - {".gitattributes"}
    if remote != expected_paths:
        return False
    for relative in sorted(expected_paths):
        local = hf_hub_download(
            repo_id,
            relative,
            repo_type="space",
            revision=revision,
            token=TOKEN,
        )
        if Path(local).read_bytes() != (site / relative).read_bytes():
            return False
    return True


def wait_space(repo_id: str, revision: str, sdk: str, seconds: int = 900) -> Any:
''',
        "live identity helpers",
    )

    text = replace_exact(
        text,
        '''        operations: list[Any] = [
            CommitOperationAdd(path.relative_to(site).as_posix(), str(path))
            for path in files
        ]
        for remote in sorted(set(api.list_repo_files(BENCH, repo_type="space")) - keep - {".gitattributes"}):
            operations.append(CommitOperationDelete(remote))
        commit = api.create_commit(
            BENCH,
            operations=operations,
            repo_type="space",
            parent_commit=info.sha,
            commit_message="fix: publish source-bound consolidated Bench Suite",
        )
        after = commit.oid
''',
        '''        published = not hub_site_matches(BENCH, info.sha, site, keep)
        if published:
            operations: list[Any] = [
                CommitOperationAdd(path.relative_to(site).as_posix(), str(path))
                for path in files
            ]
            for remote in sorted(
                set(api.list_repo_files(BENCH, repo_type="space"))
                - keep
                - {".gitattributes"}
            ):
                operations.append(CommitOperationDelete(remote))
            commit = api.create_commit(
                BENCH,
                operations=operations,
                repo_type="space",
                parent_commit=info.sha,
                commit_message="fix: publish source-bound consolidated Bench Suite",
            )
            after = commit.oid
        else:
            after = info.sha
''',
        "idempotent Bench publication",
    )

    text = replace_exact(
        text,
        '''        req = urllib.request.Request(
            BENCH_LIVE + f"/?source_verify={after}",
            headers={"Cache-Control": "no-cache", "User-Agent": "szl-bench-stage1/1"},
        )
        with urllib.request.urlopen(req, timeout=45) as response:
            body = response.read(2_000_000).decode("utf-8", "replace")
            status = response.status
        if status != 200 or "SZL Bench Suite" not in body:
            raise RuntimeError("Bench live identity failed")

        report["bench"] = {
''',
        '''        live = wait_live_identity(BENCH, after, "SZL Bench Suite")
        status = int(live["http"])

        report["bench"] = {
''',
        "bounded Bench live proof",
    )

    text = replace_exact(
        text,
        '''            "live_http": status,
            "source_revisions": revisions,
''',
        '''            "live_http": status,
            "live_origin": live["origin"],
            "live_attempts": live["attempts"],
            "published": published,
            "source_revisions": revisions,
''',
        "Bench receipt fields",
    )

    text = replace_exact(
        text,
        '''    report: dict[str, Any] = {
        "schema": "szl.nexus-bench-stage1/v1",
        "started_at": now(),
        "credential_identity": identity.get("name"),
        "secret_values_recorded": False,
        "visibility_changed": False,
    }
    archive_probe(report)
    repair_bench(report)
    verify_current_immune(report)
    report["state"] = "PRESERVED_REPAIRED_AND_VERIFIED"
    report["finished_at"] = now()
    encoded = json.dumps(report, sort_keys=True, separators=(",", ":")).encode()
    report["report_sha256"] = sha(encoded)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\\n")
    print(json.dumps({"state": report["state"], "report_sha256": report["report_sha256"]}))
    return 0
''',
        '''    report: dict[str, Any] = {
        "schema": "szl.nexus-bench-stage1/v1",
        "started_at": now(),
        "credential_identity": identity.get("name"),
        "secret_values_recorded": False,
        "visibility_changed": False,
        "completed_stages": [],
    }
    try:
        archive_probe(report)
        report["completed_stages"].append("NEXUS_ARCHIVED_AND_VERIFIED")
        persist_report(report)
        repair_bench(report)
        report["completed_stages"].append("BENCH_SOURCE_BOUND_AND_LIVE")
        persist_report(report)
        verify_current_immune(report)
        report["completed_stages"].append("IMMUNE_CURRENT_AND_EXECUTABLE")
    except Exception as exc:
        report["state"] = "FAILED"
        report["failure"] = {
            "type": type(exc).__name__,
            "message": str(exc),
        }
        report["finished_at"] = now()
        digest = persist_report(report)
        print(json.dumps({"state": report["state"], "report_sha256": digest}))
        raise
    report["state"] = "PRESERVED_REPAIRED_AND_VERIFIED"
    report["finished_at"] = now()
    digest = persist_report(report)
    print(json.dumps({"state": report["state"], "report_sha256": digest}))
    return 0
''',
        "durable staged receipts",
    )

    TARGET.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
