"""kia_client.dump_vehicle — the bits that aren't just attribute copying.

Run: python test/dump_vehicle_test.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import kia_client  # noqa: E402


class _Veh:
    """Stand-in for hyundai_kia_connect_api.Vehicle — only what dump_vehicle reads."""

    data = {}

    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


def approx(a, b, tol=0.2):
    return a is not None and abs(a - b) <= tol


# --- temperature: USA / Canada hand us °F -> normalise to °C ---
usa = kia_client.dump_vehicle(
    _Veh(
        air_temperature=72.0,
        outside_temperature=35.0,
        _air_temperature_unit="°F",
        _outside_temperature_unit="°F",
    )
)
assert approx(usa["air_temperature"], 22.2), usa["air_temperature"]
assert approx(usa["outside_temperature"], 1.7), usa["outside_temperature"]

# EU / rest: already °C (or unit unknown) — leave the value alone
eu = kia_client.dump_vehicle(
    _Veh(air_temperature=21.0, _air_temperature_unit="°C")
)
assert eu["air_temperature"] == 21.0, eu["air_temperature"]

# missing temps must not crash or invent a value
assert kia_client.dump_vehicle(_Veh(_air_temperature_unit="°F")).get("air_temperature") is None

# --- distance: USA / Canada hand us miles -> normalise to km ---
usa_d = kia_client.dump_vehicle(
    _Veh(
        odometer=12000.0,
        odometer_unit="mi",
        _odometer_unit="mi",
        ev_driving_range=200.0,
        _ev_driving_range_unit="mi",
        next_service_distance=7981.0,
        _next_service_distance_unit="mi",
    )
)
assert approx(usa_d["odometer"], 19312.1, 1), usa_d["odometer"]
assert usa_d["odometer_unit"] == "km", usa_d["odometer_unit"]
assert approx(usa_d["ev_driving_range"], 321.9, 1), usa_d["ev_driving_range"]
assert approx(usa_d["next_service_distance"], 12844.2, 1), usa_d["next_service_distance"]

# EU: km already -> untouched
eu_d = kia_client.dump_vehicle(_Veh(odometer=45000.0, _odometer_unit="km"))
assert eu_d["odometer"] == 45000.0, eu_d["odometer"]

# unknown / missing unit -> leave as-is (can't guess)
none_d = kia_client.dump_vehicle(_Veh(ev_driving_range=300.0))
assert none_d["ev_driving_range"] == 300.0


# --- fetch(): refresh:false / forceRefreshTimeout<=0 must NOT wake the car ---
class _VM:
    token = None

    def __init__(self):
        self.woke = False

    def force_refresh_all_vehicles_states(self):
        self.woke = True

    def update_all_vehicles_with_cached_state(self):
        pass


def _run_fetch(job):
    vm = _VM()
    orig_connect = kia_client.connect
    orig_select = kia_client._select_vehicles
    kia_client.connect = lambda *a, **k: (vm, None)
    kia_client._select_vehicles = lambda *a, **k: [_Veh(last_updated_at="x")]
    try:
        kia_client.fetch(job)
    finally:
        kia_client.connect = orig_connect
        kia_client._select_vehicles = orig_select
    return vm


assert _run_fetch({"refresh": True, "forceRefreshTimeout": 30}).woke is True
assert _run_fetch({"refresh": True, "forceRefreshTimeout": 0}).woke is False
assert _run_fetch({"refresh": False, "forceRefreshTimeout": 30}).woke is False
assert _run_fetch({"refresh": False, "forceRefreshTimeout": 0}).woke is False
assert _run_fetch({"refresh": True, "forceRefreshTimeout": -1}).woke is False
assert _run_fetch({"forceRefreshTimeout": None}).woke is True, "legacy default wakes"


# --- fetch(): multiple vehicles + no VIN must refuse the read, not silently
# pick [0] -- which physical car that is isn't guaranteed stable between
# polls (the account API's own vehicle order isn't guaranteed), so reads
# get the same "explicit VIN required" treatment run_command() already has
# for control commands. A single vehicle, or a VIN that's already narrowed
# _select_vehicles() down to one match, must still work exactly as before. ---
def _run_fetch_with_vehicles(job, veh_list):
    vm = _VM()
    orig_connect = kia_client.connect
    orig_select = kia_client._select_vehicles
    kia_client.connect = lambda *a, **k: (vm, None)
    kia_client._select_vehicles = lambda *a, **k: veh_list
    try:
        return kia_client.fetch(job)
    finally:
        kia_client.connect = orig_connect
        kia_client._select_vehicles = orig_select


one_veh = [_Veh(last_updated_at="x", VIN="VIN1")]
res = _run_fetch_with_vehicles({}, one_veh)
assert res["ok"] is True and len(res["vehicles"]) == 1, "a single vehicle must still work with no VIN"

two_veh = [_Veh(last_updated_at="x", VIN="VIN1"), _Veh(last_updated_at="y", VIN="VIN2")]
try:
    _run_fetch_with_vehicles({}, two_veh)
    raise AssertionError("fetch() should refuse an ambiguous multi-vehicle read with no VIN")
except kia_client.ClientError as e:
    assert "VIN" in str(e)

# a VIN already narrows _select_vehicles() itself down to one match in the
# real implementation -- this fake stands in for that already-filtered result
res2 = _run_fetch_with_vehicles({"vin": "VIN2"}, [_Veh(last_updated_at="y", VIN="VIN2")])
assert res2["ok"] is True and len(res2["vehicles"]) == 1, "an explicit VIN must still work"

# allVehicles:true is the one deliberate opt-in bypass (MM's rotate-within-
# one-module feature) -- it must return every vehicle instead of erroring,
# but ONLY when explicitly set; a plain blank-VIN, 2+-vehicle read must
# still refuse exactly as above (allVehicles defaulting to falsy must not
# accidentally widen the ambiguity guard for every other caller)
res3 = _run_fetch_with_vehicles({"allVehicles": True}, two_veh)
assert res3["ok"] is True and len(res3["vehicles"]) == 2, (
    "allVehicles:true must return every vehicle, not just the first"
)


# --- fetch(): a still-running wake-up thread past the timeout must NOT be
# read from -- it may still be mutating `vm` in place (a data race), so
# fetch() must raise instead of racily calling update_all_vehicles_with_cached_
# state() / dump_vehicle() against it. ---
import threading  # noqa: E402
import time  # noqa: E402


class _SlowVM:
    token = None

    def __init__(self):
        self.cached_state_read = False

    def force_refresh_all_vehicles_states(self):
        time.sleep(0.3)  # still "running" well past the 0.05s timeout below

    def update_all_vehicles_with_cached_state(self):
        # must never be called while the background thread above is still alive
        self.cached_state_read = True


slow_vm = _SlowVM()
orig_connect = kia_client.connect
kia_client.connect = lambda *a, **k: (slow_vm, None)
try:
    try:
        kia_client.fetch({"refresh": True, "forceRefreshTimeout": 0.05})
        raise AssertionError("fetch() should have raised ClientError on timeout")
    except kia_client.ClientError:
        pass
finally:
    kia_client.connect = orig_connect
assert slow_vm.cached_state_read is False, (
    "must not read vm state while the background refresh thread might still be writing it"
)
time.sleep(0.4)  # let the orphaned background thread finish before the process exits


# --- run_command(): a control command must not silently pick "vehicle 1"
# when the account has multiple vehicles and no VIN was configured. ---
class _CmdVeh(_Veh):
    locked = False

    def __init__(self, vin, **kw):
        super().__init__(**kw)
        self.VIN = vin
        self.id = vin

    def lock(self):
        self.locked = True


class _CmdVM:
    token = None

    def __init__(self, vehicles):
        self._vehicles = {v.VIN: v for v in vehicles}

    def update_all_vehicles_with_cached_state(self):
        pass

    @property
    def vehicles(self):
        return self._vehicles

    def lock(self, vehicle_id):
        self._vehicles[vehicle_id].lock()
        return "fake-xid-123"  # VehicleManager's real methods return Kia's job id


def _run_command(job, vehicles):
    vm = _CmdVM(vehicles)
    orig = kia_client.connect
    kia_client.connect = lambda *a, **k: (vm, None)
    try:
        return kia_client.run_command(job)
    finally:
        kia_client.connect = orig


# single vehicle, no VIN configured -> fine, defaults to it
one = [_CmdVeh("VIN1")]
res = _run_command({"command": "lock"}, one)
assert one[0].locked is True
assert res["actionId"] == "fake-xid-123", (
    "the job id VehicleManager's real methods return must be captured, not discarded"
)

# two vehicles, no VIN configured -> must refuse rather than guess
two = [_CmdVeh("VIN1"), _CmdVeh("VIN2")]
try:
    _run_command({"command": "lock"}, two)
    raise AssertionError("run_command() should refuse an ambiguous multi-vehicle control command")
except kia_client.ClientError as e:
    assert "VIN" in str(e)
assert two[0].locked is False and two[1].locked is False, "neither vehicle should be touched"

# two vehicles, explicit VIN -> targets the right one, the other untouched
two2 = [_CmdVeh("VIN1"), _CmdVeh("VIN2")]
_run_command({"command": "lock", "vin": "VIN2"}, two2)
assert two2[0].locked is False and two2[1].locked is True

# a request timeout mid-command is genuinely ambiguous (the vehicle may or
# may not have received it) -- must raise CommandUnconfirmed, not a flat
# ClientError, so a caller can distinguish "definitely failed" from
# "unknown, don't assume a retry is free"
from hyundai_kia_connect_api.exceptions import RequestTimeoutError  # noqa: E402


class _TimeoutVeh(_CmdVeh):
    def lock(self):
        raise RequestTimeoutError("simulated read timeout")


timeout_veh = [_TimeoutVeh("VIN1")]
try:
    _run_command({"command": "lock"}, timeout_veh)
    raise AssertionError("a request timeout must raise CommandUnconfirmed")
except kia_client.CommandUnconfirmed as e:
    assert isinstance(e, kia_client.ClientError), (
        "CommandUnconfirmed must still be catchable as a plain ClientError"
    )
    assert "unknown" in str(e).lower() or "timed out" in str(e).lower()

# a real, unambiguous rejection must NOT be reported as unconfirmed
class _RejectVeh(_CmdVeh):
    def lock(self):
        raise ValueError("simulated hard rejection (e.g. bad PIN)")


reject_veh = [_RejectVeh("VIN1")]
try:
    _run_command({"command": "lock"}, reject_veh)
    raise AssertionError("a clear rejection must raise plain ClientError")
except kia_client.CommandUnconfirmed:
    raise AssertionError("a clear rejection must NOT be reported as unconfirmed")
except kia_client.ClientError:
    pass

# --- run_command(): a region-ambiguous option (set_temp) must reject an
# explicit value that's wrong for the vehicle's actual region, not just
# silently pass it through. The generated HA service schema can't be
# region-scoped (see core/commands.json's $comment), so this backend check
# is the second of two defense-in-depth layers -- the first (removing the
# static "70" default from services.yaml) only stops the ACCIDENTAL case. ---
class _ClimateVeh(_CmdVeh):
    def start_climate(self, options):
        self.set_temp = getattr(options, "set_temp", None)


class _ClimateVM(_CmdVM):
    def start_climate(self, vehicle_id, options):
        self._vehicles[vehicle_id].start_climate(options)


def _run_climate(job, vehicles):
    vm = _ClimateVM(vehicles)
    orig = kia_client.connect
    kia_client.connect = lambda *a, **k: (vm, None)
    try:
        return kia_client.run_command(job)
    finally:
        kia_client.connect = orig


usa_car = [_ClimateVeh("VIN1")]
_run_climate({"command": "start_climate", "region": "USA", "options": {"set_temp": 70}}, usa_car)
assert usa_car[0].set_temp == 70, "a real Fahrenheit value for a USA vehicle must pass"

eu_car = [_ClimateVeh("VIN1")]
_run_climate({"command": "start_climate", "region": "EU", "options": {"set_temp": 21}}, eu_car)
assert eu_car[0].set_temp == 21, "a real Celsius value for an EU vehicle must pass"

# the exact accidental-default scenario this whole fix is about: a stale/
# UI-leftover Fahrenheit value explicitly sent to a metric-region vehicle
bad_eu_car = [_ClimateVeh("VIN1")]
try:
    _run_climate({"command": "start_climate", "region": "EU", "options": {"set_temp": 70}}, bad_eu_car)
    raise AssertionError("70 (Fahrenheit-shaped) must be rejected for an EU/metric vehicle")
except kia_client.ClientError as e:
    assert "set_temp" in str(e)
assert bad_eu_car[0].id and not hasattr(bad_eu_car[0], "set_temp"), (
    "the vehicle must never receive the out-of-region value"
)

# and the inverse: a Celsius-shaped value sent to a USA/Fahrenheit vehicle
bad_usa_car = [_ClimateVeh("VIN1")]
try:
    _run_climate({"command": "start_climate", "region": "USA", "options": {"set_temp": 21}}, bad_usa_car)
    raise AssertionError("21 (Celsius-shaped) must be rejected for a USA/Fahrenheit vehicle")
except kia_client.ClientError:
    pass

# omitting it entirely still falls back to the region-correct default
default_eu_car = [_ClimateVeh("VIN1")]
_run_climate({"command": "start_climate", "region": "EU"}, default_eu_car)
assert default_eu_car[0].set_temp == 21, "omitted set_temp must use the metric default for an EU vehicle"

# --- domain-range guard: a structurally-valid-looking but semantically
# impossible reading (percentage outside 0-100, a negative range/odometer)
# becomes None rather than propagating as a fake but plausible-looking
# number. isFinite/NaN/Infinity protection already exists throughout the
# HA coordinator for GPS specifically; this is the equivalent for the
# vehicle's own numeric readings, at the one place (dump_vehicle()) both
# MM and HA share. ---
garbage = kia_client.dump_vehicle(
    _Veh(
        ev_battery_percentage=137,       # Kia has, rarely, reported >100 mid-sync
        ev_battery_soh_percentage=-5,
        car_battery_percentage=float("nan"),
        fuel_level=float("inf"),
        ev_driving_range=-1,             # never legitimately negative
        odometer=-42,
    )
)
assert garbage["ev_battery_percentage"] is None, "137% must be rejected, not passed through"
assert garbage["ev_battery_soh_percentage"] is None, "-5% must be rejected"
assert garbage["car_battery_percentage"] is None, "NaN must be rejected"
assert garbage["fuel_level"] is None, "Infinity must be rejected"
assert garbage["ev_driving_range"] is None, "a negative range must be rejected"
assert garbage["odometer"] is None, "a negative odometer must be rejected"

# ordinary, plausible values must pass through completely unchanged
sane = kia_client.dump_vehicle(
    _Veh(
        ev_battery_percentage=0,   # boundary values are valid, not "out of range"
        ev_battery_soh_percentage=100,
        car_battery_percentage=82.5,
        fuel_level=0,
        ev_driving_range=0,        # an empty battery is a real, valid range reading
        odometer=45231.7,
    )
)
assert sane["ev_battery_percentage"] == 0
assert sane["ev_battery_soh_percentage"] == 100
assert sane["car_battery_percentage"] == 82.5
assert sane["fuel_level"] == 0
assert sane["ev_driving_range"] == 0
assert sane["odometer"] == 45231.7

# a missing/None reading must stay None, not be treated as "0, therefore
# in range" or crash the guard
missing = kia_client.dump_vehicle(_Veh())
assert missing.get("ev_battery_percentage") is None
assert missing.get("odometer") is None

print("dump_vehicle tests passed")
