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


def approx(a, b, tol=0.15):
    return a is not None and abs(a - b) <= tol


# USA / Canada: the library hands us °F — dump_vehicle must normalise to °C
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
    _Veh(
        air_temperature=21.0,
        outside_temperature=3.0,
        _air_temperature_unit="°C",
        _outside_temperature_unit=None,
    )
)
assert eu["air_temperature"] == 21.0, eu["air_temperature"]
assert eu["outside_temperature"] == 3.0, eu["outside_temperature"]

# missing temps must not crash or invent a value
none_case = kia_client.dump_vehicle(_Veh(_air_temperature_unit="°F"))
assert none_case.get("air_temperature") is None

print("dump_vehicle tests passed")
