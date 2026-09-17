"""KiaAccessCoordinator stale/fresh data-model tests.

Kia's cloud can answer a poll successfully (200 OK) while just echoing back
the CAR's own last-reported reading unchanged, if the car itself hasn't
checked in for a while (asleep, poor signal). That is a distinct condition
from a poll that actually FAILS -- HA already reflects a failed poll by
marking every entity unavailable (CoordinatorEntity.available reads
last_update_success). This file drives the real _async_update_data()
against fake account_poll/kia_client stand-ins (same approach as
test/coordinator_stress_test.py) to cover the failure/freshness matrix:

  Kia responds (fresh)          -> not stale, data current
  Kia responds (car's own data
    is old)                     -> stale, but still available (poll itself
                                    succeeded)
  Kia poll fails                -> UpdateFailed raised, previous vehicle
                                    data + last_successful_update preserved
                                    (not clobbered by the failed attempt)
  Kia poll recovers              -> fresh again, is_stale clears
  last_updated_at missing/bad   -> is_stale is None ("don't know"), not
                                    False ("definitely fresh")
  stale_after_minutes is per-
    entry configurable          -> same reported age, different verdict
  two vehicles                  -> independent coordinators, independent
                                    verdicts (no cross-bleed)

Run: pip install homeassistant && python test/coordinator_stale_test.py
"""
import asyncio
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

from homeassistant.helpers.update_coordinator import UpdateFailed  # noqa: E402
from homeassistant.util import dt as dt_util  # noqa: E402

from custom_components.kia_access import account_poll  # noqa: E402
from custom_components.kia_access.const import DEFAULT_CLIMATE_PREFS  # noqa: E402
from custom_components.kia_access.coordinator import KiaAccessCoordinator  # noqa: E402
from fake_ha import FakeConfig as _FakeConfig  # noqa: E402
from fake_ha import FakeStates as _FakeStates  # noqa: E402
from fake_ha import FakeStore as _FakeStore  # noqa: E402


class _FakeBus:
    def __init__(self):
        self.fired = []

    def async_fire(self, event, data):
        self.fired.append((event, data))


class _FakeConfigEntries:
    def async_update_entry(self, entry, **kwargs):
        pass


class _FakeHass:
    def __init__(self):
        self.config = _FakeConfig()
        self.states = _FakeStates()
        self.bus = _FakeBus()
        self.config_entries = _FakeConfigEntries()

    async def async_add_executor_job(self, fn, *args):
        # a real thread-pool hop, not a synchronous passthrough -- see
        # test/coordinator_stress_test.py's identical comment for why.
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, fn, *args)


class _FakeEntry:
    def __init__(self, entry_id, data, options=None):
        self.entry_id = entry_id
        self.data = data
        self.options = options or {}


def make_coordinator(entry, hass, poller):
    """Same "build via object.__new__(), set every attribute the methods
    under test read/write" approach as test/coordinator_stress_test.py --
    duplicated here (not imported from there) so this file doesn't trigger
    that file's own module-level test execution as an import side effect."""
    c = object.__new__(KiaAccessCoordinator)
    c.entry = entry
    c.hass = hass
    c.account_poller = poller
    c.vehicle = {}
    c.meta = {}
    c.last_successful_update = None
    c._prev_cond = {}
    c._announced = {}
    c._first_alert_run = True
    c._home_unplugged_since = None
    c._last_parked = None
    c._moved_since = None
    c._parked = None
    c._was_on = None
    c._awaiting_park_fix = False
    c._calendar_lock = asyncio.Lock()
    c._update_lock = asyncio.Lock()
    c._command_lock = asyncio.Lock()
    c._timers_store = _FakeStore({})
    c._geo_cache = {}
    c._geo_store = _FakeStore({"geo": {}})
    c._cal_pois = []
    c._static_pois = []
    c._cal_status = {}
    c._cal_store = _FakeStore({})
    c._route_out = {}
    c._route_at = 0.0
    c._route_origin = None
    c._route_status = {}
    c._sessions = []
    c._open_session = None
    c._ext_pending = None
    c._sessions_store = _FakeStore({})
    c._trips = []
    c._open_trip = None
    c._trips_store = _FakeStore({})
    c._prefs_store = _FakeStore({})
    c.climate_prefs = dict(DEFAULT_CLIMATE_PREFS)
    c.last_action = {"name": None, "status": "idle", "at": None}
    c._unconfirmed_commands = {}
    c._force_next_refresh = False
    c.async_update_listeners = lambda: None
    c.last_update_success = True

    async def _fake_request_refresh():
        pass

    c.async_request_refresh = _fake_request_refresh
    return c


def _v(vin, **extra):
    d = {"VIN": vin}
    d.update(extra)
    return d


def _iso(dt):
    return dt.isoformat()


def test_fresh_after_success():
    """Kia responds, the car reported a moment ago -> current, not stale."""
    now_iso = _iso(dt_util.utcnow())
    account_poll.kia_client.fetch = lambda job: {
        "ok": True,
        "vehicles": [_v("CAR1", ev_battery_percentage=78, last_updated_at=now_iso)],
        "meta": {},
    }
    poller = account_poll.AccountPoller(_FakeHass(), "acct-stale-1")
    entry = _FakeEntry("e1", {"username": "u", "region": "USA", "brand": "KIA",
                               "password": "p", "vin": "CAR1"}, options={})
    coord = make_coordinator(entry, _FakeHass(), poller)

    asyncio.run(coord._async_update_data())

    assert coord.vehicle["ev_battery_percentage"] == 78
    assert coord.is_stale is False, "a just-reported reading must not be stale"
    assert coord.data_age_seconds is not None and coord.data_age_seconds < 5
    assert coord.last_successful_update is not None
    print("-- Kia responds with a fresh reading: current, not stale")


def test_stale_when_car_hasnt_reported():
    """Kia's poll succeeds, but the CAR's own last_updated_at is well past
    the default stale_after_minutes (60) -- the poll itself is fine (no
    exception, no UpdateFailed), only the underlying reading is old."""
    old_iso = _iso(dt_util.utcnow() - timedelta(minutes=90))
    account_poll.kia_client.fetch = lambda job: {
        "ok": True,
        "vehicles": [_v("CAR1", ev_battery_percentage=78, last_updated_at=old_iso)],
        "meta": {},
    }
    poller = account_poll.AccountPoller(_FakeHass(), "acct-stale-2")
    entry = _FakeEntry("e2", {"username": "u", "region": "USA", "brand": "KIA",
                               "password": "p", "vin": "CAR1"}, options={})
    coord = make_coordinator(entry, _FakeHass(), poller)

    asyncio.run(coord._async_update_data())

    assert coord.is_stale is True, "a 90-minute-old reading must be stale under the 60-minute default"
    assert coord.data_age_seconds > 89 * 60
    assert coord.last_successful_update is not None, "the POLL still succeeded -- only the reading is old"
    print("-- Kia poll succeeds but the car's own reading is old: stale, poll still counted as successful")


def test_failed_poll_preserves_previous_data():
    """A failed poll must raise UpdateFailed AND must not clobber the
    vehicle data / last_successful_update timestamp from the last real
    success -- that's what lets HA (and this coordinator's own is_stale)
    keep serving the previous known-good reading instead of going blank."""
    fresh_iso = _iso(dt_util.utcnow())
    account_poll.kia_client.fetch = lambda job: {
        "ok": True,
        "vehicles": [_v("CAR1", ev_battery_percentage=55, last_updated_at=fresh_iso)],
        "meta": {},
    }
    poller = account_poll.AccountPoller(_FakeHass(), "acct-stale-3")
    entry = _FakeEntry("e3", {"username": "u", "region": "USA", "brand": "KIA",
                               "password": "p", "vin": "CAR1"}, options={})
    coord = make_coordinator(entry, _FakeHass(), poller)

    asyncio.run(coord._async_update_data())
    good_vehicle = dict(coord.vehicle)
    good_update_time = coord.last_successful_update
    assert good_vehicle["ev_battery_percentage"] == 55

    # now Kia's cloud stops answering entirely
    def _boom(job):
        raise TimeoutError("Kia cloud did not respond")
    account_poll.kia_client.fetch = _boom
    # bypass the dedup cache so the failure actually reaches kia_client.fetch
    poller._last_payload = None
    poller._last_error = None

    raised = False
    try:
        asyncio.run(coord._async_update_data())
    except UpdateFailed:
        raised = True
    assert raised, "a failed poll must raise UpdateFailed (this is what makes HA mark entities unavailable)"
    assert coord.vehicle == good_vehicle, "the previous successful vehicle data must survive a failed poll unchanged"
    assert coord.last_successful_update == good_update_time, (
        "last_successful_update must NOT be bumped by a failed attempt"
    )
    print("-- failed poll: UpdateFailed raised, previous data + last_successful_update preserved")


def test_recovers_after_failure():
    """After a failure, a subsequent successful poll must clear staleness
    and move last_successful_update forward again."""
    old_iso = _iso(dt_util.utcnow() - timedelta(minutes=90))
    account_poll.kia_client.fetch = lambda job: {
        "ok": True,
        "vehicles": [_v("CAR1", ev_battery_percentage=40, last_updated_at=old_iso)],
        "meta": {},
    }
    poller = account_poll.AccountPoller(_FakeHass(), "acct-stale-4")
    entry = _FakeEntry("e4", {"username": "u", "region": "USA", "brand": "KIA",
                               "password": "p", "vin": "CAR1"}, options={})
    coord = make_coordinator(entry, _FakeHass(), poller)
    asyncio.run(coord._async_update_data())
    assert coord.is_stale is True
    stale_update_time = coord.last_successful_update

    fresh_iso = _iso(dt_util.utcnow())
    account_poll.kia_client.fetch = lambda job: {
        "ok": True,
        "vehicles": [_v("CAR1", ev_battery_percentage=41, last_updated_at=fresh_iso)],
        "meta": {},
    }
    poller._last_payload = None
    poller._last_error = None
    asyncio.run(coord._async_update_data())

    assert coord.is_stale is False, "a fresh poll must clear staleness"
    assert coord.last_successful_update > stale_update_time
    print("-- Kia comes back with a fresh reading: staleness clears, last_successful_update advances")


def test_missing_last_updated_at_is_unknown_not_fresh():
    """No last_updated_at at all -> is_stale must be None ('don't know'),
    never False ('definitely fresh') -- a degraded API response shouldn't
    quietly read as guaranteed-current."""
    account_poll.kia_client.fetch = lambda job: {
        "ok": True, "vehicles": [_v("CAR1", ev_battery_percentage=60)], "meta": {},
    }
    poller = account_poll.AccountPoller(_FakeHass(), "acct-stale-5")
    entry = _FakeEntry("e5", {"username": "u", "region": "USA", "brand": "KIA",
                               "password": "p", "vin": "CAR1"}, options={})
    coord = make_coordinator(entry, _FakeHass(), poller)

    asyncio.run(coord._async_update_data())

    assert coord.is_stale is None, "missing last_updated_at must be 'unknown', not 'fresh'"
    assert coord.data_age_seconds is None
    assert coord.last_successful_update is not None, "the poll itself still succeeded"
    print("-- missing last_updated_at: is_stale is None (unknown), not falsely fresh")


def test_stale_after_minutes_is_configurable():
    """Same 10-minute-old reading reads differently depending on this
    entry's own stale_after_minutes option."""
    ten_min_ago = _iso(dt_util.utcnow() - timedelta(minutes=10))
    account_poll.kia_client.fetch = lambda job: {
        "ok": True,
        "vehicles": [_v("CAR1", last_updated_at=ten_min_ago)],
        "meta": {},
    }

    poller_a = account_poll.AccountPoller(_FakeHass(), "acct-stale-6a")
    entry_default = _FakeEntry("e6a", {"username": "u", "region": "USA", "brand": "KIA",
                                        "password": "p", "vin": "CAR1"}, options={})
    coord_default = make_coordinator(entry_default, _FakeHass(), poller_a)
    asyncio.run(coord_default._async_update_data())
    assert coord_default.is_stale is False, "10 min old must not be stale under the 60-min default"

    poller_b = account_poll.AccountPoller(_FakeHass(), "acct-stale-6b")
    entry_tight = _FakeEntry("e6b", {"username": "u", "region": "USA", "brand": "KIA",
                                      "password": "p", "vin": "CAR1"},
                              options={"stale_after_minutes": 5})
    coord_tight = make_coordinator(entry_tight, _FakeHass(), poller_b)
    asyncio.run(coord_tight._async_update_data())
    assert coord_tight.is_stale is True, "the same 10-min-old reading must be stale under a 5-min threshold"
    print("-- stale_after_minutes is per-entry configurable")


def test_two_vehicles_independent_staleness():
    """Vehicle A's fetch/failure must never affect vehicle B's staleness --
    each coordinator is its own instance with its own state."""
    fresh_iso = _iso(dt_util.utcnow())
    old_iso = _iso(dt_util.utcnow() - timedelta(minutes=90))

    def _fetch_both(job):
        return {
            "ok": True,
            "vehicles": [
                _v("CARA", last_updated_at=fresh_iso),
                _v("CARB", last_updated_at=old_iso),
            ],
            "meta": {},
        }

    account_poll.kia_client.fetch = _fetch_both
    poller = account_poll.AccountPoller(_FakeHass(), "acct-stale-7")  # SAME account, shared poller
    entry_a = _FakeEntry("e7a", {"username": "u", "region": "USA", "brand": "KIA",
                                  "password": "p", "vin": "CARA"}, options={})
    entry_b = _FakeEntry("e7b", {"username": "u", "region": "USA", "brand": "KIA",
                                  "password": "p", "vin": "CARB"}, options={})
    coord_a = make_coordinator(entry_a, _FakeHass(), poller)
    coord_b = make_coordinator(entry_b, _FakeHass(), poller)

    asyncio.run(coord_a._async_update_data())
    asyncio.run(coord_b._async_update_data())

    assert coord_a.vehicle["VIN"] == "CARA" and coord_a.is_stale is False
    assert coord_b.vehicle["VIN"] == "CARB" and coord_b.is_stale is True
    print("-- two vehicles sharing an account: independent staleness, no cross-bleed")


if __name__ == "__main__":
    test_fresh_after_success()
    test_stale_when_car_hasnt_reported()
    test_failed_poll_preserves_previous_data()
    test_recovers_after_failure()
    test_missing_last_updated_at_is_unknown_not_fresh()
    test_stale_after_minutes_is_configurable()
    test_two_vehicles_independent_staleness()
    print("all coordinator stale-data tests passed")
