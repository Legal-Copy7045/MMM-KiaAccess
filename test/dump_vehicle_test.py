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
_run_command({"command": "lock"}, one)
assert one[0].locked is True

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

print("dump_vehicle tests passed")
