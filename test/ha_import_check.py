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

# brand_display_name(): the ONE canonical "KIA"/"HYUNDAI"/"GENESIS" ->
# "Kia"/"Hyundai"/"Genesis" resolver -- entity.py's device_info/sensor.py's
# vehicle_name and config_flow.py's config-entry title all call this now,
# instead of each independently title-casing (or not) the raw stored value.
assert const.brand_display_name("HYUNDAI") == "Hyundai"
assert const.brand_display_name("GENESIS") == "Genesis"
assert const.brand_display_name(None) == "Kia", "no brand at all -- default to Kia, not blank/error"
assert const.brand_display_name("") == "Kia"
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


# Cost sensors' native_unit_of_measurement was hardcoded "USD" -- every
# non-US install's cost sensors showed the wrong currency label with no way
# to fix it. Must now reflect the "currency" option, and default to "USD"
# when it's unset (existing installs with no currency configured yet).
class _FakeCostEntry:
    def __init__(self, options):
        self.entry_id = "entry_cost"
        self.options = options


class _FakeCostCoordinator:
    def __init__(self, options, charge_log=None, trip_log=None):
        self.entry = _FakeCostEntry(options)
        self.vehicle = {}
        self.charge_log = charge_log or {"last": None}
        self.trip_log = trip_log or {
            "last": None, "last_30_days": {}, "last_90_days": {}, "lifetime": {},
        }


_default_charge = _sen.KiaAccessLastChargeSensor(
    _FakeCostCoordinator({"price_per_kwh": 0.15})
)
assert _default_charge.native_unit_of_measurement == "USD", (
    "no currency configured -- must default to USD, not raise or go blank"
)
_eur_charge = _sen.KiaAccessLastChargeSensor(
    _FakeCostCoordinator({"price_per_kwh": 0.30, "currency": "eur"})
)
assert _eur_charge.native_unit_of_measurement == "EUR", (
    f"configured currency must be used (upper-cased) -- got {_eur_charge.native_unit_of_measurement!r}"
)
_unpriced_charge = _sen.KiaAccessLastChargeSensor(
    _FakeCostCoordinator({"currency": "EUR"})
)
assert _unpriced_charge.native_unit_of_measurement == "kWh", (
    "no price configured at all -- falls back to kWh regardless of currency"
)
_gbp_cpm = _sen.KiaAccessCostPerMileSensor(
    _FakeCostCoordinator({"price_per_kwh": 0.20, "currency": "GBP"})
)
assert _gbp_cpm.native_unit_of_measurement == "GBP/mi", _gbp_cpm.native_unit_of_measurement
print("cost sensors: native_unit_of_measurement reflects the configured currency")

# trips.py/core/trips.js's kmPerKwh/kwhPer100km/costPerKm fields (added
# alongside the existing mi-based ones -- this integration previously had
# no metric efficiency/cost figures anywhere) must actually surface through
# these two sensors' attributes, not just exist unused in the trip log.
_trip_last_30d = {
    "distanceMi": 62.1, "distanceKm": 100.0, "kwh": 20.0, "cost": 3.0,
    "miPerKwh": 3.1, "kmPerKwh": 5.0, "costPerMi": 0.0483, "costPerKm": 0.03,
}
_trip_coord = _FakeCostCoordinator(
    {"price_per_kwh": 0.15},
    trip_log={
        "last": {
            "distanceMi": 10.0, "kwh": 3.0, "miPerKwh": 3.3, "kwhPer100mi": 30.0,
            "kmPerKwh": 5.3, "kwhPer100km": 18.6, "cost": 0.45, "chargedDuring": False,
        },
        "last_30_days": _trip_last_30d,
        "last_90_days": {**_trip_last_30d, "costPerKm": 0.031},
        "lifetime": {**_trip_last_30d, "costPerKm": 0.029, "kmPerKwh": 5.1},
        "recent": [],
    },
)
_trip_sensor = _sen.KiaAccessLastTripSensor(_trip_coord)
_trip_attrs = _trip_sensor.extra_state_attributes
assert _trip_attrs["km_per_kwh"] == 5.3, _trip_attrs
assert _trip_attrs["kwh_per_100km"] == 18.6, _trip_attrs
assert _trip_attrs["km_per_kwh_30d"] == 5.0, _trip_attrs

_cpm_sensor = _sen.KiaAccessCostPerMileSensor(_trip_coord)
_cpm_attrs = _cpm_sensor.extra_state_attributes
assert _cpm_attrs["cost_per_km_30d"] == 0.03, _cpm_attrs
assert _cpm_attrs["cost_per_km_90d"] == 0.031, _cpm_attrs
assert _cpm_attrs["cost_per_km_lifetime"] == 0.029, _cpm_attrs
assert _cpm_attrs["km_per_kwh_lifetime"] == 5.1, _cpm_attrs
print("trip sensors: km/kWh, kWh/100km, and cost/km attributes are exposed")

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

import asyncio  # noqa: E402  (used below and re-imported, harmlessly, near line 540)

# async_load_prefs() must restore _last_parked (the moved-while-parked /
# tow-theft anchor) from the timers store alongside the two timers it
# already restored -- without this, a HA restart silently re-anchors "where
# the car is parked" to wherever it happens to be on the first post-restart
# poll, so a vehicle towed/moved WHILE HA was down is never detected as
# having moved at all.
from fake_ha import FakeStore as _FakeStore  # noqa: E402


class _FakePrefsCoord:
    _valid_ll = co.KiaAccessCoordinator._valid_ll
    async_load_prefs = co.KiaAccessCoordinator.async_load_prefs

    def __init__(self, timers_data):
        self._prefs_store = _FakeStore({})
        self._geo_store = _FakeStore({"geo": {}})
        self._timers_store = _FakeStore(timers_data)


_lp = {"lat": 40.71, "lon": -79.75, "odo": 12345.0}
_restored = _FakePrefsCoord({
    "home_unplugged_since": 1000.0, "moved_since": None, "last_parked": _lp,
})
asyncio.run(_restored.async_load_prefs())
assert _restored._home_unplugged_since == 1000.0
assert _restored._last_parked == _lp, (
    "_last_parked must survive a restart the same way home_unplugged_since/"
    "moved_since already do -- otherwise a tow/theft while HA is down is "
    "silently adopted as the new parked position instead of detected"
)

# no timers ever saved yet (fresh install) -- must default to None, not raise
_fresh = _FakePrefsCoord({})
asyncio.run(_fresh.async_load_prefs())
assert _fresh._last_parked is None

# KiaAccessEntity.device_info must be a live @property, not a snapshot taken
# once in __init__ -- entities are created right after the coordinator's
# FIRST successful fetch (async_config_entry_first_refresh() is awaited
# before entity platforms are set up), but that first fetch can itself be a
# genuinely near-empty Kia record (see coordinator.py's "Kia returned an
# empty state... open the Kia app once to force a sync" warning) -- a
# one-time-built DeviceInfo would freeze the HA device registry entry at
# that incomplete snapshot forever, even once a later poll brings in the
# real model/name/VIN.
ent_mod = importlib.import_module(f"{pkg}.entity")


class _FakeCoordEntry:
    entry_id = "entry123"

    def __init__(self, brand="KIA"):
        self.data = {"brand": brand}


class _FakeCoordinator:
    def __init__(self, vehicle, brand="KIA"):
        self.entry = _FakeCoordEntry(brand)
        self.vehicle = vehicle
        self.region = "USA"
        self.meta = {}


class _FakeEntity(ent_mod.KiaAccessEntity):
    def __init__(self, coordinator):
        self.coordinator = coordinator
        self._key = "x"
        self._ident = coordinator.entry.entry_id
        self._attr_unique_id = f"{self._ident}_{self._key}"


_fake_coord = _FakeCoordinator({})  # first-fetch-just-happened, still empty
_ent = _FakeEntity(_fake_coord)
assert _ent.device_info["name"] == "Kia", "no vehicle data yet -> brand-derived fallback name"
assert _ent.device_info["manufacturer"] == "Kia"
_fake_coord.vehicle = {"name": "My EV9", "model": "EV9", "VIN": "5XY123"}  # a LATER poll fills it in
assert _ent.device_info["name"] == "My EV9", (
    "device_info must reflect the CURRENT coordinator.vehicle, not whatever "
    "it looked like when the entity was constructed"
)
assert _ent.device_info["model"] == "EV9"
assert _ent.device_info["serial_number"] == "5XY123"

# A Hyundai/Genesis entry (this integration validates all three brands at
# setup) with no vehicle data yet must NOT fall back to the literal "Kia" --
# that mislabeled every non-Kia install's HA device until the cloud sent
# back its own manufacturer/name field.
_hyundai_coord = _FakeCoordinator({}, brand="HYUNDAI")
_hyundai_ent = _FakeEntity(_hyundai_coord)
assert _hyundai_ent.device_info["name"] == "Hyundai", _hyundai_ent.device_info
assert _hyundai_ent.device_info["manufacturer"] == "Hyundai"

# sensor.py's KiaAccessSummarySensor had its OWN separate hardcoded "Kia"
# fallback for vehicle_name -- the device_info fix above only touched
# entity.py, so a Hyundai/Genesis install's summary sensor still said
# "Kia" here until both were unified onto _brand_name().
_summary_sensor = _sen.KiaAccessSummarySensor(_hyundai_coord)
assert _summary_sensor.extra_state_attributes["vehicle_name"] == "Hyundai", (
    f"no vehicle name/model reported yet -> brand-derived fallback, not a hardcoded 'Kia': "
    f"{_summary_sensor.extra_state_attributes}"
)

# lock.py: a FAILED lock/unlock command must not leave is_locked stuck at
# the optimistic value forever -- is_locked checks _optimistic before the
# real data unconditionally, so if _optimistic never clears (no try/finally
# around the command await), a failed "lock" call would show "Locked" in
# HA indefinitely even if the car never actually received it.
lock_mod = importlib.import_module(f"{pkg}.lock")


class _FakeLockCoordinator:
    def __init__(self):
        self.vehicle = {"is_locked": False}
        self.fail_next = False

    async def async_run_command(self, command, *a, **kw):
        if self.fail_next:
            raise RuntimeError("simulated command failure")


class _FakeLock(lock_mod.KiaAccessLock):
    def __init__(self, coordinator):
        self.coordinator = coordinator
        self._optimistic = None

    def async_write_ha_state(self):
        pass


_lock_coord = _FakeLockCoordinator()
_lock = _FakeLock(_lock_coord)

asyncio.run(_lock.async_lock())
assert _lock._optimistic is None, "optimistic flag must clear after a successful command"
assert _lock.is_locked is False, (
    "with _optimistic cleared, is_locked must read the real (still-False) "
    "data, not stay stuck at the optimistic True"
)

_lock_coord.fail_next = True
try:
    asyncio.run(_lock.async_lock())
    raise AssertionError("expected the simulated failure to propagate")
except RuntimeError:
    pass
assert _lock._optimistic is None, (
    "a FAILED lock command must not leave is_locked stuck showing the "
    "optimistic value forever -- _optimistic must clear even on failure"
)

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

# async_run_command() must serialize concurrent calls -- a hostile-review
# finding: without a lock, two nearly-simultaneous commands (e.g. an
# automation firing stop_charge right as a user taps "Start charge" from a
# different session) each independently dispatched to Kia concurrently,
# with no ordering guarantee, and whichever one's handler happened to
# finish LAST silently clobbered self.last_action regardless of which
# command actually completed last.
_cmd_order = []


async def _fake_executor_job(fn, *args):
    # simulate a real in-flight network call -- the FIRST command dispatched
    # (start_charge) deliberately takes LONGER than the second (stop_charge)
    # so that, without the lock, the second call's executor job would finish
    # first and reorder _cmd_order/last_action -- proving this test actually
    # exercises the race, not just happening to preserve call order because
    # both delays were equal.
    job = args[0] if args else {}
    delay = 0.05 if job.get("command") == "start_charge" else 0.01
    await asyncio.sleep(delay)
    return fn(*args)


def _fake_run_command(job):
    _cmd_order.append(job["command"])
    return {"ok": True}


class _CmdSelf:
    pass


_cmd_self = _CmdSelf()
_cmd_self._command_lock = asyncio.Lock()
_cmd_self._unconfirmed_commands = {}
_cmd_self.last_action = {}
_cmd_self._climate_blocked = lambda command, context: False
_cmd_self._job = lambda **kw: {"command": kw["command"]}
_cmd_self.hass = type("H", (), {"async_add_executor_job": staticmethod(_fake_executor_job)})()
_cmd_self.async_update_listeners = lambda: None


async def _fake_request_refresh():
    pass


_cmd_self.async_request_refresh = _fake_request_refresh

_orig_run_command = co.kia_client.run_command
co.kia_client.run_command = _fake_run_command
try:
    async def _run_both():
        await asyncio.gather(
            co.KiaAccessCoordinator.async_run_command(_cmd_self, "start_charge"),
            co.KiaAccessCoordinator.async_run_command(_cmd_self, "stop_charge"),
        )

    asyncio.run(_run_both())
finally:
    co.kia_client.run_command = _orig_run_command

assert _cmd_order == ["start_charge", "stop_charge"], (
    f"two concurrently-started commands must be serialized (run one at a time, in call order), "
    f"not dispatched to Kia at the same time: {_cmd_order}"
)
assert _cmd_self.last_action["name"] == "stop_charge", (
    "last_action must reflect whichever command actually ran LAST, not whichever executor job "
    f"happened to win a race: {_cmd_self.last_action}"
)

# diagnostics must redact the GPS (incl. the combined "location" string) + keys
diag = importlib.import_module(f"{pkg}.diagnostics")
assert {"location", "location_latitude", "location_longitude", "token",
        "password", "pin", "key"} <= diag._REDACT

# entry.options (routing_api_key/geocoding_api_key -- live, usable API
# keys; static_destinations -- typically home/frequent addresses) must
# actually be redacted in the diagnostics OUTPUT, not just listed in
# _REDACT -- a hostile-review finding: entry.options used to be included
# in the diagnostics payload completely raw (`dict(entry.options)`, never
# passed through async_redact_data at all), so downloading diagnostics to
# attach to a bug report -- exactly what HA's own UI invites -- leaked
# both keys in plain text.
_diag_entry = type("Entry", (), {
    "entry_id": "diag",
    "data": {"username": "d@e.com"},
    "options": {
        "routing_api_key": "tomtom-secret-abc123",
        "geocoding_api_key": "geoapify-secret-xyz789",
        "static_destinations": "Home | 123 Main St",
        "scan_interval": 30,
    },
})()
_diag_hass = type("H", (), {
    "data": {const.DOMAIN: {}},
})()
_diag_result = asyncio.run(diag.async_get_config_entry_diagnostics(_diag_hass, _diag_entry))
_diag_options = _diag_result["entry"]["options"]
assert _diag_options["routing_api_key"] != "tomtom-secret-abc123", (
    f"routing_api_key must be redacted in diagnostics output, got: {_diag_options}"
)
assert _diag_options["geocoding_api_key"] != "geoapify-secret-xyz789", (
    f"geocoding_api_key must be redacted in diagnostics output, got: {_diag_options}"
)
assert _diag_options["static_destinations"] != "Home | 123 Main St", (
    f"static_destinations must be redacted in diagnostics output, got: {_diag_options}"
)
assert _diag_options["scan_interval"] == 30, "a non-sensitive option must pass through unredacted"

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

# The integration validates Kia, Hyundai, AND Genesis accounts at setup
# (config_flow.py's BRANDS) -- user-facing copy that names only "Kia" as
# the account/brand identity (not just "Kia Access", the integration's own
# product name) is factually wrong for two of the three brands it supports.
for _step, _field in (("user", "description"), ("otp", "description")):
    _text = s["config"]["step"][_step][_field]
    assert "Kia just" not in _text and "Kia account" not in _text, (
        f"config step '{_step}'.{_field} names Kia specifically as the "
        f"account/brand, but this integration also supports Hyundai and "
        f"Genesis accounts: {_text!r}"
    )
for _key, _text in s["config"]["abort"].items():
    assert "Kia account" not in _text, (
        f"config abort '{_key}' names Kia specifically as the account brand: {_text!r}"
    )

# Same check, but over the WHOLE strings.json tree (not just the config
# step) -- the options step had its own instances of this: "Kia's server-
# side cache", "Kia's servers", "the Kia app". "Kia Access"/"Kia Connect"
# (the integration's own product name / one of the three brand SERVICES it
# explicitly lists at sign-in) are allowed through; a possessive "Kia's" or
# "the Kia app" claiming brand-specific ownership of the cloud/app is not.
def _walk_strings(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _walk_strings(v, f"{path}.{k}" if path else k)
    elif isinstance(node, str):
        yield path, node


for _path, _text in _walk_strings(s):
    assert "Kia's" not in _text and "the Kia app" not in _text, (
        f"{_path} claims Kia-specific ownership of a service/app this integration "
        f"also uses for Hyundai and Genesis accounts: {_text!r}"
    )

# Every options-form field needs BOTH a label (data) and a data_description --
# a field with a label but no description previously slipped through (e.g.
# stale_after_minutes had neither at all; several numeric fields had a label
# but no description explaining their units/effect), and nothing caught it
# until a manual review.
_init_data = s["options"]["step"]["init"]["data"]
_init_desc = s["options"]["step"]["init"]["data_description"]
_missing_desc = sorted(set(_init_data) - set(_init_desc))
assert not _missing_desc, (
    f"options step 'init' has data_description entries for every label -- missing: {_missing_desc}"
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
        "config_entries": _FakeConfigEntries([entry_a, *other_entries]),
        "async_add_executor_job": _FakeHass.async_add_executor_job,
    })()
    # nested under the same section keys the real frontend submits post-
    # sectioning (see async_step_init's own comment) -- exercises the
    # flatten-sections-back-onto-user_input step, not just the VIN logic
    user_input = {
        "vin": new_vin, "scan_interval": 30,
        "battery_and_cost": {
            "price_per_kwh": 0, "away_price_per_kwh": 0, "currency": "USD",
            "capacity_kwh": 0, "home_charge_zone": "", "charge_rates": "",
            "away_cost_entity": "", "away_cost_grace_min": 90,
        },
        "polling_advanced": {
            "stale_after_minutes": 30, "poll_car_directly": False,
            "force_refresh_timeout": 45, "block_automated_climate": False,
        },
        "destinations": {
            "range_factor": 1, "range_reserve_pct": 15, "calendar_entities": "",
            "calendar_lookahead_hours": 24, "static_destinations": "",
            "zone_entities": "", "drive_time_provider": "estimate",
            "routing_api_key": "", "geocoding_api_key": "", "drive_time_routes": True,
        },
        "alerts": {"alert_title": "", "quiet_while_driving": True},
    }
    # this test is about the uid-sync/collision behaviour, not vehicle
    # discovery -- stub the (real, network-calling) discovery helper so it
    # can't reach out to Kia's servers with these fake credentials; a None
    # return exercises the plain-free-text-field fallback path, matching
    # what this test asserted against before the VIN picker existed
    orig_discover = cf_mod._discover_vehicles_for_entry

    async def _no_discovery(hass, entry):
        return None

    cf_mod._discover_vehicles_for_entry = _no_discovery
    try:
        result = asyncio.run(cf_mod.KiaAccessOptionsFlow.async_step_init(flow, user_input))
    finally:
        cf_mod._discover_vehicles_for_entry = orig_discover
    return result, entry_a, flow.hass.config_entries


# a VIN that's free must succeed and update BOTH data and unique_id together
res, entry_a, ce = _run_options_vin_change("VIN2", [])
assert res["type"] == "create_entry", "a free VIN must be accepted"
assert entry_a.data["vin"] == "VIN2"
# sectioned submission must be saved FLAT -- every other module reads these
# options flat (opts.get("price_per_kwh"), etc.); a section dict surviving
# into entry.options unflattened would silently break every one of them
assert res["data"]["price_per_kwh"] == 0 and "battery_and_cost" not in res["data"], (
    f"options must be flattened before saving, not left nested under section keys: {res['data']}"
)
assert res["data"]["stale_after_minutes"] == 30 and "polling_advanced" not in res["data"]
assert res["data"]["drive_time_provider"] == "estimate" and "destinations" not in res["data"]
assert res["data"]["notifications"] == {"quietWhileDriving": True}, (
    "alert_title/quiet_while_driving must still fold into the nested "
    f"notifications dict conditions.py reads, after being unpacked from "
    f"the 'alerts' section: {res['data'].get('notifications')!r}"
)
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

# A submission missing an ENTIRE section's nested dict (whatever the cause --
# this test doesn't need to know why) must NOT silently wipe that section's
# previously saved fields down to schema defaults. Every field belonging to
# a section that genuinely WAS submitted must still update normally.
_prev_options = {
    "scan_interval": 15,
    "price_per_kwh": 0.22, "currency": "GBP", "capacity_kwh": 77.4,
    "notifications": {"title": "My EV6", "quietWhileDriving": False},
}
_entry_partial = _fake_entry(
    "p", "USA:KIA:user@example.com:VIN1",
    {"username": "user@example.com", "region": "USA", "brand": "KIA", "vin": "VIN1"},
)
_entry_partial.options = dict(_prev_options)
_flow_partial = object.__new__(cf_mod.KiaAccessOptionsFlow)
_flow_partial._entry = _entry_partial
_flow_partial.flow_id = "test"
_flow_partial.handler = "kia_access"
_flow_partial.hass = type("H", (), {
    "config_entries": _FakeConfigEntries([_entry_partial]),
    "async_add_executor_job": _FakeHass.async_add_executor_job,
})()
# only "polling_advanced" is submitted -- "battery_and_cost" and "alerts"
# are entirely absent, as would happen if a section never made it into
# this particular payload
_partial_input = {
    "vin": "VIN1", "scan_interval": 45,
    "polling_advanced": {
        "stale_after_minutes": 20, "poll_car_directly": True,
        "force_refresh_timeout": 60, "block_automated_climate": True,
    },
}
_orig_discover2 = cf_mod._discover_vehicles_for_entry


async def _no_discovery2(hass, entry):
    return None


cf_mod._discover_vehicles_for_entry = _no_discovery2
try:
    _partial_res = asyncio.run(
        cf_mod.KiaAccessOptionsFlow.async_step_init(_flow_partial, _partial_input)
    )
finally:
    cf_mod._discover_vehicles_for_entry = _orig_discover2

assert _partial_res["type"] == "create_entry"
_saved = _partial_res["data"]
assert _saved["price_per_kwh"] == 0.22, (
    f"a section missing from the submission must keep its previously saved "
    f"fields, not revert to schema defaults: {_saved}"
)
assert _saved["currency"] == "GBP" and _saved["capacity_kwh"] == 77.4
assert _saved["notifications"] == {"title": "My EV6", "quietWhileDriving": False}, (
    f"a missing 'alerts' section must not reset the saved title/quiet-hours: {_saved['notifications']!r}"
)
assert _saved["scan_interval"] == 45, "a field that WAS submitted must still update normally"
assert _saved["stale_after_minutes"] == 20 and _saved["poll_car_directly"] is True, (
    "a section that WAS submitted must still save its new values normally"
)

# Options flow VIN field: prefer the account's own auto-discovered vehicle
# list over a free-typed VIN (the exact thing a user can mistype), same as
# the initial setup flow already does -- see _discover_vehicles_for_entry.
def _show_options_form(entry_data, discovered):
    entry = _fake_entry("a", "USA:KIA:user@example.com:VIN1", entry_data)
    flow = object.__new__(cf_mod.KiaAccessOptionsFlow)
    flow._entry = entry
    flow.flow_id = "test"
    flow.handler = "kia_access"
    flow.hass = type("H", (), {
        "async_add_executor_job": _FakeHass.async_add_executor_job,
    })()
    orig = cf_mod._discover_vehicles_for_entry

    async def _fake_discover(hass, entry):
        return discovered

    cf_mod._discover_vehicles_for_entry = _fake_discover
    try:
        return asyncio.run(cf_mod.KiaAccessOptionsFlow.async_step_init(flow, None))
    finally:
        cf_mod._discover_vehicles_for_entry = orig


def _vin_schema_entry(form):
    schema = form["data_schema"].schema
    key = next(k for k in schema if str(k) == cf_mod.CONF_VIN)
    return key, schema[key]


# single-vehicle account: offered as a dropdown with an explicit "auto"
# choice, not a free-typed field -- a blank VIN already auto-resolves via
# AccountPoller.select_own_vehicle()
_form_single = _show_options_form(
    {"vin": "", "region": "USA", "brand": "KIA"},
    [{"vin": "VIN1", "name": "My EV9", "model": "EV9"}],
)
_key1, _sel1 = _vin_schema_entry(_form_single)
assert set(_sel1.container) == {"", "VIN1"}, _sel1.container
assert _key1.default() == "", "single-vehicle default should be the blank/auto choice"

# multi-vehicle account: only the account's real VINs are selectable, no
# blank/auto choice (ambiguous which car "auto" would mean) and no free text
_form_multi = _show_options_form(
    {"vin": "VIN1", "region": "USA", "brand": "KIA"},
    [{"vin": "VIN1", "name": "Work Car", "model": "EV6"},
     {"vin": "VIN2", "name": "", "model": "Niro"}],
)
_key2, _sel2 = _vin_schema_entry(_form_multi)
assert set(_sel2.container) == {"VIN1", "VIN2"}, _sel2.container

# The options form's REAL schema (top-level fields + everything nested
# inside each section()) must line up exactly with what strings.json
# actually documents -- a field added to one and not the other (or moved
# into the wrong section) would silently ship with no label/description,
# or a translation entry for a field the form doesn't have anymore.
_outer_schema = _form_single["data_schema"].schema
_real_top_level = set()
_real_sectioned: dict[str, set] = {}
for _k, _v in _outer_schema.items():
    _name = str(_k)
    if isinstance(_v, cf_mod.section):
        _real_sectioned[_name] = {str(_ik) for _ik in _v.schema.schema}
    else:
        _real_top_level.add(_name)

_str_sections = s["options"]["step"]["init"]["sections"]
assert set(_str_sections) == set(_real_sectioned), (
    f"strings.json sections {set(_str_sections)} don't match the real "
    f"schema's section() keys {set(_real_sectioned)}"
)
for _sec_name, _real_fields in _real_sectioned.items():
    _str_fields = set(_str_sections[_sec_name]["data"])
    assert _str_fields == _real_fields, (
        f"strings.json section '{_sec_name}' declares {_str_fields} but the "
        f"real schema has {_real_fields}"
    )

# every field (top-level or sectioned) must still have both an entry in
# the flat data/data_description maps -- those stay flat regardless of
# which section a field lives in (HA's own convention, see solaredge's
# strings.json for the same pattern)
_all_real_fields = _real_top_level | {f for fs in _real_sectioned.values() for f in fs}
assert _all_real_fields == set(_init_data), (
    f"options form fields {_all_real_fields} don't match strings.json's "
    f"flat 'data' map {set(_init_data)}"
)

# a stored VIN the account isn't currently reporting (stale, or a past typo)
# must stay selectable rather than silently vanishing from the form
_form_stale = _show_options_form(
    {"vin": "VINSTALE", "region": "USA", "brand": "KIA"},
    [{"vin": "VIN1", "name": "", "model": "EV6"},
     {"vin": "VIN2", "name": "", "model": "Niro"}],
)
_key3, _sel3 = _vin_schema_entry(_form_stale)
assert "VINSTALE" in set(_sel3.container), (
    "a stored VIN missing from the current discovery must stay selectable, "
    "not be silently dropped from the form"
)

# discovery failing entirely (offline, cooldown, etc.) must fall back to the
# old plain-text field rather than blocking Configure
_form_offline = _show_options_form(
    {"vin": "VIN1", "region": "USA", "brand": "KIA"}, None
)
_key4, _sel4 = _vin_schema_entry(_form_offline)
assert _sel4 is str, "discovery failure must fall back to a free-text VIN field"

# --- _discover_vehicles_for_entry() itself (not mocked this time): when the
# account already has a running AccountPoller, discovery MUST reuse it
# (sharing its lock/dedup-window/failure-cache) instead of making its own
# unshared kia_client.fetch() call -- a real security/reliability issue an
# adversarial review caught: an unshared discovery fetch with broken
# credentials would still hit kia_client.connect()'s account-wide
# auth-failure cooldown file, so simply opening Configure could accelerate
# or trigger a lockout that then blocks every coordinator's regular poll. ---
_account_poll_mod = importlib.import_module(f"{pkg}.account_poll")


class _FakePoller:
    def __init__(self, result=None, err=None):
        self.result = result
        self.err = err
        self.calls = 0

    async def async_fetch(self, job):
        self.calls += 1
        if self.err:
            raise self.err
        return self.result


_disc_entry = _fake_entry(
    "disc", "USA:KIA:user@example.com:VIN1",
    {"username": "user@example.com", "password": "x", "region": "USA", "brand": "KIA"},
)
_fake_poller = _FakePoller(result={"vehicles": [{"VIN": "VIN1", "name": "", "model": ""}]})


def _unshared_fetch_must_not_run(job):
    raise AssertionError(
        "kia_client.fetch() must NOT be called directly while this account "
        "has a running AccountPoller -- discovery must go through it"
    )


_orig_kia_fetch = cf_mod.kia_client.fetch
cf_mod.kia_client.fetch = _unshared_fetch_must_not_run
_disc_hass = type("H", (), {
    "data": {_account_poll_mod.ACCOUNTS_KEY: {
        _account_poll_mod.account_hash_for(_disc_entry): _fake_poller
    }},
})()
try:
    _disc_result = asyncio.run(cf_mod._discover_vehicles_for_entry(_disc_hass, _disc_entry))
finally:
    cf_mod.kia_client.fetch = _orig_kia_fetch
assert _fake_poller.calls == 1, "discovery must call the existing poller's async_fetch()"
assert _disc_result == [{"vin": "VIN1", "name": "", "model": ""}]

# no poller running yet (entry not currently loaded) -- falls back to an
# unshared fetch via the executor, since there's nothing to share with
_disc_hass_no_poller = type("H", (), {
    "data": {},
    "async_add_executor_job": _FakeHass.async_add_executor_job,
})()
_fetch_calls = {"n": 0}


def _fake_unshared_fetch(job):
    _fetch_calls["n"] += 1
    return {"vehicles": [{"VIN": "VIN2", "name": "", "model": ""}]}


cf_mod.kia_client.fetch = _fake_unshared_fetch
try:
    _disc_result2 = asyncio.run(cf_mod._discover_vehicles_for_entry(_disc_hass_no_poller, _disc_entry))
finally:
    cf_mod.kia_client.fetch = _orig_kia_fetch
assert _fetch_calls["n"] == 1, "with no running poller, discovery must fall back to a direct fetch"
assert _disc_result2 == [{"vin": "VIN2", "name": "", "model": ""}]

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

# --- __init__._get_account_poller(): one AccountPoller per (region, brand,
# username) account, shared across every config entry for that account --
# see account_poll.py's module docstring for why (an N-vehicle account was
# otherwise doing ~N times the account-level Kia API traffic of a
# single-vehicle one). ---
_hass_accounts = type("H", (), {"data": {}})()
_entry_car1 = _fake_entry(
    "car1", "USA:KIA:user@example.com:VIN1",
    {"username": "user@example.com", "region": "USA", "brand": "KIA", "vin": "VIN1"},
)
_entry_car2 = _fake_entry(
    "car2", "USA:KIA:user@example.com:VIN2",
    {"username": "user@example.com", "region": "USA", "brand": "KIA", "vin": "VIN2"},
)
_entry_other_acct = _fake_entry(
    "other_acct", "USA:KIA:someone_else@example.com",
    {"username": "someone_else@example.com", "region": "USA", "brand": "KIA"},
)

_poller_car1 = init._get_account_poller(_hass_accounts, _entry_car1)
_poller_car2 = init._get_account_poller(_hass_accounts, _entry_car2)
assert _poller_car1 is _poller_car2, (
    "two vehicles on the SAME account must share one AccountPoller, "
    "regardless of each entry's own (different) VIN"
)
assert init._get_account_poller(_hass_accounts, _entry_other_acct) is not _poller_car1, (
    "a different account must get its OWN AccountPoller, never share one"
)
assert len(_hass_accounts.data[init._ACCOUNTS_KEY]) == 2, (
    "exactly one poller per distinct account, not per entry"
)

# --- async_setup_entry(): a failure ANYWHERE in setup (not just the
# first-refresh call) must give back the refcount it took -- an adversarial-
# review finding: an earlier version's try/except only wrapped
# async_load_sessions/async_load_prefs/async_config_entry_first_refresh,
# so a failure in async_forward_entry_setups (a platform module raising)
# still bumped refcount with no matching decrement. HA retries
# async_setup_entry from scratch on every such failure without ever calling
# async_unload_entry (the entry never reached "loaded"), so this leaked one
# extra refcount per retry -- a slow, permanent overcount that means the
# AccountPoller (and its cached last-fetch payload) outlives every real
# referent and is never cleaned up. ---
class _FakeCoordinatorForSetup:
    def __init__(self, hass, entry):
        self.hass = hass
        self.entry = entry
        self.last_options = None
        self.account_poller = None

    async def async_load_sessions(self):
        pass

    async def async_load_prefs(self):
        pass

    async def async_config_entry_first_refresh(self):
        pass


class _FailingConfigEntries:
    async def async_forward_entry_setups(self, entry, platforms):
        raise RuntimeError("simulated platform setup failure")


async def _fake_register_frontend(hass):
    pass


_setup_hass = type("H", (), {"data": {}, "config_entries": _FailingConfigEntries()})()
_setup_entry = _fake_entry(
    "leak", "USA:KIA:leak@example.com",
    {"username": "leak@example.com", "region": "USA", "brand": "KIA", "vin": ""},
)
_poller_before_leak = init._get_account_poller(_setup_hass, _setup_entry)
assert _poller_before_leak.refcount == 0

_orig_coordinator_cls = init.KiaAccessCoordinator
_orig_register_frontend = init._register_frontend
init.KiaAccessCoordinator = _FakeCoordinatorForSetup
init._register_frontend = _fake_register_frontend
try:
    try:
        asyncio.run(init.async_setup_entry(_setup_hass, _setup_entry))
        raise AssertionError("expected the simulated forward_entry_setups failure to propagate")
    except RuntimeError as err:
        assert "simulated platform setup failure" in str(err)
finally:
    init.KiaAccessCoordinator = _orig_coordinator_cls
    init._register_frontend = _orig_register_frontend

assert _poller_before_leak.refcount == 0, (
    f"a failure in async_forward_entry_setups must still give back the "
    f"refcount async_setup_entry took -- got {_poller_before_leak.refcount}"
)
assert init._account_hash_for(_setup_entry) not in _setup_hass.data.get(init._ACCOUNTS_KEY, {}), (
    "the now-unreferenced poller must be removed from hass.data, not linger"
)
assert _setup_entry.entry_id not in _setup_hass.data.get(init.DOMAIN, {}), (
    "a failed setup must not leave a broken coordinator registered in hass.data"
)

# --- async_setup_entry(): a Store.async_load() failure (a truncated/
# corrupted .storage file -- not written atomically, unlike
# kia_client._save_token()) must surface as ConfigEntryNotReady, not a bare
# exception -- a hostile-review finding: async_load_sessions()/
# async_load_prefs() had no guard of their own, so this raised whatever
# Store.async_load() raised, and HA's config-entry framework treats
# anything that ISN'T ConfigEntryNotReady as a hard SETUP_ERROR it does NOT
# automatically retry -- the integration stayed broken until the user
# noticed and manually reloaded, instead of self-healing (an empty/reset
# store) on HA's own retry schedule the way a first-refresh failure
# already does. ---
class _FakeCoordinatorCorruptStore(_FakeCoordinatorForSetup):
    async def async_load_sessions(self):
        raise ValueError("Expecting value: line 1 column 1 (char 0)")  # a truncated-JSON shape


_corrupt_hass = type("H", (), {"data": {}, "config_entries": _FailingConfigEntries()})()
_corrupt_entry = _fake_entry(
    "corrupt", "USA:KIA:corrupt@example.com",
    {"username": "corrupt@example.com", "region": "USA", "brand": "KIA", "vin": ""},
)
init.KiaAccessCoordinator = _FakeCoordinatorCorruptStore
init._register_frontend = _fake_register_frontend
try:
    try:
        asyncio.run(init.async_setup_entry(_corrupt_hass, _corrupt_entry))
        raise AssertionError("expected the simulated corrupted-store failure to propagate")
    except init.ConfigEntryNotReady as err:
        assert "sessions/trips/prefs" in str(err), str(err)
    except Exception as err:  # noqa: BLE001
        raise AssertionError(
            f"a corrupted-store failure must raise ConfigEntryNotReady (so HA retries "
            f"automatically), not a bare {type(err).__name__} (a hard SETUP_ERROR HA won't "
            f"retry on its own): {err}"
        ) from err
finally:
    init.KiaAccessCoordinator = _orig_coordinator_cls
    init._register_frontend = _orig_register_frontend

# --- async_setup(): HA never calls async_setup_entry for a DISABLED entry,
# so relying on that alone would leave a legacy entry's stale unique_id
# unrepaired for as long as it stays disabled. async_setup() runs once at
# domain setup regardless of any one entry's state and must migrate every
# entry up front. ---
disabled_legacy = _fake_entry(
    "disabled", "USA:KIA:user@example.com",
    {"username": "user@example.com", "region": "USA", "brand": "KIA", "vin": "VIN1"},
)
hass_multi = type("H", (), {
    "config_entries": _FakeConfigEntries([disabled_legacy]),
    # async_setup() now also registers a websocket command (map_keys, for
    # kia-range-map-card to pull its API keys from entry.options instead of
    # the dashboard YAML) -- websocket_api.async_register_command() needs a
    # real-shaped hass.data, same as any actual HomeAssistant instance has.
    "data": {},
})()
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
