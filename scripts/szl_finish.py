#!/usr/bin/env python3
"""SZL closer. Inventory + gates. Does not invent LIVE."""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any

UA = {"User-Agent": "szl-finish/2026-09-04"}
A = "https://szlholdings-immune.hf.space"
B = "https://szlholdings-immune-lattice.hf.space"
TAB = "https://a-11-oy.com/immune"
LORENZ_IN = "c5fcc5029392a5e4f7cd65a655d5379cd65d8f915b2ee96a1db5d44e35ea2358"
LORENZ_OUT = "4071a2f2faca744907747cb2cc82a9d841e125fa287240505f9f9a8454a399ac"
KEEP_SPACES = ("immune", "immune-lattice")
PUBLIC_SPACES = (
    "immune",
    "immune-lattice",
    "killinchu",
    "a11oy",
    "counsel",
    "terra",
    "sentra",
    "finance",
    "lyte",
    "vertical-services",
    "szl-command-lab",
    "david-leads",
    "szl-constellation",
    "szl-frontier",
    "szl-model-inference-lab",
)
DEAD_SPACES = ("nexus", "anatomy", "szl-khipu", "holographic-unify")
REPOS = (
    "a11oy",
    "immune",
    "a11oy-net",
    "nexus",
    "szl-ouroboros",
    ".github",
    "szl-hf-frontier",
    "holographic-unify",
)


def sh(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(list(args), text=True, capture_output=True, check=False)


def gh(*args: str) -> subprocess.CompletedProcess[str]:
    return sh("gh", *args)


def gh_json(*args: str) -> Any:
    p = gh(*args)
    if p.returncode != 0:
        print("GH_FAIL", args, (p.stderr or "")[-400:], file=sys.stderr)
        return None
    try:
        return json.loads(p.stdout or "null")
    except json.JSONDecodeError:
        return None


def http_json(url: str, timeout: int = 20) -> tuple[int, Any]:
    req = urllib.request.Request(url, headers={**UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            code = int(r.status)
    except urllib.error.HTTPError as e:
        return int(e.code), None
    except Exception:
        return 0, None
    try:
        return code, json.loads(raw.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return code, None


def banner(title: str) -> None:
    print("\n====", title, "====")


def main() -> int:
    banner("auth")
    print("\n".join(gh("auth", "status").stdout.splitlines()[:6]))

    banner("github org")
    org = gh_json("api", "orgs/szl-holdings")
    print({k: (org or {}).get(k) for k in ("login", "public_repos", "blog")})

    banner("open product PRs")
    for repo in REPOS:
        rows = gh_json(
            "pr",
            "list",
            "-R",
            f"szl-holdings/{repo}",
            "--state",
            "open",
            "--limit",
            "15",
            "--json",
            "number,title,isDraft,mergeable,url",
        ) or []
        print(f"{repo:22} open={len(rows)}")
        for p in rows:
            print(" ", p)

    banner("hub spaces")
    for name in PUBLIC_SPACES + DEAD_SPACES:
        code, data = http_json(f"https://huggingface.co/api/spaces/SZLHOLDINGS/{name}")
        stage = ((data or {}).get("runtime") or {}).get("stage") if data else None
        flag = "KEEP" if name in KEEP_SPACES else ("DEAD" if name in DEAD_SPACES else "PUBLIC")
        print(f"  {flag:6} {name:28} http={code} stage={stage}")

    banner("channel A/B + tab")
    for label, url in (
        ("A_state", f"{A}/api/immune/state"),
        ("A_nexus", f"{A}/api/immune/nexus/status"),
        ("B_dash", f"{B}/api/immune/dashboard"),
        ("tab", TAB),
    ):
        if label == "tab":
            req = urllib.request.Request(url, headers=UA)
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    print(label, r.status, "bytes", len(r.read()))
            except Exception as e:
                print(label, "FAIL", type(e).__name__)
            continue
        code, data = http_json(url)
        print(label, code, type(data).__name__)

    code, dash = http_json(f"{B}/api/immune/dashboard")
    anatomy = None
    if isinstance(dash, dict):
        anatomy = ((dash.get("organs") or {}).get("anatomy") or {}).get("stage")
    print("anatomy", anatomy)

    banner("lorenz reference")
    print("inputHash", LORENZ_IN)
    print("outputHash", LORENZ_OUT)
    print("do not auto-POST Lorenz unless the operator asks; Channel A has a request budget")

    banner("placement")
    print("product", TAB)
    print("channel A", A)
    print("channel B", B)
    print("proof", "https://a11oy.net")
    print("do not mint SZLHOLDINGS/nexus")
    print("energy UNAVAILABLE; Lambda = Conjecture 1 OPEN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
