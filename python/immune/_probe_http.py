"""Bounded JSON GET helper, isolated by the parent process's hard deadline."""
from __future__ import annotations

import json
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def main() -> None:
    url, timeout, max_bytes = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "szl-immune-estate-probe/1"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            status = int(response.status)
            body = response.read(max_bytes + 1)
        if len(body) > max_bytes:
            raise ValueError("probe response exceeds size bound")
        payload = {"status": status, "body": json.loads(body)}
    except HTTPError as exc:
        payload = {"status": exc.code, "body": None}
        exc.close()
    except Exception as exc:
        payload = {"error": type(exc).__name__}
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
