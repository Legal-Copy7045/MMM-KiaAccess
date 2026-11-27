#!/usr/bin/env python3
"""Prints CHANGELOG.md's section for a version (the release notes). Usage: release_notes.py 1.2.3"""
import re
import sys
from pathlib import Path

v = sys.argv[1].lstrip("v")
text = Path("CHANGELOG.md").read_text()
m = re.search(rf"^## \[?{re.escape(v)}\]?.*?$\n(.*?)(?=^## |\Z)", text, re.M | re.S)
if not m:
    sys.exit(f"CHANGELOG.md has no section for {v}")
print(m.group(1).strip())
