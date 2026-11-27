#!/usr/bin/env python3
"""VERSION is SemVer, every place in .github/versions.yaml carries it, and CHANGELOG.md has its section
(project standard, STANDARD.md 2.1). With a tag argument (v1.2.3), also checks the tag matches."""
import json
import re
import sys
from pathlib import Path

import yaml

v = Path("VERSION").read_text().strip()
errors = []
if not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", v):
    errors.append(f"VERSION {v!r} is not MAJOR.MINOR.PATCH")
places = yaml.safe_load(Path(".github/versions.yaml").read_text()) if Path(".github/versions.yaml").is_file() else []
for p in places or []:
    text = Path(p["file"]).read_text()
    if "json" in p:
        got = json.loads(text)
        for k in p["json"].split("."):
            got = got[k]
    elif "yaml" in p:
        got = yaml.safe_load(text)
        for k in p["yaml"].split("."):
            got = got[k]
    else:
        m = re.search(p["regex"], text)
        got = m.group(1) if m else None
    if str(got) != v:
        errors.append(f"{p['file']}: {got} (VERSION is {v})")
log = Path("CHANGELOG.md").read_text() if Path("CHANGELOG.md").is_file() else ""
if not re.search(rf"^## \[?{re.escape(v)}\]?", log, re.M):
    errors.append(f"CHANGELOG.md has no '## [{v}] - YYYY-MM-DD' section")
if len(sys.argv) > 1 and sys.argv[1] and sys.argv[1] != f"v{v}":
    errors.append(f"tag {sys.argv[1]} doesn't match VERSION {v}")
for e in errors:
    print(f"::error::{e}")
print(v if not errors else "")
sys.exit(1 if errors else 0)
