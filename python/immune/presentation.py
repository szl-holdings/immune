"""Closed, bounded static projection for both Python observer pages.

These assets are already carried by the existing immune/ publisher prefix and
the Docker COPY immune instruction. No API or runtime authority is involved.
"""
from __future__ import annotations

import os
from pathlib import Path
import stat

ROOT = Path(__file__).resolve().parent / "static" / "szl"
MAX_ASSET_BYTES = 256 * 1024
ASSETS = {
    "/assets/szl/szl-tokens.css": ("szl-tokens.css", "text/css; charset=utf-8"),
    "/assets/szl/surface.css": ("surface.css", "text/css; charset=utf-8"),
    "/assets/szl/appearance.js": ("appearance.js", "text/javascript; charset=utf-8"),
    "/assets/szl/szl-icon-32.svg": ("szl-icon-32.svg", "image/svg+xml"),
    "/assets/szl/favicon.svg": ("favicon.svg", "image/svg+xml"),
    "/assets/szl/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
    "/assets/szl/SOURCE.json": ("SOURCE.json", "application/json"),
    "/assets/szl/PROJECTION.json": ("PROJECTION.json", "application/json"),
}


def read_asset(route: str) -> tuple[bytes, str]:
    """Never turn a request path into a filesystem path."""
    name, content_type = ASSETS[route]
    descriptor = os.open(ROOT / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ASSET_BYTES:
            raise OSError("Static asset outside regular-file bounds")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            data = stream.read(MAX_ASSET_BYTES + 1)
        if len(data) != info.st_size or len(data) > MAX_ASSET_BYTES:
            raise OSError("Static asset read outside bounds")
        return data, content_type
    finally:
        os.close(descriptor)
