"""python test/sessions_test.py — mirrors test/sessions.test.js"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import sessions as S  # noqa: E402

MIN = 60000
opts = {"pricePerKwh": 0.185, "capacityKwh": 100}
t0 = 1757368800000  # 2026-09-08T22:00:00Z in ms


def step(open_s, **cur):
    return S.update(open_s, cur, opts)


open_s = step(None, t=t0, charging=True, plugged=True, batteryPct=40, chargeKw=7.4)["open"]
assert open_s and open_s["startPct"] == 40

open_s = step(open_s, t=t0 + 60 * MIN, charging=True, plugged=True, batteryPct=55, chargeKw=7.2)["open"]
open_s = step(open_s, t=t0 + 80 * MIN, charging=False, plugged=True, batteryPct=55)["open"]
assert open_s, "20-min pause keeps the session open"
open_s = step(open_s, t=t0 + 100 * MIN, charging=True, plugged=True, batteryPct=62, chargeKw=7.3)["open"]
open_s = step(open_s, t=t0 + 200 * MIN, charging=True, plugged=True, batteryPct=80, chargeKw=1.1)["open"]

r = step(open_s, t=t0 + 600 * MIN, charging=False, plugged=False, batteryPct=80)
assert r["open"] is None
c = r["closed"]
assert c and c["startPct"] == 40 and c["endPct"] == 80
assert c["gainedPct"] == 40
assert c["kwh"] == 40
assert c["cost"] == 7.4
assert c["peakKw"] == 7.4

# trickle discarded
open_s = step(None, t=t0, charging=True, plugged=True, batteryPct=79)["open"]
r = step(open_s, t=t0 + 5 * MIN, charging=False, plugged=False, batteryPct=79)
assert r["closed"] is None

# plugged but never charging
r = step(None, t=t0, charging=False, plugged=True, batteryPct=50)
assert r["open"] is None and r["closed"] is None

# 45-min idle closes a still-plugged session
open_s = step(None, t=t0, charging=True, plugged=True, batteryPct=50, chargeKw=50)["open"]
open_s = step(open_s, t=t0 + 30 * MIN, charging=True, plugged=True, batteryPct=90, chargeKw=20)["open"]
r = step(open_s, t=t0 + 90 * MIN, charging=False, plugged=True, batteryPct=90)
assert r["closed"] and r["closed"]["kwh"] == 40

# progress
open_s = step(None, t=t0, charging=True, plugged=True, batteryPct=40, chargeKw=7.4)["open"]
open_s = step(open_s, t=t0 + 60 * MIN, charging=True, plugged=True, batteryPct=55, chargeKw=7.2)["open"]
pr = S.progress(open_s, {"t": t0 + 60 * MIN, "charging": True, "batteryPct": 55, "chargeKw": 7.2}, opts)
assert pr["kwh"] == 15 and pr["cost"] == 2.78
pr = S.progress(open_s, {"t": t0 + 70 * MIN, "charging": True, "batteryPct": 55, "chargeKw": 7.2}, opts)
assert 16 < pr["kwh"] < 16.5, pr["kwh"]
pr = S.progress(open_s, {"t": t0 + 200 * MIN, "charging": True, "batteryPct": 55, "chargeKw": 7.2}, opts)
assert pr["kwh"] < 17
assert S.progress(None, {"t": t0, "charging": True}, opts) is None

now = time.time() * 1000
sm = S.summary([
    {"endedAt": now - 2 * 864e5, "kwh": 40, "cost": 7.4},
    {"endedAt": now - 10 * 864e5, "kwh": 25, "cost": 4.63},
    {"endedAt": now - 40 * 864e5, "kwh": 30, "cost": 5.55},
], 30)
assert sm["count"] == 2 and sm["kwh"] == 65 and sm["cost"] == 12.03

# --- home vs away rate ---
ha = {"pricePerKwh": 0.185, "awayPricePerKwh": 0.55, "capacityKwh": 100}
o = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20,
                    "chargeKw": 120, "atHome": False}, ha)["open"]
assert o["atHome"] is False
r = S.update(o, {"t": t0 + 30 * MIN, "charging": False, "plugged": False, "batteryPct": 60}, ha)
assert r["closed"]["location"] == "away"
assert r["closed"]["kwh"] == 40 and r["closed"]["cost"] == 22 and r["closed"]["pricePerKwh"] == 0.55

o = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20,
                    "chargeKw": 7, "atHome": True}, ha)["open"]
r = S.update(o, {"t": t0 + 30 * MIN, "charging": False, "plugged": False, "batteryPct": 60}, ha)
assert r["closed"]["location"] == "home" and r["closed"]["cost"] == 7.4

o = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20,
                    "chargeKw": 7, "atHome": None}, ha)["open"]
r = S.update(o, {"t": t0 + 30 * MIN, "charging": False, "plugged": False, "batteryPct": 60}, ha)
assert r["closed"]["location"] == "home" and r["closed"]["cost"] == 7.4

# away rate unset -> away session uses the home rate
noaway = {"pricePerKwh": 0.185, "capacityKwh": 100}
o = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20,
                    "chargeKw": 50, "atHome": False}, noaway)["open"]
r = S.update(o, {"t": t0 + 30 * MIN, "charging": False, "plugged": False, "batteryPct": 60}, noaway)
assert r["closed"]["location"] == "away" and r["closed"]["cost"] == 7.4

# atHome learned on a later sample
o = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20, "chargeKw": 7}, ha)["open"]
assert o["atHome"] is None
o = S.update(o, {"t": t0 + 5 * MIN, "charging": True, "plugged": True, "batteryPct": 25,
                 "chargeKw": 7, "atHome": False}, ha)["open"]
assert o["atHome"] is False

ms = S.summary([
    {"endedAt": now - 1 * 864e5, "kwh": 40, "cost": 22, "location": "away"},
    {"endedAt": now - 2 * 864e5, "kwh": 30, "cost": 5.55, "location": "home"},
    {"endedAt": now - 3 * 864e5, "kwh": 10, "cost": 1.85},
], 30)
assert ms["count"] == 3
assert ms["home"]["count"] == 2 and ms["home"]["kwh"] == 40
assert ms["away"]["count"] == 1 and ms["away"]["cost"] == 22

print("all sessions tests passed")
