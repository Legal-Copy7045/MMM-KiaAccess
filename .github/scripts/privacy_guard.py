#!/usr/bin/env python3
"""Privacy guard: keeps personal details out of this public repository.

Runs on every push and pull request (.github/workflows/privacy.yml) and fails if:

1. a new commit's author or committer isn't a no-reply address
   (<id>+<user>@users.noreply.github.com, noreply@github.com, noreply@anthropic.com);
2. any tracked file or new commit message contains something that looks like a
   credential (GitHub/AWS/Google/Anthropic/OpenAI/Slack tokens, JWTs such as
   Home Assistant tokens, private keys);
3. any tracked file or new commit message matches a private term from the
   PRIVACY_DENYLIST Actions secret: one Python regular expression per line
   (case-insensitive; lines starting with # are ignored), e.g. real names,
   places, home coordinates, band or device IDs.

The private terms exist only in the secret, never in the repository, and a
match is reported only by file, line and rule number, never by the text that
matched. Without the secret (e.g. a pull request from a fork) check 3 is
skipped with a warning.

Run it locally: PRIVACY_DENYLIST="$(cat my-terms.txt)" python3 .github/scripts/privacy_guard.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

SELF = ".github/scripts/privacy_guard.py"
ALLOWED_EMAIL = re.compile(r"(^[^@\s]+@users\.noreply\.github\.com$)|(^noreply@github\.com$)|(^noreply@anthropic\.com$)", re.I)
CREDENTIALS = re.compile(
    r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"  # JWT (e.g. a Home Assistant token)
    r"|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}"  # GitHub
    r"|\bAKIA[0-9A-Z]{16}\b"  # AWS
    r"|\bAIza[0-9A-Za-z_-]{35}\b"  # Google
    r"|\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}"  # Anthropic / OpenAI
    r"|\bxox[abpors]-[A-Za-z0-9-]{10,}"  # Slack
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
)
SECRET_FILES = re.compile(r"(^|/)(secrets\.yaml|ha_token\.txt|geoapify_key\.txt|\.env|[^/]*\.pem)$", re.I)
MAX_BYTES = 5_000_000


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def error(msg: str, path: str | None = None, line: int | None = None) -> None:
    loc = f" file={path}" + (f",line={line}" if line else "") if path else ""
    print(f"::error{loc}::{msg}")


def denylist() -> list[re.Pattern]:
    raw = os.environ.get("PRIVACY_DENYLIST", "")
    rules = []
    for n, line in enumerate(raw.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            rules.append(re.compile(line, re.I))
        except re.error:
            error(f"PRIVACY_DENYLIST line {n} isn't a valid regular expression")
            rules.append(re.compile(r"(?!)"))
    return rules


def commit_range() -> list[str]:
    base, head = os.environ.get("BASE", ""), os.environ.get("HEAD", "") or "HEAD"
    if base and set(base) != {"0"}:
        try:
            git("cat-file", "-e", base + "^{commit}")
            return git("rev-list", f"{base}..{head}").split()
        except subprocess.CalledProcessError:
            pass
    return [git("rev-parse", head).strip()]


def main() -> int:
    rules = denylist()
    if not rules:
        print("::warning::PRIVACY_DENYLIST secret isn't set (or a fork PR): private terms not checked")
    problems = 0

    # 1 and part of 2/3: the commits this push or pull request adds
    for sha in commit_range():
        fields = git("show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", sha).split("\x00")
        an, ae, cn, ce, body = fields[0], fields[1], fields[2], fields[3], fields[4]
        for who, email in (("author", ae), ("committer", ce)):
            if not ALLOWED_EMAIL.match(email.strip()):
                error(f"Commit {sha[:8]}: {who} email isn't a no-reply address. Use "
                      "<id>+<user>@users.noreply.github.com (git config user.email) and turn on "
                      "GitHub's 'Keep my email addresses private'.")
                problems += 1
        text = f"{an}\n{cn}\n{body}"
        if CREDENTIALS.search(text):
            error(f"Commit {sha[:8]}: the commit message looks like it contains a credential")
            problems += 1
        for i, rule in enumerate(rules, 1):
            if rule.search(text):
                error(f"Commit {sha[:8]}: the commit message or name matches private term #{i}")
                problems += 1

    # 2 and 3: every tracked file as it is now
    for path in git("ls-files", "-z").split("\0"):
        if not path or not os.path.isfile(path):
            continue
        if SECRET_FILES.search(path):
            error("A secrets file is tracked: remove it and add it to .gitignore", path)
            problems += 1
            continue
        if os.path.getsize(path) > MAX_BYTES:
            continue
        with open(path, "rb") as fh:
            data = fh.read()
        if b"\0" in data[:8000]:
            continue  # binary
        for n, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            if path != SELF and CREDENTIALS.search(line):
                error("Looks like a credential", path, n)
                problems += 1
            for i, rule in enumerate(rules, 1):
                if rule.search(line):
                    error(f"Matches private term #{i}: replace it with a made-up value", path, n)
                    problems += 1

    print(f"privacy guard: {problems} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
