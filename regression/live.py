#!/usr/bin/env python3
"""Live stage: read-only checks of what is released and running. Exit 0 pass, 1 fail, 77 skipped (not reachable).

    python3 regression/live.py release   GitHub's latest release is v<VERSION> or older, has notes, is not a draft
    python3 regression/live.py ha        with HA_URL and HA_TOKEN: Home Assistant answers and has a Kia Access status
                                         sensor (attribute kia_access_raw). Reads /api/states only; never calls a service.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "Legal-Copy7045/MMM-KiaAccess"
SKIP = 77


def get(url: str, headers: dict | None = None):
    req = urllib.request.Request(url, headers={"User-Agent": "kia-access-regression", **(headers or {})})
    with urllib.request.urlopen(req, timeout=20) as resp:  # nosec B310: fixed https:// API or the owner's HA_URL
        return json.load(resp)


def vkey(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v.split("-")[0])[:3])


def release() -> int:
    version = (ROOT / "VERSION").read_text().strip()
    try:
        rel = get(f"https://api.github.com/repos/{REPO}/releases/latest", {"Accept": "application/vnd.github+json"})
    except (urllib.error.URLError, OSError) as exc:
        print(f"GitHub not reachable from here: {exc}")
        return SKIP
    tag = rel.get("tag_name", "")
    print(f"latest release {tag}, VERSION {version}")
    problems = []
    if vkey(tag) > vkey(version):
        problems.append(f"latest release {tag} is newer than VERSION {version}")
    if rel.get("draft") or not (rel.get("body") or "").strip():
        problems.append(f"{tag} is a draft or has no notes")
    for p in problems:
        print("FAIL:", p)
    return 1 if problems else 0


def ha() -> int:
    url, token = os.environ.get("HA_URL", "").rstrip("/"), os.environ.get("HA_TOKEN", "")
    if not url or not token:
        print("HA_URL / HA_TOKEN not set: skipped")
        return SKIP
    try:
        states = get(f"{url}/api/states", {"Authorization": f"Bearer {token}"})
    except (urllib.error.URLError, OSError) as exc:
        print(f"Home Assistant not reachable from here: {exc}")
        return SKIP
    raw = [s for s in states if (s.get("attributes") or {}).get("kia_access_raw") is True]
    print(f"{len(raw)} Kia Access status sensor(s)")
    if not raw:
        print("FAIL: no Kia Access status sensor (is the integration loaded?)")
        return 1
    stale = [s for s in raw if s.get("state") in ("unavailable", "unknown")]
    if stale:
        print(f"FAIL: {len(stale)} status sensor(s) unavailable")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit({"release": release, "ha": ha}[sys.argv[1]]())
