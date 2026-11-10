"""KiaAccessClimate: climate.set_temperature with an hvac_mode.

"off" plus a temperature must stop climate (and remember the temperature),
never start it; a plain temperature starts climate at that setting.

Run: pip install homeassistant && python test/climate_entity_test.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

from homeassistant.components.climate import HVACMode  # noqa: E402

from custom_components.kia_access import climate as climate_mod  # noqa: E402


class _Coord:
    region = "EU"

    def __init__(self):
        self.commands = []
        self.prefs = {}
        self.climate_prefs = {}
        self.vehicle = {}

    def climate_temp_unit(self):
        return "°C"

    def build_climate_options(self, temp_c=None):
        return {"set_temp": temp_c}

    async def async_set_pref(self, key, value):
        self.prefs[key] = value

    async def async_run_command(self, command, options=None, context=None):
        self.commands.append((command, options))


def _entity():
    ent = object.__new__(climate_mod.KiaAccessClimate)
    ent.coordinator = _Coord()
    return ent


ent = _entity()
asyncio.run(ent.async_set_temperature(temperature=22.5, hvac_mode=HVACMode.OFF))
assert ent.coordinator.commands == [("stop_climate", None)], ent.coordinator.commands
assert ent.coordinator.prefs["last_temp_c"] == 22.5

ent = _entity()
asyncio.run(ent.async_set_temperature(temperature=21))
assert ent.coordinator.commands == [("start_climate", {"set_temp": 21.0})], ent.coordinator.commands

ent = _entity()
asyncio.run(ent.async_set_temperature(hvac_mode=HVACMode.HEAT_COOL))
assert [c for c, _ in ent.coordinator.commands] == ["start_climate"]
# ---- the native temperature API (current HA) with the same °F / °C
# behaviour as before; HA releases without it get the plain names as
# aliases, and the unit as the plain attribute ----
class _UnitCoord(_Coord):
    def __init__(self, unit):
        super().__init__()
        self.unit = unit
        self.vehicle = {"air_temperature": 21.0}
        self.climate_prefs = {"last_temp_c": 22.0}

    def climate_temp_unit(self):
        return self.unit


def _unit_entity(unit):
    ent = object.__new__(climate_mod.KiaAccessClimate)
    ent.coordinator = _UnitCoord(unit)
    if climate_mod._NATIVE_API:
        ent._attr_native_temperature_unit = unit
    else:
        ent._attr_temperature_unit = unit
    return ent


f = _unit_entity("°F")
assert f.native_current_temperature == 70 and f.native_target_temperature == 72
assert (f.min_temp, f.max_temp, f.target_temperature_step) == (62, 82, 1)
c = _unit_entity("°C")
assert c.native_current_temperature == 21.0 and c.native_target_temperature == 22.0
assert (c.min_temp, c.max_temp, c.target_temperature_step) == (16, 30, 0.5)
if climate_mod._NATIVE_API:
    assert f.native_temperature_unit == "°F"
else:
    # pre-native HA: the plain names still work, through the aliases
    assert f.temperature_unit == "°F" and f.current_temperature == 70 and f.target_temperature == 72
# never overrides the deprecated names in the class body (current HA warns,
# and they stop working in 2027.11)
for name in ("temperature_unit", "current_temperature", "target_temperature"):
    assert name not in vars(climate_mod.KiaAccessClimate) or not climate_mod._NATIVE_API, name
assert "temperature_unit" not in vars(climate_mod.KiaAccessClimate)
print("all climate entity tests passed")
