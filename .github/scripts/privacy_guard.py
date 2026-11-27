#!/usr/bin/env python3
"""Privacy guard: keeps personal details out of this public repository.

Runs in CI (the privacy and privacy-denylist jobs, through the standard's reusable privacy.yml) and fails if:

1. any commit in the push or pull request (BASE..HEAD; without a usable BASE, the commits not yet on the default
   branch) has an author or committer that isn't a no-reply address
   (<id>+<user>@users.noreply.github.com, noreply@github.com, noreply@anthropic.com);
2. any tracked file, any line added by those commits (even one a later commit removed again: history is public too)
   or their messages contain something that looks like a credential (GitHub/AWS/Google/Anthropic/OpenAI/Slack
   tokens, JWTs such as Home Assistant tokens, private keys);
3. the same text matches a private term from the PRIVACY_DENYLIST secret: one Python regular expression per line
   (case-insensitive; lines starting with # are ignored), e.g. real names, places, home coordinates, band or
   device IDs;
4. an image (tracked, or added by those commits) carries camera or location metadata: EXIF (which holds GPS
   positions) or XMP in a JPEG, PNG, WebP or GIF; HEIC/HEIF/TIFF photos aren't accepted at all. Strip it first,
   e.g. `exiftool -all= photo.jpg` or re-save the image without metadata.

The private terms exist only in the secret, never in the repository, and a match is reported only by file, line and
rule number, never by the text that matched. The secret lives in the `privacy` environment, which only the default
branch can use, so that job (privacy-denylist) runs there only; elsewhere check 3 is skipped with a warning.
PRIVACY_DENYLIST_REQUIRED=1 makes a missing secret an error.

Run it locally: PRIVACY_DENYLIST="$(cat my-terms.txt)" BASE=origin/main HEAD=HEAD python3 .github/scripts/privacy_guard.py
"""

from __future__ import annotations

import os
import re
import struct
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
    r"|\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b"  # Telegram bot
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
)
SECRET_FILES = re.compile(r"(^|/)(secrets\.yaml|ha_token\.txt|geoapify_key\.txt|\.env|[^/]*\.pem)$", re.I)
MAX_BYTES = 5_000_000
IMAGES = re.compile(r"\.(jpe?g|png|webp|gif)$", re.I)
NO_IMAGES = re.compile(r"\.(heic|heif|tiff?|dng|cr2|nef|arw)$", re.I)  # camera formats: always carry metadata


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def git_bytes(*args: str) -> bytes:
    return subprocess.run(["git", *args], capture_output=True, check=True).stdout


def image_metadata(data: bytes) -> str | None:
    """What identifying metadata an image carries (EXIF, XMP), or None. JPEG, PNG, WebP and GIF."""
    if data[:2] == b"\xff\xd8":  # JPEG: walk the segments up to the image data
        i = 2
        while i + 4 <= len(data) and data[i] == 0xFF:
            marker = data[i + 1]
            if marker == 0xFF:
                i += 1
                continue
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            if marker in (0xDA, 0xD9):  # start of scan / end of image
                break
            (length,) = struct.unpack(">H", data[i + 2:i + 4])
            seg = data[i + 4:i + 2 + length]
            if marker == 0xE1 and seg.startswith(b"Exif\0"):
                return "EXIF"
            if marker == 0xE1 and seg.startswith(b"http://ns.adobe.com/xa"):
                return "XMP"
            if marker == 0xE1 and seg.startswith(b"http://ns.adobe.com/xmp/extension/"):
                return "XMP"
            i += 2 + length
        return None
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        i = 8
        while i + 8 <= len(data):
            length, ctype = struct.unpack(">I4s", data[i:i + 8])
            body = data[i + 8:i + 8 + length]
            if ctype == b"eXIf":
                return "EXIF"
            if ctype in (b"iTXt", b"tEXt", b"zTXt"):
                keyword = body.split(b"\0", 1)[0].lower()
                if keyword == b"xml:com.adobe.xmp":
                    return "XMP"
                if keyword.startswith(b"raw profile type") and (b"exif" in keyword or b"xmp" in keyword):
                    return "EXIF/XMP"
            if ctype == b"IEND":
                break
            i += 12 + length
        return None
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        i = 12
        while i + 8 <= len(data):
            ctype, length = data[i:i + 4], struct.unpack("<I", data[i + 4:i + 8])[0]
            if ctype == b"EXIF":
                return "EXIF"
            if ctype == b"XMP ":
                return "XMP"
            i += 8 + length + (length & 1)
        return None
    if data[:4] == b"GIF8":
        return "XMP" if b"XMP DataXMP" in data else None
    return None


def check_image(path: str, data: bytes, where: str = "") -> int:
    if NO_IMAGES.search(path):
        error(f"{where}Camera image formats aren't accepted (they carry location and camera details): "
              "convert to PNG or JPEG without metadata", path)
        return 1
    if IMAGES.search(path):
        found = image_metadata(data)
        if found:
            error(f"{where}The image carries {found} metadata (camera details, often a GPS position): strip it, "
                  "e.g. exiftool -all= <file>", path)
            return 1
    return 0


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
    """Every commit this push or pull request adds."""
    base, head = os.environ.get("BASE", ""), os.environ.get("HEAD", "") or "HEAD"
    if base and set(base) != {"0"}:
        try:
            git("cat-file", "-e", base + "^{commit}")
            return git("rev-list", f"{base}..{head}").split()
        except subprocess.CalledProcessError:
            pass  # e.g. a force push: the old tip isn't in this clone
    # A new branch or a force push: every commit not yet on the default branch.
    default = os.environ.get("DEFAULT_BRANCH", "")
    for ref in ([f"origin/{default}"] if default else []) + ["origin/HEAD"]:
        try:
            git("rev-parse", "--verify", "-q", ref + "^{commit}")
        except subprocess.CalledProcessError:
            continue
        shas = git("rev-list", head, "--not", ref).split()
        if shas:
            return shas
        break
    return [git("rev-parse", head).strip()]


def added_lines(sha: str):
    """(path, line) for every line the commit adds (a merge: compared with its first parent)."""
    out = git_bytes("show", "--format=", "--patch", "-U0", "--no-color", "--no-ext-diff", "--no-textconv",
                    "--no-renames", "--diff-merges=first-parent", sha).decode("utf-8", "replace")
    path = None
    for line in out.splitlines():
        if line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("+") and path:
            yield path, line[1:]


def added_files(sha: str) -> list[str]:
    out = git("show", "--format=", "--name-only", "--diff-filter=AM", "--no-renames", "--diff-merges=first-parent",
              "-z", sha)
    return [p for p in out.split("\0") if p]


def main() -> int:
    rules = denylist()
    problems = 0
    if not rules:
        if os.environ.get("PRIVACY_DENYLIST_REQUIRED") == "1":
            error("PRIVACY_DENYLIST isn't available to this job: add it to the 'privacy' environment's secrets")
            problems += 1
        else:
            print("::notice::PRIVACY_DENYLIST not set here (it's checked on the default branch only): "
                  "private terms not checked")

    # 1 and part of 2/3/4: the commits this push or pull request adds
    shas = commit_range()
    for sha in shas:
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
        # Every line the commit adds: history is published too, even what a later commit removes.
        for path, line in added_lines(sha):
            if SECRET_FILES.search(path):
                continue  # reported below by name (it may be in the tree) or would need a history rewrite anyway
            if path != SELF and CREDENTIALS.search(line):
                error(f"Commit {sha[:8]} adds a line that looks like a credential", path)
                problems += 1
            for i, rule in enumerate(rules, 1):
                if rule.search(line):
                    error(f"Commit {sha[:8]} adds a line matching private term #{i}: rewrite that commit", path)
                    problems += 1
        for path in added_files(sha):
            if SECRET_FILES.search(path):
                error(f"Commit {sha[:8]} adds a secrets file: rewrite that commit", path)
                problems += 1
            elif IMAGES.search(path) or NO_IMAGES.search(path):
                try:
                    blob = git_bytes("cat-file", "blob", f"{sha}:{path}")
                except subprocess.CalledProcessError:
                    continue
                problems += check_image(path, blob, f"Commit {sha[:8]}: ")

    # 2, 3 and 4: every tracked file as it is now
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
        if IMAGES.search(path) or NO_IMAGES.search(path):
            problems += check_image(path, data)
            continue
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

    print(f"privacy guard: {len(shas)} commit(s) checked, {problems} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
