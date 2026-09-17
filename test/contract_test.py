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

# ---- build_state(): powertrain/canPlugIn/rangeKm -- mirrors
# test/state.test.js's identical direct assertions ----
assert build_state({}, {})["powertrain"] == "ev", "unset engine_type defaults to ev"
assert build_state({"vehicle.engine_type": "ICE"}, {})["powertrain"] == "gas"
assert build_state({"vehicle.engine_type": "PHEV"}, {})["powertrain"] == "hybrid"
assert build_state({"vehicle.engine_type": "HEV"}, {})["powertrain"] == "hybrid"

assert build_state({}, {})["canPlugIn"] is True, "unset engine_type defaults to true (safe default)"
assert build_state({"vehicle.engine_type": "EV"}, {})["canPlugIn"] is True
assert build_state({"vehicle.engine_type": "PHEV"}, {})["canPlugIn"] is True
assert build_state({"vehicle.engine_type": "HEV"}, {})["canPlugIn"] is False, "a conventional hybrid has no plug"
assert build_state({"vehicle.engine_type": "ICE"}, {})["canPlugIn"] is False
assert build_state({"vehicle.engine_type": "hev"}, {})["canPlugIn"] is False, "case-insensitive"

assert build_state({"vehicle.ev_driving_range": 300}, {})["rangeKm"] == 300, "ev_driving_range preferred when present"
assert build_state({"vehicle.total_driving_range": 450}, {})["rangeKm"] == 450, "falls back to total_driving_range"
assert build_state(
    {"vehicle.ev_driving_range": 0, "vehicle.total_driving_range": 450}, {}
)["rangeKm"] == 450, "a zero ev_driving_range (not just missing) still falls back"
assert build_state({}, {})["rangeKm"] is None, "no range data at all -> None, not a crash"
checks += 15

# ---- powertrain gating: a pure gas vehicle has no drive battery to read
# or plug into -- mirrors test/conditions.test.js's identical direct
# assertions (not fixture-driven, since the fixture corpus above only
# checks a listed reason's `active` value, not whether a reason was
# emitted at all) ----
by_reason = {c["reason"]: c for c in evaluate(
    {"powertrain": "gas", "batteryPct": None, "car12vPct": 30}, {}, {}
)["conditions"]}
assert "ev_battery_low" not in by_reason, "gas: no ev_battery_low condition at all"
assert "ev_battery_critical" not in by_reason, "gas: no ev_battery_critical condition at all"
assert by_reason["battery_12v_low"]["active"] is True, "gas: 12V battery check still applies"

by_reason = {c["reason"]: c for c in evaluate(
    {"powertrain": "gas", "atHome": True, "homeUnpluggedMin": 999, "plugged": None}, {}, {}
)["conditions"]}
assert "not_plugged_home" not in by_reason, "gas: parked-and-not-plugged-in is meaningless, not evaluated"

by_reason = {c["reason"]: c for c in evaluate({"batteryPct": 5}, {}, {})["conditions"]}
assert by_reason["ev_battery_low"]["active"] is True, "no powertrain field -> defaults to evaluating"

by_reason = {c["reason"]: c for c in evaluate({"powertrain": "hybrid", "batteryPct": 5}, {}, {})["conditions"]}
assert by_reason["ev_battery_low"]["active"] is True, "hybrid still has a drive battery"

by_reason = {c["reason"]: c for c in evaluate(
    {"powertrain": "hybrid", "atHome": True, "homeUnpluggedMin": 999, "plugged": False}, {}, {}
)["conditions"]}
assert by_reason["not_plugged_home"]["active"] is True, "hybrid can still plug in"
checks += 6

# ---- canPlugIn: a non-plug hybrid (HEV, e.g. a Kia Sportage Hybrid or
# Hyundai Tucson Hybrid, sold alongside a PHEV version of the same car)
# shares powertrain:"hybrid" with a PHEV but has no plug -- mirrors
# test/conditions.test.js's identical direct assertions ----
by_reason = {c["reason"]: c for c in evaluate(
    {"powertrain": "hybrid", "canPlugIn": False, "atHome": True, "homeUnpluggedMin": 999, "plugged": None},
    {}, {},
)["conditions"]}
assert "not_plugged_home" not in by_reason, "HEV (hybrid, canPlugIn=False): no plug, not evaluated"

by_reason = {c["reason"]: c for c in evaluate(
    {"powertrain": "hybrid", "canPlugIn": False, "batteryPct": 5}, {}, {}
)["conditions"]}
assert by_reason["ev_battery_low"]["active"] is True, "HEV still has a drive battery worth monitoring"

by_reason = {c["reason"]: c for c in evaluate(
    {"powertrain": "hybrid", "canPlugIn": True, "atHome": True, "homeUnpluggedMin": 999, "plugged": False},
    {}, {},
)["conditions"]}
assert by_reason["not_plugged_home"]["active"] is True, "PHEV (hybrid, canPlugIn=True): has a plug"
checks += 3

print(f"all contract tests passed ({len(files)} fixtures, {checks} assertions)")
