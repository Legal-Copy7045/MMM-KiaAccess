#!/usr/bin/env python3
"""Shared regression tooling (github.com/Legal-Copy7045/project-standards, regression-kit/standard.py).

Vendored into each project as regression/standard.py and never edited there: update it from the standards repository.
A project's regression/run.py runs its stages (its own code, or run_stages() below for command-based stages) and hands
everything after the stages to this module:

    brief [--full] [--walkthrough]   reviewer briefs -> out/briefs/*.md (+ out/brief.json: full or delta audit)
    report [--walkthrough]           out/*.json + out/findings/*.json -> out/report.html | out/walkthrough.html
    log [--walkthrough|--full-check] adds the RUNS.md / WALKTHROUGHS.md row
    summary                          <= 40 lines
    manual KEY pass|fail [--note]    records a manual result for the current version
    schema findings|walkthrough      prints the JSON schema reviewers must answer with
    --version

Stage result format (out/<stage>.json):
    {"stage", "prefix", "started", "finished", "results": [{"id", "key", "status", "detail", "evidence"}]}
status is pass | fail | skip | manual. Requires Python 3.10+ and PyYAML.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import html
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is needed: pip install pyyaml")

KIT_VERSION = "1.0.0"
HERE = Path(__file__).resolve().parent          # regression/
ROOT = HERE.parent
OUT = HERE / "out"
STANDARD_ORDER = ["ci", "unit", "page", "device", "live", "manual"]
SEVERITIES = ["critical", "high", "medium", "low", "info"]
FULL_AUDIT_EVERY = 4
RUNS_HEADER = "| Date (UTC) | Commit | Version | Audit | Pass | Fail | Skip | Manual due | Failing IDs | Findings | Report |"
WALKS_HEADER = "| Date (UTC) | Commit | Version | Roles | Pages | UX checks failing | Findings | Report |"

FINDINGS_SCHEMA = {
    "type": "object", "required": ["reviewer", "status", "findings"],
    "properties": {
        "reviewer": {"enum": ["bugs", "claims", "exposure"]},
        "status": {"enum": ["done", "failed"]},
        "scope": {"type": "string", "description": "what was reviewed, in one or two sentences"},
        "findings": {"type": "array", "items": {
            "type": "object", "required": ["id", "severity", "title", "description", "verified"],
            "properties": {
                "id": {"type": "string", "description": "BUG-001 / SEC-001 / EXP-001"},
                "severity": {"enum": SEVERITIES}, "area": {"type": "string"}, "title": {"type": "string"},
                "file": {"type": "string"}, "line": {"type": "integer"}, "description": {"type": "string"},
                "scenario": {"type": "string"}, "recommendation": {"type": "string"},
                "verified": {"type": "boolean", "description": "proved by running code or by quoting the exact code path"}}}},
        "claims": {"type": "array", "description": "claims reviewer only", "items": {
            "type": "object", "required": ["id", "held"],
            "properties": {"id": {"type": "string"}, "held": {"type": "boolean"}, "note": {"type": "string"}}}}}}

WALK_SCHEMA = {
    "type": "object", "required": ["reviewer", "status", "findings"],
    "properties": {
        "reviewer": {"enum": ["desktop", "phone"]}, "status": {"enum": ["done", "failed"]},
        "findings": {"type": "array", "items": {
            "type": "object", "required": ["id", "group", "title", "detail"],
            "properties": {
                "id": {"type": "string", "description": "WD-001 (desktop) / WP-001 (phone)"},
                "group": {"enum": ["duplicate", "naming", "placement", "dead-end", "long-flow", "keep-separate",
                                   "layout", "other"]},
                "roles": {"type": "array", "items": {"type": "string"}}, "title": {"type": "string"},
                "detail": {"type": "string"}, "pages": {"type": "array", "items": {"type": "string"}},
                "screenshots": {"type": "array", "items": {"type": "string"}},
                "proposal": {"type": "string"}, "value": {"enum": ["high", "medium", "low"]}}}},
        "proposed_menus": {"type": "object", "description": "role -> list of menu sections with items"}}}


# ---------------------------------------------------------------- helpers

def now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git(*args: str) -> str:
    p = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False)
    return p.stdout.strip() if p.returncode == 0 else ""


def load_yaml(path: Path, default):
    if not path.is_file():
        return default
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return default if data is None else data


def profile() -> dict:
    p = load_yaml(HERE / "profile.yaml", None)
    if p is None:
        sys.exit("regression/profile.yaml is missing (see the standard, section 3.1)")
    return p


def version() -> str:
    vf = ROOT / profile().get("version_file", "VERSION")
    return vf.read_text().strip() if vf.is_file() else "?"


def stage_files() -> list[Path]:
    if not OUT.is_dir():
        return []
    skip = {"brief.json", "walkthrough.json", "walkthrough-checks.json"}
    return sorted(p for p in OUT.glob("*.json") if p.name not in skip)


def stage_order(name: str) -> tuple:
    return (STANDARD_ORDER.index(name) if name in STANDARD_ORDER else 2.5, name)


def load_stages() -> list[dict]:
    stages = [json.loads(p.read_text()) for p in stage_files()]
    return sorted((s for s in stages if "results" in s), key=lambda s: stage_order(s.get("stage", "")))


def load_findings(names: list[str]) -> list[dict]:
    out = []
    for n in names:
        p = OUT / "findings" / f"{n}.json"
        if p.is_file():
            try:
                out.append(json.loads(p.read_text()))
            except json.JSONDecodeError:
                out.append({"reviewer": n, "status": "failed", "scope": "unreadable JSON", "findings": []})
        else:
            out.append({"reviewer": n, "status": "missing", "scope": "no findings file", "findings": []})
    return out


# ---------------------------------------------------------------- IDs and stage runs

class Ids:
    """regression/ids/<stage>.yaml: {"PREFIX-0001": "key"}; append-only, zero-padded to 4."""

    def __init__(self, stage: str, prefix: str):
        self.path = HERE / "ids" / f"{stage}.yaml"
        self.prefix = prefix
        self.by_id: dict[str, str] = load_yaml(self.path, {}) or {}
        self.by_key = {v: k for k, v in self.by_id.items()}
        self.changed = False

    def get(self, key: str) -> str:
        if key in self.by_key:
            return self.by_key[key]
        nums = [int(m.group(1)) for i in self.by_id if (m := re.match(rf"{re.escape(self.prefix)}-(\d+)$", i))]
        new = f"{self.prefix}-{(max(nums) + 1 if nums else 1):04d}"
        self.by_id[new] = key
        self.by_key[key] = new
        self.changed = True
        return new

    def save(self) -> None:
        if self.changed:
            self.path.parent.mkdir(exist_ok=True)
            lines = [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in self.by_id.items()]
            self.path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def result_file(stage: str) -> str:
    """out/<stage>.json; the walkthrough's checks go to walkthrough-checks.json (walkthrough.json is its inventory)."""
    return "walkthrough-checks.json" if stage == "walkthrough" else f"{stage}.json"


def write_stage(stage: str, prefix: str, started: str, results: list[dict], report_missing: bool = True) -> dict:
    """Give each result its stable ID, mark known checks this run didn't produce as skipped, write out/<stage>.json."""
    ids = Ids(stage, prefix)
    seen = set()
    for r in results:
        r["id"] = r.get("id") or (f"{prefix}-RUN" if r["key"] == "RUN" else ids.get(r["key"]))
        r.setdefault("detail", "")
        r.setdefault("evidence", "")
        seen.add(r["id"])
    if report_missing and not any(r["id"].endswith("-RUN") and r["status"] == "fail" for r in results):
        for i, k in ids.by_id.items():
            if i not in seen:
                results.append({"id": i, "key": k, "status": "skip",
                                "detail": "not produced by this run (removed, renamed or not reached)", "evidence": ""})
    ids.save()
    data = {"stage": stage, "prefix": prefix, "started": started, "finished": now(),
            "results": sorted(results, key=lambda r: r["id"])}
    OUT.mkdir(exist_ok=True)
    (OUT / result_file(stage)).write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    return data


def _junit(path: Path) -> list[dict]:
    res = []
    for tc in ET.parse(path).getroot().iter("testcase"):
        key = f"{tc.get('classname', '')}::{tc.get('name', '')}".strip(":")
        status, detail = "pass", ""
        for child in tc:
            if child.tag in ("failure", "error"):
                status, detail = "fail", (child.get("message") or child.text or "")[:300]
            elif child.tag == "skipped":
                status, detail = "skip", (child.get("message") or "")[:300]
        res.append({"key": key, "status": status, "detail": detail})
    return res


def run_command_stage(stage: str, spec: dict, quiet: bool) -> dict:
    """A stage of shell commands from profile.yaml: one result per command, or per test case with junit: true."""
    started, results = now(), []
    logs = OUT / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    for cmd in spec.get("commands", []):
        key = cmd["key"]
        junit = logs / f"{stage}-{key}.xml"
        run = cmd["run"].replace("{junit}", shlex.quote(str(junit)))
        log = logs / f"{stage}-{key}.log"
        env = {**os.environ, **{k: str(v) for k, v in (cmd.get("env") or {}).items()}}
        with log.open("w") as fh:
            try:
                rc = subprocess.run(run, shell=True, cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT, env=env,
                                    timeout=cmd.get("timeout", 1800), check=False).returncode
            except subprocess.TimeoutExpired:
                rc = 124
        if cmd.get("junit") and junit.is_file():
            cases = _junit(junit)
            results += [{**c, "key": f"{key}:{c['key']}", "evidence": log.name} for c in cases]
            if rc and not any(c["status"] == "fail" for c in cases):
                results.append({"key": "RUN", "status": "fail", "detail": f"{key}: exit {rc}, no failed test",
                                "evidence": log.name})
        else:
            skip = rc == cmd.get("skip_exit", -999)
            results.append({"key": key, "status": "skip" if skip else ("pass" if rc == 0 else "fail"),
                            "detail": "" if rc == 0 else f"exit {rc}; see logs/{log.name}", "evidence": log.name})
    if stage == "walkthrough":  # the crawler's own WALK- checks ({"results": [{"key", "status", "detail"}]})
        crawled = OUT / result_file(stage)
        if crawled.is_file():
            results = [{k: r.get(k, "") for k in ("key", "status", "detail", "evidence")}
                       for r in json.loads(crawled.read_text()).get("results", [])] + results
    data = write_stage(stage, spec["prefix"], started, results)
    print_stage_line(data, quiet)
    return data


def manual_stage(quiet: bool = False) -> dict:
    items = load_yaml(HERE / "manual.yaml", []) or []
    log = load_yaml(HERE / "manual-log.yaml", {}) or {}
    ver, results = version(), []
    for it in items:
        rec = log.get(it["key"]) or {}
        if rec.get("version") == ver:
            results.append({"key": it["key"], "status": rec.get("result", "manual"), "detail": rec.get("note", "")})
        else:
            results.append({"key": it["key"], "status": "manual", "detail": "needs a person for " + ver})
    data = write_stage("manual", profile().get("stages", {}).get("manual", {}).get("prefix", "MAN"), now(), results)
    print_stage_line(data, quiet)
    return data


def print_stage_line(data: dict, quiet: bool) -> None:
    c = counts(data["results"])
    print(f"{data['stage']:<12} pass {c['pass']:>4}  fail {c['fail']:>3}  skip {c['skip']:>3}  manual {c['manual']:>3}")
    for r in data["results"]:
        if r["status"] == "fail":
            print(f"  FAIL {r['id']} {r['key']}: {r['detail'][:160]}")
    sys.stdout.flush()


def run_stages(names: list[str] | None, with_walkthrough: bool = False, quiet: bool = False) -> int:
    """Run profile.yaml's command stages (and manual) in the standard order; walkthrough beside them when asked."""
    prof = profile()
    stages = prof.get("stages", {})
    order = sorted((n for n in stages if n not in ("walkthrough", "manual")), key=stage_order)
    want = list(dict.fromkeys(names or [n for n in order if n != "live"] + ["live"] * ("live" in stages) + ["manual"]))
    walker = None
    if with_walkthrough or (names and "walkthrough" in names):
        walker = threading.Thread(target=lambda: (run_command_stage("walkthrough", stages["walkthrough"], quiet),
                                                  print("walkthrough done")))
        walker.start()
    fails = 0
    for n in want:
        if n == "walkthrough":
            continue
        data = manual_stage(quiet) if n == "manual" else run_command_stage(n, stages[n], quiet)
        fails += counts(data["results"])["fail"]
    if walker:
        walker.join()
    return 1 if fails else 0


# ---------------------------------------------------------------- RUNS.md

def runs_rows(path: Path, header: str) -> list[list[str]]:
    if not path.is_file():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    try:
        start = lines.index(header) + 2
    except ValueError:
        return []
    rows = []
    for ln in lines[start:]:
        if not ln.startswith("|"):
            break
        rows.append([c.strip() for c in ln.strip("|").split("|")])
    return rows


def last_commit(path: Path, header: str) -> str:
    rows = runs_rows(path, header)
    if rows:
        m = re.search(r"[0-9a-f]{7,40}", rows[0][1])
        return m.group(0) if m else ""
    # older, project-specific log formats: the first commit-looking token in the file
    if path.is_file():
        m = re.search(r"`([0-9a-f]{7,40})`|\bat ([0-9a-f]{7,40})\b", path.read_text(encoding="utf-8"))
        if m:
            return m.group(1) or m.group(2)
    return ""


def add_row(path: Path, header: str, title: str, row: list[str]) -> None:
    text = path.read_text(encoding="utf-8") if path.is_file() else f"# {title}\n"
    line = "| " + " | ".join(row) + " |"
    if header in text:
        lines = text.splitlines()
        i = lines.index(header) + 2
        lines.insert(i, line)
        text = "\n".join(lines) + "\n"
    else:  # first standard row: put the standard table above any older entries
        head, _, rest = text.partition("\n")
        sep = "|" + "---|" * header.count(" | ") + "---|"
        text = f"{head}\n\n{header}\n{sep}\n{line}\n\n{rest.lstrip()}"
    path.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------- brief

REVIEWER_TEXT = {
    "bugs": "Find correctness bugs and security problems in what changed, then in the project's risky paths.",
    "claims": ("Check every security and privacy claim listed below against the code, and run the project's static "
               "security tools ({tools}). A claim the code doesn't keep is a finding (SEC-). Report each claim "
               "checked in `claims` with held true/false."),
    "exposure": ("Attack the new code and the build, deployment and workflow surface as an outsider and as a "
                 "signed-in user reaching beyond their role: Dockerfiles, compose files, deployment scripts, "
                 ".github/workflows (permissions, untrusted input in run:, pull_request_target, secrets, unpinned "
                 "actions), the release path, outbound requests (SSRF), anything newly reachable without signing in."),
}
PREAMBLE = """You are an independent, read-only reviewer of the repository at {root} ({name}: {type}).
Do not edit, commit or push anything, run no test suite and nothing that touches a database or port the regression
stages use, and contact no host except 127.0.0.1. Ignore .claude/. Use made-up names only; include nothing that
identifies a real person. Mark a finding verified only if you proved it by running code or quote the exact code path
that makes it certain; leave out false positives. Return ONLY one JSON object matching this schema:
{schema}
"""


def audit_depth(force_full: bool) -> tuple[str, str]:
    rows = runs_rows(HERE / "RUNS.md", RUNS_HEADER)
    if force_full:
        return "full", "asked for"
    if not rows:
        return "full", "first run in the standard format"
    since = 0
    for r in rows:
        if r[3].startswith("full"):
            mm = lambda v: ".".join(v.split(".")[:2])  # noqa: E731
            if mm(r[2]) != mm(version()):
                return "full", f"version {mm(version())} is new since the last full audit ({r[2]})"
            break
        since += 1
    else:
        return "full", "no full audit on record"
    if since + 1 >= FULL_AUDIT_EVERY:
        return "full", f"every {FULL_AUDIT_EVERY}th run"
    return "delta", f"{since} run(s) since the last full audit"


def cmd_brief(args) -> None:
    prof = profile()
    briefs = OUT / "briefs"
    briefs.mkdir(parents=True, exist_ok=True)
    rv = prof.get("reviewers", {})
    common = dict(root=ROOT, name=prof.get("name", ROOT.name), type=prof.get("type", "project"))
    if args.walkthrough:
        for who, size in (("desktop", "1280x900"), ("phone", "390x844")):
            text = PREAMBLE.format(**common, schema=json.dumps(WALK_SCHEMA)) + f"""
Your task: a streamlining review of the {who} walkthrough ({size}), roles: {', '.join(prof.get('roles', []))}.
Inventory: {OUT / 'walkthrough.json'} (role -> {who} -> menu and pages); screenshots under {OUT / 'walkthrough'}
(the Read tool shows images); automated UX checks: {OUT / 'walkthrough-checks.json'}.
Find: duplicates (two ways to the same thing), confusing or inconsistent names, things in the wrong place, dead ends,
long flows (count the taps), what must stay separate (say why), layout problems the checks missed. Propose a menu per
role. Rate each finding's value (high/medium/low). Ids: {'WD' if who == 'desktop' else 'WP'}-001 onward.
Project focus: {rv.get(who, '') or 'none given'}
"""
            (briefs / f"{who}.md").write_text(text, encoding="utf-8")
            print(f"brief: {briefs / (who + '.md')}")
        return
    depth, why = audit_depth(args.full)
    prev = last_commit(HERE / "RUNS.md", RUNS_HEADER)
    if prev and subprocess.run(["git", "cat-file", "-e", f"{prev}^{{commit}}"], cwd=ROOT,
                               capture_output=True).returncode != 0:
        prev = ""  # not in this (shallow) clone: treat as unknown, so the whole repository is reviewed
    if not prev and depth == "delta":
        depth, why = "full", "the previous run's commit is not available"
    changed = git("diff", "--name-only", f"{prev}..HEAD").splitlines() if prev else []
    claims = load_yaml(HERE / "claims.yaml", []) or []
    if depth == "delta":
        picked = [c for c in claims if any(fnmatch.fnmatch(f, g) for f in changed for g in c.get("code", ["*"]))]
    else:
        picked = claims
    rng = f"`git diff {prev}..HEAD` ({len(changed)} files)" if prev else "the whole repository (no previous run found)"
    for who in ("bugs", "claims", "exposure"):
        body = REVIEWER_TEXT[who].format(tools=prof.get("security_tools", "bandit, pip-audit, npm audit"))
        text = PREAMBLE.format(**common, schema=json.dumps(FINDINGS_SCHEMA)) + f"\nYour task ({who}): {body}\n"
        text += f"Since the last run: {rng}. Reviewer name in the JSON: \"{who}\".\n"
        if who == "claims":
            text += (f"Audit depth: {depth.upper()} ({why}). " + (
                "Read the whole codebase, not only the changes.\n" if depth == "full" else
                "Check the claims below (their code changed) and that nothing in the diff breaks another claim.\n"))
            text += "Claims:\n" + "".join(
                f"- {c['id']}: {c['claim']} (docs: {', '.join(c.get('where', []))}; code: {', '.join(c.get('code', []))})\n"
                for c in picked) if picked else "Claims: none affected by this diff.\n"
        text += f"Project focus: {rv.get(who, '') or 'none given'}\n"
        (briefs / f"{who}.md").write_text(text, encoding="utf-8")
    meta = {"audit": depth, "why": why, "previous_commit": prev, "changed_files": len(changed),
            "claims_checked": [c["id"] for c in picked], "claims_total": len(claims)}
    (OUT / "brief.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(f"audit: {depth} ({why}); claims to check: {len(picked)}/{len(claims)}; briefs in {briefs}")


# ---------------------------------------------------------------- summary, report, log

def counts(results: list[dict]) -> dict:
    c = {"pass": 0, "fail": 0, "skip": 0, "manual": 0}
    for r in results:
        c[r["status"] if r["status"] in c else "fail"] += 1
    return c


def catalogue_gaps(stages: list[dict]) -> tuple[list[str], list[str]]:
    """Features whose match finds no automatic check; automatic checks no feature claims."""
    keys = [f"{s['stage']}:{r['key']}" for s in stages if s["stage"] not in ("manual", "walkthrough")
            for r in s["results"] if r["status"] != "skip"]
    claimed, uncovered = set(), []
    for f in sorted((HERE / "catalogue").glob("*.yaml")):
        for feat in load_yaml(f, []) or []:
            pats = [re.compile(p) for p in feat.get("match", [])]
            hit = {k for k in keys if any(p.search(k) for p in pats)}
            claimed |= hit
            if not hit and not feat.get("manual_only"):
                uncovered.append(f"{f.stem}: {feat.get('feature', '?')}")
    unclaimed = [k for k in keys if k not in claimed and not k.endswith(":RUN")]
    return uncovered, unclaimed


def findings_counts(sets: list[dict]) -> dict:
    c = {s: 0 for s in SEVERITIES}
    for fs in sets:
        for f in fs.get("findings", []):
            c[f.get("severity", "info")] = c.get(f.get("severity", "info"), 0) + 1
    return c


def cmd_summary(_args=None) -> None:
    stages = load_stages()
    lines = [f"{profile().get('name', ROOT.name)} {version()} at {git('rev-parse', '--short', 'HEAD')}"]
    fails = []
    for s in stages:
        c = counts(s["results"])
        lines.append(f"  {s['stage']:<12} pass {c['pass']:>4}  fail {c['fail']:>3}  skip {c['skip']:>3}  manual {c['manual']:>3}")
        fails += [f"  {r['id']} {r['key'][:80]}: {r['detail'][:80]}" for r in s["results"] if r["status"] == "fail"]
    if fails:
        lines.append(f"Failing ({len(fails)}):")
        lines += fails[:15] + ([f"  ... {len(fails) - 15} more in the report"] if len(fails) > 15 else [])
    meta = json.loads((OUT / "brief.json").read_text()) if (OUT / "brief.json").is_file() else {}
    sets = load_findings(["bugs", "claims", "exposure"])
    fc = findings_counts(sets)
    lines.append(f"Audit: {meta.get('audit', '?')} ({meta.get('why', 'no brief')}). Findings: "
                 + ", ".join(f"{n} {k}" for k, n in fc.items() if n) if any(fc.values()) else
                 f"Audit: {meta.get('audit', '?')}. Findings: none")
    broken = [c["id"] for fs in sets for c in fs.get("claims", []) if not c.get("held", True)]
    if broken:
        lines.append("Claims not held: " + ", ".join(broken))
    bad = [f"{fs['reviewer']} ({fs['status']})" for fs in sets if fs.get("status") not in ("done", None)]
    if bad:
        lines.append("Reviewers without a result: " + ", ".join(bad))
    uncovered, unclaimed = catalogue_gaps(stages)
    if uncovered or unclaimed:
        lines.append(f"Catalogue: {len(uncovered)} feature(s) without an automatic check, {len(unclaimed)} check(s) "
                     "no feature claims")
    print("\n".join(lines[:40]))


CSS = """:root{--bg:#fff;--fg:#1d1d1f;--mut:#6b6b70;--line:#e3e3e8;--card:#f6f6f8;--bad:#b42318;--ok:#067647;--warn:#b54708}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#111113;--fg:#ececf0;--mut:#9a9aa3;--line:#2c2c31;--card:#1a1a1d;--bad:#f97066;--ok:#47cd89;--warn:#fdb022}}
:root[data-theme=dark]{--bg:#111113;--fg:#ececf0;--mut:#9a9aa3;--line:#2c2c31;--card:#1a1a1d;--bad:#f97066;--ok:#47cd89;--warn:#fdb022}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px}
.mut{color:var(--mut)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.tile b{font-size:22px;display:block}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600}.fail,.critical,.high{color:var(--bad);font-weight:600}.pass{color:var(--ok)}.medium,.manual{color:var(--warn)}
code{font-size:13px}details{margin:6px 0}"""


def page(title: str, body: str) -> str:
    return (f"<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,"
            f"initial-scale=1'><title>{html.escape(title)}</title><style>{CSS}</style></head><body><main>{body}"
            "</main></body></html>")


def when() -> str:
    tz = profile().get("report_tz", "UTC")
    try:
        from zoneinfo import ZoneInfo
        t = dt.datetime.now(ZoneInfo(tz))
    except Exception:  # noqa: BLE001
        t, tz = dt.datetime.now(dt.timezone.utc), "UTC"
    return t.strftime("%Y-%m-%d %H:%M ") + tz


def table(head: list[str], rows: list[list[str]]) -> str:
    h = "".join(f"<th>{html.escape(c)}</th>" for c in head)
    b = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f"<div class=wrap><table><thead><tr>{h}</tr></thead><tbody>{b}</tbody></table></div>"


def esc(v) -> str:
    return html.escape(str(v if v is not None else ""))


def cmd_report(args) -> None:
    prof, ver, sha = profile(), version(), git("rev-parse", "--short", "HEAD")
    name = prof.get("name", ROOT.name)
    if args.walkthrough:
        return report_walkthrough(prof, ver, sha, name)
    stages = load_stages()
    meta = json.loads((OUT / "brief.json").read_text()) if (OUT / "brief.json").is_file() else {}
    sets = load_findings(["bugs", "claims", "exposure"])
    tot = counts([r for s in stages for r in s["results"]])
    fc = findings_counts(sets)
    notes = load_yaml(OUT / "notes.yaml", {}) or {}
    b = [f"<h1>{esc(name)} regression</h1><p class=mut>Version {esc(ver)} at <code>{esc(sha)}</code>, {esc(when())}. "
         f"Security audit: {esc(meta.get('audit', '?'))} ({esc(meta.get('why', 'no brief'))}).</p>"]
    if notes.get("summary"):
        b.append(f"<p>{esc(notes['summary'])}</p>")
    b.append("<div class=tiles>" + "".join(f"<div class=tile><b class={k}>{v}</b>{k}</div>" for k, v in tot.items())
             + "".join(f"<div class=tile><b class={k}>{v}</b>{k} findings</div>" for k, v in fc.items() if v) + "</div>")
    b.append("<h2>Stages</h2>" + table(["Stage", "Pass", "Fail", "Skip", "Manual", "Finished"], [
        [esc(s["stage"])] + [str(counts(s["results"])[k]) for k in ("pass", "fail", "skip", "manual")]
        + [esc(s.get("finished", ""))] for s in stages]))
    fails = [[f"<code>{esc(r['id'])}</code>", esc(r["key"]), esc(r["detail"])] for s in stages for r in s["results"]
             if r["status"] == "fail"]
    b.append("<h2>Failing checks</h2>" + (table(["ID", "Check", "Detail"], fails) if fails else "<p>None.</p>"))
    allf = sorted((f | {"_r": fs["reviewer"]} for fs in sets for f in fs.get("findings", [])),
                  key=lambda f: SEVERITIES.index(f.get("severity", "info")))
    rows = []
    for f in allf:
        where = f"{f.get('file', '')}:{f.get('line', '')}".strip(":")
        rows.append([f"<code>{esc(f['id'])}</code>", f"<span class={esc(f.get('severity'))}>{esc(f.get('severity'))}</span>",
                     esc(f["_r"]), "yes" if f.get("verified") else "no",
                     f"<details><summary>{esc(f.get('title'))}</summary><p>{esc(f.get('description'))}</p>"
                     f"<p><b>Scenario.</b> {esc(f.get('scenario'))}</p><p><b>Fix.</b> {esc(f.get('recommendation'))}</p>"
                     f"<p class=mut>{esc(where)}</p></details>"])
    b.append("<h2>Security audit and review findings</h2>" + (table(["ID", "Severity", "Reviewer", "Verified", "Finding"], rows)
                                                             if rows else "<p>None.</p>"))
    st = [f"{esc(fs['reviewer'])}: {esc(fs.get('status'))} — {esc(fs.get('scope', ''))}" for fs in sets]
    b.append("<p class=mut>" + "<br>".join(st) + "</p>")
    claims = {c["id"]: c for c in load_yaml(HERE / "claims.yaml", []) or []}
    cr = [[esc(c["id"]), esc(claims.get(c["id"], {}).get("claim", "")),
           "<span class=pass>held</span>" if c.get("held") else "<span class=fail>not held</span>", esc(c.get("note"))]
          for fs in sets for c in fs.get("claims", [])]
    if cr:
        b.append(f"<h2>Claims checked ({len(cr)} of {len(claims)})</h2>" + table(["ID", "Claim", "Result", "Note"], cr))
    man = [[esc(r["id"]), esc(r["key"]), esc(r["detail"])] for s in stages if s["stage"] == "manual"
           for r in s["results"] if r["status"] == "manual"]
    if man:
        b.append(f"<h2>Manual checks due ({len(man)})</h2>" + table(["ID", "Check", "Note"], man))
    uncovered, unclaimed = catalogue_gaps(stages)
    if uncovered or unclaimed:
        b.append("<h2>Catalogue</h2><p>Features without an automatic check: " + (esc(", ".join(uncovered)) or "none")
                 + f".</p><p class=mut>{len(unclaimed)} automatic check(s) not claimed by any feature.</p>")
    if notes.get("observations"):
        b.append("<h2>Observations</h2><ul>" + "".join(f"<li>{esc(o)}</li>" for o in notes["observations"]) + "</ul>")
    (OUT / "report.html").write_text(page(f"{name} regression", "".join(b)), encoding="utf-8")
    print(OUT / "report.html")


def report_walkthrough(prof, ver, sha, name) -> None:
    inv = json.loads((OUT / "walkthrough.json").read_text()) if (OUT / "walkthrough.json").is_file() else {}
    chk = json.loads((OUT / "walkthrough-checks.json").read_text()) if (OUT / "walkthrough-checks.json").is_file() else {"results": []}
    sets = load_findings(["walkthrough-desktop", "walkthrough-phone"])
    pages = sum(len(v.get("pages", [])) for r in inv.values() if isinstance(r, dict) for v in r.values() if isinstance(v, dict))
    fails = [r for r in chk.get("results", []) if r["status"] == "fail"]
    b = [f"<h1>{esc(name)} walkthrough</h1><p class=mut>Version {esc(ver)} at <code>{esc(sha)}</code>, {esc(when())}. "
         f"{len(inv)} roles, {pages} pages (desktop and phone).</p>",
         "<div class=tiles>" + f"<div class=tile><b>{len(inv)}</b>roles</div><div class=tile><b>{pages}</b>pages</div>"
         f"<div class=tile><b class={'fail' if fails else 'pass'}>{len(fails)}</b>UX checks failing</div>"
         + "".join(f"<div class=tile><b>{len(fs.get('findings', []))}</b>{esc(fs['reviewer'])} findings</div>" for fs in sets)
         + "</div>"]
    if fails:
        b.append("<h2>UX checks failing</h2>" + table(["ID", "Check", "Detail"], [
            [f"<code>{esc(r['id'])}</code>", esc(r["key"]), esc(r["detail"])] for r in fails]))
    for fs in sets:
        rows = [[f"<code>{esc(f['id'])}</code>", esc(f.get("group")), esc(f.get("value", "")), esc(", ".join(f.get("roles", []))),
                 f"<details><summary>{esc(f['title'])}</summary><p>{esc(f.get('detail'))}</p>"
                 f"<p><b>Proposal.</b> {esc(f.get('proposal'))}</p><p class=mut>{esc(', '.join(f.get('pages', [])))}</p></details>"]
                for f in sorted(fs.get("findings", []), key=lambda f: (f.get("group", ""), f.get("value", "")))]
        b.append(f"<h2>{esc(fs['reviewer'])} ({esc(fs.get('status'))})</h2>"
                 + (table(["ID", "Group", "Value", "Roles", "Finding"], rows) if rows else "<p>None.</p>"))
        if fs.get("proposed_menus"):
            b.append("<details><summary>Proposed menus</summary><pre>" + esc(yaml.safe_dump(fs["proposed_menus"],
                     sort_keys=False, allow_unicode=True)) + "</pre></details>")
    (OUT / "walkthrough.html").write_text(page(f"{name} walkthrough", "".join(b)), encoding="utf-8")
    print(OUT / "walkthrough.html")


def link(kind: str) -> str:
    url = (load_yaml(HERE / "published.yaml", {}) or {}).get(kind, "")
    return f"[{kind}]({url})" if url else "(not published)"


def cmd_log(args) -> None:
    sha, ver = git("rev-parse", "--short", "HEAD"), version()
    date = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M")
    both = args.full_check
    if not args.walkthrough or both:
        stages = load_stages()
        tot = counts([r for s in stages for r in s["results"]])
        meta = json.loads((OUT / "brief.json").read_text()) if (OUT / "brief.json").is_file() else {}
        fc = findings_counts(load_findings(["bugs", "claims", "exposure"]))
        failing = [r["id"] for s in stages for r in s["results"] if r["status"] == "fail"]
        rep = link("regression") + (" · " + link("walkthrough") if both else "")
        add_row(HERE / "RUNS.md", RUNS_HEADER, "Regression runs", [
            date, f"`{sha}`", ver, meta.get("audit", "?") + (" (full check)" if both else ""), str(tot["pass"]),
            str(tot["fail"]), str(tot["skip"]), str(tot["manual"]),
            ", ".join(failing[:12]) + (f" +{len(failing) - 12}" if len(failing) > 12 else "") or "none",
            ", ".join(f"{n} {k}" for k, n in fc.items() if n) or "none", rep])
        print("logged in regression/RUNS.md")
    if args.walkthrough or both:
        inv = json.loads((OUT / "walkthrough.json").read_text()) if (OUT / "walkthrough.json").is_file() else {}
        chk = json.loads((OUT / "walkthrough-checks.json").read_text()) if (OUT / "walkthrough-checks.json").is_file() else {"results": []}
        pages = sum(len(v.get("pages", [])) for r in inv.values() if isinstance(r, dict) for v in r.values() if isinstance(v, dict))
        nf = sum(len(fs.get("findings", [])) for fs in load_findings(["walkthrough-desktop", "walkthrough-phone"]))
        rep = link("walkthrough") + (" · " + link("regression") if both else "")
        add_row(HERE / "WALKTHROUGHS.md", WALKS_HEADER, "Walkthroughs", [
            date, f"`{sha}`", ver, str(len(inv)), str(pages),
            str(sum(1 for r in chk.get("results", []) if r["status"] == "fail")), str(nf), rep])
        print("logged in regression/WALKTHROUGHS.md")


def cmd_manual(args) -> None:
    path = HERE / "manual-log.yaml"
    log = load_yaml(path, {}) or {}
    log[args.key] = {"result": args.result, "version": version(), "date": dt.date.today().isoformat(),
                     "note": args.note or ""}
    path.write_text(yaml.safe_dump(log, sort_keys=True, allow_unicode=True), encoding="utf-8")
    print(f"{args.key}: {args.result} for {version()}")


def walkthrough_due() -> bool:
    """True when a UI file changed since the newest WALKTHROUGHS.md row (or there is none)."""
    prev = last_commit(HERE / "WALKTHROUGHS.md", WALKS_HEADER)
    if not prev:
        return True
    pats = [re.compile(p) for p in (profile().get("walkthrough", {}) or {}).get("ui_paths", [".*"])]
    changed = git("diff", "--name-only", f"{prev}..HEAD").splitlines()
    return any(p.search(f) for f in changed for p in pats)


# ---------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="standard.py", description=__doc__.split("\n\n")[0])
    ap.add_argument("--version", action="version", version=f"regression-kit {KIT_VERSION}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("brief"); p.add_argument("--full", action="store_true"); p.add_argument("--walkthrough", action="store_true")
    p = sub.add_parser("report"); p.add_argument("--walkthrough", action="store_true")
    p = sub.add_parser("log"); p.add_argument("--walkthrough", action="store_true"); p.add_argument("--full-check", action="store_true")
    sub.add_parser("summary")
    sub.add_parser("walkthrough-due")
    p = sub.add_parser("manual"); p.add_argument("key"); p.add_argument("result", choices=["pass", "fail"]); p.add_argument("--note")
    p = sub.add_parser("schema"); p.add_argument("which", choices=["findings", "walkthrough"])
    a = ap.parse_args(argv)
    if a.cmd == "schema":
        print(json.dumps(FINDINGS_SCHEMA if a.which == "findings" else WALK_SCHEMA, indent=1))
    elif a.cmd == "walkthrough-due":
        due = walkthrough_due()
        print("walkthrough due" if due else "no UI change since the last walkthrough")
        return 0 if due else 3
    else:
        {"brief": cmd_brief, "report": cmd_report, "log": cmd_log, "summary": cmd_summary, "manual": cmd_manual}[a.cmd](a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
