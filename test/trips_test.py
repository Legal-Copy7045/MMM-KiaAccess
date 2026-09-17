"""trips.py <-> core/trips.js parity check. Run: python test/trips_test.py"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import trips as T  # noqa: E402

MIN = 60000


def near(a, b, tol=0.1):
    return abs(a - b) <= tol


# haversine_km must never raise or propagate NaN/Infinity/out-of-range --
# the one caller (_close()) already passes a None result through _round()
# safely, so it degrades to None (matching the existing None-input case)
assert T.haversine_km(40.7539, -79.8103, 40.4406, -79.9959) is not None
assert T.haversine_km(float("nan"), -79.8, 40.4, -79.9) is None
assert T.haversine_km(float("inf"), -79.8, 40.4, -79.9) is None
assert T.haversine_km(500, -79.8, 40.4, -79.9) is None, "out-of-range latitude"
assert T.haversine_km(40.7, -200, 40.4, -79.9) is None, "out-of-range longitude"
assert T.haversine_km(True, -79.8, 40.4, -79.9) is None, "bool must not pass as a coordinate"


def run(samples, opts=None):
    open_t = None
    closed = []
    for s in samples:
        r = T.update(open_t, s, opts or {})
        open_t = r["open"]
        if r["closed"]:
            closed.append(r["closed"])
    return open_t, closed


t = 1_788_000_000_000

# plain home -> work drive
_, closed = run([
    {"t": t + 0 * MIN, "odometerKm": 1000, "batteryPct": 90, "carOn": False,
     "locationLat": 40.7539, "locationLon": -79.8103},
    {"t": t + 5 * MIN, "odometerKm": 1000, "batteryPct": 90, "carOn": False,
     "locationLat": 40.7539, "locationLon": -79.8103},
    {"t": t + 20 * MIN, "odometerKm": 1015, "batteryPct": 87, "carOn": True,
     "locationLat": 40.62, "locationLon": -79.80},
    {"t": t + 35 * MIN, "odometerKm": 1030, "batteryPct": 84, "carOn": True,
     "locationLat": 40.55, "locationLon": -79.88},
    {"t": t + 45 * MIN, "odometerKm": 1030, "batteryPct": 84, "carOn": False,
     "locationLat": 40.55, "locationLon": -79.88},
    {"t": t + 60 * MIN, "odometerKm": 1030, "batteryPct": 84, "carOn": False,
     "locationLat": 40.55, "locationLon": -79.88},
], {"pricePerKwh": 0.185, "capacityKwh": 100})

assert len(closed) == 1, closed
trip = closed[0]
assert trip["distanceKm"] == 30, trip
assert trip["usedPct"] == 6
assert near(trip["kwh"], 6.0)
assert 3 < trip["miPerKwh"] < 3.2, trip["miPerKwh"]
assert near(trip["cost"], 6.0 * 0.185)
assert trip["chargedDuring"] is False

# startRangeKm / outsideTempC / startPct / endPct -- must reflect the LAST
# parked reading before departure (anchor refresh is gated on a fresh GPS
# fix, same as lat/pct already are), not the first, and mid-drive readings
# must never become the trip's "start". Omitting them entirely (every
# pre-analytics.py caller) must keep working, both simply come back None.
t2 = t + 100 * MIN
_, closed = run([
    {"t": t2 + 0 * MIN, "odometerKm": 2000, "batteryPct": 80, "carOn": False,
     "locationLat": 40.60, "locationLon": -79.80, "rangeKm": 300, "outsideTempC": -5},
    {"t": t2 + 5 * MIN, "odometerKm": 2000, "batteryPct": 80, "carOn": False,
     "locationLat": 40.60, "locationLon": -79.80, "rangeKm": 295, "outsideTempC": -6},
    {"t": t2 + 20 * MIN, "odometerKm": 2020, "batteryPct": 75, "carOn": True,
     "locationLat": 40.55, "locationLon": -79.85, "rangeKm": 270, "outsideTempC": -6},
    {"t": t2 + 35 * MIN, "odometerKm": 2040, "batteryPct": 71, "carOn": True,
     "locationLat": 40.50, "locationLon": -79.90, "rangeKm": 250, "outsideTempC": -4},
    {"t": t2 + 45 * MIN, "odometerKm": 2040, "batteryPct": 71, "carOn": False,
     "locationLat": 40.50, "locationLon": -79.90, "rangeKm": 250, "outsideTempC": -4},
    {"t": t2 + 60 * MIN, "odometerKm": 2040, "batteryPct": 71, "carOn": False,
     "locationLat": 40.50, "locationLon": -79.90, "rangeKm": 250, "outsideTempC": -4},
], {"pricePerKwh": 0.185, "capacityKwh": 100})
assert len(closed) == 1
tr = closed[0]
assert tr["startPct"] == 80
assert tr["endPct"] == 71
assert tr["startRangeKm"] == 295, "must be the LAST parked reading before departure, not the first"
assert tr["outsideTempC"] == -6

_, closed = run([
    {"t": t2 + 200 * MIN, "odometerKm": 3000, "batteryPct": 80, "carOn": False},
    {"t": t2 + 220 * MIN, "odometerKm": 3020, "batteryPct": 75, "carOn": True},
    {"t": t2 + 235 * MIN, "odometerKm": 3040, "batteryPct": 71, "carOn": False},
    {"t": t2 + 250 * MIN, "odometerKm": 3040, "batteryPct": 71, "carOn": False},
])
assert len(closed) == 1
assert closed[0]["startRangeKm"] is None
assert closed[0]["outsideTempC"] is None

# driveway shuffle never a trip
_, closed = run([
    {"t": t, "odometerKm": 2000, "batteryPct": 50, "carOn": False},
    {"t": t + 2 * MIN, "odometerKm": 2000.2, "batteryPct": 50, "carOn": True},
    {"t": t + 20 * MIN, "odometerKm": 2000.2, "batteryPct": 50, "carOn": False},
    {"t": t + 40 * MIN, "odometerKm": 2000.2, "batteryPct": 50, "carOn": False},
])
assert len(closed) == 0

# charged during window -> distance kept, energy nulled
_, closed = run([
    {"t": t, "odometerKm": 3000, "batteryPct": 40, "carOn": False},
    {"t": t + 10 * MIN, "odometerKm": 3020, "batteryPct": 30, "carOn": True},
    {"t": t + 30 * MIN, "odometerKm": 3020, "batteryPct": 80, "charging": True, "carOn": False},
    {"t": t + 45 * MIN, "odometerKm": 3020, "batteryPct": 80, "carOn": False},
    {"t": t + 60 * MIN, "odometerKm": 3020, "batteryPct": 80, "carOn": False},
], {"capacityKwh": 100})
assert len(closed) == 1
assert closed[0]["distanceKm"] == 20
assert closed[0]["kwh"] is None
assert closed[0]["chargedDuring"] is True

# cached-poll mode: no carOn, just odo jumps
_, closed = run([
    {"t": t, "odometerKm": 5000, "batteryPct": 80},
    {"t": t + 30 * MIN, "odometerKm": 5040, "batteryPct": 72},
    {"t": t + 60 * MIN, "odometerKm": 5040, "batteryPct": 72},
    {"t": t + 90 * MIN, "odometerKm": 5040, "batteryPct": 72},
], {"capacityKwh": 100})
assert len(closed) == 1, closed
assert closed[0]["distanceKm"] == 40
assert closed[0]["usedPct"] == 8

# summary
now = time.time() * 1000
s = T.summary([
    {"endedAt": now - 2 * 864e5, "distanceKm": 30, "kwh": 6, "cost": 1.11},
    {"endedAt": now - 5 * 864e5, "distanceKm": 20, "kwh": 4, "cost": 0.74},
    {"endedAt": now - 90 * 864e5, "distanceKm": 999, "kwh": 200, "cost": 40},
], 30)
assert s["count"] == 2
assert s["distanceKm"] == 50
assert s["kwh"] == 10
assert near(s["cost"], 1.85, 0.01)
assert 0 < s["costPerMi"] < 0.1

# --- DEFAULT_CAPACITY_KWH (the EV9's own usable pack size) must never be
# used as a generic "capacity unknown" guess for some OTHER model -- see
# core/sessions.js's identical fix for the reasoning. ---
_drive_samples = [
    {"t": t + 0 * MIN, "odometerKm": 1000, "batteryPct": 90, "carOn": False,
     "locationLat": 40.7539, "locationLon": -79.8103},
    {"t": t + 5 * MIN, "odometerKm": 1000, "batteryPct": 90, "carOn": False,
     "locationLat": 40.7539, "locationLon": -79.8103},
    {"t": t + 20 * MIN, "odometerKm": 1015, "batteryPct": 87, "carOn": True,
     "locationLat": 40.62, "locationLon": -79.80},
    {"t": t + 45 * MIN, "odometerKm": 1030, "batteryPct": 84, "carOn": False,
     "locationLat": 40.55, "locationLon": -79.88},
    {"t": t + 60 * MIN, "odometerKm": 1030, "batteryPct": 84, "carOn": False,
     "locationLat": 40.55, "locationLon": -79.88},
]
_, no_cap_closed = run(_drive_samples, {"pricePerKwh": 0.185})  # no capacityKwh, no model
assert no_cap_closed[0]["kwh"] is None, (
    "with no configured/reported capacity and no EV9 hint, kwh must stay "
    "None, not borrow the EV9's pack size"
)
_, niro_closed = run(_drive_samples, {"pricePerKwh": 0.185, "model": "Niro EV"})
assert niro_closed[0]["kwh"] is None, "a non-EV9 model must not silently borrow the EV9's pack size"
_, ev9_closed = run(_drive_samples, {"pricePerKwh": 0.185, "model": "EV9"})
assert near(ev9_closed[0]["kwh"], 5.988), (
    "an EV9 with no configured capacity must still fall back to its own "
    "99.8kWh default (6% of it)"
)

# _is_ev9()'s (?!\d) guard and [\s-]* tolerance, proven independently at
# the TRIP level too -- trips.py has its OWN copy of this logic (not
# shared with sessions.py), and a v2.72.0 fix to sessions.py's regex was
# initially missed here entirely (caught only by checking the vendored
# custom_components copy still had the old pattern) -- these trip-level
# assertions exist so a future regex change to one copy without the
# other fails a test instead of silently drifting again.
_, ev90_closed = run(_drive_samples, {"pricePerKwh": 0.185, "model": "EV90"})
assert ev90_closed[0]["kwh"] is None, (
    "a hypothetical differently-numbered model ('EV90') must not match "
    "the EV9 regex and borrow its pack size"
)
_, ev_hyphen9_closed = run(_drive_samples, {"pricePerKwh": 0.185, "model": "EV-9"})
assert near(ev_hyphen9_closed[0]["kwh"], 5.988), (
    "a hyphenated 'EV-9' model string must still match and fall back to "
    "the 99.8kWh default"
)

# ---- powertrain: hybrid (PHEV/HEV) trips must NOT have used_pct/kwh/cost
# computed -- see core/trips.js's identical test/comment ----
_hybrid_samples = [
    {"t": t + 0 * MIN, "odometerKm": 2000, "batteryPct": 90, "carOn": False,
     "locationLat": 40.7539, "locationLon": -79.8103},
    {"t": t + 5 * MIN, "odometerKm": 2000, "batteryPct": 90, "carOn": False,
     "locationLat": 40.7539, "locationLon": -79.8103},
    {"t": t + 20 * MIN, "odometerKm": 2050, "batteryPct": 0, "carOn": True,
     "locationLat": 40.62, "locationLon": -79.80},
    {"t": t + 45 * MIN, "odometerKm": 2050, "batteryPct": 0, "carOn": False,
     "locationLat": 40.55, "locationLon": -79.88},
    {"t": t + 60 * MIN, "odometerKm": 2050, "batteryPct": 0, "carOn": False,
     "locationLat": 40.55, "locationLon": -79.88},
]

_, hybrid_closed = run(_hybrid_samples, {"pricePerKwh": 0.185, "capacityKwh": 18, "powertrain": "hybrid"})
assert hybrid_closed[0]["distanceKm"] == 50, "distance is still tracked for a hybrid"
assert hybrid_closed[0]["usedPct"] is None, "hybrid: usedPct must not be attributed to the battery"
assert hybrid_closed[0]["kwh"] is None, "hybrid: kwh must not be computed"
assert hybrid_closed[0]["cost"] is None, "hybrid: cost must not be computed"
assert hybrid_closed[0]["miPerKwh"] is None, "hybrid: efficiency must not be computed"

_, ev_closed = run(_hybrid_samples, {"pricePerKwh": 0.185, "capacityKwh": 18, "powertrain": "ev"})
assert ev_closed[0]["usedPct"] == 90, "same samples, pure EV: usedPct IS attributed"
assert ev_closed[0]["kwh"] > 0, "pure EV: kwh IS computed"

_, no_opt_closed = run(_hybrid_samples, {"pricePerKwh": 0.185, "capacityKwh": 18})
assert no_opt_closed[0]["usedPct"] == 90, "no powertrain option -> unchanged (ev-like) default behaviour"

print("all trips tests passed")
