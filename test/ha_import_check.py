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

# _bool(): some binary_sensor-shaped fields aren't strict 0/1 -- the EV9
# sends ev_battery_is_plugged_in as a connector-type code (seen live: 4
# while actively charging), not a boolean. Real bug: plugged came back None
# for a code of 4, so notPluggedInHome false-fired at home while charging,
# and switch.<v>_charging was marked unavailable. Nonzero numbers must read
# as True; keep parity with core/state.js's bool() (see test/state.test.js).
_vs = importlib.import_module(f"{pkg}.vehicle_state")
assert _vs._bool({"vehicle.x": 4}, "x") is True, "nonzero connector-type code reads as plugged"
assert _vs._bool({"vehicle.x": 0}, "x") is False
assert _vs._bool({"vehicle.x": True}, "x") is True
assert _vs._bool({"vehicle.x": "weird"}, "x") is None, "non-numeric unknown strings stay unknown"

# headlamp_status fallback: allow-list, not a deny-list (see test/state.test.js)
assert _vs.build_state({"vehicle.headlamp_status": "on"}, {})["headlights"] is True
assert _vs.build_state({"vehicle.headlamp_status": "OFF"}, {})["headlights"] is False
for _v in ("unknown", "unavailable", "error", "not_available", "unsupported"):
    assert _vs.build_state({"vehicle.headlamp_status": _v}, {})["headlights"] is None, (
        f"headlamp_status {_v!r} must stay unknown, not read as on"
    )

# services.yaml must validate against HA's ACTUAL schema for the whole file,
# not just parse as YAML -- HA loads it as one document and silently drops
# EVERY service's description/fields (Developer Tools shows blank options
# for the whole integration) if any single service in it fails validation.
# Bit us for real: send_to_car's lat/lon had step: 0.000001, but the number
# selector requires step >= 1e-3 (or the literal "any") -- go check
# homeassistant.helpers.service._load_services_file's except clause.
from homeassistant.helpers.service import _SERVICES_SCHEMA  # noqa: E402
from homeassistant.util.yaml import load_yaml_dict  # noqa: E402

_services_path = os.path.join(ROOT, "custom_components/kia_access/services.yaml")
try:
    _validated = _SERVICES_SCHEMA(load_yaml_dict(_services_path))
except Exception as err:  # noqa: BLE001
    raise AssertionError(
        f"services.yaml fails HA's real schema -- every Kia Access service "
        f"would show blank options in Developer Tools: {err}"
    ) from err
assert "test_alert" in _validated and "send_to_car" in _validated
print("services.yaml: ok -", len(_validated), "services validate")

cond = importlib.import_module(f"{pkg}.conditions")
vs = importlib.import_module(f"{pkg}.vehicle_state")
r = cond.evaluate(vs.build_state({"vehicle.is_locked": "false"}, {}), {}, {})
assert any(c["reason"] == "unlocked" and c["active"] is True for c in r["conditions"])
assert importlib.import_module(f"{pkg}.const").EVENT_KIA_ACCESS_ALERT == "kia_access_alert"

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

# _valid_ll() gates what enters the persistent geocode cache -- must reject
# NaN/Infinity (isinstance(float("nan"), float) is True, so a naive
# isinstance-only check lets them through) and out-of-range coordinates,
# both reachable from a malformed geocoder API response.
_vll = co.KiaAccessCoordinator._valid_ll
assert _vll([37.4, -122.1]) is True, "a normal coordinate pair"
assert _vll([float("nan"), -122.1]) is False, "NaN must be rejected"
assert _vll([float("inf"), -122.1]) is False, "Infinity must be rejected"
assert _vll([37.4, float("-inf")]) is False, "-Infinity must be rejected"
assert _vll([91, 0]) is False, "latitude out of range"
assert _vll([0, 181]) is False, "longitude out of range"
assert _vll([True, 1]) is False, "bool must not pass as a coordinate"
assert _vll(None) is False
assert _vll([37.4]) is False, "too few elements"

# _haversine_km() is the one choke point every distance calc in coordinator.py
# funnels through -- it must reject the same bad inputs _valid_ll() does,
# since live vehicle/zone coordinates reach it via a bare float() with no
# validation of their own.
_hk = co.KiaAccessCoordinator._haversine_km
assert isinstance(_hk(37.4, -122.1, 37.5, -122.2), float), "a normal pair returns a distance"
assert _hk(None, -122.1, 37.5, -122.2) is None
assert _hk(float("nan"), -122.1, 37.5, -122.2) is None, "NaN must be rejected"
assert _hk(float("inf"), -122.1, 37.5, -122.2) is None, "Infinity must be rejected"
assert _hk(91, 0, 37.5, -122.2) is None, "latitude out of range"
assert _hk(37.4, 181, 37.5, -122.2) is None, "longitude out of range"
assert _hk(True, -122.1, 37.5, -122.2) is None, "bool must not pass as a coordinate"

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
        self._force_next_refresh = False


_cache_job = _FakeCoord({})._job()
assert _cache_job["refresh"] is False, "cache-only: refresh must be False"
assert _cache_job["forceRefreshTimeout"] == 0, "cache-only: no wake-up wait"
_live_job = _FakeCoord({"poll_car_directly": True, "force_refresh_timeout": 30})._job()
assert _live_job["refresh"] is True and _live_job["forceRefreshTimeout"] == 30
# explicit poll off wins even with a stale legacy timeout
_off_job = _FakeCoord({"poll_car_directly": False, "force_refresh_timeout": 60})._job()
assert _off_job["refresh"] is False and _off_job["forceRefreshTimeout"] == 0

# manual "Refresh now" (_force_next_refresh) must wake the car even when
# cache-only is on, and it must be a one-shot flag (cleared after one _job())
_fc = _FakeCoord({})
_fc._force_next_refresh = True
_forced_job = _fc._job()
assert _forced_job["refresh"] is True, "forced refresh must wake the car"
assert _forced_job["forceRefreshTimeout"] == co.DEFAULT_FORCE_REFRESH_TIMEOUT, (
    "forced refresh must use a real wait even though the option is 0/absent"
)
assert _fc._force_next_refresh is False, "the force flag must be one-shot"
assert _fc._job()["refresh"] is False, "second call must fall back to cache-only"
assert hasattr(co.KiaAccessCoordinator, "async_force_refresh")

_btn = importlib.import_module(f"{pkg}.button")
assert hasattr(_btn, "KiaAccessRefreshButton")

# CommandUnconfirmed: a request timeout is genuinely ambiguous (the vehicle
# may or may not have received it), so it must be its own exception type,
# still catchable as a plain ClientError by callers that don't care about
# the distinction.
_kc = importlib.import_module(f"{pkg}.kia_client")
assert hasattr(_kc, "CommandUnconfirmed")
assert issubclass(_kc.CommandUnconfirmed, _kc.ClientError)

# unconfirmed_commands property: must return a snapshot copy, not the live
# dict (a caller mutating the returned value must not corrupt coordinator
# state), and only the coordinator's own _unconfirmed_commands feeds it.
_ucp = co.KiaAccessCoordinator.unconfirmed_commands.fget
_fake_uc_coord = type("C", (), {
    "_unconfirmed_commands": {"start_climate": {"since": "x", "message": "timed out"}}
})()
_uc = _ucp(_fake_uc_coord)
assert _uc == {"start_climate": {"since": "x", "message": "timed out"}}
_uc["start_climate"] = "mutated"
assert _fake_uc_coord._unconfirmed_commands["start_climate"] != "mutated", (
    "the property must return a copy, not a reference to the live dict"
)

# KiaAccessActionSensor surfaces unconfirmed_commands in its attributes only
# when non-empty (so the common case doesn't carry an empty-dict attribute)
_sensor_mod = importlib.import_module(f"{pkg}.sensor")


def _fake_action_coord(unconfirmed):
    return type("C", (), {
        "last_action": {"name": "start_climate", "status": "unconfirmed", "at": "t"},
        "unconfirmed_commands": unconfirmed,
        "entry": type("E", (), {"entry_id": "e1"})(),
        "vehicle": {},
    })()


_action_sensor = object.__new__(_sensor_mod.KiaAccessActionSensor)
_action_sensor.coordinator = _fake_action_coord({"start_climate": {"since": "x", "message": "m"}})
attrs = _sensor_mod.KiaAccessActionSensor.extra_state_attributes.fget(_action_sensor)
assert attrs.get("unconfirmed_commands") == {"start_climate": {"since": "x", "message": "m"}}

_action_sensor2 = object.__new__(_sensor_mod.KiaAccessActionSensor)
_action_sensor2.coordinator = _fake_action_coord({})
attrs2 = _sensor_mod.KiaAccessActionSensor.extra_state_attributes.fget(_action_sensor2)
assert "unconfirmed_commands" not in attrs2, "must be omitted, not an empty dict, when nothing is pending"

_cln = co.KiaAccessCoordinator._clean_address
assert _cln(["Maple Street", "Maple St, Springfield, PA", {"road": "x"}]) == "Maple Street"
assert _cln({"road": "Main St", "city": "Pittsburgh"}) == "Main St"
assert _cln("123 Main St") == "123 Main St"
assert _cln(None) is None

# _plausible_destination() replaced the old hardcoded North-America-only
# bounding box (_in_us) -- calendar/static/zone destinations must be judged
# by distance from the user's own home, not a hardcoded region, since this
# project advertises support for 8 regions and the old box silently
# discarded every destination for the 7 non-US/CA ones.
_PlausibleCoord = type("PlausibleCoord", (), {
    "_home_point": co.KiaAccessCoordinator._home_point,
    "_haversine_km": staticmethod(co.KiaAccessCoordinator._haversine_km),
    "_zone_radius_m": staticmethod(co.KiaAccessCoordinator._zone_radius_m),
    "_plausible_destination": co.KiaAccessCoordinator._plausible_destination,
    "_MAX_PLAUSIBLE_DESTINATION_KM": co.KiaAccessCoordinator._MAX_PLAUSIBLE_DESTINATION_KM,
})


def _fake_home_coord(home_lat, home_lon):
    zone = None
    if home_lat is not None:
        zone = type("Z", (), {"attributes": {"latitude": home_lat, "longitude": home_lon, "radius": 100}})()
    return _PlausibleCoord(), type("H", (), {
        "states": type("S", (), {"get": lambda self, eid: zone})()
    })()


_pd_coord, _pd_hass = _fake_home_coord(40.7539, -79.8103)  # home: Saxonburg PA
_pd_coord.hass = _pd_hass
assert _pd_coord._plausible_destination(40.44, -79.99) is True, "Pittsburgh, near home"
assert _pd_coord._plausible_destination(51.5, -0.12) is False, "London, nowhere near home"
assert _pd_coord._plausible_destination(None, None) is False

_pd_coord_eu, _pd_hass_eu = _fake_home_coord(52.52, 13.405)  # home: Berlin, Germany
_pd_coord_eu.hass = _pd_hass_eu
assert _pd_coord_eu._plausible_destination(53.5511, 9.9937) is True, (
    "Hamburg (~255km) is a plausible destination from a Berlin home -- the "
    "old US-only box would have wrongly excluded every non-US/CA destination"
)
assert _pd_coord_eu._plausible_destination(48.8566, 2.3522) is False, (
    "Paris (~880km) is genuinely implausible as a drivable calendar "
    "destination, same as the old box's intent for a far-off zone"
)

_pd_coord_none, _pd_hass_none = _fake_home_coord(None, None)  # no zone.home configured
_pd_coord_none.hass = _pd_hass_none
assert _pd_coord_none._plausible_destination(48.8566, 2.3522) is True, (
    "no home configured -- can't judge distance, so don't block"
)
assert hasattr(co.KiaAccessCoordinator, "async_refresh_calendar_pois")
assert hasattr(co.KiaAccessCoordinator, "_refresh_drive_times")
assert hasattr(co.KiaAccessCoordinator, "_charge_at_home")
assert hasattr(co.KiaAccessCoordinator, "_charge_rate")
_pcr = co.KiaAccessCoordinator._parse_charge_rates
assert _pcr("zone.work = 0.19\nHome = 0.185\n# note\n\nbad line") == [
    ("zone.work", 0.19), ("zone.home", 0.185)
]
assert _pcr("") == [] and _pcr(None) == []
# float("Infinity") parses successfully and is >= 0 -- must still be rejected
assert _pcr("zone.home = Infinity") == [], "an infinite rate must be rejected"
assert _pcr("zone.home = -1") == [], "a negative rate must be rejected"

# _zone_radius_m() is the single shared helper _home_point(), _charge_at_
# home(), and _charge_rate() all now use for parsing a zone's radius
# attribute -- test it directly once here, on top of the _home_point()
# exercise below (which was the original site this hardening shipped in).
_zrm = co.KiaAccessCoordinator._zone_radius_m
_fake_zone = lambda radius: type("Z", (), {"attributes": {"radius": radius}})()
assert _zrm(_fake_zone(50)) == 50.0
assert _zrm(_fake_zone(None)) == 100.0
assert _zrm(_fake_zone("garbage")) == 100.0
assert _zrm(_fake_zone(float("nan"))) == 100.0
assert _zrm(_fake_zone(float("inf"))) == 100.0
assert _zrm(_fake_zone(-10)) == 100.0

# _home_point() must never raise out of a malformed zone.home radius --
# it's called from _emit_alerts() with no surrounding guard, so an
# unhandled ValueError here would fail the entire coordinator update
_hp = co.KiaAccessCoordinator._home_point
_fake_zone_coord = lambda radius: type("C", (), {
    "_zone_radius_m": staticmethod(co.KiaAccessCoordinator._zone_radius_m),
    "hass": type("H", (), {
        "states": type("S", (), {"get": lambda self, eid: type("Z", (), {
            "attributes": {"latitude": 1.0, "longitude": 2.0, "radius": radius}
        })()})()
    })()
})()
assert _hp(_fake_zone_coord(100))[2] == 100.0, "a normal radius"
assert _hp(_fake_zone_coord("not a number"))[2] == 100.0, "malformed radius must not raise"
assert _hp(_fake_zone_coord(float("nan")))[2] == 100.0, "NaN radius must fall back"
assert _hp(_fake_zone_coord(float("inf")))[2] == 100.0, "Infinite radius must fall back"
assert _hp(_fake_zone_coord(-5))[2] == 100.0, "negative radius must fall back"
assert _hp(_fake_zone_coord(None))[2] == 100.0, "missing radius must fall back"

# _external_away_cost() must treat NaN/Infinity as "no valid reading yet"
# (None), not as a real cost -- returning non-None here wrongly skips the
# caller's _ext_pending retry path, permanently missing the real cost once
# the entity recovers.
_eac = co.KiaAccessCoordinator._external_away_cost
_dt_util = importlib.import_module("homeassistant.util.dt")


def _fake_cost_coord(state_value, options=None):
    st = type("St", (), {"state": state_value, "last_changed": _dt_util.utcnow()})()
    opts = {"away_cost_entity": "sensor.cost"}
    opts.update(options or {})
    return type("C", (), {
        "entry": type("E", (), {"options": opts})(),
        "hass": type("H", (), {"states": type("S", (), {
            "get": lambda self, eid: st
        })()})(),
    })()


_session = {"startedAt": _dt_util.utcnow().timestamp() * 1000, "endedAt": _dt_util.utcnow().timestamp() * 1000}
assert _eac(_fake_cost_coord("12.34"), _session) == 12.34, "a real cost must pass through"
assert _eac(_fake_cost_coord("nan"), _session) is None, "NaN must read as no-valid-reading-yet"
assert _eac(_fake_cost_coord("inf"), _session) is None, "Infinity must read as no-valid-reading-yet"
assert _eac(_fake_cost_coord("-5"), _session) is None, "a non-positive cost must be rejected"
assert _eac(_fake_cost_coord("unknown"), _session) is None, "a non-numeric state must be rejected"

# away_cost_grace_min: 0 is a genuinely valid configured value (the number
# selector's own min bound, meaning "no grace, only accept a cost reading
# from within the session window itself") -- `or 90` would silently widen
# it back out. Session ended 30 min ago; the cost sensor's last_changed is
# "now" (see _fake_cost_coord). With 0 grace that's outside the window and
# must be rejected; with the old 90-min default it would wrongly pass.
_old_ended = (_dt_util.utcnow().timestamp() - 30 * 60) * 1000
_grace_session = {"startedAt": _old_ended, "endedAt": _old_ended}
assert _eac(_fake_cost_coord("9.99", {"away_cost_grace_min": 0}), _grace_session) is None, (
    "an explicitly configured 0-minute grace must actually mean zero, not fall back to 90"
)
assert _eac(_fake_cost_coord("9.99", {"away_cost_grace_min": 90}), _grace_session) == 9.99, (
    "a real 90-minute grace must still work (sanity check against the fix above)"
)
_sess = importlib.import_module(f"{pkg}.sessions")
_scl = _sess.update(None, {"t": 0, "charging": True, "batteryPct": 10, "atHome": False},
                    {"pricePerKwh": 0.2, "awayPricePerKwh": 0.6})["open"]
assert _scl["atHome"] is False
_scc = _sess.update(_scl, {"t": 6e5, "charging": False, "plugged": False, "batteryPct": 20},
                    {"pricePerKwh": 0.2, "awayPricePerKwh": 0.6, "capacityKwh": 100})["closed"]
assert _scc["location"] == "away" and _scc["pricePerKwh"] == 0.6
assert _scc.get("costSource") == "rate"
_ovr = _sess.apply_cost(_scc, 12.34, "external")
assert _ovr["cost"] == 12.34 and _ovr["costSource"] == "external"
assert _ovr["estimatedCost"] == _scc["cost"]
assert hasattr(co.KiaAccessCoordinator, "set_charge_cost")
assert hasattr(co.KiaAccessCoordinator, "_external_away_cost")
_psd = co.KiaAccessCoordinator._parse_static_destinations
assert _psd("Museum | 100 Main St\nAirport = 1 Terminal Rd\n\n123 Elm St, Town") == [
    ("Museum", "100 Main St"), ("Airport", "1 Terminal Rd"), ("123 Elm St", "123 Elm St, Town")
]
assert _psd("") == [] and _psd(None) == []

# "block automated climate": user-context calls pass, automation contexts don't
_cb = co.KiaAccessCoordinator._climate_blocked
_ctx = lambda uid: type("Ctx", (), {"user_id": uid})()
_bc = lambda opts: type("C", (), {
    "entry": type("E", (), {"options": opts})(),
    "_CLIMATE_COMMANDS": co.KiaAccessCoordinator._CLIMATE_COMMANDS,
})()
assert _cb(_bc({}), "start_climate", _ctx(None)) is False, "off by default"
assert _cb(_bc({"block_automated_climate": True}), "start_climate", _ctx(None)) is True
assert _cb(_bc({"block_automated_climate": True}), "start_climate", _ctx("abc")) is False
assert _cb(_bc({"block_automated_climate": True}), "lock", _ctx(None)) is False, "non-climate"
assert _cb(_bc({"block_automated_climate": True}), "stop_climate", None) is True
assert co.KiaAccessCoordinator._poi_key(40.712345, -79.754321) == "40.7123,-79.7543"

# diagnostics must redact the GPS (incl. the combined "location" string) + keys
diag = importlib.import_module(f"{pkg}.diagnostics")
assert {"location", "location_latitude", "location_longitude", "token",
        "password", "pin", "key"} <= diag._REDACT

init = importlib.import_module(pkg)
assert hasattr(init, "_register_frontend")
assert hasattr(init, "async_track_time_interval"), (
    "the 1-min calendar-refresh timer needs this imported"
)
assert manifest.get("after_dependencies") == ["lovelace"], (
    "_ensure_lovelace_resource reads hass.data[LOVELACE_DATA]; without this "
    "hint lovelace may not have set up yet when we look for it"
)

# _register_services()'s voluptuous schema is registered ONCE, globally,
# before any vehicle/entry_id (and therefore region) is known -- an option
# with a `metric` variant (currently just start_climate's set_temp) must
# validate the UNION of both ranges, or a real EU/Celsius value would be
# hard-rejected by vol.Range() before ever reaching the region-aware
# default-filling in kia_client.py.
class _FakeServices:
    def __init__(self):
        self.registered = {}

    def has_service(self, domain, key):
        return False

    def async_register(self, domain, key, handler, schema=None):
        self.registered[key] = schema


_fake_services_hass = type("H", (), {"services": _FakeServices()})()
init._register_services(_fake_services_hass)
_climate_schema = _fake_services_hass.services.registered["start_climate"]
_climate_schema({"set_temp": 70})  # USA/Canada value must still pass
_climate_schema({"set_temp": 21})  # a real EU/Celsius value must not be rejected
try:
    _climate_schema({"set_temp": 200})
    raise AssertionError("a wildly out-of-range set_temp should still be rejected")
except init.vol.Invalid:  # same voluptuous module __init__.py itself uses
    pass

# an "int" option (ac_limit/dc_limit/duration/etc.) must reject a genuinely
# fractional value instead of vol.Coerce(int)'s silent truncation
# (80.9 -> 80) -- only matters for a raw/automation call bypassing the UI's
# own number selector, which already prevents this for a human.
_charge_schema = _fake_services_hass.services.registered["set_charge_limits"]
_charge_schema({"ac_limit": 80})  # a real whole-number int must still pass
_charge_schema({"ac_limit": 80.0})  # a whole-number float must still pass
try:
    _charge_schema({"ac_limit": 80.9})
    raise AssertionError("a fractional ac_limit must be rejected, not silently truncated")
except init.vol.Invalid:
    pass

# _ensure_lovelace_resource (auto-registers the card as a real Lovelace
# resource so the frontend awaits it, instead of racing add_extra_js_url on a
# cold app launch) must resolve its private-API imports against the real
# installed HA package, and no-op cleanly -- never raise -- when lovelace
# hasn't set up yet (hass.data is just a plain dict here, no LOVELACE_DATA key)
import asyncio  # noqa: E402

assert hasattr(init, "_ensure_lovelace_resource")
_fake_hass = type("H", (), {"data": {}})()
asyncio.run(init._ensure_lovelace_resource(_fake_hass, "/kia_access/kia-access-card.js"))
assert os.path.exists(
    os.path.join(ROOT, "custom_components/kia_access/frontend/kia-access-card.js")
), "card bundle not vendored"
# local brand images (HA 2026.3+ brand/ folder, served at
# /api/brands/integration/kia_access/icon.png) -- this is now the ONLY path;
# home-assistant/brands stopped accepting new custom-integration icons
for _f in ("icon.png", "icon@2x.png"):
    assert os.path.exists(
        os.path.join(ROOT, "custom_components/kia_access/brand", _f)
    ), f"missing custom_components/kia_access/brand/{_f}"

# strings.json <-> translations/en.json identical, and cover the flow steps
s = json.load(open(os.path.join(ROOT, "custom_components/kia_access/strings.json"), encoding="utf-8"))
e = json.load(open(os.path.join(ROOT, "custom_components/kia_access/translations/en.json"), encoding="utf-8"))
assert s == e, "strings.json and translations/en.json differ"
assert {"user", "otp", "vehicle", "reauth_confirm"} <= set(s["config"]["step"])
assert "vin" not in s["config"]["step"]["user"]["data"], (
    "VIN must not be collected on the initial form -- it's only knowable "
    "after login, from the account's own vehicle list (async_step_vehicle)"
)

# Multi-vehicle unique-id scoping: without a VIN, two "Add Integration"
# attempts for the same account must still collide (a real duplicate) --
# but WITH different VINs, they must be allowed to coexist as separate
# config entries (one per vehicle), or a multi-vehicle account could never
# be fully set up (each vehicle needs its own VIN-scoped entry once
# kia_client.fetch()/run_command() refuse to guess which car to use).
#
# VIN is no longer typed on the initial form -- it comes from the account's
# own vehicle list (self._vm.vehicles, populated by login()/verify_otp_
# and_complete_login() before async_step_user()/async_step_otp() hand off
# to _after_login()). These fakes drive the real flow through _try_login()
# and _list_vehicles() rather than a hand-typed VIN field.
cf_mod = importlib.import_module(f"{pkg}.config_flow")


class _StopEarly(Exception):
    """Raised from the patched async_set_unique_id to short-circuit the
    flow right after capturing the uid it computed, before it would try
    self._finish() (which needs a real HA config-entry machinery)."""


class _FakeVehicle:
    def __init__(self, vin, name="", model=""):
        self.VIN = vin
        self.name = name
        self.model = model


class _FakeHass:
    async def async_add_executor_job(self, fn, *args):
        return fn(*args)


def _captured_uid(vin):
    """Single-vehicle-account case (or no vehicles yet): auto-picked, no
    vehicle-choice step, uid resolved directly off the account + that VIN."""
    flow = object.__new__(cf_mod.KiaAccessConfigFlow)
    flow._reauth_entry = None
    flow._vm = type("VM", (), {
        "vehicles": {"1": _FakeVehicle(vin)} if vin else {}
    })()
    flow.hass = _FakeHass()
    flow._try_login = lambda: {"access_token": "tok"}
    captured = {}

    async def _fake_set_unique_id(uid):
        captured["uid"] = uid
        raise _StopEarly()

    flow.async_set_unique_id = _fake_set_unique_id
    user_input = {
        "username": "user@example.com", "password": "x", "pin": "",
        "region": "USA", "brand": "KIA", "geocode": False,
    }
    try:
        asyncio.run(cf_mod.KiaAccessConfigFlow.async_step_user(flow, user_input))
    except _StopEarly:
        pass
    return captured["uid"]


_uid_no_vin = _captured_uid("")
_uid_vin1 = _captured_uid("vin1")
_uid_vin2 = _captured_uid("vin2")
assert _uid_no_vin == "USA:KIA:user@example.com", "blank VIN keeps the original account-only id"
assert _uid_vin1 == "USA:KIA:user@example.com:VIN1", "VIN must be included (and uppercased) once set"
assert _uid_vin1 != _uid_vin2, (
    "two different VINs on the same account must get DIFFERENT unique ids, "
    "or a second vehicle could never be added as its own config entry"
)
assert _uid_no_vin != _uid_vin1, "a blank-VIN entry and a VIN-scoped entry for the same account must differ"

# Multi-vehicle account: login succeeding must show the vehicle-choice step
# (not auto-pick vehicle 1, which would make it impossible to ever set up
# the second/third car) -- and picking one there must resolve to the SAME
# uid a single-vehicle account setup with that VIN would get.
_multi_flow = object.__new__(cf_mod.KiaAccessConfigFlow)
_multi_flow._reauth_entry = None
_multi_flow._vm = type("VM", (), {
    "vehicles": {
        "1": _FakeVehicle("vin1", name="Work Car", model="EV6"),
        "2": _FakeVehicle("vin2", name="", model="Niro"),
    }
})()
_multi_flow.hass = _FakeHass()
_multi_flow._try_login = lambda: {"access_token": "tok"}
_shown = {}


def _fake_show_form(*, step_id, data_schema=None, **kw):
    _shown["step_id"] = step_id
    _shown["schema"] = data_schema
    return {"type": "form", "step_id": step_id}


_multi_flow.async_show_form = _fake_show_form
_user_input = {
    "username": "user@example.com", "password": "x", "pin": "",
    "region": "USA", "brand": "KIA", "geocode": False,
}
_res = asyncio.run(cf_mod.KiaAccessConfigFlow.async_step_user(_multi_flow, _user_input))
assert _res["step_id"] == "vehicle", (
    "a multi-vehicle account must be asked to choose, not silently default "
    "to whichever vehicle the account API happened to list first"
)
_vin_field_key = next(k for k in _shown["schema"].schema if str(k) == cf_mod.CONF_VIN)
_choice_keys = set(_shown["schema"].schema[_vin_field_key].container)
assert _choice_keys == {"VIN1", "VIN2"}, _choice_keys

_multi_captured = {}


async def _fake_set_unique_id2(uid):
    _multi_captured["uid"] = uid
    raise _StopEarly()


_multi_flow.async_set_unique_id = _fake_set_unique_id2
try:
    asyncio.run(cf_mod.KiaAccessConfigFlow.async_step_vehicle(_multi_flow, {"vin": "vin2"}))
except _StopEarly:
    pass
assert _multi_captured["uid"] == "USA:KIA:user@example.com:VIN2"

# Options flow VIN edit: changing entry.data[VIN] must ALSO keep entry.
# unique_id in sync, and must be REJECTED (not silently allowed) if another
# entry already owns the target VIN -- otherwise two entries could end up
# silently targeting the same physical vehicle (two coordinators polling/
# alerting/logging sessions for one car). HA's own async_update_entry
# duplicate-unique_id guard is (as of the HA version this was checked
# against) only a deprecated warning log, not an actual block, so this
# project's own explicit check is load-bearing, not a redundant safety net.
class _FakeConfigEntries:
    def __init__(self, entries):
        self._entries = entries
        self.updates = []

    def async_entries(self, domain):
        return list(self._entries)

    def async_update_entry(self, entry, data=None, unique_id=None, **kw):
        self.updates.append({"entry": entry, "data": data, "unique_id": unique_id})
        if data is not None:
            object.__setattr__(entry, "data", data)
        if unique_id is not None:
            object.__setattr__(entry, "unique_id", unique_id)
        return True


def _fake_entry(entry_id, unique_id, data):
    return type("Entry", (), {
        "entry_id": entry_id, "unique_id": unique_id, "data": dict(data), "options": {},
    })()


def _run_options_vin_change(new_vin, other_entries):
    entry_a = _fake_entry(
        "a", "USA:KIA:user@example.com:VIN1",
        {"username": "user@example.com", "region": "USA", "brand": "KIA", "vin": "VIN1"},
    )
    flow = object.__new__(cf_mod.KiaAccessOptionsFlow)
    flow._entry = entry_a
    flow.flow_id = "test"
    flow.handler = "kia_access"
    flow.hass = type("H", (), {
        "config_entries": _FakeConfigEntries([entry_a, *other_entries])
    })()
    user_input = {"vin": new_vin, "scan_interval": 30, "poll_car_directly": False,
                  "force_refresh_timeout": 45, "block_automated_climate": False,
                  "price_per_kwh": 0, "away_price_per_kwh": 0, "home_charge_zone": "",
                  "charge_rates": "", "away_cost_grace_min": 90, "capacity_kwh": 0,
                  "range_factor": 1, "range_reserve_pct": 15, "calendar_entities": "",
                  "calendar_lookahead_hours": 24, "drive_time_provider": "estimate",
                  "routing_api_key": "", "drive_time_routes": True,
                  "static_destinations": "", "geocoding_api_key": "", "zone_entities": "",
                  "away_cost_entity": ""}
    result = asyncio.run(cf_mod.KiaAccessOptionsFlow.async_step_init(flow, user_input))
    return result, entry_a, flow.hass.config_entries


# a VIN that's free must succeed and update BOTH data and unique_id together
res, entry_a, ce = _run_options_vin_change("VIN2", [])
assert res["type"] == "create_entry", "a free VIN must be accepted"
assert entry_a.data["vin"] == "VIN2"
assert entry_a.unique_id == "USA:KIA:user@example.com:VIN2", (
    "unique_id must be updated alongside data -- leaving it stale is exactly "
    "the bug this fix closes"
)

# a VIN already owned by ANOTHER entry must be rejected, not silently allowed
entry_b = _fake_entry("b", "USA:KIA:user@example.com:VIN2", {"vin": "VIN2"})
res2, entry_a2, ce2 = _run_options_vin_change("VIN2", [entry_b])
assert res2["type"] == "form" and res2.get("errors", {}).get("vin") == "vin_in_use", (
    "changing to a VIN already used by another entry must be rejected with a "
    "form error, not silently accepted"
)
assert entry_a2.data.get("vin") != "VIN2", "the collision must not have been applied"
assert not ce2.updates, "no update should have been attempted once a collision was detected"

# --- __init__._migrate_unique_id(): a pre-v2.54 entry can have a VIN in
# entry.data but still an account-only (no-VIN) unique_id -- either because
# it was created before v2.52 added VIN scoping, or its VIN was set later
# via the Options flow before v2.53's fix started keeping unique_id in sync.
# Left alone, v2.54's setup flow always resolving a real VIN (even for a
# single-vehicle account) means a second entry for the SAME account would
# get a different, VIN-scoped id and not collide -- two coordinators for
# one physical car. ---
def _run_migrate(entry_data, entry_uid, other_entries):
    entry = _fake_entry("m", entry_uid, entry_data)
    hass = type("H", (), {"config_entries": _FakeConfigEntries([entry, *other_entries])})()
    init._migrate_unique_id(hass, entry)
    return entry, hass.config_entries


# blank VIN -> nothing to migrate, id is already the correct (account-only) form
e, ce = _run_migrate(
    {"username": "user@example.com", "region": "USA", "brand": "KIA", "vin": ""},
    "USA:KIA:user@example.com", [],
)
assert e.unique_id == "USA:KIA:user@example.com"
assert not ce.updates, "a blank-VIN entry's id is already correct -- nothing to touch"

# VIN populated, stale account-only uid, no collision -> repaired to VIN-scoped
e2, ce2 = _run_migrate(
    {"username": "user@example.com", "region": "USA", "brand": "KIA", "vin": "VIN1"},
    "USA:KIA:user@example.com", [],
)
assert e2.unique_id == "USA:KIA:user@example.com:VIN1", (
    "a stale pre-v2.53 entry must be repaired to the VIN-scoped id"
)

# VIN populated, uid already correct (created by v2.54's own setup flow) -> no-op
e3, ce3 = _run_migrate(
    {"username": "user@example.com", "region": "USA", "brand": "KIA", "vin": "VIN1"},
    "USA:KIA:user@example.com:VIN1", [],
)
assert not ce3.updates, "an already-correct entry must not be touched"

# VIN populated, stale uid, but ANOTHER entry already owns the target id --
# must be left alone (surfaced via a log warning), never silently merged
other_entry = _fake_entry("other", "USA:KIA:user@example.com:VIN1", {"vin": "VIN1"})
e4, ce4 = _run_migrate(
    {"username": "user@example.com", "region": "USA", "brand": "KIA", "vin": "VIN1"},
    "USA:KIA:user@example.com", [other_entry],
)
assert e4.unique_id == "USA:KIA:user@example.com", (
    "must not overwrite into a collision with another entry"
)
assert not ce4.updates

# --- async_setup(): HA never calls async_setup_entry for a DISABLED entry,
# so relying on that alone would leave a legacy entry's stale unique_id
# unrepaired for as long as it stays disabled. async_setup() runs once at
# domain setup regardless of any one entry's state and must migrate every
# entry up front. ---
disabled_legacy = _fake_entry(
    "disabled", "USA:KIA:user@example.com",
    {"username": "user@example.com", "region": "USA", "brand": "KIA", "vin": "VIN1"},
)
hass_multi = type("H", (), {"config_entries": _FakeConfigEntries([disabled_legacy])})()
assert asyncio.run(init.async_setup(hass_multi, {})) is True
assert disabled_legacy.unique_id == "USA:KIA:user@example.com:VIN1", (
    "async_setup() must migrate every entry it finds, not rely on that "
    "entry's own async_setup_entry (which a disabled entry never gets) "
    "having already run"
)


# --- config_flow._finish_with_uid(): re-running setup for a single-vehicle
# account that already has a legacy blank-VIN entry must not silently create
# a SECOND entry for the same physical car (v2.54's flow always resolves a
# real VIN for a single-vehicle account, so the plain unique-id check alone
# never sees a collision -- the two ids genuinely differ). Only applies when
# the account currently has exactly one vehicle; a 2+-vehicle account's
# blank-VIN entry is a different, already-ambiguous situation this guard
# deliberately leaves alone (adding a legitimate second vehicle must still
# work). ---
def _run_finish_with_uid(vin, vehicle_count, existing_entries):
    flow = object.__new__(cf_mod.KiaAccessConfigFlow)
    flow._job = {
        "username": "user@example.com", "region": "USA", "brand": "KIA",
        cf_mod.CONF_VIN: vin,
    }
    flow._vehicle_count = vehicle_count
    flow._token = {"tok": 1}
    flow.hass = type("H", (), {"config_entries": _FakeConfigEntries(existing_entries)})()

    async def _noop_set_unique_id(uid):
        flow._captured_uid = uid

    flow.async_set_unique_id = _noop_set_unique_id
    flow._abort_if_unique_id_configured = lambda: None  # simulate "not already configured"
    flow._finish = lambda token: {"type": "create_entry"}

    return asyncio.run(cf_mod.KiaAccessConfigFlow._finish_with_uid(flow))


legacy_blank_entry = _fake_entry("legacy", "USA:KIA:user@example.com", {"vin": ""})

# single-vehicle account, legacy blank-VIN entry already exists -> must abort
r1 = _run_finish_with_uid("VIN1", 1, [legacy_blank_entry])
assert r1.get("type") == "abort" and r1.get("reason") == "already_configured", (
    "re-adding an already-configured single-vehicle account must not create a "
    "second entry for the same car just because the ids happen to differ"
)

# multi-vehicle account with the SAME legacy blank-VIN entry present -> NOT
# blocked (adding a real second/third vehicle must keep working)
r2 = _run_finish_with_uid("VIN2", 2, [legacy_blank_entry])
assert r2.get("type") == "create_entry", (
    "a genuinely different vehicle on a multi-vehicle account must not be blocked"
)

# single-vehicle account, no legacy entry present -> proceeds normally
r3 = _run_finish_with_uid("VIN1", 1, [])
assert r3.get("type") == "create_entry"

# blank VIN (e.g. account API returned 0 vehicles) -> guard never applies
r4 = _run_finish_with_uid("", 0, [legacy_blank_entry])
assert r4.get("type") == "create_entry"

print("ha_import_check: ok")
