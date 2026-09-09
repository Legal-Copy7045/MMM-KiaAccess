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

print("all sessions tests passed")
