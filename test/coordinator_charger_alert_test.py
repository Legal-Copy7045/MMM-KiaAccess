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

from custom_components.kia_access import coordinator as coordinator_mod  # noqa: E402
from custom_components.kia_access.coordinator import KiaAccessCoordinator  # noqa: E402
from fake_ha import FakeConfig as _FakeConfig  # noqa: E402
from fake_ha import FakeStore as _FakeStore  # noqa: E402

# _async_charger_state_changed() sleeps CHARGER_START_SETTLE_SECONDS before
# building the start alert (see the constant's own docstring) -- zeroed here
# so these tests run in milliseconds, not 90 real seconds per start-alert
# check. It's read from the module namespace at call time, so patching the
# module attribute (not the KiaAccessCoordinator class) is what takes effect.
coordinator_mod.CHARGER_START_SETTLE_SECONDS = 0


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
    assert coord._charger_session["lastEnergyReading"] == 2.5
    assert coord._charger_session["accumulatedKwh"] == 0.0
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


def test_charger_start_settle_delay_skips_alert_if_session_changed_during_sleep():
    """If the session closes (or closes and reopens) while the start
    alert's settle delay is still asleep, the delayed alert must recognize
    its own session token is stale and skip firing -- otherwise it would
    report numbers for a session that's already someone else's, e.g. a
    very short false start racing a real stop."""
    import asyncio

    coordinator_mod.CHARGER_START_SETTLE_SECONDS = 0.05
    try:
        coord = make_coordinator(options={"charger_status_entity": "binary_sensor.charger"})

        async def _race():
            start_task = asyncio.ensure_future(
                coord._async_charger_state_changed(_event(_FakeState("on")))
            )
            await asyncio.sleep(0.01)  # let the start branch open the session, then sleep
            await coord._async_charger_state_changed(_event(_FakeState("plugged_in_idle")))
            await start_task

        asyncio.run(_race())

        reasons = [data["reason"] for _, data in coord.hass.bus.fired]
        assert reasons == ["charger_charging_stopped"], reasons
        assert coord._charger_session is None
    finally:
        coordinator_mod.CHARGER_START_SETTLE_SECONDS = 0
    print("-- charger start settle delay: a session that closes while the delayed start alert is asleep skips it, instead of firing stale numbers")


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


def test_charger_stop_zero_away_rate_falls_back_to_home_not_free():
    """away_price_per_kwh's own documented meaning (strings.json): "0 =
    fall back to the home rate". An explicit 0 must not price an away
    session at $0/kWh instead."""
    zone_state = _FakeState("zoning")
    zone_state.attributes = {"latitude": 10.0, "longitude": 10.0, "radius": 100}
    states = _FakeStates({
        "sensor.charger_energy": _FakeState("0"),
        "zone.home": zone_state,
    })
    coord = make_coordinator(
        options={
            "charger_status_entity": "binary_sensor.charger",
            "charger_energy_entity": "sensor.charger_energy",
            "price_per_kwh": 0.185,
            "away_price_per_kwh": 0,  # explicit 0 -- documented as "use home rate"
            "home_charge_zone": "zone.home",
        },
        states=states,
        vehicle={"location_latitude": 50.0, "location_longitude": 50.0},  # far from home
    )
    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    states.set("sensor.charger_energy", "10")
    _run(coord._async_charger_state_changed(_event(_FakeState("off"))))
    data = coord.hass.bus.fired[1][1]
    assert data["value"]["rateLabel"] == "home", data
    assert data["value"]["cost"] == round(10 * 0.185, 2), data
    print("-- charger stop: away_price_per_kwh=0 falls back to the home rate, not a free away session")


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
    assert value["chargingStoppedAt"] is not None
    print("-- charger stop: pct/duration/vehicle name/chargingStoppedAt included")


def test_charger_power_entity_refines_stop_duration_and_finish_time():
    """charger_power_entity is purely a passive data source: it must never
    open/close a session or fire an alert on its own -- that would risk
    exactly the flip-flop a brief post-finish power blip could otherwise
    cause. It only refines the SINGLE stop alert's duration/finish time to
    when power was actually last flowing, for chargers (ha-emporia-ev
    observed) whose status entity keeps reporting "charging" well past the
    real finish, until a scheduled session end."""
    states = _FakeStates({"sensor.charger_power": _FakeState("0")})
    coord = make_coordinator(
        options={"charger_status_entity": "binary_sensor.charger", "charger_power_entity": "sensor.charger_power"},
        states=states,
    )
    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    started_at = coord._charger_session["startedAt"]

    fired_after_start = len(coord.hass.bus.fired)
    _run(coord._async_charger_power_changed(_event(_FakeState("7200"))))  # real charging power
    real_stop_at = coord._charger_session["lastActivePowerAt"]
    # idle/BMS-balancing draw below the active threshold must NOT push the
    # "last active" timestamp later, and must not fire anything on its own
    _run(coord._async_charger_power_changed(_event(_FakeState("5"))))
    assert coord._charger_session["lastActivePowerAt"] == real_stop_at
    assert len(coord.hass.bus.fired) == fired_after_start

    # the status entity itself only flips off much later (e.g. a scheduled
    # session end), same as the real ha-emporia-ev report this is modeled on
    _run(coord._async_charger_state_changed(_event(_FakeState("plugged_in_idle"))))

    value = coord.hass.bus.fired[1][1]["value"]
    expected_min = (real_stop_at - started_at) / 60000
    assert abs(value["durationMin"] - expected_min) < 0.01, value
    assert value["chargingStoppedAt"] is not None
    print("-- charger power entity: stop alert's duration/finish time reflect the last real power reading, not the status entity's own later end time")


def test_charger_power_changed_ignored_with_no_open_session_or_below_threshold():
    coord = make_coordinator(options={"charger_status_entity": "binary_sensor.charger"})
    # no open session yet -- must be a quiet no-op, not an error
    _run(coord._async_charger_power_changed(_event(_FakeState("7200"))))
    assert coord._charger_session is None

    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))
    _run(coord._async_charger_power_changed(_event(_FakeState("10"))))  # below threshold
    assert "lastActivePowerAt" not in coord._charger_session
    assert len(coord.hass.bus.fired) == 1  # only the start alert -- power tracking fired nothing
    print("-- charger power entity: no-op with no open session, and a below-threshold reading doesn't count as active")


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
    """A single decrease with no prior real increase this session (a reboot,
    a lifetime-counter reset right at start) must never report a negative
    kWh -- it contributes nothing (not subtracted), leaving the session
    with zero accumulated energy, reported as kwh: null rather than 0 or a
    negative number."""
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
    print("-- charger stop: a lone decrease (no real usage yet) reports null kWh, not negative")


def test_charger_energy_survives_a_mid_session_counter_reset():
    """The real bug this pins: ha-emporia-ev's "Energy Today" resets at
    local midnight, unrelated to the charging session's own start/stop. An
    overnight session spanning that reset must sum the pre-reset and
    post-reset usage, not just (reading-at-stop minus reading-at-start) --
    that naive snapshot silently subtracts away the whole pre-reset
    portion. Modeled on a real session: charging from 11pm, ~5kWh drawn
    before midnight, counter resets to 0, ~22.9kWh more drawn after --
    30.06kWh true total (matching what the charger's own dashboard showed
    live), not the ~17.9kWh (22.9 - 5) a snapshot delta would report."""
    states = _FakeStates({"sensor.charger_energy": _FakeState("40.0")})  # day's total so far, pre-session
    coord = make_coordinator(
        options={
            "charger_status_entity": "binary_sensor.charger",
            "charger_energy_entity": "sensor.charger_energy",
            "price_per_kwh": 0.185,
        },
        states=states,
    )
    _run(coord._async_charger_state_changed(_event(_FakeState("on"))))  # 11pm, seeds lastEnergyReading=40.0
    states.set("sensor.charger_energy", "45.0")  # 11:59pm -- +5 kWh before midnight
    _run(coord._async_charger_energy_changed(_event(_FakeState("45.0"))))
    states.set("sensor.charger_energy", "0.0")  # midnight reset -- must NOT be subtracted as -45
    _run(coord._async_charger_energy_changed(_event(_FakeState("0.0"))))
    states.set("sensor.charger_energy", "22.9")  # 2:15am -- +22.9 kWh since the reset
    _run(coord._async_charger_energy_changed(_event(_FakeState("22.9"))))
    _run(coord._async_charger_state_changed(_event(_FakeState("plugged_in_idle"))))  # e.g. 5:55am, scheduled end

    value = coord.hass.bus.fired[1][1]["value"]
    assert value["kwh"] == 27.9, value  # 5 (pre-midnight) + 22.9 (post-reset), not 22.9 - 40 or -17.1
    assert value["cost"] == round(27.9 * 0.185, 2), value
    print("-- charger energy: correctly sums usage across a mid-session counter reset (e.g. a daily-resetting sensor at midnight), instead of undercounting via a naive start/stop snapshot")


ALL_TESTS = [
    test_charger_is_charging_normalizes_common_states,
    test_charger_start_fires_alert_and_opens_session,
    test_charger_duplicate_on_does_not_refire,
    test_charger_start_settle_delay_skips_alert_if_session_changed_during_sleep,
    test_charger_unknown_state_ignored,
    test_charger_stop_reports_energy_and_cost,
    test_charger_stop_prefers_away_rate_when_not_at_home,
    test_charger_stop_zero_away_rate_falls_back_to_home_not_free,
    test_charger_stop_includes_pct_duration_and_vehicle_name,
    test_charger_power_entity_refines_stop_duration_and_finish_time,
    test_charger_power_changed_ignored_with_no_open_session_or_below_threshold,
    test_charger_stop_month_totals_are_calendar_month_not_rolling_30_days,
    test_charger_stop_without_energy_entity_reports_no_kwh,
    test_charger_stop_with_negative_delta_ignored,
    test_charger_energy_survives_a_mid_session_counter_reset,
]

if __name__ == "__main__":
    for t in ALL_TESTS:
        t()
    print(f"\nAll {len(ALL_TESTS)} coordinator_charger_alert_test checks passed.")
