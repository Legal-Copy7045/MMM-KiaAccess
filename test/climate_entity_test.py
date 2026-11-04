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
print("all climate entity tests passed")
