"""custom_components/kia_access/account_poll.py -- the shared-login
AccountPoller and select_own_vehicle().

Prompted by a real multi-vehicle account: before this, an N-vehicle HA
account meant N independent config entries each logging in and polling
Kia's account-level API on their own schedule -- roughly N times the
account-level API traffic a single-vehicle account generates for the exact
same data, real exposure to the same rate-limiting/lockout risk the
auth-failure circuit breaker (see test/auth_cooldown_test.py) exists to
contain. AccountPoller shares one login/fetch across every coordinator for
the same account; select_own_vehicle() is how each coordinator then picks
its own vehicle back out of that shared, all-vehicles result.

Run: python test/account_poll_test.py
"""
import asyncio
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# account_poll.py does `from . import kia_client` -- a relative import, so it
# must be imported as part of a package. Build a minimal fake package
# pointing straight at the real files on disk rather than requiring the
# full homeassistant install ha_import_check.py needs.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PKG_DIR = os.path.join(_HERE, "..", "custom_components", "kia_access")

_pkg = types.ModuleType("_kia_access_pkg_test")
_pkg.__path__ = [_PKG_DIR]
sys.modules["_kia_access_pkg_test"] = _pkg

import importlib  # noqa: E402

kia_client = importlib.import_module("_kia_access_pkg_test.kia_client")
sys.modules["_kia_access_pkg_test.kia_client"] = kia_client
account_poll = importlib.import_module("_kia_access_pkg_test.account_poll")

AccountPoller = account_poll.AccountPoller
select_own_vehicle = account_poll.select_own_vehicle


# --------------------------------------------------------------------------
# select_own_vehicle()
# --------------------------------------------------------------------------

def _v(vin):
    return {"VIN": vin}


# no VIN configured (single-vehicle account, the common case): the one
# vehicle returned is picked automatically
got = select_own_vehicle([_v("VIN1")], "")
assert got["VIN"] == "VIN1"

# no VIN configured, multiple vehicles: genuinely ambiguous -- must raise,
# not silently guess vehicle 0
try:
    select_own_vehicle([_v("VIN1"), _v("VIN2")], "")
    raise AssertionError("expected a ClientError for an unconfigured multi-vehicle account")
except kia_client.ClientError as err:
    assert "2 vehicles" in str(err) and "VIN" in str(err), str(err)

# no VIN configured, account returned 0 vehicles this poll
try:
    select_own_vehicle([], "")
    raise AssertionError("expected a ClientError for 0 vehicles")
except kia_client.ClientError as err:
    assert "no matching vehicles" in str(err)

# VIN configured and present (case/whitespace-insensitive): picked out
got = select_own_vehicle([_v("vin1"), _v("VIN2")], " Vin1 ")
assert got["VIN"] == "vin1"

# VIN configured but the account currently has other (different) vehicles --
# diagnostic message must name both the configured VIN and what was seen
try:
    select_own_vehicle([_v("VIN2"), _v("VIN3")], "VIN1")
    raise AssertionError("expected a ClientError for a VIN mismatch")
except kia_client.ClientError as err:
    msg = str(err)
    assert "VIN1" in msg and "VIN2" in msg and "VIN3" in msg, msg

# VIN configured, but this poll returned 0 vehicles at all -- distinct
# "transient gap" message, not "your VIN is wrong"
try:
    select_own_vehicle([], "VIN1")
    raise AssertionError("expected a ClientError for 0 vehicles with a configured VIN")
except kia_client.ClientError as err:
    assert "VIN1" in str(err) and "0 vehicles this poll" in str(err)

# VIN configured, account HAS vehicles this poll, but one has neither a VIN
# nor an id (a badly degraded API response) -- it must still show up in the
# "account currently has" list as an unidentified vehicle, not silently
# vanish and make the diagnostic undercount what was actually returned
try:
    select_own_vehicle([_v("VIN2"), {"VIN": None, "id": None}], "VIN1")
    raise AssertionError("expected a ClientError for a VIN mismatch")
except kia_client.ClientError as err:
    msg = str(err)
    assert "VIN2" in msg, msg
    assert "unidentified" in msg, (
        "a vehicle with neither VIN nor id must still be represented, not silently dropped: " + msg
    )
    assert "0 vehicles this poll" not in msg, (
        "the account DID return vehicles this poll -- must not claim otherwise " + msg
    )


# --------------------------------------------------------------------------
# AccountPoller: dedup window + refcount bookkeeping
# --------------------------------------------------------------------------

class _FakeHass:
    async def async_add_executor_job(self, fn, *args):
        return fn(*args)


_calls = {"n": 0}
_payloads = []


def _fake_fetch(job):
    _calls["n"] += 1
    # the poller must always force allVehicles + a blank vin, regardless of
    # what the calling coordinator's own job dict asked for
    assert job["allVehicles"] is True
    assert job["vin"] == ""
    return {"ok": True, "vehicles": [_v("VIN1")], "meta": {"call": _calls["n"]}}


account_poll.kia_client.fetch = _fake_fetch

poller = AccountPoller(_FakeHass(), "acct-hash")
assert poller.refcount == 0

job = {"vin": "VIN1", "allVehicles": False, "username": "u"}

r1 = asyncio.run(poller.async_fetch(job))
assert _calls["n"] == 1 and r1["meta"]["call"] == 1

# a second call right away must reuse the cached payload, not fetch again
r2 = asyncio.run(poller.async_fetch(job))
assert _calls["n"] == 1, "a call inside the dedup window must not re-fetch"
assert r2 is r1, "a dedup-window hit must return the exact cached payload"

# force the dedup window to have elapsed -- the NEXT call must fetch fresh
poller._last_fetched_at -= account_poll.DEDUP_WINDOW_SEC + 1
r3 = asyncio.run(poller.async_fetch(job))
assert _calls["n"] == 2 and r3["meta"]["call"] == 2, (
    "a call outside the dedup window must trigger a real fetch"
)

# a FAILED fetch must also be deduped within the same window -- a sibling
# coordinator's call while the account is broken must reuse that failure
# instead of independently retrying the same broken login, which is what
# actually accelerates tripping kia_client.py's own auth-failure cooldown
_fail_calls = {"n": 0}


def _fake_fetch_fails(job):
    _fail_calls["n"] += 1
    raise kia_client.ClientError(f"simulated auth failure #{_fail_calls['n']}")


account_poll.kia_client.fetch = _fake_fetch_fails
fail_poller = AccountPoller(_FakeHass(), "acct-hash-2")

try:
    asyncio.run(fail_poller.async_fetch(job))
    raise AssertionError("expected the simulated failure to propagate")
except kia_client.ClientError as err:
    assert "simulated auth failure #1" in str(err)
assert _fail_calls["n"] == 1

# a second call right away must re-raise the SAME cached failure, not
# attempt its own independent (also-failing) fetch
try:
    asyncio.run(fail_poller.async_fetch(job))
    raise AssertionError("expected the cached failure to be re-raised")
except kia_client.ClientError as err:
    assert "simulated auth failure #1" in str(err), (
        f"must re-raise the CACHED failure, not a fresh one: {err}"
    )
assert _fail_calls["n"] == 1, "a call inside the dedup window must not retry a failing fetch"

# outside the window, a fresh attempt is made (and can itself fail again,
# or succeed if whatever was broken has since cleared)
fail_poller._last_error_at -= account_poll.DEDUP_WINDOW_SEC + 1
try:
    asyncio.run(fail_poller.async_fetch(job))
    raise AssertionError("expected a fresh failure outside the dedup window")
except kia_client.ClientError as err:
    assert "simulated auth failure #2" in str(err)
assert _fail_calls["n"] == 2

# and a SUCCESS after a cached failure must clear that cached failure, not
# leave it lingering to wrongly short-circuit some later call
account_poll.kia_client.fetch = _fake_fetch
fail_poller._last_error_at -= account_poll.DEDUP_WINDOW_SEC + 1
ok_result = asyncio.run(fail_poller.async_fetch(job))
assert ok_result["ok"] is True
assert fail_poller._last_error is None, "a success must clear any previously cached failure"

# refcount is plain bookkeeping the caller (see __init__.py's
# async_setup_entry/async_unload_entry) owns -- exercise the same pattern
# here so a regression in either side shows up
poller.refcount += 1
poller.refcount += 1
assert poller.refcount == 2, "two coordinators sharing this account's poller"
poller.refcount -= 1
assert poller.refcount == 1, "unloading one entry must not drop the other's reference"
poller.refcount -= 1
assert poller.refcount == 0, "unloading the last entry must leave nothing referencing it"

print("account_poll_test: ok")
