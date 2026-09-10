"""range.py <-> core/range.js parity check. Run: python test/range_test.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import range as R  # noqa: E402


def near(a, b, tol=0.5):
    return abs(a - b) <= tol


# reach()
assert near(R.reach(300), 248.4), R.reach(300)
assert near(R.reach(300, {"roundTrip": True}), 124.2)
assert near(R.reach(300, {"reserveKm": 30, "reservePct": 50}), 270 * 0.92)
assert near(R.reach(200, {"factor": 1, "reservePct": 0}), 200)
assert R.reach(0) is None
assert R.reach("x") is None
assert R.reach(None) is None
assert R.reach(5, {"reserveKm": 50}) == 0

# haversine / bearing
d = R.haversine_km(40.7539, -79.8103, 40.4406, -79.9959)
assert 28 < d < 40, d
b = R.bearing_deg(40.7539, -79.8103, 40.4406, -79.9959)
assert 180 < b < 260, b

# poi_status
car = (40.7539, -79.8103)
pois = [
    {"name": "Shore", "lat": 38.34, "lon": -75.08},
    {"name": "Work", "lat": 40.4406, "lon": -79.9959},
    {"name": "Cabin", "lat": 39.87, "lon": -79.49},
    {"name": "bad", "lat": None, "lon": 1},
]
st = R.poi_status(car[0], car[1], pois, 120)
assert [p["name"] for p in st] == ["Work", "Cabin", "Shore"], st
assert st[0]["reachable"] is True
assert st[2]["reachable"] is False
assert st[0]["marginKm"] > 80
assert st[2]["marginKm"] < 0
assert st[0]["arrivalPct"] is None

st2 = R.poi_status(car[0], car[1], pois, 120,
                   {"batteryPct": 80, "rangeKm": 300, "roadFactor": 1.3})
assert 60 < st2[0]["arrivalPct"] < 80, st2[0]["arrivalPct"]
assert st2[2]["arrivalPct"] == 0
assert st2[0]["arrivalPct"] > st2[1]["arrivalPct"]
assert all(isinstance(p["durationMin"], (int, float)) for p in st2)
assert st2[0]["durationMin"] < st2[1]["durationMin"], "duration grows with distance"
assert 25 < st2[0]["durationMin"] < 55, st2[0]["durationMin"]

# circle_ring
ring = R.circle_ring(40.7539, -79.8103, 100, 32)
assert len(ring) == 33
assert ring[0] == ring[32]
assert near(ring[0][1] - 40.7539, 100 / 111.32, 0.02)

# summary
s = R.summary(car[0], car[1], 300, pois, {"roundTrip": True})
assert near(s["oneWayKm"], 248.4)
assert near(s["roundTripKm"], 124.2)
assert s["reachKm"] == s["roundTripKm"]
assert s["pois"][0]["name"] == "Work"
assert isinstance(s["circle"], list) and len(s["circle"]) > 10

print("all range tests passed")
