#!/usr/bin/env python3
"""Kia Access regression runner (the project standard's command set; see regression/README.md and profile.yaml).

    python3 regression/run.py check                 ci + unit, quiet: run before marking a PR ready
    python3 regression/run.py                       every stage but walkthrough
    python3 regression/run.py --with-walkthrough    every stage and the walkthrough
    python3 regression/run.py --stage unit          one stage (repeatable)
    python3 regression/run.py brief|report|log|summary|manual|schema|walkthrough-due ...   (standard.py)

The ci, page, live and walkthrough stages are the commands in profile.yaml. The unit stage is this project's own:
one check per test file (every node test the `npm test` script runs, every Python test scripts/test-python.js
lists), so the catalogue can name the file that covers each feature. The Home Assistant tests are skipped, not
failed, when `homeassistant` isn't installed (CI's hass job runs them). Everything after the stages is standard.py.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import standard  # noqa: E402

TOOLING = {"brief", "report", "log", "summary", "manual", "schema", "walkthrough-due"}
ROOT = standard.ROOT


def unit_files() -> list[tuple[str, list[str], str]]:
    """(key, command, group) for every test file, in the order the project's own runners use."""
    pkg = json.loads((ROOT / "package.json").read_text())
    out = [(f"js:{m}", ["node", m], "js") for m in re.findall(r"node (test/[\w.-]+\.js)", pkg["scripts"]["test"])]
    listed = subprocess.run(["node", "scripts/test-python.js", "--list"], cwd=ROOT, capture_output=True, text=True,
                            check=True).stdout.split("\n")
    for line in filter(None, listed):
        group, f = line.split(" ", 1)
        out.append((f"py:{f}", [sys.executable, f], group))
    return out


def unit_stage(quiet: bool) -> dict:
    started, results = standard.now(), []
    logs = standard.OUT / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    has_hass = subprocess.run([sys.executable, "-c", "import homeassistant"], capture_output=True).returncode == 0
    for key, cmd, group in unit_files():
        log = logs / ("unit-" + re.sub(r"[^\w.-]+", "_", key) + ".log")
        if group == "hass" and not has_hass:
            results.append({"key": key, "status": "skip", "detail": "homeassistant isn't installed here (CI's hass job runs it)"})
            continue
        with log.open("w") as fh:
            try:
                rc = subprocess.run(cmd, cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT, timeout=900, check=False).returncode
            except subprocess.TimeoutExpired:
                rc = 124
        results.append({"key": key, "status": "pass" if rc == 0 else "fail",
                        "detail": "" if rc == 0 else f"exit {rc}; see logs/{log.name}", "evidence": log.name})
    prefix = standard.profile()["stages"]["unit"]["prefix"]
    data = standard.write_stage("unit", prefix, started, results)
    standard.print_stage_line(data, quiet)
    return data


def run(names, with_walkthrough=False, quiet=False) -> int:
    prof = standard.profile()
    stages = prof["stages"]
    order = sorted((n for n in stages if n not in ("walkthrough", "manual")), key=standard.stage_order)
    want = list(dict.fromkeys(names or order + ["manual"]))
    if with_walkthrough and "walkthrough" not in want:
        want.append("walkthrough")
    fails = 0
    for n in want:
        if n == "unit":
            data = unit_stage(quiet)
        elif n == "manual":
            data = standard.manual_stage(quiet)
        else:
            data = standard.run_command_stage(n, stages[n], quiet)
        fails += standard.counts(data["results"])["fail"]
    return 1 if fails else 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] in TOOLING:
        return standard.main(sys.argv[1:])
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("mode", nargs="?", choices=["check"], help="ci + unit, quiet")
    ap.add_argument("--stage", action="append", help="run only this stage (repeatable)")
    ap.add_argument("--with-walkthrough", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    standard.OUT.mkdir(exist_ok=True)
    if a.mode == "check":
        return run(["ci", "unit"], quiet=True)
    return run(a.stage, with_walkthrough=a.with_walkthrough, quiet=a.quiet)


if __name__ == "__main__":
    sys.exit(main())
