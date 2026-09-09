"""Semantic vehicle conditions - Python port of core/conditions.js.

Kept deliberately line-for-line with the JS so the two stay in sync; the
fixtures/ corpus is run through both in CI (test/contract_test.py and
test/contract.test.js) to catch drift.

    evaluate(state, cfg, prev) -> {"conditions": [...], "meta": {"charging": ...}}

`state` is a buildState()-style dict, `cfg` is the notifications config, `prev`
is {reason: bool, "_charging": bool|None} from the previous tick.
"""
from __future__ import annotations

import math
import time

CORNER = {"FL": "Front-left", "FR": "Front-right", "RL": "Rear-left", "RR": "Rear-right"}
CORNERS = ["FL", "FR", "RL", "RR"]

CHECK_DEFAULTS = {
    "evBatteryLow": {"enabled": True, "level": "warning", "belowPct": 20, "clearPct": 25},
    "evBatteryCritical": {"enabled": True, "level": "critical", "belowPct": 8, "clearPct": 12},
    "battery12vLow": {"enabled": True, "level": "warning", "belowPct": 55, "clearPct": 60},
    "battery12vCritical": {"enabled": True, "level": "critical", "belowPct": 40, "clearPct": 45},
    "battery12vDrain": {"enabled": True, "level": "warning", "dropPct": 8, "overHours": 12},
    "vehicleFault": {"enabled": True, "level": "critical"},
    "otpExpiring": {"enabled": True, "level": "warning"},
    "unlocked": {"enabled": True, "level": "warning"},
    "doorOpen": {"enabled": True, "level": "warning"},
    "windowOpen": {"enabled": True, "level": "warning"},
    "hoodOpen": {"enabled": True, "level": "warning"},
    "liftgateOpen": {"enabled": True, "level": "warning"},
    "sunroofOpen": {"enabled": True, "level": "warning"},
    "tyrePressure": {"enabled": True, "level": "critical"},
    "chargeComplete": {"enabled": True, "level": "info", "targetPct": None},
    "chargeInterrupted": {"enabled": True, "level": "warning", "targetPct": None, "minGapPct": 3},
    "chargingStarted": {"enabled": True, "level": "info"},
    "serviceDue": {"enabled": True, "level": "warning", "belowKm": 800},
    "notPluggedInHome": {
        "enabled": True, "level": "warning", "graceMin": 20,
        "afterHour": None, "beforeHour": None,
    },
}

DEFAULTS = {"title": "Kia EV9", "quietWhileDriving": True, "checks": {}}


def _num(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _tri(v):
    if v is True:
        return True
    if v is False:
        return False
    return None


def _any_open(s, prefix):
    vals = [s.get(prefix + c) for c in CORNERS]
    if any(v is True for v in vals):
        return True
    if all(v is False for v in vals):
        return False
    return None


def _open_list(s, prefix):
    return [c for c in CORNERS if s.get(prefix + c) is True]


def _check_cfg(cfg, name):
    d = CHECK_DEFAULTS.get(name, {"enabled": True, "level": "warning"})
    u = (cfg.get("checks") or {}).get(name)
    if u is False:
        return {"enabled": False}
    if u is True or u is None:
        return dict(d)
    return {**d, **u}


def _now_ms():
    return time.time() * 1000.0


def evaluate(s, cfg, prev):
    s = s or {}
    cfg = {**DEFAULTS, **(cfg or {})}
    prev = prev or {}
    title = cfg.get("title") or DEFAULTS["title"]
    driving = cfg.get("quietWhileDriving") is not False and s.get("carOn") is True
    out = []

    def emit(reason, level, active, message, value=None, one_shot=False):
        out.append({
            "reason": reason,
            "level": level or "warning",
            "active": active,
            "oneShot": one_shot is True,
            "title": title,
            "message": message,
            "value": value or {},
        })

    # ---- battery thresholds (with hysteresis dead-band) ----
    def threshold(reason, cur, c, label):
        if not c.get("enabled"):
            return
        if cur is None:
            emit(reason, c.get("level"), None, f"{label} level unknown", {})
            return
        below = _num(c.get("belowPct"))
        clear = _num(c.get("clearPct")) if c.get("clearPct") is not None else below
        if below is None:
            active = None
        elif cur <= below:
            active = True
        elif cur >= clear:
            active = False
        else:
            active = prev.get(reason) is True
        emit(reason, c.get("level"), active, f"{label} low - {round(cur)}%",
             {"pct": cur, "threshold": below})

    threshold("ev_battery_low", _num(s.get("batteryPct")), _check_cfg(cfg, "evBatteryLow"), "EV battery")
    threshold("ev_battery_critical", _num(s.get("batteryPct")), _check_cfg(cfg, "evBatteryCritical"), "EV battery critically")
    threshold("battery_12v_low", _num(s.get("car12vPct")), _check_cfg(cfg, "battery12vLow"), "12V battery")
    threshold("battery_12v_critical", _num(s.get("car12vPct")), _check_cfg(cfg, "battery12vCritical"), "12V battery critically")

    # ---- vehicle fault lamps (brake fluid, 12V system, ABS, airbag, ...) ----
    c_fault = _check_cfg(cfg, "vehicleFault")
    if c_fault.get("enabled"):
        faults = s.get("faults") if isinstance(s.get("faults"), list) else None
        f_active = None if faults is None else (len(faults) > 0)
        emit("vehicle_fault", c_fault.get("level"), f_active,
             ("Warning light: " + ", ".join(faults)) if f_active else "No fault lights",
             {"faults": faults or []})

    # ---- 12V draining while parked ----
    c_vd = _check_cfg(cfg, "battery12vDrain")
    if c_vd.get("enabled"):
        parked = s.get("carOn") is not True and s.get("charging") is not True and s.get("plugged") is not True
        over_ms = (_num(c_vd.get("overHours")) or 12) * 3600e3
        drop = _num(c_vd.get("dropPct")) or 8
        recent = sorted(
            [h for h in (s.get("history") or [])
             if h and _num(h.get("v12")) is not None and _now_ms() - h["t"] <= over_ms],
            key=lambda h: h["t"],
        )
        delta = (_num(recent[0]["v12"]) - _num(recent[-1]["v12"])) if len(recent) >= 2 else None
        if not parked or delta is None:
            vd_active = False if prev.get("battery_12v_drain") is True else None
        elif delta >= drop:
            vd_active = True
        elif delta <= drop / 2:
            vd_active = False
        else:
            vd_active = prev.get("battery_12v_drain") is True
        emit("battery_12v_drain", c_vd.get("level"), vd_active,
             (f"12V battery down {round(delta)}% while parked" if delta is not None else "12V battery trend"),
             {"dropPct": round(delta) if delta is not None else None,
              "overHours": _num(c_vd.get("overHours")) or 12})

    # ---- OTP / refresh-token expiry warning ----
    c_o = _check_cfg(cfg, "otpExpiring")
    if c_o.get("enabled"):
        age = _num(s.get("tokenAgeDays"))
        life = _num(c_o.get("lifetimeDays")) if _num(c_o.get("lifetimeDays")) is not None else (_num(s.get("otpLifetimeDays")) or 30)
        warn = _num(c_o.get("warnDays")) if _num(c_o.get("warnDays")) is not None else (_num(s.get("otpWarnDays")) or 7)
        if age is None:
            emit("otp_expiring", c_o.get("level"), None, "OTP age unknown")
        else:
            remaining = max(0, math.ceil(life - age))
            emit("otp_expiring", c_o.get("level"), (life - age) <= warn,
                 (f"OTP enrolment expires in ~{remaining} day" + ("" if remaining == 1 else "s"))
                 if remaining > 0 else "OTP enrolment has likely expired - re-run enroll.py",
                 {"remainingDays": remaining, "ageDays": round(age)})

    # ---- unlocked ----
    c_u = _check_cfg(cfg, "unlocked")
    if c_u.get("enabled") and not driving:
        locked = s.get("locked")
        emit("unlocked", c_u.get("level"),
             _tri(True if locked is False else False if locked is True else None),
             "Vehicle is unlocked")

    # ---- open parts ----
    def open_bool(reason, c_key, message, raw):
        c = _check_cfg(cfg, c_key)
        if not c.get("enabled") or driving:
            return
        emit(reason, c.get("level"), _tri(raw), message)

    c_d = _check_cfg(cfg, "doorOpen")
    if c_d.get("enabled") and not driving:
        doors = _open_list(s, "door")
        emit("door_open", c_d.get("level"), _any_open(s, "door"),
             (f"{CORNER[doors[0]]} door is open" if len(doors) == 1
              else f"{len(doors)} doors are open" if len(doors) > 1 else "Doors closed"),
             {"corners": doors})

    c_w = _check_cfg(cfg, "windowOpen")
    if c_w.get("enabled") and not driving:
        wins = _open_list(s, "win")
        emit("window_open", c_w.get("level"), _any_open(s, "win"),
             (f"{CORNER[wins[0]]} window is open" if len(wins) == 1
              else f"{len(wins)} windows are open" if len(wins) > 1 else "Windows closed"),
             {"corners": wins})

    open_bool("hood_open", "hoodOpen", "Hood (frunk) is open", s.get("hood"))
    open_bool("liftgate_open", "liftgateOpen", "Liftgate is open", s.get("trunk"))
    open_bool("sunroof_open", "sunroofOpen", "Sunroof is open", s.get("sunroof"))

    # ---- tyre pressure ----
    c_t = _check_cfg(cfg, "tyrePressure")
    if c_t.get("enabled"):
        tyres = [c for c in CORNERS if s.get("tyre" + c) is True]
        if s.get("tyreAny") is True or tyres:
            t_active = True
        elif s.get("tyreAny") is False and all(s.get("tyre" + c) is not True for c in CORNERS):
            t_active = False
        else:
            t_active = None
        emit("tyre_pressure", c_t.get("level"), t_active,
             (("Low tyre pressure - " + ", ".join(CORNER[c] for c in tyres)) if tyres else "Tyre pressure warning")
             if t_active is True else "Tyre pressure OK",
             {"corners": tyres})

    # ---- charging complete / interrupted (one-shot events) ----
    was_charging = prev.get("_charging") is True
    stopped_now = was_charging and s.get("charging") is False
    soc = _num(s.get("batteryPct"))

    c_c = _check_cfg(cfg, "chargeComplete")
    if c_c.get("enabled"):
        target_c = _num(c_c.get("targetPct"))
        if target_c is None:
            target_c = _num(s.get("chargeLimitPct"))
        if target_c is None:
            target_c = 95
        complete = bool(stopped_now and soc is not None and soc >= target_c - 1)
        emit("charge_complete", c_c.get("level"), complete,
             "Charging complete" + (f" - {round(soc)}%" if soc is not None else ""),
             {"pct": soc, "target": target_c}, True)

    c_i = _check_cfg(cfg, "chargeInterrupted")
    if c_i.get("enabled"):
        target_i = _num(c_i.get("targetPct"))
        if target_i is None:
            target_i = _num(s.get("chargeLimitPct"))
        if target_i is None:
            target_i = 95
        gap = _num(c_i.get("minGapPct")) if c_i.get("minGapPct") is not None else 3
        interrupted = bool(stopped_now and s.get("plugged") is True and soc is not None and soc < target_i - gap)
        emit("charge_interrupted", c_i.get("level"), interrupted,
             "Charging stopped early" + (f" - {round(soc)}%" if soc is not None else ""),
             {"pct": soc, "target": target_i}, True)

    # ---- charging started (one-shot: reassurance it plugged in OK) ----
    c_cs = _check_cfg(cfg, "chargingStarted")
    if c_cs.get("enabled"):
        started_now = prev.get("_charging") is not True and s.get("charging") is True
        kw = _num(s.get("chargeKw"))
        emit("charging_started", c_cs.get("level"), bool(started_now),
             "Charging started" + (f" - {round(kw * 10) / 10} kW" if kw else ""),
             {"kw": kw, "pct": soc}, True)

    # ---- next service due ----
    c_sv = _check_cfg(cfg, "serviceDue")
    if c_sv.get("enabled"):
        sv_km = _num(s.get("serviceKm"))
        below_km = _num(c_sv.get("belowKm")) if c_sv.get("belowKm") is not None else 800
        due_active = None if sv_km is None else sv_km <= below_km
        dist = (
            None if sv_km is None
            else f"{round(sv_km)} km" if s.get("units") == "metric"
            else f"{round(sv_km * 0.621371)} mi"
        )
        emit("service_due", c_sv.get("level"), due_active,
             "Service not due" if due_active is not True
             else "Service overdue" if sv_km <= 0
             else f"Service due - {dist} to go",
             {"km": sv_km, "remaining": dist})

    # ---- home but not plugged in ----
    c_hp = _check_cfg(cfg, "notPluggedInHome")
    if c_hp.get("enabled") and not driving:
        grace = _num(c_hp.get("graceMin")) if c_hp.get("graceMin") is not None else 20
        home_min = _num(s.get("homeUnpluggedMin"))
        hr = time.localtime().tm_hour
        after = _num(c_hp.get("afterHour"))
        before = _num(c_hp.get("beforeHour"))
        in_window = (after is None or hr >= after) and (before is None or hr < before)
        if s.get("plugged") is True or s.get("atHome") is not True:
            hp_active = False
        elif home_min is not None and home_min >= grace and in_window:
            hp_active = True
        else:
            hp_active = prev.get("not_plugged_home") is True
        emit("not_plugged_home", c_hp.get("level"), hp_active,
             "Home and not plugged in", {"minutesHome": home_min})

    return {"conditions": out, "meta": {"charging": _tri(s.get("charging"))}}
