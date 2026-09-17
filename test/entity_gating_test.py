"""EV-only entity gating: button.py / number.py must not expose charging
commands or charge-limit sliders for a pure gas vehicle -- entities.py's
_hidePowertrainRow/etc. already hid these from the Lovelace card's details
table, but the actual HA button/number entities were unconditionally
created regardless of powertrain. Drives the real async_setup_entry()
functions against a fake hass/coordinator, same "call the real function
against a duck-typed self" approach as test/coordinator_stress_test.py.

Run: pip install homeassistant && python test/entity_gating_test.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

from custom_components.kia_access import button as button_mod  # noqa: E402
from custom_components.kia_access import number as number_mod  # noqa: E402
from custom_components.kia_access.const import DOMAIN  # noqa: E402


class _FakeEntry:
    def __init__(self, entry_id):
        self.entry_id = entry_id


class _FakeCoordinator:
    def __init__(self, engine_type):
        self.entry = _FakeEntry("e1")
        self.vehicle = {"engine_type": engine_type} if engine_type else {}


class _FakeHass:
    def __init__(self, coordinator):
        self.data = {DOMAIN: {"e1": coordinator}}


def _setup(mod, engine_type):
    coordinator = _FakeCoordinator(engine_type)
    hass = _FakeHass(coordinator)
    collected = []

    def add(entities):  # AddEntitiesCallback is a plain sync callable, not a coroutine
        collected.extend(entities)

    asyncio.run(mod.async_setup_entry(hass, coordinator.entry, add))
    return collected


def test_gas_vehicle_gets_no_charging_buttons():
    entities = _setup(button_mod, "ICE")
    names = [e._attr_name for e in entities]
    assert "Refresh now" in names, "the refresh button is powertrain-independent"
    assert "Lock" in names, "non-charge commands must still be created"
    for charge_name in ("Open charge port", "Close charge port", "Start charging", "Stop charging"):
        assert charge_name not in names, f"gas vehicle must not get a {charge_name!r} button"
    print("-- gas vehicle: no charging buttons, non-charge commands unaffected")


def test_ev_vehicle_gets_charging_buttons():
    entities = _setup(button_mod, "EV")
    names = [e._attr_name for e in entities]
    for charge_name in ("Open charge port", "Close charge port", "Start charging", "Stop charging"):
        assert charge_name in names, f"EV must still get a {charge_name!r} button"
    print("-- EV vehicle: charging buttons present")


def test_hybrid_vehicle_gets_charging_buttons():
    entities = _setup(button_mod, "PHEV")
    names = [e._attr_name for e in entities]
    assert "Start charging" in names, "PHEV/HEV can still charge a drive battery"
    print("-- hybrid vehicle: charging buttons present")


def test_unset_engine_type_defaults_to_ev_safe():
    """No engine_type at all (e.g. before the first successful poll) must
    default to showing the buttons, matching powertrain_for()'s own
    documented fail-safe -- a missing/degraded reading must never silently
    hide a real EV's controls."""
    entities = _setup(button_mod, None)
    names = [e._attr_name for e in entities]
    assert "Start charging" in names
    print("-- unset engine_type: defaults to EV-safe (charging buttons present)")


def test_gas_vehicle_gets_no_charge_limit_numbers():
    entities = _setup(number_mod, "ICE")
    names = [e._attr_name for e in entities]
    assert "Climate run time" in names, "non-charge numbers must still be created"
    assert "AC charge limit" not in names
    assert "DC charge limit" not in names
    print("-- gas vehicle: no charge-limit number entities")


def test_ev_vehicle_gets_charge_limit_numbers():
    entities = _setup(number_mod, "EV")
    names = [e._attr_name for e in entities]
    assert "AC charge limit" in names
    assert "DC charge limit" in names
    print("-- EV vehicle: charge-limit number entities present")


if __name__ == "__main__":
    test_gas_vehicle_gets_no_charging_buttons()
    test_ev_vehicle_gets_charging_buttons()
    test_hybrid_vehicle_gets_charging_buttons()
    test_unset_engine_type_defaults_to_ev_safe()
    test_gas_vehicle_gets_no_charge_limit_numbers()
    test_ev_vehicle_gets_charge_limit_numbers()
    print("all entity gating tests passed")
