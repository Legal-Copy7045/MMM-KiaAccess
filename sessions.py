"""Charge-session tracking - Python port of core/sessions.js.

Kept line-for-line with the JS; both are exercised in CI
(test/sessions.test.js / test/sessions_test.py).
"""
from __future__ import annotations

import time

DEFAULT_CAPACITY_KWH = 99.8  # Kia EV9 usable
GAP_MIN = 45
MIN_KWH = 0.3


def _num(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _round(n, dp=2):
    f = 10 ** dp
    return round(n * f) / f


def _tri(v):
    return v if v is True or v is False else None


def _rate_for(at_home, opts):
    """which per-kWh rate applies to a session, given where it charged"""
    home = _num(opts.get("pricePerKwh")) or 0
    away = _num(opts.get("awayPricePerKwh"))
    return away if (at_home is False and away is not None) else home


def update(open_s, cur, opts=None):
    """Fold one state sample into session tracking.

    open_s: dict | None   session in progress
    cur:    {"t", "charging", "plugged", "batteryPct", "chargeKw", "atHome"}
            atHome True/False/None(unknown) -> which rate the session is costed at
    opts:   {"pricePerKwh", "awayPricePerKwh", "capacityKwh", "minKwh", "gapMin"}
    -> {"open": dict|None, "closed": dict|None}
    """
    opts = opts or {}
    cap = _num(opts.get("capacityKwh")) or DEFAULT_CAPACITY_KWH
    min_kwh = _num(opts.get("minKwh"))
    if min_kwh is None:
        min_kwh = MIN_KWH
    gap_ms = (_num(opts.get("gapMin")) or GAP_MIN) * 60000

    t = _num(cur.get("t")) or (time.time() * 1000)
    pct = _num(cur.get("batteryPct"))
    kw = _num(cur.get("chargeKw"))
    charging = cur.get("charging") is True
    plugged = cur.get("plugged") is not False

    if charging and not open_s:
        return {
            "open": {
                "startedAt": t, "lastChargingAt": t,
                "startPct": pct, "lastPct": pct, "peakKw": kw or 0,
                "atHome": _tri(cur.get("atHome")),
            },
            "closed": None,
        }
    if not open_s:
        return {"open": None, "closed": None}

    if charging:
        open_s["lastChargingAt"] = t
        if open_s.get("atHome") is None and _tri(cur.get("atHome")) is not None:
            open_s["atHome"] = cur.get("atHome")
        if pct is not None:
            open_s["lastPct"] = pct
            if open_s.get("startPct") is None:
                open_s["startPct"] = pct
        if kw is not None and kw > open_s["peakKw"]:
            open_s["peakKw"] = kw
        return {"open": open_s, "closed": None}

    if (plugged and cur.get("plugged") is not False
            and t - (open_s.get("lastChargingAt") or open_s["startedAt"]) < gap_ms):
        if pct is not None:
            open_s["lastPct"] = pct
        return {"open": open_s, "closed": None}

    end_pct = pct if pct is not None else open_s.get("lastPct")
    start_pct = open_s.get("startPct")
    gained = max(0, end_pct - start_pct) if (start_pct is not None and end_pct is not None) else None
    kwh = (gained / 100) * cap if gained is not None else None
    mins = max(0, round((open_s.get("lastChargingAt", t) - open_s["startedAt"]) / 60000))
    rate = _rate_for(open_s.get("atHome"), opts)
    s = {
        "startedAt": open_s["startedAt"],
        "endedAt": open_s.get("lastChargingAt") or t,
        "minutes": mins,
        "startPct": start_pct,
        "endPct": end_pct,
        "gainedPct": _round(gained, 1) if gained is not None else None,
        "kwh": _round(kwh, 2) if kwh is not None else None,
        "cost": _round(kwh * rate, 2) if (kwh is not None and rate > 0) else None,
        "peakKw": _round(open_s["peakKw"], 1),
        "avgKw": _round(kwh / (mins / 60), 1) if (kwh is not None and mins > 0) else None,
        "pricePerKwh": rate or None,
        "location": "away" if open_s.get("atHome") is False else "home",
    }
    closed = s if (s["kwh"] is not None and s["kwh"] >= min_kwh) else None
    return {"open": None, "closed": closed}


def progress(open_s, cur, opts=None):
    """Live figures for the session in progress. None if no session."""
    if not open_s:
        return None
    opts = opts or {}
    cap = _num(opts.get("capacityKwh")) or DEFAULT_CAPACITY_KWH
    price = _rate_for(open_s.get("atHome"), opts)
    t = _num(cur.get("t")) or (time.time() * 1000)
    pct = _num(cur.get("batteryPct"))
    last_pct = pct if pct is not None else open_s.get("lastPct")
    start_pct = open_s.get("startPct")
    kwh_soc = (
        max(0, (last_pct - start_pct) / 100 * cap)
        if (start_pct is not None and last_pct is not None) else 0
    )
    kw = _num(cur.get("chargeKw"))
    if kw is None:
        kw = open_s.get("peakKw") or 0
    drift_ms = max(0, min(15 * 60000, t - (open_s.get("lastChargingAt") or open_s["startedAt"])))
    kwh = kwh_soc + (kw * (drift_ms / 3600000) if cur.get("charging") is True else 0)
    return {
        "kwh": _round(kwh, 2),
        "cost": _round(kwh * price, 2) if price > 0 else None,
        "gainedPct": (
            _round(last_pct - start_pct, 1)
            if (start_pct is not None and last_pct is not None) else None
        ),
        "minutes": max(0, round((t - open_s["startedAt"]) / 60000)),
    }


def summary(sessions, days=30):
    """totals over the last `days`, split home / away"""
    cutoff = (time.time() * 1000) - days * 864e5
    acc = {k: {"count": 0, "kwh": 0.0, "cost": 0.0, "have": False}
           for k in ("all", "home", "away")}
    for s in sessions or []:
        if not s or _num(s.get("endedAt")) is None or s["endedAt"] < cutoff:
            continue
        where = "away" if s.get("location") == "away" else "home"
        for a in (acc["all"], acc[where]):
            a["count"] += 1
            if s.get("kwh") is not None:
                a["kwh"] += s["kwh"]
            if s.get("cost") is not None:
                a["cost"] += s["cost"]
                a["have"] = True

    def out(a):
        return {"count": a["count"], "kwh": _round(a["kwh"], 1),
                "cost": _round(a["cost"], 2) if a["have"] else None}

    r = out(acc["all"])
    r["home"] = out(acc["home"])
    r["away"] = out(acc["away"])
    return r
