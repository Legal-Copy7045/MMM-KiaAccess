"""kia_client.connect()'s auth-failure circuit breaker.

Prompted by a real incident: a broken re-login inside hyundai_kia_connect_api
(AuthenticationError: "Re-login failed: 'int' object has no attribute 'get'")
kept getting retried on HA's normal setup-retry schedule, and the account
got locked out of Kia Connect entirely. Nothing before this distinguished
"the API had a blip, retry soon is fine" from "authentication is repeatedly
and identically failing" -- both just retried at the same cadence, which is
exactly what turns a broken login into a lockout.

Run: python test/auth_cooldown_test.py
"""
import os
import sys
import tempfile
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# kia_client.connect() does `from hyundai_kia_connect_api import
# VehicleManager` etc. as LOCAL imports inside the function body -- stub the
# whole package in sys.modules before importing kia_client, same idea as
# ha_import_check.py's stand-in for the same package.
_fake_pkg = types.ModuleType("hyundai_kia_connect_api")


class _AuthenticationOTPRequired(Exception):
    pass


class _FakeToken:
    @staticmethod
    def from_dict(raw):
        return raw


_CONTROL = {"fail": False, "calls": 0}


class _FakeVehicleManager:
    def __init__(self, **kw):
        self.token = None
        self._kw = kw

    def check_and_refresh_token(self):
        _CONTROL["calls"] += 1
        if _CONTROL["fail"]:
            raise Exception("simulated: 'int' object has no attribute 'get'")


_fake_pkg.VehicleManager = _FakeVehicleManager
_token_mod = types.ModuleType("hyundai_kia_connect_api.Token")
_token_mod.Token = _FakeToken
_exceptions_mod = types.ModuleType("hyundai_kia_connect_api.exceptions")
_exceptions_mod.AuthenticationOTPRequired = _AuthenticationOTPRequired
sys.modules["hyundai_kia_connect_api"] = _fake_pkg
sys.modules["hyundai_kia_connect_api.Token"] = _token_mod
sys.modules["hyundai_kia_connect_api.exceptions"] = _exceptions_mod

import kia_client as K  # noqa: E402

JOB = {"region": "USA", "brand": "KIA", "username": "u@e.com", "password": "pw", "token": {}}


def _reset(tmpdir):
    _CONTROL["fail"] = False
    _CONTROL["calls"] = 0
    K._HERE = tmpdir  # redirect auth-state (and token) files into a scratch dir
    K.time.time = lambda: _NOW["t"]


_NOW = {"t": 1_000_000.0}


# ---- pure state-machine functions ----
s = {}
s = K._record_auth_failure(s, now=0)
assert s["consecutiveFailures"] == 1
s = K._record_auth_failure(s, now=10)
assert s["consecutiveFailures"] == 2
assert "cooldownUntil" not in s
s = K._record_auth_failure(s, now=20)
assert s["consecutiveFailures"] == 0, "the threshold-triggering failure resets the counter for the next window"
assert s.get("cooldownUntil") == 20 + K.AUTH_COOLDOWN_BASE_MIN * 60
assert K._cooldown_remaining_sec(s, now=20) > 0
assert K._cooldown_remaining_sec(s, now=s["cooldownUntil"] + 1) == 0

# a failure outside the window doesn't inherit the earlier count
s2 = {"consecutiveFailures": 2, "lastFailureAt": 0}
s2 = K._record_auth_failure(s2, now=K.AUTH_FAILURE_WINDOW_SEC + 100)
assert s2["consecutiveFailures"] == 1, "a failure long after the last one must not carry over the old streak"

# repeated cooldowns escalate (capped)
s3 = {"cooldownsTriggered": 1}
s3 = K._record_auth_failure(s3, now=0)
s3 = K._record_auth_failure(s3, now=1)
s3 = K._record_auth_failure(s3, now=2)
assert s3["cooldownUntil"] == 2 + K.AUTH_COOLDOWN_BASE_MIN * 2 * 60, "second cooldown must be longer than the first"

s4 = {"cooldownsTriggered": 20}  # way past any real escalation
s4 = K._record_auth_failure(s4, now=0)
s4 = K._record_auth_failure(s4, now=1)
s4 = K._record_auth_failure(s4, now=2)
assert s4["cooldownUntil"] == 2 + K.AUTH_COOLDOWN_MAX_MIN * 60, "escalation must cap, not grow forever"

# ---- connect() end to end, through the real auth-state file ----
with tempfile.TemporaryDirectory() as tmpdir:
    _reset(tmpdir)

    # a single failure must NOT trip the breaker -- connect() re-raises the
    # underlying exception as-is (not wrapped), and a normal retry schedule
    # is still fine below the threshold
    _CONTROL["fail"] = True
    for i in range(K.AUTH_FAILURE_THRESHOLD - 1):
        try:
            K.connect(JOB)
            raise AssertionError("connect() should have raised")
        except K.ClientError as e:
            raise AssertionError(f"must not wrap a sub-threshold failure as ClientError: {e}")
        except Exception as e:
            assert "cooling down" not in str(e).lower()
        _NOW["t"] += 5

    assert _CONTROL["calls"] == K.AUTH_FAILURE_THRESHOLD - 1, (
        "every sub-threshold attempt must actually call check_and_refresh_token()"
    )

    # the THRESHOLD-th consecutive failure trips the breaker
    try:
        K.connect(JOB)
        raise AssertionError("connect() should have raised")
    except K.ClientError as e:
        assert "cooling down" in str(e).lower()
    assert _CONTROL["calls"] == K.AUTH_FAILURE_THRESHOLD

    # while cooling down, connect() must refuse WITHOUT even attempting
    # check_and_refresh_token() again -- the whole point is zero further
    # traffic to Kia's servers during the window
    _NOW["t"] += 60  # still well inside the 30-min cooldown
    try:
        K.connect(JOB)
        raise AssertionError("connect() should have raised while cooling down")
    except K.ClientError as e:
        assert "cooling down" in str(e).lower()
    assert _CONTROL["calls"] == K.AUTH_FAILURE_THRESHOLD, (
        "a call during the cooldown window must not touch check_and_refresh_token() at all"
    )

    # once the cooldown expires, connect() tries again -- and a SUCCESS
    # clears the auth-state file entirely (proven by checking a fresh
    # failure streak afterward starts back at 1, not continuing the old count)
    _NOW["t"] += K.AUTH_COOLDOWN_BASE_MIN * 60 + 1
    _CONTROL["fail"] = False
    K.connect(JOB)  # must succeed, no exception
    assert _CONTROL["calls"] == K.AUTH_FAILURE_THRESHOLD + 1

    state_file = K._auth_state_file(JOB)
    assert K._load_auth_state(state_file) == {}, "a successful connect() must clear the auth-state file"

print("all auth_cooldown tests passed")
