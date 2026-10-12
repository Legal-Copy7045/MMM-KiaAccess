"""Wake-up gating (quiet hours + wake_interval_min) and the one-shot quick
retry after a failed poll.

With "poll the car directly" on, a scheduled poll wakes the car only
outside quiet hours and once the car's own last report is older than
wake_interval_min; otherwise it reads Kia's cache. A manual "Refresh now"
always wakes it. The first failed poll after a success retries in 60s,
later ones in the same outage wait the normal scan_interval.

Run: pip install homeassistant && python test/coordinator_wake_test.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
from coordinator_stale_test import (  # noqa: E402
    _FakeEntry,
    _FakeHass,
    _iso,
    _v,
    make_coordinator,
)

from homeassistant.helpers.update_coordinator import UpdateFailed  # noqa: E402
from homeassistant.util import dt as dt_util  # noqa: E402

from custom_components.kia_access import account_poll  # noqa: E402
from custom_components.kia_access import coordinator as coord_mod  # noqa: E402

_DATA = {"username": "u", "region": "USA", "brand": "KIA", "password": "p", "vin": "CAR1"}


def _coord(options, reported_minutes_ago=None):
    poller = account_poll.AccountPoller(_FakeHass(), "acct-wake")
    c = make_coordinator(_FakeEntry("w", dict(_DATA), options=options), _FakeHass(), poller)
    if reported_minutes_ago is not None:
        c.vehicle = _v("CAR1", last_updated_at=_iso(
            dt_util.utcnow() - timedelta(minutes=reported_minutes_ago)))
    return c


def _at_hour(hour):
    fake_now = datetime(2026, 10, 12, hour, 30, tzinfo=dt_util.DEFAULT_TIME_ZONE)
    return mock.patch.object(coord_mod.dt_util, "now", return_value=fake_now)


def test_default_is_unchanged():
    c = _coord({"poll_car_directly": True}, reported_minutes_ago=1)
    assert c._job()["refresh"] is True, "no interval / quiet hours set: every poll wakes, as before"
    c = _coord({"poll_car_directly": False}, reported_minutes_ago=600)
    assert c._job()["refresh"] is False, "polling directly off: never wakes"
    print("-- defaults: behaviour exactly as before the options existed")


def test_quiet_hours_overnight():
    opts = {"poll_car_directly": True, "quiet_hours_start": 22, "quiet_hours_end": 7}
    for hour, wakes in ((21, True), (22, False), (23, False), (0, False),
                        (6, False), (7, True), (12, True)):
        with _at_hour(hour):
            job = _coord(opts)._job()
        assert job["refresh"] is wakes, (hour, job["refresh"])
        if not wakes:
            assert job["forceRefreshTimeout"] == 0, "a quiet-hours poll must not wait for a wake"
    print("-- quiet hours 22-7 wrap midnight; end hour is exclusive")


def test_quiet_hours_daytime_and_off():
    opts = {"poll_car_directly": True, "quiet_hours_start": 9, "quiet_hours_end": 17}
    for hour, wakes in ((8, True), (9, False), (16, False), (17, True)):
        with _at_hour(hour):
            assert _coord(opts)._job()["refresh"] is wakes, hour
    opts = {"poll_car_directly": True, "quiet_hours_start": 5, "quiet_hours_end": 5}
    with _at_hour(5):
        assert _coord(opts)._job()["refresh"] is True, "start == end means no quiet hours"
    print("-- same-day quiet hours; start == end turns them off")


def test_manual_refresh_ignores_quiet_hours_and_interval():
    opts = {"poll_car_directly": False, "quiet_hours_start": 22,
            "quiet_hours_end": 7, "wake_interval_min": 1440}
    with _at_hour(2):
        c = _coord(opts, reported_minutes_ago=1)
        c._force_next_refresh = True
        job = c._job()
    assert job["refresh"] is True and job["forceRefreshTimeout"] > 0
    print("-- Refresh now always wakes the car")


def test_wake_interval_uses_cars_own_report():
    opts = {"poll_car_directly": True, "wake_interval_min": 60}
    assert _coord(opts, reported_minutes_ago=20)._job()["refresh"] is False
    assert _coord(opts, reported_minutes_ago=61)._job()["refresh"] is True
    assert _coord(opts)._job()["refresh"] is True, "no report yet: allowed to wake"
    print("-- wake_interval_min: skipped while the car's own report is newer")


def test_quick_retry_once_per_outage():
    calls = {"n": 0}

    def flaky(job):
        calls["n"] += 1
        if calls["n"] in (2, 3, 5):
            raise RuntimeError("Kia 503")
        return {"ok": True, "vehicles": [_v("CAR1", last_updated_at=_iso(dt_util.utcnow()))],
                "meta": {}}

    account_poll.kia_client.fetch = flaky
    c = _coord({})
    retries = []
    for i in range(5):
        # each poll its own account fetch, not the dedup cache
        c.account_poller = account_poll.AccountPoller(_FakeHass(), f"acct-retry-{i}")
        try:
            asyncio.run(c._async_update_data())
            retries.append("ok")
        except UpdateFailed as err:
            retries.append(err.retry_after)
    assert retries == ["ok", 60, None, "ok", 60], retries
    print("-- first failure after a success retries in 60s, the next waits the normal interval")


def test_unanswered_wake_still_spaced():
    """A wake the car never answers leaves its own report old -- the
    interval must still hold, going by our last attempt."""
    c = _coord({"poll_car_directly": True, "wake_interval_min": 240}, reported_minutes_ago=600)
    assert c._job()["refresh"] is True
    c._last_wake_at = dt_util.utcnow() - timedelta(minutes=30)
    assert c._job()["refresh"] is False, "30 min after an unanswered wake: no new wake"
    c._last_wake_at = dt_util.utcnow() - timedelta(minutes=241)
    assert c._job()["refresh"] is True
    print("-- wake interval holds even when the car never answered")


def test_quick_retry_reads_cache():
    def failing(job):
        raise RuntimeError("force refresh timed out")

    account_poll.kia_client.fetch = failing
    c = _coord({"poll_car_directly": True}, reported_minutes_ago=600)
    c.account_poller = account_poll.AccountPoller(_FakeHass(), "acct-retry-cache")
    try:
        asyncio.run(c._async_update_data())
    except UpdateFailed as err:
        assert err.retry_after == 60
    assert c._last_wake_at is not None, "the failed poll did try to wake"
    job = c._job()
    assert job["refresh"] is False, "the 60s retry must read the cache, not wake again"
    assert c._job()["refresh"] is True, "...and only that one retry"
    print("-- the quick retry after a failed wake reads the cache")


def test_command_leaves_refresh_flag():
    c = _coord({"poll_car_directly": False})
    c._force_next_refresh = True
    assert c._job(command="lock", options={})["refresh"] is False
    assert c._force_next_refresh is True, "a command must not eat a queued Refresh now"
    assert c._job()["refresh"] is True
    print("-- a command doesn't consume a queued Refresh now")


def test_12v_history_feeds_drain_check():
    """HA records one 12V sample per new car report, and the drain check
    sees it -- it used to get an empty history and could never fire."""
    from custom_components.kia_access.conditions import evaluate
    from custom_components.kia_access.vehicle_state import build_state

    c = _coord({})
    now = dt_util.utcnow()
    for hours_ago, pct in ((10, 90), (10, 90), (5, 85), (1, 80)):
        c.vehicle = _v("CAR1", car_battery_percentage=pct, last_updated_at=_iso(
            now - timedelta(hours=hours_ago)))
        c._record_12v()
    assert [h["v12"] for h in c._v12_history] == [90, 85, 80], "unchanged report not re-recorded"
    state = build_state({"vehicle.car_battery_percentage": 80}, {"history": c._v12_history})
    res = evaluate(state, {}, {})
    drain = next(x for x in res["conditions"] if x["reason"] == "battery_12v_drain")
    assert drain["active"] is True, drain
    print("-- 12V history recorded per car report; the drain check can fire")


if __name__ == "__main__":
    test_default_is_unchanged()
    test_quiet_hours_overnight()
    test_quiet_hours_daytime_and_off()
    test_manual_refresh_ignores_quiet_hours_and_interval()
    test_wake_interval_uses_cars_own_report()
    test_quick_retry_once_per_outage()
    test_unanswered_wake_still_spaced()
    test_quick_retry_reads_cache()
    test_command_leaves_refresh_flag()
    test_12v_history_feeds_drain_check()
    print("all coordinator wake/retry tests passed")
