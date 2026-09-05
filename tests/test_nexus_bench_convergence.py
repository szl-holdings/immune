# SPDX-License-Identifier: Apache-2.0
"""Offline contracts for the NEXUS and Bench convergence operator."""
from __future__ import annotations

import importlib.util
import json
import os
import urllib.error
from pathlib import Path
from types import SimpleNamespace

import pytest

os.environ.setdefault("HF_TOKEN", "offline-test-token")
SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "nexus_bench_stage1.py"
SPEC = importlib.util.spec_from_file_location("nexus_bench_stage1_contract", SCRIPT)
operator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(operator)


class Response:
    status = 200

    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self) -> "Response":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self, limit: int = -1) -> bytes:
        return self._body if limit < 0 else self._body[:limit]


def test_space_origin_accepts_provider_subdomain_and_full_host() -> None:
    assert operator.space_origin(
        SimpleNamespace(subdomain="betterwithage-szl-bench-suite"),
        "betterwithage/szl-bench-suite",
    ) == "https://betterwithage-szl-bench-suite.hf.space"
    assert operator.space_origin(
        SimpleNamespace(subdomain="betterwithage-szl-bench-suite.hf.space"),
        "betterwithage/szl-bench-suite",
    ) == "https://betterwithage-szl-bench-suite.hf.space"


def test_space_origin_rejects_untrusted_scheme_or_host() -> None:
    with pytest.raises(RuntimeError, match="scheme"):
        operator.space_origin(
            SimpleNamespace(subdomain="http://example.invalid"),
            "betterwithage/szl-bench-suite",
        )
    with pytest.raises(RuntimeError, match="subdomain"):
        operator.space_origin(
            SimpleNamespace(subdomain="example.invalid"),
            "betterwithage/szl-bench-suite",
        )


def test_live_identity_retries_transient_404_then_proves_marker() -> None:
    original_api = operator.api
    operator.api = SimpleNamespace(
        space_info=lambda _repo_id: SimpleNamespace(
            subdomain="betterwithage-szl-bench-suite"
        )
    )
    calls: list[str] = []
    sleeps: list[float] = []

    def opener(request, *, timeout: float):
        calls.append(request.full_url)
        assert timeout == 45
        if len(calls) == 1:
            raise urllib.error.HTTPError(
                request.full_url, 404, "Not Found", {}, None
            )
        return Response(b"<title>SZL Bench Suite</title>")

    try:
        result = operator.wait_live_identity(
            "betterwithage/szl-bench-suite",
            "a" * 40,
            "SZL Bench Suite",
            attempts=2,
            delay=0.25,
            opener=opener,
            sleeper=sleeps.append,
        )
    finally:
        operator.api = original_api

    assert result["http"] == 200
    assert result["attempts"] == 2
    assert result["origin"] == "https://betterwithage-szl-bench-suite.hf.space"
    assert sleeps == [0.25]
    assert all("source_verify=" + "a" * 40 in url for url in calls)


def test_live_identity_fails_closed_after_bounded_transient_errors() -> None:
    original_api = operator.api
    operator.api = SimpleNamespace(
        space_info=lambda _repo_id: SimpleNamespace(
            subdomain="betterwithage-szl-bench-suite"
        )
    )

    def opener(request, *, timeout: float):
        raise urllib.error.HTTPError(request.full_url, 503, "Unavailable", {}, None)

    try:
        with pytest.raises(TimeoutError, match="live identity did not converge"):
            operator.wait_live_identity(
                "betterwithage/szl-bench-suite",
                "b" * 40,
                "SZL Bench Suite",
                attempts=2,
                delay=0,
                opener=opener,
                sleeper=lambda _seconds: None,
            )
    finally:
        operator.api = original_api


def test_hub_site_match_prevents_republishing_identical_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    site = tmp_path / "site"
    site.mkdir()
    (site / "index.html").write_bytes(b"<h1>SZL Bench Suite</h1>")
    (site / "results.json").write_bytes(b"{}\n")
    remote = tmp_path / "remote"
    remote.mkdir()
    (remote / "index.html").write_bytes((site / "index.html").read_bytes())
    (remote / "results.json").write_bytes((site / "results.json").read_bytes())

    original_api = operator.api
    operator.api = SimpleNamespace(
        list_repo_files=lambda *_args, **_kwargs: [
            ".gitattributes",
            "index.html",
            "results.json",
        ]
    )
    monkeypatch.setattr(
        operator,
        "hf_hub_download",
        lambda _repo_id, name, **_kwargs: str(remote / name),
    )
    try:
        assert operator.hub_site_matches(
            "betterwithage/szl-bench-suite",
            "c" * 40,
            site,
            {"index.html", "results.json"},
        )
        (remote / "results.json").write_bytes(b'{"changed":true}\n')
        assert not operator.hub_site_matches(
            "betterwithage/szl-bench-suite",
            "c" * 40,
            site,
            {"index.html", "results.json"},
        )
    finally:
        operator.api = original_api


def test_failure_receipt_is_written_and_self_hashes(tmp_path: Path) -> None:
    original_report = operator.REPORT
    operator.REPORT = tmp_path / "reports" / "stage1.json"
    report = {
        "schema": "szl.nexus-bench-stage1/v1",
        "state": "FAILED",
        "failure": {"type": "HTTPError", "message": "HTTP Error 404"},
        "secret_values_recorded": False,
    }
    try:
        digest = operator.persist_report(report)
        stored = json.loads(operator.REPORT.read_text(encoding="utf-8"))
    finally:
        operator.REPORT = original_report

    assert len(digest) == 64
    assert stored["report_sha256"] == digest
    assert stored["state"] == "FAILED"
    assert stored["secret_values_recorded"] is False
