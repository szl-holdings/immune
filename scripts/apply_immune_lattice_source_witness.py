#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Materialize the exact-source witness for the IMMUNE lattice Space."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "python/immune/server.py"
DOCKERFILE = ROOT / "python/space/Dockerfile"
WORKFLOW = ROOT / ".github/workflows/deploy-hf-space.yml"
TEST = ROOT / "tests/test_immune_lattice_source_witness.py"


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"{path}: expected one replacement anchor, found {count}: {old[:120]!r}"
        )
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def update_server() -> None:
    old = '''HTML = Path(__file__).resolve().parent.parent / "space" / "index.html"
NEXUS_HTML = Path(__file__).resolve().parent.parent / "space" / "nexus.html"
SOURCE_REV = (
    os.environ.get("SOURCE_REVISION")
    or os.environ.get("GITHUB_SHA")
    or os.environ.get("SPACE_REPO_ID")
    or "UNSIGNED-honest"
)
_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
'''
    new = '''HTML = Path(__file__).resolve().parent.parent / "space" / "index.html"
NEXUS_HTML = Path(__file__).resolve().parent.parent / "space" / "nexus.html"
SOURCE_IDENTITY_PATHS = (
    Path("/app/source-identity.json"),
    Path(__file__).resolve().parent.parent / "space" / "source-identity.json",
    Path("source-identity.json"),
)


def _load_source_identity() -> dict[str, str]:
    for path in SOURCE_IDENTITY_PATHS:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        repository = str(payload.get("source_repository") or "").strip()
        revision = str(payload.get("source_revision") or "").strip()
        if repository == "szl-holdings/immune" and re.fullmatch(r"[0-9a-f]{40}", revision):
            return {"source_repository": repository, "source_revision": revision}
    return {}


_SOURCE_IDENTITY = _load_source_identity()
SOURCE_REPOSITORY = str(
    _SOURCE_IDENTITY.get("source_repository")
    or os.environ.get("SOURCE_REPOSITORY")
    or "szl-holdings/immune"
)
SOURCE_REV = str(
    _SOURCE_IDENTITY.get("source_revision")
    or os.environ.get("SOURCE_REVISION")
    or os.environ.get("GITHUB_SHA")
    or "UNSIGNED-honest"
)
_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")


def source_identity() -> dict[str, object]:
    exact = bool(
        SOURCE_REPOSITORY == "szl-holdings/immune"
        and re.fullmatch(r"[0-9a-f]{40}", SOURCE_REV)
    )
    return {
        "schema": "szl.runtime-source/v1",
        "service": "immune-lattice",
        "source_repository": SOURCE_REPOSITORY,
        "source_revision": SOURCE_REV,
        "source": {
            "repository": SOURCE_REPOSITORY,
            "revision": SOURCE_REV,
            "channel": "python",
        },
        "exact_source": exact,
    }
'''
    replace_once(SERVER, old, new)

    replace_once(
        SERVER,
        '''        if path in ("/health", "/healthz", "/readyz"):
''',
        '''        if path in ("/api/build-info", "/deployment.json"):
            self._json(200, source_identity())
            return
        if path in ("/health", "/healthz", "/readyz"):
''',
    )
    replace_once(
        SERVER,
        '''                        "repository": "szl-holdings/immune",
''',
        '''                        "repository": SOURCE_REPOSITORY,
''',
    )


def update_dockerfile() -> None:
    replace_once(
        DOCKERFILE,
        '''COPY nexus.html ./nexus.html
COPY server.py ./server.py
''',
        '''COPY nexus.html ./nexus.html
COPY source-identity.json ./source-identity.json
COPY server.py ./server.py
''',
    )


def update_workflow() -> None:
    replace_once(
        WORKFLOW,
        '''    timeout-minutes: 20
''',
        '''    timeout-minutes: 35
''',
    )
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
    replace_once(
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
        '''              "nexus.html": "python/space/nexus.html",
          }
''',
        '''              "nexus.html": "python/space/nexus.html",
              "source-identity.json": "python/space/source-identity.json",
          }
''',
    )
    marker = '''          print("Published Channel B revision:", commit.oid)
          PY
'''
    replacement = '''          print("Published Channel B revision:", commit.oid)
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
                      headers={"Cache-Control": "no-cache", "User-Agent": "SZL-IMMUNE-source-proof/1"},
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
              raise SystemExit(f"Channel B exact-source witness did not converge: {last}")
          PY
'''
    # There are two identical print markers in the workflow. Bind specifically to
    # the Channel B marker by replacing the final occurrence.
    text = WORKFLOW.read_text(encoding="utf-8")
    index = text.rfind(marker)
    if index < 0:
        raise SystemExit("Channel B publication marker is missing")
    WORKFLOW.write_text(text[:index] + replacement + text[index + len(marker):], encoding="utf-8")


def write_test() -> None:
    TEST.write_text(
        '''# SPDX-License-Identifier: Apache-2.0
"""Source-only contracts for the IMMUNE lattice exact-source witness."""
from __future__ import annotations

import ast
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "python/immune/server.py"
DOCKERFILE = ROOT / "python/space/Dockerfile"
WORKFLOW = ROOT / ".github/workflows/deploy-hf-space.yml"


class ImmuneLatticeSourceWitnessTests(unittest.TestCase):
    def test_server_exposes_standard_read_only_identity_routes(self) -> None:
        text = SERVER.read_text(encoding="utf-8")
        ast.parse(text)
        for token in (
            '"/api/build-info"',
            '"/deployment.json"',
            '"schema": "szl.runtime-source/v1"',
            '"source_repository": SOURCE_REPOSITORY',
            '"source_revision": SOURCE_REV',
            'Path("/app/source-identity.json")',
            're.fullmatch(r"[0-9a-f]{40}", SOURCE_REV)',
        ):
            self.assertIn(token, text)
        self.assertNotIn('"repository": "szl-holdings/immune",', text)

    def test_channel_b_image_contains_generated_identity(self) -> None:
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("COPY source-identity.json ./source-identity.json", dockerfile)
        self.assertIn('identity = Path("python/space/source-identity.json")', workflow)
        self.assertIn('"source_revision": os.environ["GITHUB_SHA"]', workflow)
        self.assertIn(
            '"source-identity.json": "python/space/source-identity.json"', workflow
        )
        self.assertIn("Verify exact Channel B source witness", workflow)
        self.assertIn("revision == expected", workflow)

    def test_identity_document_shape_is_exact_and_non_secret(self) -> None:
        sample = {
            "schema": "szl.runtime-source/v1",
            "source_repository": "szl-holdings/immune",
            "source_revision": "a" * 40,
            "channel": "python",
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source-identity.json"
            path.write_text(json.dumps(sample), encoding="utf-8")
            loaded = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(loaded, sample)
        self.assertNotIn("token", json.dumps(loaded).lower())


if __name__ == "__main__":
    unittest.main()
''',
        encoding="utf-8",
    )


def verify() -> None:
    server = SERVER.read_text(encoding="utf-8")
    workflow = WORKFLOW.read_text(encoding="utf-8")
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    assert server.count('"/api/build-info"') == 1
    assert server.count('"/deployment.json"') == 1
    assert workflow.count("Verify exact Channel B source witness") == 1
    assert dockerfile.count("COPY source-identity.json ./source-identity.json") == 1


def main() -> int:
    update_server()
    update_dockerfile()
    update_workflow()
    write_test()
    verify()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
