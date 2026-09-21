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


class _AuthenticationError(Exception):
    pass


class _AuthenticationOTPRequired(_AuthenticationError):
    pass  # a subclass in the real library too


class _FakeToken:
    @staticmethod
    def from_dict(raw):
        return raw


# "refresh": what update_all_vehicles_with_cached_state() does -- None (ok),
# "auth" (the library's _retry_on_auth_error wrapper's
# AuthenticationError("Re-login failed: ..."), raised AFTER connect()
# already succeeded), "otp", or "other" (a non-auth failure).
_CONTROL = {"fail": False, "calls": 0, "refresh": None, "refresh_calls": 0}


class _FakeVehicleManager:
    def __init__(self, **kw):
        self.token = None
        self._kw = kw

    def check_and_refresh_token(self):
        _CONTROL["calls"] += 1
        if _CONTROL["fail"]:
            raise Exception("simulated: 'int' object has no attribute 'get'")

    def update_all_vehicles_with_cached_state(self):
        _CONTROL["refresh_calls"] += 1
        mode = _CONTROL["refresh"]
        if mode == "auth":
            raise _AuthenticationError(
                "Re-login failed: 'int' object has no attribute 'get'"
            )
        if mode == "otp":
            raise _AuthenticationOTPRequired("OTP required to refresh token")
        if mode == "other":
            raise ValueError("simulated non-auth failure (timeout, bad payload)")


_fake_pkg.VehicleManager = _FakeVehicleManager
_token_mod = types.ModuleType("hyundai_kia_connect_api.Token")
_token_mod.Token = _FakeToken
_exceptions_mod = types.ModuleType("hyundai_kia_connect_api.exceptions")
_exceptions_mod.AuthenticationOTPRequired = _AuthenticationOTPRequired
_exceptions_mod.AuthenticationError = _AuthenticationError
sys.modules["hyundai_kia_connect_api"] = _fake_pkg
sys.modules["hyundai_kia_connect_api.Token"] = _token_mod
sys.modules["hyundai_kia_connect_api.exceptions"] = _exceptions_mod

import kia_client as K  # noqa: E402

JOB = {"region": "USA", "brand": "KIA", "username": "u@e.com", "password": "pw", "token": {}}


def _reset(tmpdir):
    _CONTROL["fail"] = False
    _CONTROL["calls"] = 0
    _CONTROL["refresh"] = None
    _CONTROL["refresh_calls"] = 0
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

    # once the cooldown expires, connect() tries again -- and it succeeds.
    # A successful connect() alone must NOT clear the failure history: it
    # only proves the LOCAL token was usable, not that the server will
    # accept the very next request (see the post-connect scenarios below).
    _NOW["t"] += K.AUTH_COOLDOWN_BASE_MIN * 60 + 1
    _CONTROL["fail"] = False
    vm, _ = K.connect(JOB)  # must succeed, no exception
    assert _CONTROL["calls"] == K.AUTH_FAILURE_THRESHOLD + 1

    state_file = K._auth_state_file(JOB)
    assert K._load_auth_state(state_file) != {}, (
        "connect() success alone must not wipe the failure history -- the "
        "server can still reject the first real API call"
    )
    # ...it clears only once a real API call has ALSO gone through
    K._refresh_cached_state(vm, JOB)
    assert K._load_auth_state(state_file) == {}, (
        "a successful state refresh must clear the auth-state file"
    )


# ---- the failure mode from the upstream issue (Hyundai-Kia-Connect/
# hyundai_kia_connect_api#1313): connect() succeeds (the local token is
# fine), then the library's own _retry_on_auth_error wrapper re-logs-in
# inside update_all_vehicles_with_cached_state() and that raises
# AuthenticationError("Re-login failed: ..."). That used to bypass the
# breaker entirely (only check_and_refresh_token() was guarded), and even a
# counted failure would have been wiped by the next poll's successful
# connect(). Every poll re-attempted the failing login on the normal
# schedule -- the pattern that got an account locked out. ----
def _poll_via_fetch():
    return K.fetch(dict(JOB, refresh=False))


with tempfile.TemporaryDirectory() as tmpdir:
    _reset(tmpdir)
    _CONTROL["refresh"] = "auth"

    for i in range(K.AUTH_FAILURE_THRESHOLD - 1):
        try:
            _poll_via_fetch()
            raise AssertionError("fetch() should have raised")
        except K.ClientError as e:
            raise AssertionError(f"a sub-threshold failure must re-raise the original error: {e}")
        except _AuthenticationError as e:
            assert "Re-login failed" in str(e)
        _NOW["t"] += 5

    try:
        _poll_via_fetch()
        raise AssertionError("fetch() should have raised")
    except K.ClientError as e:
        assert "cooling down" in str(e).lower(), e
    assert _CONTROL["refresh_calls"] == K.AUTH_FAILURE_THRESHOLD

    # cooling down: the next poll must not touch Kia at all -- neither the
    # token check nor the API call
    calls_before, refresh_before = _CONTROL["calls"], _CONTROL["refresh_calls"]
    _NOW["t"] += 60
    try:
        _poll_via_fetch()
        raise AssertionError("fetch() should have refused during the cooldown")
    except K.ClientError as e:
        assert "cooling down" in str(e).lower()
    assert (_CONTROL["calls"], _CONTROL["refresh_calls"]) == (calls_before, refresh_before), (
        "no traffic of any kind may reach Kia while cooling down"
    )

# run_command() shares the same guarded refresh
with tempfile.TemporaryDirectory() as tmpdir:
    _reset(tmpdir)
    _CONTROL["refresh"] = "auth"
    for i in range(K.AUTH_FAILURE_THRESHOLD):
        try:
            K.run_command(dict(JOB, command="lock"))
            raise AssertionError("run_command() should have raised")
        except K.ClientError as e:
            assert i == K.AUTH_FAILURE_THRESHOLD - 1 and "cooling down" in str(e).lower(), (i, e)
        except _AuthenticationError:
            assert i < K.AUTH_FAILURE_THRESHOLD - 1
        _NOW["t"] += 5

# an OTP-required response is NOT a rejected login: it maps to OtpRequired
# (same as connect()) and is not counted toward the breaker
with tempfile.TemporaryDirectory() as tmpdir:
    _reset(tmpdir)
    _CONTROL["refresh"] = "otp"
    for i in range(K.AUTH_FAILURE_THRESHOLD + 1):
        try:
            _poll_via_fetch()
            raise AssertionError("fetch() should have raised")
        except K.OtpRequired:
            pass
    assert K._load_auth_state(K._auth_state_file(JOB)) == {}, "OTP-required must not count as an auth failure"

# a non-auth failure (timeout, bad payload, ...) propagates untouched and is
# not counted -- the breaker is for rejected logins, not every hiccup
with tempfile.TemporaryDirectory() as tmpdir:
    _reset(tmpdir)
    _CONTROL["refresh"] = "other"
    for i in range(K.AUTH_FAILURE_THRESHOLD + 1):
        try:
            _poll_via_fetch()
            raise AssertionError("fetch() should have raised")
        except ValueError:
            pass
    assert K._load_auth_state(K._auth_state_file(JOB)) == {}

# a cooldown that has already EXPIRED leaves a stale cooldownUntil in the
# state file. The first (sub-threshold) failure afterward must re-raise the
# raw error like any other sub-threshold failure -- not be mistaken for a
# fresh cooldown ("cooling down for ~-29 min").
with tempfile.TemporaryDirectory() as tmpdir:
    _reset(tmpdir)
    _CONTROL["fail"] = True
    for i in range(K.AUTH_FAILURE_THRESHOLD):
        try:
            K.connect(JOB)
        except Exception:
            pass
        _NOW["t"] += 5
    _NOW["t"] += K.AUTH_COOLDOWN_BASE_MIN * 60 + K.AUTH_FAILURE_WINDOW_SEC + 1  # cooldown over
    try:
        K.connect(JOB)
        raise AssertionError("connect() should have raised")
    except K.ClientError as e:
        raise AssertionError(f"first failure after an expired cooldown was mistaken for a new cooldown: {e}")
    except Exception as e:
        assert "cooling down" not in str(e).lower()

print("all auth_cooldown tests passed")
