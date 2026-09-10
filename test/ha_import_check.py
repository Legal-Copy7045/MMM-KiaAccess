#!/usr/bin/env python3
"""Import the Kia Access integration against a real Home Assistant install and
check the pieces hassfest cares about, without a running HA instance.

Run: pip install homeassistant && python test/ha_import_check.py
"""
import importlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# a stand-in for hyundai_kia_connect_api so config_flow/coordinator import
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

pkg = "custom_components.kia_access"

manifest = json.load(open(os.path.join(ROOT, "custom_components/kia_access/manifest.json"), encoding="utf-8"))
assert manifest["domain"] == "kia_access"
assert manifest["config_flow"] is True
assert manifest["version"], "manifest needs a version"
assert any(r.startswith("hyundai_kia_connect_api") for r in manifest["requirements"])

for mod in ("const", "conditions", "vehicle_state", "range", "coordinator",
            "config_flow", "entity", "sensor", "binary_sensor", "button",
            "device_tracker", "lock", "climate", "number", "switch", "select",
            "diagnostics", "__init__"):
    importlib.import_module(f"{pkg}.{mod}" if mod != "__init__" else pkg)
    print("imported", mod)

cond = importlib.import_module(f"{pkg}.conditions")
vs = importlib.import_module(f"{pkg}.vehicle_state")
r = cond.evaluate(vs.build_state({"vehicle.is_locked": "false"}, {}), {}, {})
assert any(c["reason"] == "unlocked" and c["active"] is True for c in r["conditions"])
assert importlib.import_module(f"{pkg}.const").EVENT_STATE_CHANGED == "kia_access_alert"

const = importlib.import_module(f"{pkg}.const")
assert len(const.ENTITIES) >= 20
assert {c["key"] for c in const.COMMANDS} >= {"lock", "unlock", "start_climate", "send_to_car"}
_calls = {c.get("call", "bare") for c in const.COMMANDS}
assert _calls <= {"bare", "positional", "climate_options", "poi"}, f"unknown call style: {_calls}"
assert {"lock", "climate", "number", "switch", "select"} <= set(const.PLATFORMS)
assert const.SEAT_LEVELS["Heat - high"] == 8 and const.SEAT_LEVELS["Off"] == 0
assert set(const.DEFAULT_CLIMATE_PREFS) >= {"duration", "front_left_seat", "steering_wheel"}
_sc = next(c for c in const.COMMANDS if c["key"] == "start_climate")
assert "front_left_seat" in _sc["options"] and "rear_right_seat" in _sc["options"]

# diagnostics entry point
diag = importlib.import_module(f"{pkg}.diagnostics")
assert hasattr(diag, "async_get_config_entry_diagnostics")

# range engine parity surface
tp = importlib.import_module(f"{pkg}.trips")
_r = tp.update(None, {"t": 0, "odometerKm": 100, "batteryPct": 80}, {})
assert _r["open"] and _r["closed"] is None
assert tp.summary([], 30)["count"] == 0
_sen = importlib.import_module(f"{pkg}.sensor")
assert hasattr(_sen, "KiaAccessLastTripSensor") and hasattr(_sen, "KiaAccessCostPerMileSensor")
assert hasattr(_sen, "KiaAccessParkedSensor")

rng = importlib.import_module(f"{pkg}.range")
assert rng.reach(300, {"reservePct": 10, "factor": 0.92}) is not None
_ps = rng.poi_status(40.7, -79.7, [{"name": "H", "lat": 40.8, "lon": -79.7}], 500,
                     {"batteryPct": 80, "rangeKm": 300})
assert _ps[0]["arrivalPct"] is not None and _ps[0]["arrivalPct"] < 80
assert rng.summary(40.7, -79.7, 300, [{"name": "H", "lat": 40.7, "lon": -79.7}])["pois"][0]["reachable"]

rt = importlib.import_module(f"{pkg}.routing")
assert rt.matrix_request("geoapify", {"lat": 40.7, "lon": -79.7},
                         [{"lat": 40.8, "lon": -79.7}], "K")["method"] == "POST"
assert rt.matrix_request("geoapify", {"lat": 40.7, "lon": -79.7}, [], "K") is None
_rm = rt.parse_matrix("geoapify",
                      {"sources_to_targets": [[{"target_index": 0,
                                                "distance": 1000, "time": 120}]]}, 1)
assert _rm[0]["durationMin"] == 2 and abs(_rm[0]["distanceKm"] - 1) < 1e-6
_rt = rt.parse_route("tomtom", {"routes": [{"summary": {
    "lengthInMeters": 12000, "travelTimeInSeconds": 900,
    "noTrafficTravelTimeInSeconds": 780}, "guidance": {"instructions": [
    {"routeOffsetInMeters": 0, "roadNumbers": ["US 1"]},
    {"routeOffsetInMeters": 12000}]}}]})
assert _rt["delayMin"] == 2 and _rt["typicalMin"] == 13 and _rt["via"] == "US 1"
_wl = _sen._when_local
assert isinstance(_wl("2026-09-11T09:00:00-04:00"), str)
assert isinstance(_wl("2026-09-11"), str)
assert _wl(None) is None and _wl("") is None

cf = importlib.import_module(f"{pkg}.config_flow")
assert hasattr(cf, "KiaAccessConfigFlow")
assert hasattr(cf.KiaAccessConfigFlow, "async_step_otp")

# the options flow must instantiate without touching the read-only
# OptionsFlow.config_entry property (HA >= 2024.11)
_fake_entry = type("E", (), {"options": {}, "data": {}, "entry_id": "x"})()
assert cf.KiaAccessConfigFlow.async_get_options_flow(_fake_entry) is not None
assert cf.KiaAccessOptionsFlow(_fake_entry)._entry is _fake_entry
assert callable(cf._number)

# "Poll the car directly" master switch: default off (server cache), and the
# old seconds-based option is honoured for pre-toggle installs
co = importlib.import_module(f"{pkg}.coordinator")
_pcd = co.KiaAccessCoordinator._poll_car_directly
_mk = lambda opts: type("C", (), {"entry": type("E", (), {"options": opts})()})()
assert _pcd(_mk({})) is False, "default must be server-cache (no car wake-up)"
assert _pcd(_mk({"poll_car_directly": True})) is True
assert _pcd(_mk({"poll_car_directly": False})) is False
assert _pcd(_mk({"force_refresh_timeout": 45})) is True, "legacy: >0 -> poll"
assert _pcd(_mk({"force_refresh_timeout": 0})) is False

# _job() must NEVER let kia_client wake the car when cache-only is set:
# both refresh:False AND forceRefreshTimeout:0 (either alone is sufficient)
class _FakeCoord:
    _poll_car_directly = co.KiaAccessCoordinator._poll_car_directly
    _job = co.KiaAccessCoordinator._job

    def __init__(self, opts):
        self.entry = type(
            "E", (), {"data": {"username": "u", "password": "p"}, "options": opts}
        )()


_cache_job = _FakeCoord({})._job()
assert _cache_job["refresh"] is False, "cache-only: refresh must be False"
assert _cache_job["forceRefreshTimeout"] == 0, "cache-only: no wake-up wait"
_live_job = _FakeCoord({"poll_car_directly": True, "force_refresh_timeout": 30})._job()
assert _live_job["refresh"] is True and _live_job["forceRefreshTimeout"] == 30
# explicit poll off wins even with a stale legacy timeout
_off_job = _FakeCoord({"poll_car_directly": False, "force_refresh_timeout": 60})._job()
assert _off_job["refresh"] is False and _off_job["forceRefreshTimeout"] == 0

_cln = co.KiaAccessCoordinator._clean_address
assert _cln(["Oak Creek Drive", "Oak Creek, Sarver, PA", {"road": "x"}]) == "Oak Creek Drive"
assert _cln({"road": "Main St", "city": "Pittsburgh"}) == "Main St"
assert _cln("123 Main St") == "123 Main St"
assert _cln(None) is None

_in_us = co.KiaAccessCoordinator._in_us
assert _in_us(40.71, -79.75) is True      # Sarver PA
assert _in_us(51.5, -0.12) is False       # London
assert _in_us(None, None) is False
assert hasattr(co.KiaAccessCoordinator, "async_refresh_calendar_pois")
assert hasattr(co.KiaAccessCoordinator, "_refresh_drive_times")
_psd = co.KiaAccessCoordinator._parse_static_destinations
assert _psd("Nana | 5 Foo St\nAirport = 700 Bar Rd\n\n123 Main St, Town") == [
    ("Nana", "5 Foo St"), ("Airport", "700 Bar Rd"), ("123 Main St", "123 Main St, Town")
]
assert _psd("") == [] and _psd(None) == []
assert co.KiaAccessCoordinator._poi_key(40.712345, -79.754321) == "40.7123,-79.7543"

# diagnostics must redact the GPS (incl. the combined "location" string) + keys
diag = importlib.import_module(f"{pkg}.diagnostics")
assert {"location", "location_latitude", "location_longitude", "token",
        "password", "pin", "key"} <= diag._REDACT

init = importlib.import_module(pkg)
assert hasattr(init, "_register_frontend")
assert os.path.exists(
    os.path.join(ROOT, "custom_components/kia_access/frontend/kia-access-card.js")
), "card bundle not vendored"

# strings.json <-> translations/en.json identical, and cover the flow steps
s = json.load(open(os.path.join(ROOT, "custom_components/kia_access/strings.json"), encoding="utf-8"))
e = json.load(open(os.path.join(ROOT, "custom_components/kia_access/translations/en.json"), encoding="utf-8"))
assert s == e, "strings.json and translations/en.json differ"
assert {"user", "otp", "reauth_confirm"} <= set(s["config"]["step"])

print("ha_import_check: ok")
