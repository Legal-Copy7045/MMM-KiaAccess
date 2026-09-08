#!/usr/bin/env python3
"""Runs every fixtures/*.json through vehicle_state.py + conditions.py.

test/contract.test.js runs the same files through the JS originals; CI runs both,
so any JS<->Python drift fails the build.
"""
import glob
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from conditions import evaluate  # noqa: E402
from vehicle_state import build_state  # noqa: E402

files = sorted(glob.glob(os.path.join(ROOT, "fixtures", "*.json")))
assert len(files) >= 5, "expected a fixture corpus"


def resolve_history(hist):
    if not isinstance(hist, list):
        return hist
    now = time.time() * 1000
    return [
        {**h, "t": now - h["hoursAgo"] * 3600e3} if isinstance(h, dict) and h.get("hoursAgo") is not None else h
        for h in hist
    ]


checks = 0
for path in files:
    fx = json.load(open(path, encoding="utf-8"))
    label = f"{os.path.basename(path)}: {fx.get('name')}"

    if fx.get("state") is not None:
        state = dict(fx["state"])
        state["history"] = resolve_history(state.get("history"))
    else:
        state = build_state(fx.get("flat") or {}, {})

    for k, want in (fx.get("expectState") or {}).items():
        got = state.get(k)
        assert got == want, f"{label} - state.{k}: got {got!r} want {want!r}"
        checks += 1

    res = evaluate(state, fx.get("cfg") or {}, fx.get("prev") or {})
    by_reason = {c["reason"]: c for c in res["conditions"]}
    for reason, want in (fx.get("expectConditions") or {}).items():
        assert reason in by_reason, f"{label} - condition {reason!r} not emitted"
        got = by_reason[reason]["active"]
        assert got is want, f"{label} - {reason}.active: got {got!r} want {want!r}"
        checks += 1

print(f"all contract tests passed ({len(files)} fixtures, {checks} assertions)")
