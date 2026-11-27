#!/usr/bin/env python3
"""Which CI groups this run needs (project standard, STANDARD.md 1.2). Writes to $GITHUB_OUTPUT:
  <group>=true|false for every group in .github/changes.yaml, full=true|false, release=true|false.

pull_request: by the files the PR changes (BASE...HEAD). push to main: no group; release=true when VERSION has no
v<VERSION> tag. schedule / workflow_dispatch: every group, full=true (dispatch with RELEASE_INPUT=true on main also
releases an untagged VERSION). Locally: EVENT=pull_request BASE=origin/main HEAD=HEAD python3 .github/scripts/changes.py
"""
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml  # preinstalled on GitHub's ubuntu runners

cfg = yaml.safe_load(Path(".github/changes.yaml").read_text()) or {}
groups = cfg.get("groups", {})
compile_all = lambda pats: [re.compile(p) for p in pats or []]  # noqa: E731
ignore, shared = compile_all(cfg.get("ignore")), compile_all(cfg.get("shared"))
patterns = {g: compile_all(p) for g, p in groups.items()}
event = os.environ.get("EVENT", "")
out = {g: False for g in groups}
full = release = False


def untagged() -> bool:
    v = Path("VERSION").read_text().strip()
    return subprocess.run(["git", "ls-remote", "--exit-code", "--tags", "origin", f"refs/tags/v{v}"],
                          capture_output=True).returncode != 0


if event == "pull_request":
    files = subprocess.run(["git", "diff", "--name-only", f"{os.environ['BASE']}...{os.environ['HEAD']}"],
                           capture_output=True, text=True, check=True).stdout.split()
    for f in files:
        if any(p.search(f) for p in ignore):
            continue
        hit = [g for g, ps in patterns.items() if any(p.search(f) for p in ps)]
        if any(p.search(f) for p in shared) or not hit:
            out = {g: True for g in groups}
            break
        for g in hit:
            out[g] = True
elif event == "push":
    release = untagged()
else:  # schedule, workflow_dispatch
    out = {g: True for g in groups}
    full = True
    release = os.environ.get("RELEASE_INPUT") == "true" and os.environ.get("GITHUB_REF") == "refs/heads/main" and untagged()

out.update(full=full, release=release)
lines = [f"{k}={'true' if v else 'false'}" for k, v in out.items()]
print("\n".join(lines))
if os.environ.get("GITHUB_OUTPUT"):
    with open(os.environ["GITHUB_OUTPUT"], "a") as fh:
        fh.write("\n".join(lines) + "\n")
sys.exit(0)
