"""KiaAccessCoordinator._async_charger_state_changed() -- the charger-agnostic
"Charging started"/"Charging stopped" alerts (kia_access_alert reasons
charger_charging_started/charger_charging_stopped) driven by an external
charger's own status entity (ChargePoint's binary_sensor.*_charging,
Emporia's status sensor, or any other HA integration's equivalent), not the
car-reported ev_battery_is_charging conditions.py already alerts on.

Same object.__new__()-plus-duck-typed-attributes approach as
test/coordinator_alerts_test.py.

Run: pip install homeassistant && python test/coordinator_charger_alert_test.py
"""
import os
import sys
import time
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

from homeassistant.util import dt as dt_util  # noqa: E402

from custom_components.kia_access.coordinator import KiaAccessCoordinator  # noqa: E402
from fake_ha import FakeConfig as _FakeConfig  # noqa: E402
from fake_ha import FakeStore as _FakeStore  # noqa: E402


class _FakeState:
    def __init__(self, state, last_changed=None):
        self.state = state
        self.attributes = {}
        self.last_changed = last_changed


class _FakeStates:
    def __init__(self, data=None):
        self._data = dict(data or {})

    def get(self, entity_id):
        return self._data.get(entity_id)

    def set(self, entity_id, state, last_changed=None):
        self._data[entity_id] = _FakeState(state, last_changed)

    def async_all(self, domain):
        return []


class _FakeBus:
    def __init__(self):
        self.fired = []

    def async_fire(self, event, data):
        self.fired.append((event, data))


class _FakeHass:
    def __init__(self, states=None):
        self.config = _FakeConfig()
        self.states = states or _FakeStates()
        self.bus = _FakeBus()


class _FakeEntry:
    def __init__(self, entry_id="e1", options=None, brand="KIA"):
        self.entry_id = entry_id
        self.options = options or {}
        self.data = {"brand": brand}


def make_coordinator(options=None, states=None, vehicle=None):
    c = object.__new__(KiaAccessCoordinator)
    c.entry = _FakeEntry(options=options or {})
    c.hass = _FakeHass(states=states)
    c.vehicle = vehicle or {"model": "EV9", "VIN": "KNDC1"}
    c._charger_session = None
    c._home_unplugged_since = None
    c._moved_since = None
    c._last_parked = None
    c._timers_store = _FakeStore({})
    c._sessions = []
    c._trips = []
    c._force_next_refresh = False

    # _async_charger_state_changed() now force-refreshes the vehicle poll
    # before building the alert (see its own docstring: self.vehicle can
    # otherwise be up to a scan_interval stale). Real DataUpdateCoordinator
    # machinery (debouncer, update_interval, ...) isn't set up on this
    # object.__new__()-built stub, so stand in with a no-op that just
    # records it was called -- these tests care that the vehicle dict
    # passed in is used as-is, not about exercising the real poll/debounce
    # plumbing (that's coordinator_stress_test.py's job).
    async def _noop_refresh():
        c.refresh_calls = getattr(c, "refresh_calls", 0) + 1

    c.async_request_refresh = _noop_refresh
    c.refresh_calls = 0
    return c


def _event(new_state):
    return types.SimpleNamespace(data={"new_state": new_state})


def _run(coro):
    import asyncio

    return asyncio.run(coro)


# ---- _charger_is_charging normalization ----

def test_charger_is_charging_normalizes_common_states():
    f = KiaAccessCoordinator._charger_is_charging
    assert f(_FakeState("on")) is True
    assert f(_FakeState("Charging")) is True
    assert f(_FakeState("off")) is False
    assert f(_FakeState("Not Charging")) is False
    assert f(_FakeState("plugged_in")) is False
    assert f(None) is None
    assert f(_FakeState("unavailable")) is None
    # ha-emporia-ev's real sensor.*_status ENUM values (STATUS_OPTIONS in its
    # const.py: "charging" / "plugged_in_idle" / "not_plugged_in" / "error") --
    # "charging" already matched above; these are the two real not-charging
    # values that must resolve to False, not silently fall through to
    # None/ignored (they don't match "idle" or "plugged_in" alone -- they're
    # each a single distinct underscore-joined token).
    assert f(_FakeState("plugged_in_idle")) is False
    assert f(_FakeState("not_plugged_in")) is False
    print("-- _charger_is_charging: normalizes on/off/Charging/Not Charging/ha-emporia-ev's status enum/unknown")


# ---- start alert ----

def test_charger_start_fires_alert_and_opens_session():
    states = _FakeStates({"sensor.charger_energy": _FakeState("2.5")})
    coord = make_coordinator(
        options={"charger_status_entity": "binary_sensor.charger", "charger_energy_entity": "sensor.charger_energy"},
        states=states,
        vehicle={
            "model": "EV9", "VIN": "KNDC1", "name": "MelodEV",
            "ev_battery_percentage": 68, "ev_charging_power": 9.3,
            "ev_estimated_current_charge_duration": 133,
        },
    )
    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    assert coord._charger_session is not None
    assert coord._charger_session["startEnergy"] == 2.5
    assert coord._timers_store._data["charger_session"] == coord._charger_session
    events = coord.hass.bus.fired
    assert len(events) == 1, events
    name, data = events[0]
    assert name == "kia_access_alert"
    assert data["reason"] == "charger_charging_started"
    assert data["active"] is True
    assert data["message"] == "Charging started"
    assert data["value"] == {
        "pct": 68.0, "kw": 9.3, "etaMin": 133.0, "vehicleName": "MelodEV",
    }
    # forces a fresh vehicle poll before reading pct/kw/etaMin, so the alert
    # never reports leftovers from up to a scan_interval-old cached reading
    assert coord.refresh_calls == 1
    assert coord._force_next_refresh is True
    print("-- charger status on with no open session: fires charger_charging_started (with pct/kw/eta/name), opens session")
    print("-- charger start: forces a live vehicle poll before building the alert, not stale cached data")


def test_charger_duplicate_on_does_not_refire():
    states = _FakeStates({"sensor.charger_energy": _FakeState("2.5")})
    coord = make_coordinator(
        options={"charger_status_entity": "binary_sensor.charger", "charger_energy_entity": "sensor.charger_energy"},
        states=states,
    )
    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    assert len(coord.hass.bus.fired) == 1
    print("-- a second 'on' with a session already open: no duplicate alert")


def test_charger_unknown_state_ignored():
    coord = make_coordinator(options={"charger_status_entity": "binary_sensor.charger"})
    _run(coord._async_charger_state_changed(_event(_FakeState("unavailable"))))
    assert coord._charger_session is None
    assert coord.hass.bus.fired == []
    print("-- unavailable/unrecognized state: ignored, no alert, no session opened")


# ---- stop alert: energy + cost ----

def test_charger_stop_reports_energy_and_cost():
    states = _FakeStates({"sensor.charger_energy": _FakeState("2.5")})
    coord = make_coordinator(
        options={
            "charger_status_entity": "binary_sensor.charger",
            "charger_energy_entity": "sensor.charger_energy",
            "price_per_kwh": 0.20,
            "currency": "GBP",
        },
        states=states,
    )
    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    states.set("sensor.charger_energy", "14.5")  # +12 kWh this session
    _run(coord._async_charger_state_changed(_event(_FakeState("off"))))

    assert coord._charger_session is None
    assert coord._timers_store._data["charger_session"] is None
    events = coord.hass.bus.fired
    assert len(events) == 2, events
    name, data = events[1]
    assert name == "kia_access_alert"
    assert data["reason"] == "charger_charging_stopped"
    assert data["active"] is False
    assert data["value"]["kwh"] == 12.0
    assert data["value"]["cost"] == 2.4  # 12 kWh * 0.20/kWh
    assert "12.0 kWh" in data["message"]
    assert "2.4 GBP" in data["message"]
    assert data["value"]["currency"] == "GBP"
    print("-- charger stop: 12 kWh delta priced at price_per_kwh, reported in the stop alert")


def test_charger_stop_prefers_away_rate_when_not_at_home():
    """No home_charge_zone/zone.home configured at all -> _charge_at_home()
    can't resolve (no GPS/zone data in this fake), so this exercises the
    "at_home is None -> home rate" branch, not the away rate -- away_price_per_kwh
    only applies once the car's own location is known to be outside home. This
    test pins that documented behavior so a future refactor can't silently
    start guessing 'away' just because the zone lookup came back empty."""
    states = _FakeStates({"sensor.charger_energy": _FakeState("0")})
    coord = make_coordinator(
        options={
            "charger_status_entity": "binary_sensor.charger",
            "charger_energy_entity": "sensor.charger_energy",
            "price_per_kwh": 0.20,
            "away_price_per_kwh": 0.45,
        },
        states=states,
    )
    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    states.set("sensor.charger_energy", "5")
    _run(coord._async_charger_state_changed(_event(_FakeState("off"))))
    data = coord.hass.bus.fired[1][1]
    assert data["value"]["cost"] == 1.0  # 5 kWh * home rate 0.20, not the away rate
    print("-- charger stop: unresolved at-home state falls back to the home rate, not away")


def test_charger_stop_without_energy_entity_reports_no_kwh():
    coord = make_coordinator(options={"charger_status_entity": "binary_sensor.charger"})
    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    _run(coord._async_charger_state_changed(_event(_FakeState("off"))))
    data = coord.hass.bus.fired[1][1]
    assert data["value"]["kwh"] is None
    assert data["value"]["cost"] is None
    assert data["message"] == "Charging stopped"
    print("-- charger stop with no charger_energy_entity configured: plain 'Charging stopped', no figures")


def test_charger_stop_includes_pct_duration_and_vehicle_name():
    states = _FakeStates({"sensor.charger_energy": _FakeState("0")})
    coord = make_coordinator(
        options={
            "charger_status_entity": "binary_sensor.charger",
            "charger_energy_entity": "sensor.charger_energy",
            "price_per_kwh": 0.20,
        },
        states=states,
        vehicle={"model": "EV9", "name": "MelodEV", "ev_battery_percentage": 100},
    )
    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    states.set("sensor.charger_energy", "12")
    _run(coord._async_charger_state_changed(_event(_FakeState("off"))))

    value = coord.hass.bus.fired[1][1]["value"]
    assert value["pct"] == 100.0
    assert value["vehicleName"] == "MelodEV"
    assert value["durationMin"] is not None and value["durationMin"] >= 0
    print("-- charger stop: pct/duration/vehicle name included")


def test_charger_stop_month_totals_are_calendar_month_not_rolling_30_days():
    """monthCost/monthMiles/costPerMile are since local midnight on the 1st
    of THIS calendar month -- a session/trip from one hour before the month
    started must be excluded even though it's well within any rolling
    30-day window (the ask this test pins: "this month" means the calendar
    month, not the last 30 days)."""
    start_of_month = dt_util.as_utc(
        dt_util.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    )
    start_ms = start_of_month.timestamp() * 1000
    this_month_ms = start_ms + 3600_000  # 1h into this month
    last_month_ms = start_ms - 3600_000  # 1h before this month started

    states = _FakeStates({"sensor.charger_energy": _FakeState("0")})
    coord = make_coordinator(
        options={"charger_status_entity": "binary_sensor.charger", "charger_energy_entity": "sensor.charger_energy"},
        states=states,
    )
    coord._sessions = [
        {"endedAt": this_month_ms, "cost": 10.0, "kwh": 50.0, "location": "home"},
        {"endedAt": last_month_ms, "cost": 999.0, "kwh": 999.0, "location": "home"},
    ]
    coord._trips = [
        {"endedAt": this_month_ms, "distanceKm": 100.0, "cost": 5.0},
        {"endedAt": last_month_ms, "distanceKm": 9999.0, "cost": 9999.0},
    ]

    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    states.set("sensor.charger_energy", "5")
    _run(coord._async_charger_state_changed(_event(_FakeState("off"))))

    value = coord.hass.bus.fired[1][1]["value"]
    # costPerMile = charging spend this month / miles driven this month --
    # the trip's own `cost` field (5.0, trip-attributed cost) is a separate
    # concept and must NOT be the numerator here.
    assert value["monthCost"] == 10.0, value
    assert value["monthMiles"] == round(100.0 * 0.621371, 1), value
    assert value["costPerMile"] == round(10.0 / round(100.0 * 0.621371, 1), 3), value
    print("-- charger stop: monthCost/monthMiles/costPerMile are calendar-month-to-date, excluding last month")


def test_charger_stop_with_negative_delta_ignored():
    """A charger's energy sensor resetting/rolling over between start and stop
    (a reboot, a lifetime-counter reset) must never report a negative or
    nonsensical kWh figure."""
    states = _FakeStates({"sensor.charger_energy": _FakeState("10")})
    coord = make_coordinator(
        options={"charger_status_entity": "binary_sensor.charger", "charger_energy_entity": "sensor.charger_energy",
                 "price_per_kwh": 0.20},
        states=states,
    )
    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    states.set("sensor.charger_energy", "3")  # went DOWN -- a reset, not real usage
    _run(coord._async_charger_state_changed(_event(_FakeState("off"))))
    data = coord.hass.bus.fired[1][1]
    assert data["value"]["kwh"] is None
    assert data["value"]["cost"] is None
    print("-- charger stop: an energy reading that decreased is treated as unknown, not a negative kWh")


ALL_TESTS = [
    test_charger_is_charging_normalizes_common_states,
    test_charger_start_fires_alert_and_opens_session,
    test_charger_duplicate_on_does_not_refire,
    test_charger_unknown_state_ignored,
    test_charger_stop_reports_energy_and_cost,
    test_charger_stop_prefers_away_rate_when_not_at_home,
    test_charger_stop_includes_pct_duration_and_vehicle_name,
    test_charger_stop_month_totals_are_calendar_month_not_rolling_30_days,
    test_charger_stop_without_energy_entity_reports_no_kwh,
    test_charger_stop_with_negative_delta_ignored,
]

if __name__ == "__main__":
    for t in ALL_TESTS:
        t()
    print(f"\nAll {len(ALL_TESTS)} coordinator_charger_alert_test checks passed.")
