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
    orig = kia_client.connect
    kia_client.connect = lambda *a, **k: (vm, None)
    kia_client._select_vehicles = lambda *a, **k: [_Veh(last_updated_at="x")]
    try:
        kia_client.fetch(job)
    finally:
        kia_client.connect = orig
    return vm


assert _run_fetch({"refresh": True, "forceRefreshTimeout": 30}).woke is True
assert _run_fetch({"refresh": True, "forceRefreshTimeout": 0}).woke is False
assert _run_fetch({"refresh": False, "forceRefreshTimeout": 30}).woke is False

print("dump_vehicle tests passed")
