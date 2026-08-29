#!/usr/bin/env python3
"""HF Space entry — Hub flatten copies this to /server.py."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
for candidate in (ROOT, ROOT.parent, Path("/app")):
    if (candidate / "immune" / "runtime.py").exists():
        sys.path.insert(0, str(candidate))
        break

from immune.server import main  # noqa: E402

if __name__ == "__main__":
    main()
