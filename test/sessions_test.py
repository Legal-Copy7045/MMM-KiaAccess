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
# minutes (200) spans start->last-charging-sample INCLUDING the 20-min
# pause and the two gaps either side of it (60->80 charging->pause,
# 80->100 pause->resume, 40 min total unaccounted); activeMinutes (160)
# only sums the two genuinely-consecutive charging=True spans (0->60,
# 100->200). Same 40 kWh delivered, so activeAvgKw (the charger's real
# rate) reads meaningfully higher than avgKw (the whole-session rate).
assert c["minutes"] == 200
assert c["activeMinutes"] == 160
assert c["avgKw"] == 12  # 40 kWh / (200/60) h
assert c["activeAvgKw"] == 15  # 40 kWh / (160/60) h
assert c["activeAvgKw"] > c["avgKw"], (
    "a session with a mid-charge pause must show a higher active-only rate "
    "than its whole-session rate"
)

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

# unknown location (no home zone, never resolved) -> priced at the home
# rate (the best available guess), but the location itself must stay
# "unknown", not silently claim a confirmed "home" it never had
o = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20,
                    "chargeKw": 7, "atHome": None}, ha)["open"]
r = S.update(o, {"t": t0 + 30 * MIN, "charging": False, "plugged": False, "batteryPct": 60}, ha)
assert r["closed"]["location"] == "unknown" and r["closed"]["cost"] == 7.4

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

# a session with the explicit "unknown" location must land in neither the
# home nor the away bucket -- only in the overall total -- not get silently
# counted as home (the bug this whole change fixes)
mu = S.summary([
    {"endedAt": now - 1 * 864e5, "kwh": 40, "cost": 22, "location": "away"},
    {"endedAt": now - 2 * 864e5, "kwh": 30, "cost": 5.55, "location": "home"},
    {"endedAt": now - 3 * 864e5, "kwh": 10, "cost": 1.85},
    {"endedAt": now - 1 * 864e5, "kwh": 15, "cost": 3, "location": "unknown"},
], 30)
assert mu["count"] == 4, "unknown session still counted in the overall total"
assert mu["home"]["count"] == 2, "unknown must not be folded into home"
assert mu["away"]["count"] == 1, "unknown must not be folded into away either"
assert mu["unknown"]["count"] == 1
assert mu["unknown"]["kwh"] == 15 and mu["unknown"]["cost"] == 3

# --- per-zone rate override (cur.rate / cur.rateLabel) ---
o = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20,
                    "chargeKw": 50, "atHome": False, "rate": 0.31, "rateLabel": "Work"}, ha)["open"]
assert o["rate"] == 0.31
r = S.update(o, {"t": t0 + 30 * MIN, "charging": False, "plugged": False, "batteryPct": 60}, ha)
assert r["closed"]["location"] == "Work"
assert r["closed"]["cost"] == 12.4 and r["closed"]["pricePerKwh"] == 0.31

o = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20,
                    "chargeKw": 7, "rate": 0.12, "rateLabel": "home"}, ha)["open"]
r = S.update(o, {"t": t0 + 30 * MIN, "charging": False, "plugged": False, "batteryPct": 60}, ha)
assert r["closed"]["location"] == "home" and r["closed"]["cost"] == 4.8

o = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20, "chargeKw": 7}, ha)["open"]
o = S.update(o, {"t": t0 + 5 * MIN, "charging": True, "plugged": True, "batteryPct": 25,
                 "chargeKw": 7, "rate": 0.4, "rateLabel": "Depot"}, ha)["open"]
assert o["rate"] == 0.4 and o["rateLabel"] == "Depot"

zs = S.summary([
    {"endedAt": now - 1 * 864e5, "kwh": 40, "cost": 12.4, "location": "Work"},
    {"endedAt": now - 2 * 864e5, "kwh": 30, "cost": 5.55, "location": "home"},
], 30)
assert zs["away"]["count"] == 1 and zs["away"]["cost"] == 12.4
assert zs["home"]["count"] == 1

# --- apply_cost ---
est = {"startedAt": 1, "kwh": 30, "cost": 16.5, "costSource": "rate", "location": "away"}
real = S.apply_cost(est, 24.99, "external")
assert real["cost"] == 24.99 and real["costSource"] == "external"
assert real["estimatedCost"] == 16.5 and est["cost"] == 16.5
real2 = S.apply_cost(real, 20, "manual")
assert real2["estimatedCost"] == 16.5 and real2["cost"] == 20
assert S.apply_cost(est, "x", "external")["cost"] == 16.5
assert S.apply_cost(None, 5, "external") is None

# --- DEFAULT_CAPACITY_KWH (the EV9's own usable pack size) must never be
# used as a generic "capacity unknown" guess for some OTHER model -- that
# silently computes another car's kWh/cost off the wrong battery size. ---
no_cap_opts = {"pricePerKwh": 0.185}  # no capacityKwh, no model
o2 = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20, "chargeKw": 7}, no_cap_opts)["open"]
r2 = S.update(o2, {"t": t0 + 30 * MIN, "charging": False, "plugged": False, "batteryPct": 60}, no_cap_opts)
assert r2["closed"] is None, (
    "with no configured/reported capacity and no EV9 hint, a session with "
    "only a % delta must not be recorded with a guessed kWh"
)

# a non-EV9 model must NOT get the EV9 default either
niro_opts = {"pricePerKwh": 0.185, "model": "Niro EV"}
o3 = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20, "chargeKw": 7}, niro_opts)["open"]
r3 = S.update(o3, {"t": t0 + 30 * MIN, "charging": False, "plugged": False, "batteryPct": 60}, niro_opts)
assert r3["closed"] is None, "a non-EV9 model must not silently borrow the EV9's pack size"

# an EV9 (identified by model) with no configured capacityKwh DOES still
# get the 99.8kWh default -- this is the one case it's actually meant for
ev9_opts = {"pricePerKwh": 0.185, "model": "EV9"}
o4 = S.update(None, {"t": t0, "charging": True, "plugged": True, "batteryPct": 20, "chargeKw": 7}, ev9_opts)["open"]
r4 = S.update(o4, {"t": t0 + 30 * MIN, "charging": False, "plugged": False, "batteryPct": 60}, ev9_opts)
assert r4["closed"], "an EV9 with no configured capacity must still fall back to its own default"
assert r4["closed"]["kwh"] == 39.92, "40% of the EV9's 99.8kWh default"

# _is_ev9()'s (?!\d) guard: a model whose name merely STARTS with "ev9" but
# is actually some other, differently-numbered model (a hypothetical future
# "EV90"/"EV99") must not match -- an adversarial-review finding on the
# unanchored regex this replaced.
assert S._is_ev9("EV90") is False, "a trailing digit means a different model, not an EV9"
assert S._is_ev9("EV99") is False
assert S._is_ev9("EV9") is True
assert S._is_ev9("EV9 GT-Line") is True, "a real EV9 trim name must still match"
assert S._is_ev9("ev9x") is True, "a non-digit suffix is still presumed an EV9 variant"
assert S._is_ev9("EV-9") is True, "a hyphenated model string must also match -- Kia's own API-reported model isn't guaranteed one exact format"

print("all sessions tests passed")
