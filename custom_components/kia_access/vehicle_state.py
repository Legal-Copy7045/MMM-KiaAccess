"""Python port of core/state.js buildState().

Turns a flat map of `vehicle.*` values into the normalised dict consumed by
conditions.evaluate(). Kept line-for-line with the JS; the fixtures/ corpus is
run through both in CI.
"""
from __future__ import annotations

import time

_TRUE = {True, "true", "True", 1, "1"}
_FALSE = {False, "false", "False", 0, "0"}


def _bool(f, key):
    v = f.get("vehicle." + key)
    if v in _TRUE:
        return True
    if v in _FALSE:
        return False
    return None


def _num(f, key):
    raw = f.get("vehicle." + key)
    if raw is None or raw == "":
        return None
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    return v if v == v and v not in (float("inf"), float("-inf")) else None


def _any_true(f, *keys):
    vals = [_bool(f, k) for k in keys]
    if any(v is True for v in vals):
        return True
    if all(v is False for v in vals):
        return False
    return None


def build_state(flat, opts=None):
    f = flat or {}
    opts = opts or {}

    hs = f.get("vehicle.headlamp_status")
    headlights = _any_true(f, "headlamp_left_low", "headlamp_right_low",
                           "headlamp_left_high", "headlamp_right_high")
    if headlights is None and isinstance(hs, str):
        t = hs.strip().lower()
        headlights = bool(t and t not in ("off", "none", "0"))

    def climate():
        if _bool(f, "air_control_is_on") is not True:
            return None
        set_t = _num(f, "air_temperature")
        out_t = _num(f, "outside_temperature")
        if set_t is not None and out_t is not None:
            if set_t - out_t >= 1:
                return "heat"
            if out_t - set_t >= 1:
                return "cool"
        return "on"

    def charge_limit():
        ac = _num(f, "ev_charge_limits_ac")
        dc = _num(f, "ev_charge_limits_dc")
        vals = [v for v in (ac, dc) if v is not None and v > 0]
        return max(vals) if vals else None

    def token_age_days():
        ts = f.get("_meta.tokenEnrolledAt")
        if not ts:
            return None
        try:
            import datetime
            dt = datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            ms = time.time() * 1000 - dt.timestamp() * 1000
        except Exception:
            return None
        return ms / 864e5 if ms >= 0 else None

    return {
        "batteryPct": _num(f, "ev_battery_percentage"),
        "rangeKm": _num(f, "ev_driving_range"),
        "chargeKw": _num(f, "ev_charging_power"),
        "charging": _bool(f, "ev_battery_is_charging"),
        "plugged": _bool(f, "ev_battery_is_plugged_in"),
        "v2l": _bool(f, "ev_v2l_status"),
        "v2x": _bool(f, "ev_v2x_status"),
        "locked": _bool(f, "is_locked"),
        "carOn": _any_true(f, "engine_is_running", "accessory_on", "ign3", "remote_ignition"),
        "headlights": headlights,
        "doorFL": _bool(f, "front_left_door_is_open"),
        "doorFR": _bool(f, "front_right_door_is_open"),
        "doorRL": _bool(f, "back_left_door_is_open"),
        "doorRR": _bool(f, "back_right_door_is_open"),
        "winFL": _bool(f, "front_left_window_is_open"),
        "winFR": _bool(f, "front_right_window_is_open"),
        "winRL": _bool(f, "back_left_window_is_open"),
        "winRR": _bool(f, "back_right_window_is_open"),
        "hood": _bool(f, "hood_is_open"),
        "trunk": _bool(f, "trunk_is_open"),
        "sunroof": _bool(f, "sunroof_is_open"),
        "defrost": _bool(f, "defrost_is_on"),
        "rearHeat": _bool(f, "back_window_heater_is_on"),
        "mirrorHeat": _bool(f, "side_mirror_heater_is_on"),
        "steerHeat": _bool(f, "steering_wheel_heater_is_on"),
        "climate": climate(),
        "tyreAny": _bool(f, "tire_pressure_all_warning_is_on"),
        "tyreFL": _bool(f, "tire_pressure_front_left_warning_is_on"),
        "tyreFR": _bool(f, "tire_pressure_front_right_warning_is_on"),
        "tyreRL": _bool(f, "tire_pressure_rear_left_warning_is_on"),
        "tyreRR": _bool(f, "tire_pressure_rear_right_warning_is_on"),
        "car12vPct": _num(f, "car_battery_percentage"),
        "chargeLimitPct": charge_limit(),
        "capacityKwh": _num(f, "ev_battery_capacity"),
        "history": opts.get("history") or [],
        "tokenAgeDays": token_age_days(),
        "otpLifetimeDays": opts.get("otpLifetimeDays"),
        "otpWarnDays": opts.get("otpWarnDays"),
    }
