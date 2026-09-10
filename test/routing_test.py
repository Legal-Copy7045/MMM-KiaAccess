"""routing.py <-> core/routing.js parity check. Run: python test/routing_test.py"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import routing as R  # noqa: E402

origin = {"lat": 40.71374, "lon": -79.75464}
targets = [{"lat": 40.4406, "lon": -79.9959}, {"lat": 39.87, "lon": -79.49}]

# matrix_request: geoapify
g = R.matrix_request("geoapify", origin, targets, "KEY")
assert g["method"] == "POST"
assert "routematrix?apiKey=KEY" in g["url"]
gb = json.loads(g["body"])
assert gb["sources"][0]["location"] == [-79.75464, 40.71374]
assert len(gb["targets"]) == 2
assert gb["mode"] == "drive"

# matrix_request: tomtom
t = R.matrix_request("tomtom", origin, targets, "KEY2", {"traffic": False})
assert "matrix/2?key=KEY2" in t["url"]
tb = json.loads(t["body"])
assert tb["origins"][0]["point"]["latitude"] == 40.71374
assert tb["options"]["traffic"] == "historical"
assert tb["options"]["travelMode"] == "car"

# guards
assert R.matrix_request("geoapify", origin, targets, "") is None
assert R.matrix_request("geoapify", origin, [], "KEY") is None
assert R.matrix_request("nope", origin, targets, "KEY") is None
assert R.matrix_request("geoapify", {"lat": None, "lon": 1}, targets, "KEY") is None

g2 = R.matrix_request("geoapify", origin, [targets[0], {"lat": None, "lon": 2}], "KEY")
assert len(json.loads(g2["body"])["targets"]) == 1

# parse_matrix: geoapify
g_resp = {
    "sources_to_targets": [[
        {"source_index": 0, "target_index": 0, "distance": 42000, "time": 2400},
        {"source_index": 0, "target_index": 1, "distance": None, "time": None},
    ]]
}
gp = R.parse_matrix("geoapify", g_resp, 2)
assert gp[0]["durationMin"] == 40
assert abs(gp[0]["distanceKm"] - 42) < 0.001
assert gp[1] is None

# parse_matrix: tomtom
t_resp = {
    "data": [
        {"originIndex": 0, "destinationIndex": 0,
         "routeSummary": {"lengthInMeters": 42000, "travelTimeInSeconds": 2400}},
        {"originIndex": 0, "destinationIndex": 1,
         "routeSummary": {"lengthInMeters": 95000, "travelTimeInSeconds": 5400}},
    ]
}
tp = R.parse_matrix("tomtom", t_resp, 2)
assert tp[0]["durationMin"] == 40
assert tp[1]["durationMin"] == 90
assert abs(tp[1]["distanceKm"] - 95) < 0.001

# junk / empty
assert R.parse_matrix("geoapify", None, 2) == [None, None]
assert R.parse_matrix("tomtom", {}, 1) == [None]
assert R.parse_matrix("nope", t_resp, 2) == [None, None]

print("all routing tests passed")
