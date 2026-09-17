"""KiaAccessCoordinator._emit_alerts() split -- tests _build_alert_state(),
_track_parking() and _fire_condition_edges() independently (the architecture
audit's top complaint: parking-location tracking used to live inside the
alert emitter, so it could only run -- and only be tested -- as part of one
150-line method), plus the specific ordering-hazard fix the split made:
timer state (home-unplugged / moved-while-parked / last-parked) must be
persisted for the cycle even when condition evaluation itself raises, since
those timers are a genuinely independent piece of state from whether alert
firing succeeded.

Uses the same object.__new__()-plus-duck-typed-attributes approach as
test/coordinator_stress_test.py, trimmed to just what these three methods
read/write.

Run: pip install homeassistant && python test/coordinator_alerts_test.py
"""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

from custom_components.kia_access import coordinator as coordinator_mod  # noqa: E402
from custom_components.kia_access.coordinator import KiaAccessCoordinator  # noqa: E402


class _FakeStore:
    def __init__(self, initial=None):
        self._data = initial

    async def async_load(self):
        return self._data

    async def async_save(self, data):
        self._data = data


class _FakeConfig:
    from homeassistant.util.unit_system import IMPERIAL_SYSTEM
    units = IMPERIAL_SYSTEM


class _FakeStates:
    def get(self, entity_id):
        return None  # no zone.home configured -- keeps _at_home() a clean None

    def async_all(self, domain):
        return []


class _FakeHass:
    def __init__(self):
        self.config = _FakeConfig()
        self.states = _FakeStates()


class _FakeEntry:
    def __init__(self, entry_id="e1", options=None):
        self.entry_id = entry_id
        self.options = options or {}


def make_coordinator(vehicle, last_parked=None, entry=None):
    c = object.__new__(KiaAccessCoordinator)
    c.entry = entry or _FakeEntry()
    c.hass = _FakeHass()
    c.vehicle = vehicle
    c.meta = {}
    c._prev_cond = {}
    c._announced = {}
    c._first_alert_run = True
    c._home_unplugged_since = None
    c._last_parked = last_parked
    c._moved_since = None
    c._parked = None
    c._was_on = None
    c._awaiting_park_fix = False
    c._timers_store = _FakeStore({})
    return c


def test_build_alert_state_flags_moved_while_parked():
    """odometer unchanged, GPS shifted > 1000ft, car off -> movedWhileParked*
    populated and _moved_since gets set (was None)."""
    coord = make_coordinator(
        vehicle={
            "odometer": 100.0,
            "location_latitude": 10.01,
            "location_longitude": 10.0,
            "engine_is_running": False,
        },
        last_parked={"lat": 10.0, "lon": 10.0, "odo": 100.0},
    )
    cfg = {}
    state = coord._build_alert_state(cfg)
    assert coord._moved_since is not None, "moved-while-parked must start the timer"
    assert state["movedWhileParkedKm"] > 0.3, state
    assert state["movedWhileParkedMin"] is not None
    print("-- _build_alert_state: flags moved-while-parked and starts its timer")


def test_build_alert_state_no_move_when_parked_still():
    """Odometer unchanged, GPS basically unchanged -> no timer started."""
    coord = make_coordinator(
        vehicle={
            "odometer": 100.0,
            "location_latitude": 10.0,
            "location_longitude": 10.0,
            "engine_is_running": False,
        },
        last_parked={"lat": 10.0, "lon": 10.0, "odo": 100.0},
    )
    state = coord._build_alert_state({})
    assert coord._moved_since is None
    assert state["movedWhileParkedKm"] == 0
    print("-- _build_alert_state: parked and stationary stays quiet")


def test_track_parking_snapshots_on_drive_to_park_transition():
    coord = make_coordinator(vehicle={})
    coord._was_on = True
    coord._track_parking(False, 12.34, 56.78)
    assert coord._parked is not None
    assert coord._parked["lat"] == 12.34
    assert coord._parked["lon"] == 56.78
    assert coord._was_on is False
    print("-- _track_parking: snapshots on the drive->park transition")


def test_track_parking_waits_for_gps_fix_before_snapshotting():
    """Car parks with no GPS fix yet -- must not snapshot garbage, and must
    remember the transition is still pending until a fix arrives."""
    coord = make_coordinator(vehicle={})
    coord._was_on = True
    coord._track_parking(False, None, None)
    assert coord._parked is None
    assert coord._awaiting_park_fix is True

    # fix arrives on a later poll, car still off
    coord._track_parking(False, 1.0, 2.0)
    assert coord._parked is not None
    assert coord._parked["lat"] == 1.0
    assert coord._awaiting_park_fix is False
    print("-- _track_parking: defers the snapshot until a GPS fix actually arrives")


def test_fire_condition_edges_swallows_evaluation_failure():
    coord = make_coordinator(vehicle={})
    coordinator_mod.evaluate_conditions = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom"))
    try:
        coord._fire_condition_edges({}, {})  # must not raise
    finally:
        import importlib
        importlib.reload(coordinator_mod)
    print("-- _fire_condition_edges: a condition-evaluation failure is caught, not propagated")


def test_emit_alerts_persists_timers_even_when_condition_eval_fails():
    """The actual ordering-hazard regression: before the split, an
    evaluate_conditions() failure hit a `return` inside the same try/except
    that guarded persisting timers, so this cycle's timer state (already
    mutated on self) was silently never saved. This must now persist
    regardless of whether condition evaluation itself succeeded."""
    coord = make_coordinator(
        vehicle={
            "odometer": 100.0,
            "location_latitude": 10.01,
            "location_longitude": 10.0,
            "engine_is_running": False,
        },
        last_parked={"lat": 10.0, "lon": 10.0, "odo": 100.0},
    )
    coordinator_mod.evaluate_conditions = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom"))
    try:
        asyncio.run(coord._emit_alerts())
    finally:
        import importlib
        importlib.reload(coordinator_mod)

    assert coord._moved_since is not None, "the timer itself must still have started"
    saved = coord._timers_store._data
    assert saved.get("moved_since") == coord._moved_since, (
        "moved_since must be persisted to the timers store even though condition "
        f"evaluation raised -- store has {saved!r}"
    )
    print("-- _emit_alerts: timers persist for the cycle even when condition evaluation raises")


test_build_alert_state_flags_moved_while_parked()
test_build_alert_state_no_move_when_parked_still()
test_track_parking_snapshots_on_drive_to_park_transition()
test_track_parking_waits_for_gps_fix_before_snapshotting()
test_fire_condition_edges_swallows_evaluation_failure()
test_emit_alerts_persists_timers_even_when_condition_eval_fails()

print("all coordinator alerts tests passed")
