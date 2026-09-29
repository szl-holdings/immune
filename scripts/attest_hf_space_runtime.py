# Copyright 2026 SZL Holdings — SPDX-License-Identifier: Apache-2.0
"""Fail-closed live attestation for one IMMUNE Space after publication.

Reads the publication-boundary receipt written by ``publish_existing`` and then
uses only public, unauthenticated Hugging Face endpoints. It performs no
provider mutation and never reads a credential.

A publication is LIVE_VERIFIED only when all of these hold:

* the Space API reports the receipt's ``hub_commit`` as both the repository
  head and the running build (``runtime.sha``), with stage RUNNING;
* every smoke path on the Space host answers exact HTTP 200 with a body.

A terminal build or runtime stage at the published commit, a paused or
quota-blocked Space, or a timeout (which includes a head superseded by another
commit) fails the run. The outcome is written to a receipt either way.
"""

from __future__ import annotations

import argparse
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
USER_AGENT = "szl-immune-live-attestation/1"

Fetch = Callable[[str], tuple[int, bytes]]


class AttestationError(RuntimeError):
    """A sanitized failure code plus bounded detail; never provider secrets."""


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
        return error.code, b""


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
            if status == 200 and body:
                break
            if attempt + 1 < attempts:
                sleep(pause)
        results.append({"path": path, "status": status, "bytes": len(body)})
        if status != 200 or not body:
            raise AttestationError(
                f"SMOKE_FAILED: {path} HTTP {status} bytes={len(body)}"
            )
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--space", required=True, choices=sorted(OWNED_SPACES))
    parser.add_argument("--publication-receipt", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--timeout", type=float, default=1200.0)
    parser.add_argument("--poll", type=float, default=15.0)
    parser.add_argument("--smoke-path", action="append", default=[], dest="smoke_paths")
    args = parser.parse_args(argv)
    if not args.smoke_paths:
        parser.error("at least one --smoke-path is required")

    report: dict[str, Any] = {
        "schema": "szl.immune.live-attestation/v1",
        "space": args.space,
        "auth": "none (public Hub API and Space host)",
        "live_verified": False,
    }
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    try:
        published = load_publication(args.publication_receipt, args.space)
        report.update(published)
        report["runtime"] = wait_running(
            args.space, published["hub_commit"], timeout=args.timeout, poll=args.poll
        )
        report["smoke"] = smoke(args.space, args.smoke_paths)
        report.update(state="LIVE_VERIFIED", live_verified=True)
        code = 0
    except AttestationError as error:
        report.update(state="NOT_VERIFIED", error=str(error)[:1000])
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
