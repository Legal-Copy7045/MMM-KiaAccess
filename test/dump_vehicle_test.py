"""kia_client.dump_vehicle — the bits that aren't just attribute copying.

Run: python test/dump_vehicle_test.py
"""
import enum
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

# USA payload that left the unit code out: the library sets the value but
# leaves the unit None -- that's still miles, not km
usa_missing = kia_client.dump_vehicle(
    _Veh(ev_driving_range=200.0, _ev_driving_range_unit=None,
         total_driving_range=210.0, ev_driving_range_unit=None),
    "USA",
)
assert approx(usa_missing["ev_driving_range"], 321.9, 1), usa_missing["ev_driving_range"]
assert approx(usa_missing["total_driving_range"], 338.0, 1), usa_missing["total_driving_range"]
assert usa_missing["ev_driving_range_unit"] == "km", usa_missing["ev_driving_range_unit"]

# ...but an explicit unit still wins over the region default
usa_km = kia_client.dump_vehicle(
    _Veh(ev_driving_range=300.0, _ev_driving_range_unit="km"), "USA"
)
assert usa_km["ev_driving_range"] == 300.0, usa_km["ev_driving_range"]

# missing unit outside the USA: leave as-is (EU/AU/... report km)
eu_missing = kia_client.dump_vehicle(_Veh(ev_driving_range=300.0), "EU")
assert eu_missing["ev_driving_range"] == 300.0

# charge-limit target ranges get the same miles -> km treatment
tr = kia_client.dump_vehicle(
    _Veh(ev_target_range_charge_AC=250.0, _ev_target_range_charge_AC_unit="mi"), "EU"
)
assert approx(tr["ev_target_range_charge_AC"], 402.3, 1), tr["ev_target_range_charge_AC"]

# tyre pressures: the car's display unit (psi / kPa / bar) -> kPa
tp = kia_client.dump_vehicle(_Veh(
    tire_pressure_front_left=36.0, tire_pressure_front_left_unit="psi",
    tire_pressure_front_right=2.5, tire_pressure_front_right_unit="bar",
    tire_pressure_rear_left=250.0, tire_pressure_rear_left_unit="kPa",
    tire_pressure_rear_right=36.0, tire_pressure_rear_right_unit=None,
))
assert approx(tp["tire_pressure_front_left"], 248.2, 0.2), tp["tire_pressure_front_left"]
assert tp["tire_pressure_front_left_unit"] == "kPa"
assert tp["tire_pressure_front_right"] == 250.0, tp["tire_pressure_front_right"]
assert tp["tire_pressure_rear_left"] == 250.0
assert tp["tire_pressure_rear_right"] is None, "no unit: psi vs kPa unknowable -> no reading"


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


# --- _select_vehicles(): must strip whitespace on both sides of the
# comparison, matching config_flow.py's own .strip().upper() normalization
# of the stored VIN -- a stray space either side (copy-pasted from the app,
# or however the API happens to format it) would otherwise silently break
# the match forever with no visible cause. ---
class _VMWithVehicles:
    def __init__(self, vehicles):
        self.vehicles = {i: v for i, v in enumerate(vehicles)}


padded_veh = _Veh(VIN=" VIN1 ")
assert kia_client._select_vehicles(_VMWithVehicles([padded_veh]), "vin1") == [padded_veh], (
    "a VIN with surrounding whitespace on the vehicle side must still match"
)
clean_veh = _Veh(VIN="VIN1")
assert kia_client._select_vehicles(_VMWithVehicles([clean_veh]), " vin1 ") == [clean_veh], (
    "a VIN with surrounding whitespace on the configured side must still match"
)

# --- _vehicle_key()/_select_vehicles(): Kia USA's own API implementation
# (KiaUvoApiUSA.get_vehicles()) never populates Vehicle.VIN at all -- every
# other region/brand does. Without a fallback, VIN-based selection silently
# matched nothing for every Kia USA multi-vehicle account: the initial
# "choose a vehicle" step, kia_client.fetch()'s own VIN filter, and the
# Configure VIN picker all keyed strictly off a field that's always blank
# there. Falls back to the vehicle's own account-issued `id` instead, which
# is just as stable/unique per vehicle for selection purposes. ---
no_vin_veh = _Veh(VIN=None, id="vehicle-id-123")
assert kia_client._vehicle_key(no_vin_veh) == "VEHICLE-ID-123", (
    "a vehicle with no VIN at all must fall back to its own id"
)
assert kia_client._select_vehicles(_VMWithVehicles([no_vin_veh]), "vehicle-id-123") == [no_vin_veh], (
    "selecting by the id fallback must work exactly like selecting by a real VIN"
)
has_vin_veh = _Veh(VIN="REALVIN1", id="vehicle-id-456")
assert kia_client._vehicle_key(has_vin_veh) == "REALVIN1", (
    "a vehicle WITH a real VIN must still prefer it over its id"
)
assert kia_client._vehicle_key_dict({"VIN": None, "id": "vehicle-id-789"}) == "VEHICLE-ID-789"
assert kia_client._vehicle_key_dict({"VIN": "REALVIN2", "id": "vehicle-id-000"}) == "REALVIN2"


# --- fetch()'s "no matching vehicles" error must actually say something --
# the configured VIN it looked for, and what the account currently has (or
# that the account returned nothing at all this poll), not just a bare
# "no matching vehicles on the account" that leaves a multi-vehicle account
# user with nothing to go on when this fires. ---
def _run_fetch_real_select(job, vehicles):
    vm = _VMWithVehicles(vehicles)
    vm.token = None
    vm.force_refresh_all_vehicles_states = lambda: None
    vm.update_all_vehicles_with_cached_state = lambda: None
    orig_connect = kia_client.connect
    kia_client.connect = lambda *a, **k: (vm, None)
    try:
        kia_client.fetch(job)
        raise AssertionError("fetch() should have raised ClientError")
    except kia_client.ClientError as e:
        return str(e)
    finally:
        kia_client.connect = orig_connect


msg = _run_fetch_real_select(
    {"vin": "VIN3", "forceRefreshTimeout": 0},
    [_Veh(VIN="VIN1"), _Veh(VIN="VIN2")],
)
assert "VIN3" in msg, f"must name the VIN it was looking for: {msg!r}"
assert "VIN1" in msg and "VIN2" in msg, f"must list what the account actually has: {msg!r}"

msg2 = _run_fetch_real_select({"vin": "VIN9", "forceRefreshTimeout": 0}, [])
assert "VIN9" in msg2, f"must still name the configured VIN even with 0 vehicles: {msg2!r}"
assert "0 vehicles" in msg2, f"must say the account returned nothing, not just 'no match': {msg2!r}"

msg3 = _run_fetch_real_select({"forceRefreshTimeout": 0}, [])
assert "0 vehicles" in msg3, f"no configured VIN + 0 vehicles -> must say the account returned nothing: {msg3!r}"
assert "VIN" not in msg3, (
    f"no configured VIN at all -> must not fabricate one to 'look for': {msg3!r}"
)
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

# --- Canada is NOT a Fahrenheit region, despite sitting next to "USA" in
# most of this project's other region lists. hyundai_kia_connect_api's
# KiaUvoApiCA.start_climate takes set_temp in CELSIUS (a hard `.index()`
# lookup into a 14.0-31.5C tuple in 0.5 steps) -- treating CA like USA
# here sent a 62-82 Fahrenheit value that was never in that tuple, so
# start_climate raised an unhandled ValueError on every call for a real
# Canadian account. Confirmed against the installed library source
# (KiaUvoApiCA.py), not assumed. ---
ca_car = [_ClimateVeh("VIN1")]
_run_climate({"command": "start_climate", "region": "CA", "options": {"set_temp": 21}}, ca_car)
assert ca_car[0].set_temp == 21, "a real Celsius value for a CA vehicle must pass -- CA is metric, not Fahrenheit"

bad_ca_car = [_ClimateVeh("VIN1")]
try:
    _run_climate({"command": "start_climate", "region": "CA", "options": {"set_temp": 70}}, bad_ca_car)
    raise AssertionError("70 (Fahrenheit-shaped) must be rejected for a CA/metric vehicle")
except kia_client.ClientError as e:
    assert "set_temp" in str(e)
assert not hasattr(bad_ca_car[0], "set_temp"), "the vehicle must never receive the out-of-region value"

default_ca_car = [_ClimateVeh("VIN1")]
_run_climate({"command": "start_climate", "region": "CA"}, default_ca_car)
assert default_ca_car[0].set_temp == 21, "omitted set_temp must use the metric (Celsius) default for a CA vehicle"

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

# --- engine_type: hyundai_kia_connect_api sets this (and a few other
# Vehicle fields) to a plain Enum MEMBER, not the plain string its own type
# annotation claims -- and a plain Enum's str() renders as "ClassName.MEMBER"
# ("ENGINE_TYPES.EV"), not the member's own value ("EV"). A naive fallback
# to str(value) would silently ship that mangled form to every consumer
# (the card's powertrain picker, most notably), which would then never
# match "ICE"/"EV"/"PHEV"/"HEV" against anything and silently fall back to
# its default. Mirrors the shape of the real
# hyundai_kia_connect_api.const.ENGINE_TYPES (a plain Enum, not str+Enum)
# without depending on that package being installed. ---
class _ENGINE_TYPES(enum.Enum):
    ICE = "ICE"
    EV = "EV"
    PHEV = "PHEV"
    HEV = "HEV"


for member in _ENGINE_TYPES:
    got = kia_client.dump_vehicle(_Veh(engine_type=member))["engine_type"]
    assert got == member.value, (
        f"engine_type={member!r} must serialize as {member.value!r}, not a mangled "
        f"str(Enum) like 'ENGINE_TYPES.{member.name}' -- got {got!r}"
    )

# a vehicle with no engine_type at all (an older/degraded API response) must
# stay a clean None, not "None" or crash
assert kia_client.dump_vehicle(_Veh(engine_type=None))["engine_type"] is None

# --- run_command(): the EU-style-only commands (valet, windows, schedule,
# charging current, V2L limit) ---
import datetime as _dt  # noqa: E402


class _RecVM(_CmdVM):
    """Records every VehicleManager call it gets."""

    def __init__(self, vehicles):
        super().__init__(vehicles)
        self.calls = []

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        def rec(*args):
            self.calls.append((name, args))
            return "xid"
        return rec


def _run_rec(job):
    vm = _RecVM([_CmdVeh("VIN1")])
    orig = kia_client.connect
    kia_client.connect = lambda *a, **k: (vm, None)
    try:
        kia_client.run_command(job)
    finally:
        kia_client.connect = orig
    return vm.calls


# region-limited: refused for USA before ever connecting
try:
    _run_rec({"command": "start_valet_mode", "region": "USA"})
    raise AssertionError("valet mode must be refused for a USA vehicle")
except kia_client.ClientError as e:
    assert "USA" in str(e) and "EU" in str(e), e
assert _run_rec({"command": "start_valet_mode", "region": "EU"}) == [("start_valet_mode", ("VIN1",))]

# close_windows: preset -> every window CLOSED
(name, (vid, w)), = _run_rec({"command": "close_windows", "region": "EU"})
assert name == "set_windows_state" and vid == "VIN1"
assert [int(w.front_left), int(w.front_right), int(w.back_left), int(w.back_right)] == [0, 0, 0, 0]

# set_windows: only the windows given change, the rest stay None
(_, (_, w)), = _run_rec({"command": "set_windows", "region": "AU",
                         "options": {"front_left": "vent", "back_right": "open"}})
assert int(w.front_left) == 2 and int(w.back_right) == 1
assert w.front_right is None and w.back_left is None
try:
    _run_rec({"command": "set_windows", "region": "EU", "options": {}})
    raise AssertionError("set_windows with no window must be refused")
except kia_client.ClientError:
    pass

# set_charging_current: the % choice maps to the library's level
assert _run_rec({"command": "set_charging_current", "region": "EU",
                 "options": {"current": "90"}}) == [("set_charging_current", ("VIN1", 2))]
try:
    _run_rec({"command": "set_charging_current", "region": "EU", "options": {}})
    raise AssertionError("a required option left out must be refused")
except kia_client.ClientError as e:
    assert "current" in str(e)

assert _run_rec({"command": "set_v2l_limit", "region": "EU",
                 "options": {"limit": 30}}) == [("set_vehicle_to_load_discharge_limit", ("VIN1", 30))]

# schedule: given fields set, everything else None (= keep the car's setting)
(name, (_, req)), = _run_rec({"command": "schedule_charging_and_climate", "region": "EU", "options": {
    "first_departure_enabled": True, "first_departure_time": "07:30",
    "first_departure_days": ["mon", "tue", "fri"], "off_peak_start_time": "23:00:00",
    "temperature": 21.5,
}})
assert name == "schedule_charging_and_climate"
assert req.first_departure.enabled is True
assert req.first_departure.time == _dt.time(7, 30)
assert req.first_departure.days == [1, 2, 5]
assert req.second_departure is None
assert req.off_peak_start_time == _dt.time(23, 0) and req.off_peak_end_time is None
assert req.temperature == 21.5 and req.charging_enabled is None and req.defrost is None

# set_off_peak_charging: mode -> (charging_enabled, off_peak_charge_only_enabled)
for mode, want in (("off", (False, None)), ("time", (True, True)), ("target", (True, False))):
    (_, (_, req)), = _run_rec({"command": "set_off_peak_charging", "region": "EU",
                               "options": {"mode": mode}})
    assert (req.charging_enabled, req.off_peak_charge_only_enabled) == want, mode
try:
    _run_rec({"command": "set_off_peak_charging", "region": "EU", "options": {"mode": "sometimes"}})
    raise AssertionError("an unknown select choice must be refused")
except kia_client.ClientError:
    pass
try:
    _run_rec({"command": "schedule_charging_and_climate", "region": "EU",
              "options": {"off_peak_start_time": "25:99"}})
    raise AssertionError("a bad time must be refused")
except kia_client.ClientError:
    pass

# a step-limited int (V2L limit, steps of 10) off the grid is refused
try:
    _run_rec({"command": "set_v2l_limit", "region": "EU", "options": {"limit": 25}})
    raise AssertionError("limit 25 is off the 10% grid")
except kia_client.ClientError as e:
    assert "multiple of 10" in str(e)
# departure days in every documented form
assert kia_client.parse_days("d", "mon,tue") == [1, 2]
assert kia_client.parse_days("d", ["Monday", "friday", 0]) == [0, 1, 5]

# --- fetch(): wakeVin wakes only that car; the empty-state warning names
# the car(s) it's about ---
class _WakeVM(_CmdVM):
    def __init__(self, vehicles):
        super().__init__(vehicles)
        self.woken = []

    def force_refresh_vehicle_state(self, vid):
        self.woken.append(vid)

    def force_refresh_all_vehicles_states(self):
        self.woken.append("ALL")


def _fetch_with(vm, job):
    orig = kia_client.connect
    kia_client.connect = lambda *a, **k: (vm, None)
    try:
        return kia_client.fetch(job)
    finally:
        kia_client.connect = orig


wvm = _WakeVM([_CmdVeh("VINA", last_updated_at="2026-01-01T00:00:00"), _CmdVeh("VINB")])
res = _fetch_with(wvm, {"allVehicles": True, "wakeVin": "VINB", "refresh": True, "forceRefreshTimeout": 5})
assert wvm.woken == ["VINB"], wvm.woken
assert "VINB" in res["meta"]["warning"] and "VINA" not in res["meta"]["warning"], res["meta"]
assert res["meta"]["emptyVehicles"] == ["VINB"]
wvm2 = _WakeVM([_CmdVeh("VINA"), _CmdVeh("VINB")])
_fetch_with(wvm2, {"allVehicles": True, "refresh": True, "forceRefreshTimeout": 5})
assert wvm2.woken == ["ALL"], "no wakeVin: whole account, as before"

# battery temperatures get the same °F -> °C treatment as the others
bt = kia_client.dump_vehicle(_Veh(ev_battery_temperature_min=77.0,
                                  _ev_battery_temperature_min_unit="°F"))
assert approx(bt["ev_battery_temperature_min"], 25.0), bt["ev_battery_temperature_min"]

# --- daily_stats: the car's energy log as clean records (kWh, km), not the
# library dataclasses' repr() strings; [] when the region has none ---
import datetime as _dt2  # noqa: E402
from hyundai_kia_connect_api.Vehicle import DailyDrivingStats  # noqa: E402

ds = kia_client.dump_vehicle(_Veh(daily_stats=[
    DailyDrivingStats(date=_dt2.datetime(2026, 6, 2, 17, 40), total_consumed=5000,
                      engine_consumption=4000, climate_consumption=600,
                      onboard_electronics_consumption=300, battery_care_consumption=100,
                      regenerated_energy=800, distance=20, distance_unit="mi"),
    DailyDrivingStats(date=_dt2.datetime(2026, 6, 1), total_consumed=9000, distance=50,
                      distance_unit="km"),
    DailyDrivingStats(date=None, total_consumed=1),
]), "EU")["daily_stats"]
assert [r["at"] for r in ds] == ["2026-06-01T00:00:00", "2026-06-02T17:40:00"], ds
assert ds[1] == {"at": "2026-06-02T17:40:00", "date": "2026-06-02", "kwh": 5.0,
                 "drivingKwh": 4.0, "climateKwh": 0.6, "electronicsKwh": 0.3,
                 "batteryCareKwh": 0.1, "regenKwh": 0.8, "distanceKm": 32.19}, ds[1]
assert ds[0]["distanceKm"] == 50 and ds[0]["climateKwh"] is None
# a missing distance unit on a USA account means miles
us = kia_client.dump_vehicle(_Veh(daily_stats=[DailyDrivingStats(
    date=_dt2.datetime(2026, 6, 1), total_consumed=1000, distance=10, distance_unit=None)]), "USA")
assert us["daily_stats"][0]["distanceKm"] == 16.09
assert kia_client.dump_vehicle(_Veh())["daily_stats"] == [], "Kia USA: no log"
# other library dataclasses serialise as dicts, never repr() strings
assert kia_client.jsonable(DailyDrivingStats(total_consumed=1))["total_consumed"] == 1

print("dump_vehicle tests passed")
