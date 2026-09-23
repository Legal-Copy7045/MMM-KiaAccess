"""KiaAccessCoordinator concurrency stress tests -- the HA-side half of the
exhaustive failure-matrix exercise (see test/stress-node-helper.test.js for
the MagicMirror-side half). Drives the REAL KiaAccessCoordinator methods
(_async_update_data, async_run_command, _refresh_calendar_and_routes) --
not reimplementations of their locking -- against fake, in-memory
hass/Store/AccountPoller stand-ins, so a real race in the actual lock
usage would show up here.

A full KiaAccessCoordinator needs a live hass/DataUpdateCoordinator setup
(update loop, debouncer) that's overkill for exercising its OWN locking
logic. Instead this builds an instance via object.__new__() (skipping
DataUpdateCoordinator.__init__) and sets every attribute the methods under
test actually read/write, then calls those real bound methods directly --
same "call the real function against a duck-typed self" approach
test/coordinator_analytics_test.py already uses for the `analytics`
property, extended here to full async methods.

Run: pip install homeassistant && python test/coordinator_stress_test.py
"""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

from custom_components.kia_access import account_poll  # noqa: E402
from custom_components.kia_access import kia_client  # noqa: E402
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
        # a REAL thread-pool hop, not a synchronous passthrough -- a plain
        # `return fn(*args)` never actually yields control back to the event
        # loop while `fn` runs, which would make every concurrency assertion
        # in this file pass trivially (nothing can interleave with a
        # synchronous call) regardless of whether the coordinator's own
        # locks are doing anything at all. This is exactly the class of test
        # bug this session's own discipline (verify a fix's test actually
        # fails without the fix) caught here during a command-lock
        # break/restore check.
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, fn, *args)


class _FakeEntry:
    def __init__(self, entry_id, data, options=None):
        self.entry_id = entry_id
        self.data = data
        self.options = options or {}


def make_coordinator(entry, hass, poller):
    c = object.__new__(KiaAccessCoordinator)
    c.entry = entry
    c.hass = hass
    c.account_poller = poller
    c.vehicle = {}
    c.meta = {}
    c._prev_cond = {}
    c._announced = {}
    c._first_alert_run = True
    c._home_unplugged_since = None
    c._last_parked = None
    c._moved_since = None
    c._parked = None
    c._charger_session = None
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
    # DataUpdateCoordinator's own machinery -- stubbed rather than fully
    # initialized (that needs a real hass event loop / debouncer), since
    # none of the methods under test actually depend on ITS internals,
    # only on being callable.
    c.async_update_listeners = lambda: None
    c.last_update_success = True
    refresh_calls = []

    async def _fake_request_refresh():
        refresh_calls.append(time.monotonic())

    c.async_request_refresh = _fake_request_refresh
    c._refresh_calls = refresh_calls
    return c


def _v(vin, **extra):
    d = {"VIN": vin}
    d.update(extra)
    return d


def test_overlapping_updates_serialize():
    """1. Overlapping _async_update_data() on ONE coordinator -- _update_lock
    must force strictly sequential entry, never two updates' bodies actually
    running at once (which would race self.vehicle/_sessions/_trips writes)."""
    account_poll.kia_client.fetch = lambda job: {
        "ok": True, "vehicles": [_v("CAR1", ev_battery_percentage=50)], "meta": {}
    }
    poller = account_poll.AccountPoller(_FakeHass(), "acct-1")
    entry = _FakeEntry("e1", {"username": "u", "region": "USA", "brand": "KIA",
                               "password": "p", "vin": "CAR1"})
    coord = make_coordinator(entry, _FakeHass(), poller)

    concurrency = {"active": 0, "max_seen": 0}
    real_update_lock = coord._update_lock

    class _WatchedLock:
        """Wraps the real asyncio.Lock so we can observe how many callers
        are inside the locked section at once, without changing its
        actual locking behaviour at all."""
        async def __aenter__(self):
            await real_update_lock.acquire()
            concurrency["active"] += 1
            concurrency["max_seen"] = max(concurrency["max_seen"], concurrency["active"])
            return self

        async def __aexit__(self, *exc):
            concurrency["active"] -= 1
            real_update_lock.release()

    coord._update_lock = _WatchedLock()

    async def run_both():
        await asyncio.gather(coord._async_update_data(), coord._async_update_data())

    asyncio.run(run_both())
    assert concurrency["max_seen"] == 1, (
        "two overlapping _async_update_data() calls must never have both bodies "
        f"inside the _update_lock section at once -- saw {concurrency['max_seen']} concurrent"
    )
    assert coord.vehicle["VIN"] == "CAR1", "must still end with a valid, uncorrupted vehicle result"
    print("-- overlapping _async_update_data(): _update_lock serializes correctly")


def test_concurrent_commands_serialize():
    """2. Two concurrent commands -- _command_lock must serialize them, and
    last_action must reflect whichever command genuinely ran (and completed)
    LAST, not whichever async task happened to finish first in a race."""
    order = []
    concurrency = {"active": 0, "max_seen": 0}

    def _slow_command(job):
        concurrency["active"] += 1
        concurrency["max_seen"] = max(concurrency["max_seen"], concurrency["active"])
        # time.sleep(), not a busy `while` loop -- a tight CPU spin loop
        # holds the GIL almost continuously and starves the main thread's
        # asyncio event loop from actually scheduling the second gather()
        # task promptly, which made an earlier version of this test pass
        # even with _command_lock's `async with` swapped out entirely (no
        # real overlap ever got a chance to happen, lock or not). time.sleep
        # releases the GIL, letting real concurrency actually manifest here
        # if the lock isn't doing its job.
        time.sleep(0.02)
        order.append(job["command"])
        concurrency["active"] -= 1

    kia_client.run_command = _slow_command
    account_poll.kia_client.fetch = lambda job: {"ok": True, "vehicles": [_v("CAR1")], "meta": {}}
    poller = account_poll.AccountPoller(_FakeHass(), "acct-2")
    entry = _FakeEntry("e2", {"username": "u", "region": "USA", "brand": "KIA",
                               "password": "p", "vin": "CAR1"})
    coord = make_coordinator(entry, _FakeHass(), poller)

    async def run_both_commands():
        await asyncio.gather(
            coord.async_run_command("start_climate"),
            coord.async_run_command("stop_climate"),
        )

    asyncio.run(run_both_commands())
    assert concurrency["max_seen"] == 1, (
        "two concurrent async_run_command() calls must never both be inside "
        f"the command body at once -- saw {concurrency['max_seen']} concurrent"
    )
    assert order == ["start_climate", "stop_climate"], (
        "commands must run in the order they were issued (asyncio.gather starts "
        f"coroutines in argument order, and the lock must preserve that): {order}"
    )
    assert coord.last_action["name"] == "stop_climate", (
        "last_action must reflect the command that ACTUALLY ran last, not a race -- "
        f"got {coord.last_action}"
    )
    assert coord.last_action["status"] == "done"
    assert len(coord._refresh_calls) == 2, "each command must still request its own post-command refresh"
    print("-- two concurrent commands: _command_lock serializes, last_action reflects the true last command")


def test_overlapping_calendar_refresh_serializes():
    """3. Overlapping _refresh_calendar_and_routes() calls -- _calendar_lock
    must serialize them (this is the exact race coordinator.py's own comment
    on _refresh_calendar_and_routes describes: two callers -- the poll cycle
    and the separate 1-min calendar timer -- mutating self._cal_status
    across multiple awaits)."""
    concurrency = {"active": 0, "max_seen": 0}
    entry = _FakeEntry("e3", {"username": "u", "region": "USA", "brand": "KIA", "password": "p"})
    poller = account_poll.AccountPoller(_FakeHass(), "acct-3")
    coord = make_coordinator(entry, _FakeHass(), poller)

    calls = []

    async def _slow_refresh_pois():
        concurrency["active"] += 1
        concurrency["max_seen"] = max(concurrency["max_seen"], concurrency["active"])
        # mutate shared state across an await, exactly like the real
        # implementation does across its own geocoding/calendar awaits --
        # a genuine race would let the two calls' writes interleave
        coord._cal_status = {"marker": "A"}
        await asyncio.sleep(0.02)
        coord._cal_status["marker"] = "A-done"
        calls.append("pois")
        concurrency["active"] -= 1

    async def _slow_drive_times():
        await asyncio.sleep(0.01)
        calls.append("routes")

    coord.async_refresh_calendar_pois = _slow_refresh_pois
    coord._refresh_drive_times = _slow_drive_times

    async def run_both_refreshes():
        await asyncio.gather(
            coord._refresh_calendar_and_routes(),
            coord._refresh_calendar_and_routes(),
        )

    asyncio.run(run_both_refreshes())
    assert concurrency["max_seen"] == 1, (
        "two overlapping _refresh_calendar_and_routes() calls must never both be "
        f"inside the calendar-refresh body at once -- saw {concurrency['max_seen']} concurrent"
    )
    assert calls == ["pois", "routes", "pois", "routes"], (
        "the second call's pois+routes pair must not interleave with the first's: " + str(calls)
    )
    assert coord._cal_status["marker"] == "A-done", "the last write must be a complete, uncorrupted one"
    print("-- overlapping calendar/drive-time refreshes: _calendar_lock serializes correctly")


def test_command_and_update_dont_corrupt_each_other():
    """4. A command running concurrently with a full update -- different
    locks, by design (a control command shouldn't have to wait behind a slow
    poll cycle) -- must not deadlock and must not corrupt either's own
    state."""
    account_poll.kia_client.fetch = lambda job: {
        "ok": True, "vehicles": [_v("CAR1", ev_battery_percentage=61)], "meta": {}
    }
    kia_client.run_command = lambda job: None
    poller = account_poll.AccountPoller(_FakeHass(), "acct-4")
    entry = _FakeEntry("e4", {"username": "u", "region": "USA", "brand": "KIA",
                               "password": "p", "vin": "CAR1"})
    coord = make_coordinator(entry, _FakeHass(), poller)

    async def run_command_and_update():
        await asyncio.gather(
            coord.async_run_command("start_climate"),
            coord._async_update_data(),
        )

    asyncio.run(asyncio.wait_for(run_command_and_update(), timeout=5))
    assert coord.last_action["name"] == "start_climate"
    assert coord.last_action["status"] == "done"
    assert coord.vehicle["VIN"] == "CAR1", "the concurrent update must still complete cleanly"
    print("-- command + concurrent update: independent locks, no deadlock, no state corruption")


def test_multi_vehicle_shared_account_no_cross_bleed():
    """5. Multiple vehicles on ONE shared account (AccountPoller), updated
    concurrently -- each coordinator must end up with its OWN vehicle, no
    cross-vehicle bleed, even though both share the exact same underlying
    fetch. Also covers "config removal during an active fetch": coordinator
    B's poller refcount is dropped (as __init__.py's async_unload_entry
    would do) WHILE coordinator A's update is still in-flight on the SAME
    shared poller -- A's own update must be unaffected."""
    fetch_calls = {"n": 0}

    def _slow_multi_fetch(job):
        fetch_calls["n"] += 1
        # a real kia_client.fetch() is a blocking call made via
        # async_add_executor_job -- simulate it taking real wall-clock time
        # so both coordinators' updates are genuinely in flight together
        time.sleep(0.03)
        return {
            "ok": True,
            "vehicles": [_v("CAR_A", ev_battery_percentage=40), _v("CAR_B", ev_battery_percentage=70)],
            "meta": {},
        }

    account_poll.kia_client.fetch = _slow_multi_fetch
    shared_poller = account_poll.AccountPoller(_FakeHass(), "acct-5")
    shared_poller.refcount = 2

    entry_a = _FakeEntry("ea", {"username": "u", "region": "USA", "brand": "KIA",
                                 "password": "p", "vin": "CAR_A"})
    entry_b = _FakeEntry("eb", {"username": "u", "region": "USA", "brand": "KIA",
                                 "password": "p", "vin": "CAR_B"})
    coord_a = make_coordinator(entry_a, _FakeHass(), shared_poller)
    coord_b = make_coordinator(entry_b, _FakeHass(), shared_poller)

    async def run_both_accounts():
        # start A's update, let it get into the shared fetch, then simulate
        # B's config entry being removed (refcount decremented) while A's
        # fetch is still in flight -- A must still complete correctly
        task_a = asyncio.create_task(coord_a._async_update_data())
        await asyncio.sleep(0.005)  # let A acquire the poller's lock first
        shared_poller.refcount -= 1  # "B's entry was just removed"
        task_b = asyncio.create_task(coord_b._async_update_data())
        await asyncio.gather(task_a, task_b)

    asyncio.run(run_both_accounts())
    assert coord_a.vehicle["VIN"] == "CAR_A", (
        f"coordinator A must end up with its OWN vehicle, not B's: {coord_a.vehicle}"
    )
    assert coord_b.vehicle["VIN"] == "CAR_B", (
        f"coordinator B must end up with its OWN vehicle, not A's: {coord_b.vehicle}"
    )
    # AccountPoller's own dedup window (10s) means B's update (starting
    # shortly after A's) should reuse A's in-flight/just-finished fetch
    # rather than triggering an entirely separate one
    assert fetch_calls["n"] == 1, (
        "B's update landing well inside the dedup window of A's real fetch must "
        f"reuse it, not trigger a second real account-level fetch -- got {fetch_calls['n']} calls"
    )
    assert shared_poller.refcount == 1, "B's simulated removal must not be undone by anything here"
    print("-- two vehicles sharing one account, concurrent updates + a mid-flight config removal: no cross-bleed")


test_overlapping_updates_serialize()
test_concurrent_commands_serialize()
test_overlapping_calendar_refresh_serializes()
test_command_and_update_dont_corrupt_each_other()
test_multi_vehicle_shared_account_no_cross_bleed()

print("all coordinator stress tests passed")
