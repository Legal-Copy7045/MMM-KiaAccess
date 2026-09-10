"""trips.py <-> core/trips.js parity check. Run: python test/trips_test.py"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import trips as T  # noqa: E402

MIN = 60000


def near(a, b, tol=0.1):
    return abs(a - b) <= tol


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
     "locationLat": 40.71, "locationLon": -79.75},
    {"t": t + 5 * MIN, "odometerKm": 1000, "batteryPct": 90, "carOn": False,
     "locationLat": 40.71, "locationLon": -79.75},
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

print("all trips tests passed")
