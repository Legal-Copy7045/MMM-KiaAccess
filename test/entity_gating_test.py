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
from custom_components.kia_access import binary_sensor as binary_sensor_mod  # noqa: E402
from custom_components.kia_access import sensor as sensor_mod  # noqa: E402
from custom_components.kia_access.const import DOMAIN, ENTITIES  # noqa: E402


class _FakeEntry:
    def __init__(self, entry_id):
        self.entry_id = entry_id


class _FakeCoordinator:
    def __init__(self, engine_type, region="USA"):
        self.entry = _FakeEntry("e1")
        self.vehicle = {"engine_type": engine_type} if engine_type else {}
        self.region = region


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


def test_phev_gets_charging_buttons():
    entities = _setup(button_mod, "PHEV")
    names = [e._attr_name for e in entities]
    assert "Start charging" in names, "a PHEV has a plug"
    print("-- PHEV: charging buttons present")


def test_hev_gets_no_charging_buttons():
    """An HEV (conventional, non-plug hybrid -- e.g. a Kia Sportage Hybrid
    or Hyundai Tucson Hybrid, sold alongside a PHEV version of the same
    car) has no plug at all, same as gas -- it must NOT get charging
    buttons even though it shares powertrain_for()'s "hybrid" bucket with
    a PHEV."""
    entities = _setup(button_mod, "HEV")
    names = [e._attr_name for e in entities]
    for charge_name in ("Open charge port", "Close charge port", "Start charging", "Stop charging"):
        assert charge_name not in names, f"HEV (no plug) must not get a {charge_name!r} button"
    assert "Lock" in names, "non-charge commands unaffected"
    print("-- HEV: no charging buttons (no plug), non-charge commands unaffected")


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


def test_phev_gets_charge_limit_numbers():
    entities = _setup(number_mod, "PHEV")
    names = [e._attr_name for e in entities]
    assert "AC charge limit" in names and "DC charge limit" in names
    print("-- PHEV: charge-limit number entities present")


def test_hev_gets_no_charge_limit_numbers():
    """An HEV has no plug -- no external charging, no charge limits to set."""
    entities = _setup(number_mod, "HEV")
    names = [e._attr_name for e in entities]
    assert "Climate run time" in names, "non-charge numbers must still be created"
    assert "AC charge limit" not in names
    assert "DC charge limit" not in names
    print("-- HEV: no charge-limit number entities (no plug)")


def test_capability_flags_hide_buttons():
    """An EU car that reports supports_valet_mode / supports_window_control
    False gets no such buttons; unknown (None / missing) keeps them."""
    coordinator = _FakeCoordinator("EV", "EU")
    coordinator.vehicle.update({"supports_valet_mode": False, "supports_window_control": None})
    collected = []
    asyncio.run(button_mod.async_setup_entry(_FakeHass(coordinator), _FakeEntry("e1"), collected.extend))
    names = {e._attr_name for e in collected}
    assert "Start valet mode" not in names and "Stop valet mode" not in names, names
    assert "Close windows" in names, "unknown capability keeps the region rule"
    print("-- buttons hidden when the car reports the capability false")


def test_numeric_booleans():
    """The EV9 reports plugged-in as a connector code (4 while charging):
    any nonzero number is on, 0 off, a non-boolean string unknown."""
    spec = next(e for e in ENTITIES if e["key"] == "ev_battery_is_plugged_in")
    coordinator = _FakeCoordinator("EV")
    ent = binary_sensor_mod.KiaAccessBinarySensor(coordinator, spec)
    for raw, want in ((4, True), (1, True), (0, False), ("true", True),
                      ("false", False), ("maybe", None), (None, None)):
        coordinator.vehicle["ev_battery_is_plugged_in"] = raw
        assert ent.is_on is want, (raw, ent.is_on)
    lock = binary_sensor_mod.KiaAccessBinarySensor(
        coordinator, next(e for e in ENTITIES if e["key"] == "is_locked"))
    coordinator.vehicle["is_locked"] = 1
    assert lock.is_on is False, "inverted lock: locked (1) -> off"
    print("-- numeric booleans (EV9 connector code) read as on/off")


def test_region_limited_buttons_only_where_supported():
    """valet mode / close / vent windows are EU-style-API only: no button
    for a USA car (it could only fail), a button for an EU one."""
    limited = {"Start valet mode", "Stop valet mode", "Close windows", "Vent windows"}
    for region, want in (("USA", False), ("CA", False), ("EU", True), ("AU", True)):
        coordinator = _FakeCoordinator("EV", region)
        collected = []
        asyncio.run(button_mod.async_setup_entry(
            _FakeHass(coordinator), _FakeEntry("e1"), collected.extend))
        names = {e._attr_name for e in collected}
        assert (limited <= names) is want and (not (limited & names)) is (not want), (region, names)
        assert "Lock" in names
    print("-- valet / window buttons only for regions the library supports")


def test_region_specific_entities_start_disabled():
    """entities.json `enabled_default: false` -> created, but disabled in
    the entity registry; every other catalogue entry stays enabled."""
    coordinator = _FakeCoordinator("EV")
    by_key = {}
    for spec in ENTITIES:
        cls = (sensor_mod.KiaAccessSensor if spec["domain"] == "sensor"
               else binary_sensor_mod.KiaAccessBinarySensor)
        by_key[spec["key"]] = (spec, cls(coordinator, spec))
    for key, (spec, ent) in by_key.items():
        want = spec.get("enabled_default") is not False
        assert ent.entity_registry_enabled_default is want, key
    assert by_key["tire_pressure_front_left"][1].entity_registry_enabled_default is False
    assert by_key["front_left_window_is_open"][1].entity_registry_enabled_default is True
    print("-- region/model-specific catalogue entities are created disabled")


def test_fuel_economy_unit_follows_the_car():
    """hyundai_kia_connect_api 5.2 translates the car's fuel-economy unit
    code (average_fuel_economy_*_unit); the sensor shows it, keeps the last
    one through a poll that leaves it out, and fixed-unit sensors are
    unaffected."""
    coordinator = _FakeCoordinator("PHEV")
    spec = next(e for e in ENTITIES if e["key"] == "average_fuel_economy_drive")
    ent = sensor_mod.KiaAccessSensor(coordinator, spec)
    assert ent.native_unit_of_measurement is None, "no unit reported yet"
    coordinator.vehicle["average_fuel_economy_drive_unit"] = "L/100km"
    coordinator.vehicle["average_fuel_economy_drive"] = 5.4
    assert ent.native_unit_of_measurement == "L/100km"
    assert ent.native_value == 5.4
    coordinator.vehicle["average_fuel_economy_drive_unit"] = None
    assert ent.native_unit_of_measurement == "L/100km", "last unit kept"
    coordinator.vehicle["average_fuel_economy_drive_unit"] = "MPG"
    assert ent.native_unit_of_measurement == "MPG"
    for key in ("average_fuel_economy_after_refuel", "average_fuel_economy_accumulated"):
        s = next(e for e in ENTITIES if e["key"] == key)
        assert s.get("unit_key") == key + "_unit", key
    soc = sensor_mod.KiaAccessSensor(
        coordinator, next(e for e in ENTITIES if e["key"] == "ev_battery_percentage"))
    assert soc.native_unit_of_measurement == "%"
    print("-- fuel economy sensors carry the car's own unit")


def test_tyre_pressure_kept_while_parked():
    """kia_uvo #1930: some backends send no tyre pressures while the car is
    parked. The four tyre sensors keep the last real reading (marked
    `retained`, with when it was taken), take a fresh one as soon as it
    comes, and restore the stored kPa value after an HA restart."""
    from homeassistant.components.sensor import SensorExtraStoredData
    from homeassistant.core import State

    tyre_keys = {e["key"] for e in ENTITIES if e.get("retain_last")}
    assert tyre_keys == {"tire_pressure_front_left", "tire_pressure_front_right",
                         "tire_pressure_rear_left", "tire_pressure_rear_right"}, tyre_keys
    made = {e._key: type(e) for e in _setup(sensor_mod, "EV") if hasattr(e, "_key")}
    for key in tyre_keys:
        assert made[key] is sensor_mod.KiaAccessRetainedSensor, key
    assert made["ev_battery_percentage"] is sensor_mod.KiaAccessSensor

    spec = next(e for e in ENTITIES if e["key"] == "tire_pressure_front_left")
    coordinator = _FakeCoordinator("EV", "AU")
    coordinator.vehicle.update(tire_pressure_front_left=250.0,
                               last_updated_at="2026-11-20T08:15:00+11:00")
    ent = sensor_mod.KiaAccessRetainedSensor(coordinator, spec)
    ent.async_write_ha_state = lambda: None
    assert ent.native_value == 250
    assert ent.extra_state_attributes == {
        "last_reported": "2026-11-20T08:15:00+11:00", "retained": False}

    coordinator.vehicle.update(tire_pressure_front_left=None,
                               last_updated_at="2026-11-20T18:00:00+11:00")
    ent._handle_coordinator_update()
    assert ent.native_value == 250, "parked: last reading kept"
    assert ent.extra_state_attributes == {
        "last_reported": "2026-11-20T08:15:00+11:00", "retained": True}

    coordinator.vehicle.update(tire_pressure_front_left=241.3,
                               last_updated_at="2026-11-21T07:30:00+11:00")
    ent._handle_coordinator_update()
    assert ent.native_value == 241.3
    assert ent.extra_state_attributes["retained"] is False
    assert ent.extra_state_attributes["last_reported"] == "2026-11-21T07:30:00+11:00"

    # restart while parked: restore the stored native (kPa) value, not the
    # state string (that is in the user's display unit, here psi)
    async def _noop(self):
        return None
    sensor_mod.KiaAccessSensor.async_added_to_hass = _noop
    try:
        cold = _FakeCoordinator("EV", "AU")
        cold.vehicle["tire_pressure_front_left"] = None
        ent2 = sensor_mod.KiaAccessRetainedSensor(cold, spec)

        async def _data():
            return SensorExtraStoredData(241.3, "kPa")

        async def _state():
            return State("sensor.x", "35.0", {"last_reported": "2026-11-21T07:30:00+11:00",
                                              "unit_of_measurement": "psi"})
        ent2.async_get_last_sensor_data = _data
        ent2.async_get_last_state = _state
        assert ent2.native_value is None
        asyncio.run(ent2.async_added_to_hass())
        assert ent2.native_value == 241.3, ent2.native_value
        assert ent2.extra_state_attributes == {
            "last_reported": "2026-11-21T07:30:00+11:00", "retained": True}

        # a live reading at startup wins over the stored one
        live = _FakeCoordinator("EV", "AU")
        live.vehicle["tire_pressure_front_left"] = 238.0
        ent3 = sensor_mod.KiaAccessRetainedSensor(live, spec)
        ent3.async_get_last_sensor_data = _data
        ent3.async_get_last_state = _state
        asyncio.run(ent3.async_added_to_hass())
        assert ent3.native_value == 238

        # nothing stored (first install): stays unknown
        empty = sensor_mod.KiaAccessRetainedSensor(_FakeCoordinator("EV", "AU"), spec)

        async def _none():
            return None
        empty.async_get_last_sensor_data = _none
        empty.async_get_last_state = _none
        asyncio.run(empty.async_added_to_hass())
        assert empty.native_value is None
        assert empty.extra_state_attributes == {"last_reported": None, "retained": False}
    finally:
        del sensor_mod.KiaAccessSensor.async_added_to_hass
    print("-- tyre pressures: last reading kept while parked and restored after restart")


if __name__ == "__main__":
    test_gas_vehicle_gets_no_charging_buttons()
    test_ev_vehicle_gets_charging_buttons()
    test_phev_gets_charging_buttons()
    test_hev_gets_no_charging_buttons()
    test_unset_engine_type_defaults_to_ev_safe()
    test_gas_vehicle_gets_no_charge_limit_numbers()
    test_ev_vehicle_gets_charge_limit_numbers()
    test_phev_gets_charge_limit_numbers()
    test_hev_gets_no_charge_limit_numbers()
    test_region_specific_entities_start_disabled()
    test_region_limited_buttons_only_where_supported()
    test_numeric_booleans()
    test_capability_flags_hide_buttons()
    test_fuel_economy_unit_follows_the_car()
    test_tyre_pressure_kept_while_parked()
    print("all entity gating tests passed")
