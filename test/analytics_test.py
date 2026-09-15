"""analytics.py <-> core/analytics.js parity check.

Fixtures here are the SAME numbers used in test/analytics.test.js, so both
language ports are pinned to identical math, not just internally
consistent with themselves.

Run: python test/analytics_test.py
"""
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import analytics as A  # noqa: E402


def near(a, b, tol=0.05):
    return a is not None and b is not None and abs(a - b) <= tol


def utc_ms(y, m, d):
    return int(datetime(y, m, d, tzinfo=timezone.utc).timestamp() * 1000)


# ---- observed_efficiency(): overall, temperature buckets, speed buckets,
# monthly trend, excluding trips that charged mid-drive ----
trips = [
    {"distanceKm": 40, "usedPct": 15, "minutes": 45, "endedAt": utc_ms(2026, 1, 15),
     "chargedDuring": False, "outsideTempC": -10},
    {"distanceKm": 60, "usedPct": 22, "minutes": 68, "endedAt": utc_ms(2026, 1, 20),
     "chargedDuring": False, "outsideTempC": -8},
    {"distanceKm": 100, "usedPct": 30, "minutes": 70, "endedAt": utc_ms(2026, 6, 15),
     "chargedDuring": False, "outsideTempC": 28},
    {"distanceKm": 90, "usedPct": 27, "minutes": 63, "endedAt": utc_ms(2026, 6, 20),
     "chargedDuring": False, "outsideTempC": 30},
    {"distanceKm": 50, "usedPct": 5, "minutes": 60, "endedAt": utc_ms(2026, 6, 22),
     "chargedDuring": True, "outsideTempC": 20},
    {"distanceKm": None, "usedPct": None, "minutes": 10, "endedAt": utc_ms(2026, 6, 23),
     "chargedDuring": False},
]

eff = A.observed_efficiency(trips, {"units": "imperial"})
assert eff is not None
assert eff["tripsSampled"] == 4
assert eff["unit"] == "mi/%"

expected_overall_km_per_pct = (40 / 15 + 60 / 22 + 100 / 30 + 90 / 27) / 4
assert near(eff["overall"], expected_overall_km_per_pct * 0.621371), eff["overall"]

assert len(eff["temperatureBuckets"]) == 2, eff["temperatureBuckets"]
cold = next(b for b in eff["temperatureBuckets"] if b["label"] == "<20°F")
warm = next(b for b in eff["temperatureBuckets"] if b["label"] == ">75°F")
assert cold["tripCount"] == 2
assert warm["tripCount"] == 2
assert warm["efficiency"] > cold["efficiency"], (warm["efficiency"], cold["efficiency"])

assert len(eff["speedBuckets"]) == 2, eff["speedBuckets"]
mixed = next(b for b in eff["speedBuckets"] if b["label"].startswith("mixed"))
highway = next(b for b in eff["speedBuckets"] if b["label"].startswith("highway"))
assert mixed["tripCount"] == 2
assert highway["tripCount"] == 2

assert len(eff["monthlyTrend"]) == 2
assert eff["monthlyTrend"][0]["month"] == "2026-01"
assert eff["monthlyTrend"][1]["month"] == "2026-06"
assert eff["monthlyTrend"][0]["tripCount"] == 2
assert eff["monthlyTrend"][1]["tripCount"] == 2

# ---- observed_efficiency(): no usable trips -> None, not a crash ----
assert A.observed_efficiency([], {}) is None
assert A.observed_efficiency([{"chargedDuring": True}], {}) is None
assert A.observed_efficiency(None, {}) is None

# ---- range_accuracy(): a car that under-delivers on its own estimate ----
trips2 = [
    {"distanceKm": 40, "usedPct": 15, "minutes": 45, "endedAt": 1, "chargedDuring": False,
     "startRangeKm": 300, "startPct": 80},
    {"distanceKm": 60, "usedPct": 22, "minutes": 68, "endedAt": 2, "chargedDuring": False,
     "startRangeKm": 310, "startPct": 85},
    {"distanceKm": 100, "usedPct": 30, "minutes": 70, "endedAt": 3, "chargedDuring": False,
     "startRangeKm": 320, "startPct": 90},
    {"distanceKm": 90, "usedPct": 27, "minutes": 63, "endedAt": 4, "chargedDuring": False,
     "startRangeKm": 315, "startPct": 88},
]
acc = A.range_accuracy(trips2, {"units": "imperial"})
assert acc is not None
assert acc["tripsSampled"] == 4
assert acc["kiaEstimate"] == 193, acc["kiaEstimate"]
assert acc["observedEstimate"] == 161, acc["observedEstimate"]
assert near(acc["accuracyPct"], -16.8, 0.2), acc["accuracyPct"]
assert near(acc["personalRangeFactor"], 0.832, 0.01), acc["personalRangeFactor"]

partial = A.range_accuracy(trips2 + [
    {"distanceKm": 10, "usedPct": 5, "minutes": 10, "endedAt": 5, "chargedDuring": False}
], {"units": "imperial"})
assert partial["tripsSampled"] == 4, "the trip with no startRangeKm must not count"

# ---- range_accuracy(): personalRangeFactor clamped to a sane band ----
wild = A.range_accuracy([
    {"distanceKm": 500, "usedPct": 5, "minutes": 300, "endedAt": 1, "chargedDuring": False,
     "startRangeKm": 50, "startPct": 10},
    {"distanceKm": 500, "usedPct": 5, "minutes": 300, "endedAt": 2, "chargedDuring": False,
     "startRangeKm": 50, "startPct": 10},
], {})
assert wild["personalRangeFactor"] <= 1.5, wild["personalRangeFactor"]

starved = A.range_accuracy([
    {"distanceKm": 1, "usedPct": 50, "minutes": 10, "endedAt": 1, "chargedDuring": False,
     "startRangeKm": 400, "startPct": 90},
    {"distanceKm": 1, "usedPct": 50, "minutes": 10, "endedAt": 2, "chargedDuring": False,
     "startRangeKm": 400, "startPct": 90},
], {})
assert starved["personalRangeFactor"] >= 0.5, starved["personalRangeFactor"]

# ---- charging_performance(): home vs. away, SOC bands HOME-ONLY (mixing a
# home L2 charger with a public DC-fast session would average two entirely
# different power ceilings into one meaningless number) ----
sessions = [
    {"startPct": 20, "endPct": 45, "minutes": 100, "kwh": 25, "avgKw": 15, "location": "home", "cost": 3.5},
    {"startPct": 45, "endPct": 70, "minutes": 90, "kwh": 25, "avgKw": 16.7, "location": "home", "cost": 3.5},
    {"startPct": 55, "endPct": 78, "minutes": 85, "kwh": 23, "avgKw": 16.2, "location": "home", "cost": 3.2},
    {"startPct": 78, "endPct": 95, "minutes": 70, "kwh": 17, "avgKw": 14.6, "location": "home", "cost": 2.4},
    {"startPct": 30, "endPct": 90, "minutes": 45, "kwh": 60, "avgKw": 80, "location": "away", "cost": 22},
]
cp = A.charging_performance(sessions)
assert cp is not None
assert cp["sessionsSampled"] == 5
assert cp["home"]["count"] == 4
assert cp["away"]["count"] == 1
assert near(cp["away"]["avgKw"], 80)
for b in cp["socBands"]:
    assert b["avgKw"] < 20, f"socBands must exclude the away DC-fast session, got {b['avgKw']} for {b['label']}"
band_50_80 = next((b for b in cp["socBands"] if b["label"] == "50–80%"), None)
assert band_50_80 is not None
assert band_50_80["sessionCount"] == 2

# ---- charging_performance(): a session with a scheduled-charging pause
# (avgKw diluted by the whole session span vs. activeAvgKw, the charger's
# real rate -- see sessions.py) must report BOTH, and socBands must
# bucket by the active rate, not the diluted one -- otherwise a real
# 1.4 kW-ish charger reads as ~1 kW just because the car sat plugged in
# (but not drawing) for part of the session ----
sessions_paused = [
    # 22.5 kWh over a 1386-min (23.1h) session -> avgKw ~0.97, but only
    # 964 active minutes -> activeAvgKw ~1.4 (matches an L1/trickle charger)
    {"startPct": 30, "endPct": 52, "minutes": 1386, "kwh": 22.5, "avgKw": 1, "activeMinutes": 964,
     "activeAvgKw": 1.4, "location": "home", "cost": 4.16},
    {"startPct": 30, "endPct": 55, "minutes": 1200, "kwh": 25, "avgKw": 1.25, "activeMinutes": 1000,
     "activeAvgKw": 1.5, "location": "home", "cost": 4.6},
]
cp2 = A.charging_performance(sessions_paused)
assert cp2 is not None
assert near(cp2["home"]["avgKw"], 1.1), f"whole-session average must stay the diluted figure: {cp2['home']['avgKw']}"
assert near(cp2["home"]["activeAvgKw"], 1.4, 0.15), f"activeAvgKw must average the charger's real rate: {cp2['home']['activeAvgKw']}"
band = next((b for b in cp2["socBands"] if b["label"] == "10–50%"), None)
assert band is not None, "both sessions' ~41% midpoint must land in the 10-50% band"
assert near(band["avgKw"], 1.4, 0.15), (
    f"socBands must bucket by activeAvgKw (~1.45), not the diluted avgKw (~1.1): got {band['avgKw']}"
)

# ---- charging_performance(): sessions with no activeAvgKw at all (older
# cache entries from before this field existed) must still work --
# _group_sessions()'s activeAvgKw stays None rather than crashing or
# silently mixing in avgKw, and socBands falls back to avgKw for exactly
# those sessions ----
sessions_old = [
    {"startPct": 20, "endPct": 45, "minutes": 100, "kwh": 25, "avgKw": 15, "location": "home", "cost": 3.5},
    {"startPct": 22, "endPct": 48, "minutes": 95, "kwh": 26, "avgKw": 16, "location": "home", "cost": 3.6},
]
cp3 = A.charging_performance(sessions_old)
assert cp3["home"]["activeAvgKw"] is None, "no session here has activeAvgKw -- must stay None, not fall back to avgKw"
assert near(cp3["socBands"][0]["avgKw"], 15.5), "socBands must fall back to avgKw for pre-upgrade sessions"

# ---- charging_performance(): no usable sessions -> None ----
assert A.charging_performance([]) is None
assert A.charging_performance(None) is None

# ---- driving_patterns(): usage profile from fields every trip already has ----
import time  # noqa: E402
now = time.time() * 1000
DAY = 864e5
trips3 = [
    {"distanceKm": 40, "minutes": 48, "endedAt": now - 2 * DAY},
    {"distanceKm": 20, "minutes": 24, "endedAt": now - 5 * DAY},
    {"distanceKm": 60, "minutes": 72, "endedAt": now - 40 * DAY},
]
dp = A.driving_patterns(trips3, {"units": "imperial", "days": 30})
assert dp is not None
assert dp["tripCount"] == 2, "the 40-day-old trip must be outside the window"
assert near(dp["avgTripDistance"], (40 + 20) / 2 * 0.621371, 0.5)
assert near(dp["avgSpeed"], 50 * 0.621371, 1)
assert dp["windowDays"] == 30

print("all analytics tests passed")
