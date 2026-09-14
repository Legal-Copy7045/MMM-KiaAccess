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
assert {"user", "otp", "reauth_confirm"} <= set(s["config"]["step"])

# Multi-vehicle unique-id scoping: without a VIN, two "Add Integration"
# attempts for the same account must still collide (a real duplicate) --
# but WITH different VINs, they must be allowed to coexist as separate
# config entries (one per vehicle), or a multi-vehicle account could never
# be fully set up (each vehicle needs its own VIN-scoped entry once
# kia_client.fetch()/run_command() refuse to guess which car to use).
cf_mod = importlib.import_module(f"{pkg}.config_flow")


class _StopEarly(Exception):
    """Raised from the patched async_set_unique_id to short-circuit the
    flow right after capturing the uid it computed, before it would try a
    real Kia login."""


def _captured_uid(vin):
    flow = object.__new__(cf_mod.KiaAccessConfigFlow)
    flow._reauth_entry = None
    captured = {}

    async def _fake_set_unique_id(uid):
        captured["uid"] = uid
        raise _StopEarly()

    flow.async_set_unique_id = _fake_set_unique_id
    user_input = {
        "username": "user@example.com", "password": "x", "pin": "",
        "region": "USA", "brand": "KIA", "vin": vin, "geocode": False,
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

print("ha_import_check: ok")
