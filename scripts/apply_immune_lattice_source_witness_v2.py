#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Apply the IMMUNE lattice source witness to Channel B only."""
from __future__ import annotations

import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/deploy-hf-space.yml"
V1 = ROOT / "scripts/apply_immune_lattice_source_witness.py"


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:100]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_last(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    index = text.rfind(old)
    if index < 0:
        raise SystemExit(f"{path}: final anchor missing: {old[:100]!r}")
    path.write_text(text[:index] + new + text[index + len(old):], encoding="utf-8")


def update_workflow() -> None:
    replace_once(WORKFLOW, "    timeout-minutes: 20\n", "    timeout-minutes: 35\n")
    replace_once(
        WORKFLOW,
        '''          import os
          from huggingface_hub import HfApi, CommitOperationAdd, CommitOperationDelete
          from pathlib import Path
''',
        '''          import json
          import os
          from huggingface_hub import HfApi, CommitOperationAdd, CommitOperationDelete
          from pathlib import Path
''',
    )
    replace_last(
        WORKFLOW,
        '''          api = HfApi(token=token)
          try:
''',
        '''          api = HfApi(token=token)
          identity = Path("python/space/source-identity.json")
          identity.write_text(
              json.dumps(
                  {
                      "schema": "szl.runtime-source/v1",
                      "source_repository": "szl-holdings/immune",
                      "source_revision": os.environ["GITHUB_SHA"],
                      "channel": "python",
                  },
                  sort_keys=True,
              )
              + "\\n",
              encoding="utf-8",
          )
          try:
''',
    )
    replace_once(
        WORKFLOW,
        '''          if Path("python/space/nexus.html").is_file():
              uploads["nexus.html"] = "python/space/nexus.html"
          root = Path("python/immune")
''',
        '''          if Path("python/space/nexus.html").is_file():
              uploads["nexus.html"] = "python/space/nexus.html"
          uploads["source-identity.json"] = str(identity)
          root = Path("python/immune")
''',
    )
    replace_last(
        WORKFLOW,
        '''          print("Published Channel B revision:", commit.oid)
          PY
''',
        '''          print("Published Channel B revision:", commit.oid)
          PY
      - name: Verify exact Channel B source witness
        run: |
          set -euo pipefail
          python3 <<'PY'
          import json
          import os
          import time
          import urllib.error
          import urllib.request

          expected = os.environ["GITHUB_SHA"]
          url = "https://szlholdings-immune-lattice.hf.space/api/build-info"
          deadline = time.monotonic() + 900
          last = "not attempted"
          while time.monotonic() < deadline:
              try:
                  request = urllib.request.Request(
                      url,
                      headers={
                          "Cache-Control": "no-cache",
                          "User-Agent": "SZL-IMMUNE-source-proof/1",
                      },
                  )
                  with urllib.request.urlopen(request, timeout=20) as response:
                      payload = json.loads(response.read().decode("utf-8"))
                  repository = payload.get("source_repository")
                  revision = payload.get("source_revision")
                  if repository == "szl-holdings/immune" and revision == expected:
                      print(json.dumps(payload, sort_keys=True))
                      break
                  last = f"observed repository={repository!r} revision={revision!r}"
              except (OSError, ValueError, urllib.error.URLError) as exc:
                  last = f"{type(exc).__name__}: {exc}"
              time.sleep(15)
          else:
              raise SystemExit(
                  f"Channel B exact-source witness did not converge: {last}"
              )
          PY
''',
    )


def main() -> int:
    module = runpy.run_path(str(V1))
    module["update_server"]()
    module["update_dockerfile"]()
    update_workflow()
    module["write_test"]()
    module["verify"]()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
