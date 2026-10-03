# Copyright 2026 SZL Holdings — SPDX-License-Identifier: Apache-2.0
"""Fail-closed live attestation for one IMMUNE Space after publication.

Reads the publication-boundary receipt written by ``publish_existing`` and then
uses only public, unauthenticated Hugging Face endpoints. It performs no
provider mutation and never reads a credential.

A publication is LIVE_VERIFIED only when all of these hold:

* the Space API reports the receipt's ``hub_commit`` as both the repository
  head and the running build (``runtime.sha``), with stage RUNNING;
* every smoke path on the Space host answers exact HTTP 200 with a body.

The optional blocked-readiness witness is a narrower source-live observation:
ordinary smoke paths still require HTTP 200, while /readyz must return a
source-bound, fail-closed HTTP 503 contract. That outcome never grants action
readiness or produces an external-authority release receipt.

A terminal build or runtime stage at the published commit, a paused or
quota-blocked Space, or a timeout (which includes a head superseded by another
commit) fails the run. The outcome is written to a receipt either way.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from scripts.assert_hf_space_operational import (
    SpaceOperationalBlocker,
    inspect_space_state,
)

API_ROOT = "https://huggingface.co/api/spaces/"
OWNED_SPACES = frozenset({"SZLHOLDINGS/immune", "SZLHOLDINGS/immune-lattice"})
TERMINAL_STAGES = frozenset({"BUILD_ERROR", "CONFIG_ERROR", "RUNTIME_ERROR"})
SHA = re.compile(r"[0-9a-f]{40}")
MAX_BODY_BYTES = 2_000_000
MAX_READINESS_BYTES = 65_536
USER_AGENT = "szl-immune-live-attestation/1"
CHANNEL_A_BLOCKERS = frozenset({
    "DEPLOYMENT_REVISION_BINDING_UNVERIFIED",
    "ACTION_AUTHORITY_READ_ONLY",
    "ACTION_AUTHORITY_UNAVAILABLE",
    "ACTION_AUTHORITY_DURABILITY_UNVERIFIED",
    "RECEIPT_LEDGER_DURABILITY_UNVERIFIED",
})
CHANNEL_B_BLOCKERS = frozenset({
    "RECEIPT_LEDGER_EMPTY", "ACTION_AUTHORITY_UNAVAILABLE",
})

Fetch = Callable[[str], tuple[int, bytes]]


class AttestationError(RuntimeError):
    """A sanitized failure code plus bounded detail; never provider secrets."""

    def __init__(self, message: str, *, observations: list[dict[str, Any]] | None = None):
        super().__init__(message)
        self.observations = observations


def space_host(space: str) -> str:
    if space not in OWNED_SPACES:
        raise AttestationError("UNSUPPORTED_SPACE")
    return "https://" + space.replace("/", "-").lower() + ".hf.space"


def http_get(url: str, timeout: float = 30.0) -> tuple[int, bytes]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Cache-Control": "no-cache"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(MAX_BODY_BYTES + 1)
    except urllib.error.HTTPError as error:
        try:
            return error.code, error.read(MAX_BODY_BYTES + 1)
        finally:
            error.close()


def readiness_diagnostic(body: bytes) -> dict[str, Any] | None:
    """Keep declared readiness fields, never an arbitrary response body."""
    if len(body) > MAX_BODY_BYTES:
        return None
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("schema") != "szl.immune-readiness/v1":
        return None
    result: dict[str, Any] = {"schema": payload["schema"]}
    if payload.get("status") in ("READY", "READ_ONLY", "NOT_READY"):
        result["status"] = payload["status"]
    for key in ("ready", "runtime_ready", "read_ready", "authority_ready", "write_ready"):
        if type(payload.get(key)) is bool:
            result[key] = payload[key]
    blockers = payload.get("blockers")
    if isinstance(blockers, list) and len(blockers) <= 32 and all(
        isinstance(code, str) and re.fullmatch(r"[A-Z0-9_]{1,80}", code)
        for code in blockers
    ):
        result["blockers"] = blockers
    return result


def unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def load_publication(path: Path, space: str) -> dict[str, str]:
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise AttestationError("PUBLICATION_RECEIPT_UNAVAILABLE") from None
    if not isinstance(receipt, dict) or receipt.get("space") != space:
        raise AttestationError("PUBLICATION_RECEIPT_SPACE_MISMATCH")
    if receipt.get("state") != "COMMITTED_LIVE_UNVERIFIED":
        raise AttestationError("PUBLICATION_NOT_COMMITTED")
    hub_commit = receipt.get("hub_commit")
    source = receipt.get("source_revision")
    if not isinstance(hub_commit, str) or not SHA.fullmatch(hub_commit):
        raise AttestationError("PUBLICATION_RECEIPT_INVALID_COMMIT")
    if not isinstance(source, str) or not SHA.fullmatch(source):
        raise AttestationError("PUBLICATION_RECEIPT_INVALID_SOURCE")
    return {"hub_commit": hub_commit, "source_revision": source}


def wait_running(
    space: str,
    expected: str,
    *,
    timeout: float,
    poll: float,
    fetch: Fetch = http_get,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, str]:
    """Poll until the exact published commit is the running build."""
    deadline = clock() + timeout
    last = "no observation"
    while True:
        status, body = fetch(API_ROOT + space)
        if status == 200:
            try:
                payload: Any = json.loads(body.decode("utf-8"))
            except ValueError:
                payload = None
            try:
                observation = inspect_space_state(payload, expected)
            except SpaceOperationalBlocker as blocker:
                if str(blocker).startswith(
                    ("HF_SPACE_PAUSED", "HF_SPACE_QUOTA_EXCEEDED")
                ):
                    raise AttestationError(str(blocker)) from None
                last = str(blocker)
            else:
                runtime = payload.get("runtime") or {}
                running_sha = str(runtime.get("sha") or "")
                state = {
                    "stage": observation.stage,
                    "repo_sha": observation.observed_revision,
                    "runtime_sha": running_sha,
                }
                last = json.dumps(state, sort_keys=True)
                # A head that differs from the publication can be API lag right
                # after the commit, so it is polled, never accepted. If another
                # writer superseded this commit the poll times out and fails.
                if (
                    observation.revision_matches
                    and observation.stage in TERMINAL_STAGES
                ):
                    raise AttestationError(
                        f"HF_SPACE_{observation.stage}: {last} "
                        f"provider_error={observation.provider_error or '<none>'}"
                    )
                if (
                    observation.revision_matches
                    and observation.stage == "RUNNING"
                    and running_sha == expected
                ):
                    return state
        else:
            last = f"space API HTTP {status}"
        if clock() >= deadline:
            raise AttestationError(f"HF_SPACE_RUNNING_TIMEOUT: {last}")
        sleep(poll)


def smoke(
    space: str,
    paths: list[str],
    *,
    attempts: int = 3,
    pause: float = 10.0,
    fetch: Fetch = http_get,
    sleep: Callable[[float], None] = time.sleep,
) -> list[dict[str, Any]]:
    host = space_host(space)
    results = []
    for path in paths:
        if not path.startswith("/") or "//" in path or ".." in path:
            raise AttestationError(f"INVALID_SMOKE_PATH: {path!r}")
        status, body = 0, b""
        for attempt in range(attempts):
            status, body = fetch(host + path)
            if status == 200 and body and len(body) <= MAX_BODY_BYTES:
                break
            if attempt + 1 < attempts:
                sleep(pause)
        observation: dict[str, Any] = {
            "path": path,
            "status": status,
            "bytes": len(body),
            "body_sha256": hashlib.sha256(body).hexdigest(),
        }
        if path == "/readyz":
            diagnostic = readiness_diagnostic(body)
            if diagnostic is not None:
                observation["readiness"] = diagnostic
        results.append(observation)
        if status != 200 or not body or len(body) > MAX_BODY_BYTES:
            raise AttestationError(
                f"SMOKE_FAILED: {path} HTTP {status} bytes={len(body)}",
                observations=results,
            )
    return results


def blocked_readiness(
    space: str,
    expected_source: str,
    *,
    fetch: Fetch = http_get,
) -> dict[str, Any]:
    """Observe only a known 503 readiness contract at the exact running source.

    This does not satisfy action readiness, evidence durability, or authority
    qualification. Unknown blockers and contradictory green fields fail closed.
    """
    if not SHA.fullmatch(expected_source):
        raise AttestationError("INVALID_EXPECTED_SOURCE")
    try:
        status, body = fetch(space_host(space) + "/readyz")
    except (OSError, TimeoutError, urllib.error.URLError):
        raise AttestationError("BLOCKED_READINESS_FETCH_FAILED") from None
    observation: dict[str, Any] = {
        "path": "/readyz",
        "status": status,
        "bytes": len(body),
        "body_sha256": hashlib.sha256(body).hexdigest(),
    }

    def refuse(code: str) -> None:
        raise AttestationError(code, observations=[observation])

    if status != 503 or not body or len(body) > MAX_READINESS_BYTES:
        refuse("BLOCKED_READINESS_HTTP_OR_SIZE_INVALID")
    try:
        payload = json.loads(body.decode("utf-8"), object_pairs_hook=unique_json_object)
    except (UnicodeError, ValueError):
        refuse("BLOCKED_READINESS_JSON_INVALID")
    if not isinstance(payload, dict) or payload.get("schema") != "szl.immune-readiness/v1":
        refuse("BLOCKED_READINESS_SCHEMA_INVALID")
    if (
        payload.get("status") not in ("READ_ONLY", "NOT_READY")
        or any(payload.get(key) is not False for key in
               ("ready", "authority_ready", "write_ready"))
        or ("ok" in payload and payload["ok"] is not False)
        or payload.get("live_operator") is True
        or payload.get("demo_operator") is True
    ):
        refuse("BLOCKED_READINESS_STATE_INVALID")
    read_ready = payload.get("status") == "READ_ONLY"
    if payload.get("runtime_ready") is not read_ready or payload.get("read_ready") is not read_ready:
        refuse("BLOCKED_READINESS_READ_STATE_INVALID")
    source = payload.get("source")
    if (
        not isinstance(source, dict)
        or source.get("repository") != "szl-holdings/immune"
        or source.get("revision") != expected_source
    ):
        refuse("BLOCKED_READINESS_SOURCE_INVALID")
    blockers = payload.get("blockers")
    allowed = CHANNEL_A_BLOCKERS if space == "SZLHOLDINGS/immune" else CHANNEL_B_BLOCKERS
    if (
        not isinstance(blockers, list)
        or not 1 <= len(blockers) <= len(allowed)
        or any(type(code) is not str or code not in allowed for code in blockers)
        or len(set(blockers)) != len(blockers)
    ):
        refuse("BLOCKED_READINESS_BLOCKERS_INVALID")
    if space == "SZLHOLDINGS/immune":
        build = payload.get("build")
        runtime = payload.get("runtime")
        integrity = runtime.get("artifact_integrity") if isinstance(runtime, dict) else None
        if (
            source.get("build_revision") != expected_source
            or source.get("manifest_schema") != "szl.hf-deploy-manifest/v2"
            or not isinstance(build, dict)
            or build.get("state") != "OBSERVED_HASH_MATCH"
            or not isinstance(integrity, dict)
            or integrity.get("status") != "MATCH"
        ):
            refuse("BLOCKED_READINESS_BUILD_INVALID")
        if read_ready:
            if source.get("alignment_state") != "OBSERVED_RUNTIME_HASH_MATCH" or "DEPLOYMENT_REVISION_BINDING_UNVERIFIED" in blockers:
                refuse("BLOCKED_READINESS_ALIGNMENT_INVALID")
        elif (
            source.get("alignment_state") != "REVISION_UNAVAILABLE"
            or "DEPLOYMENT_REVISION_BINDING_UNVERIFIED" not in blockers
        ):
            refuse("BLOCKED_READINESS_ALIGNMENT_INVALID")
    else:
        if source.get("channel") != "python" or "ACTION_AUTHORITY_UNAVAILABLE" not in blockers:
            refuse("BLOCKED_READINESS_CHANNEL_INVALID")
        if not read_ready and "RECEIPT_LEDGER_EMPTY" not in blockers:
            refuse("BLOCKED_READINESS_LEDGER_INVALID")
        if read_ready and "RECEIPT_LEDGER_EMPTY" in blockers:
            refuse("BLOCKED_READINESS_LEDGER_INVALID")
    observation["readiness"] = {
        "schema": "szl.immune-readiness/v1",
        "status": payload["status"],
        "source_revision": expected_source,
        "ready": False,
        "runtime_ready": read_ready,
        "read_ready": read_ready,
        "authority_ready": False,
        "write_ready": False,
        "blockers": blockers,
    }
    return observation


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--space", required=True, choices=sorted(OWNED_SPACES))
    parser.add_argument("--publication-receipt", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--timeout", type=float, default=1200.0)
    parser.add_argument("--poll", type=float, default=15.0)
    parser.add_argument("--smoke-path", action="append", default=[], dest="smoke_paths")
    parser.add_argument("--blocked-readiness", action="store_true")
    args = parser.parse_args(argv)
    if not args.smoke_paths:
        parser.error("at least one --smoke-path is required")
    if args.blocked_readiness and "/readyz" in args.smoke_paths:
        parser.error("/readyz must use only --blocked-readiness")

    report: dict[str, Any] = {
        "schema": "szl.immune.live-attestation/v1",
        "space": args.space,
        "auth": "none (public Hub API and Space host)",
        "live_verified": False,
        "source_live_verified": False,
        "action_ready": False,
    }
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    try:
        published = load_publication(args.publication_receipt, args.space)
        report.update(published)
        report["runtime"] = wait_running(
            args.space, published["hub_commit"], timeout=args.timeout, poll=args.poll
        )
        report["smoke"] = smoke(args.space, args.smoke_paths)
        if args.blocked_readiness:
            report["blocked_readiness"] = blocked_readiness(
                args.space, published["source_revision"]
            )
            report.update(
                state="SOURCE_LIVE_READINESS_BLOCKED",
                source_live_verified=True,
                live_verified=False,
                action_ready=False,
            )
        else:
            report.update(state="LIVE_VERIFIED", live_verified=True)
        code = 0
    except AttestationError as error:
        report.update(state="NOT_VERIFIED", error=str(error)[:1000])
        if error.observations is not None:
            if args.blocked_readiness and "smoke" in report:
                report["blocked_readiness"] = error.observations[0]
            else:
                report["smoke"] = error.observations
        print(f"::error::{args.space}: {str(error)[:1000]}")
        code = 1
    report["observed_at"] = datetime.now(timezone.utc).isoformat()
    args.receipt.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, sort_keys=True))
    return code


if __name__ == "__main__":
    sys.exit(main())
