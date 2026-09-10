"""Trip / drive-segment tracking - Python port of core/trips.js.

Kept line-for-line with the JS; both are exercised in CI
(test/trips.test.js / test/trips_test.py).
"""
from __future__ import annotations

import math
import time

DEFAULT_CAPACITY_KWH = 99.8  # Kia EV9 usable
MIN_KM = 0.5
PARK_GAP_MIN = 8
MI_PER_KM = 0.621371


def _num(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _round(n, dp=2):
    if n is None:
        return None
    f = 10 ** dp
    return round(n * f) / f


def haversine_km(a_lat, a_lon, b_lat, b_lon):
    if None in (a_lat, a_lon, b_lat, b_lon):
        return None
    r, p = 6371, math.pi / 180
    d_lat = (b_lat - a_lat) * p
    d_lon = (b_lon - a_lon) * p
    s = (math.sin(d_lat / 2) ** 2
         + math.cos(a_lat * p) * math.cos(b_lat * p) * math.sin(d_lon / 2) ** 2)
    return r * 2 * math.asin(math.sqrt(s))


def _close(open_t, opts, end_at):
    cap = _num(opts.get("capacityKwh")) or DEFAULT_CAPACITY_KWH
    price = _num(opts.get("pricePerKwh")) or 0
    dist = (max(0, open_t["lastOdo"] - open_t["anchorOdo"])
            if (open_t.get("lastOdo") is not None and open_t.get("anchorOdo") is not None)
            else None)
    min_km = _num(opts.get("minKm"))
    if min_km is None:
        min_km = MIN_KM
    if dist is None or dist < min_km:
        return None
    used_pct = (open_t["anchorPct"] - open_t["lastPct"]
                if (not open_t.get("chargedSince")
                    and open_t.get("anchorPct") is not None
                    and open_t.get("lastPct") is not None)
                else None)
    kwh = (used_pct / 100) * cap if (used_pct is not None and used_pct > 0) else None
    mins = max(1, round((end_at - open_t["anchorAt"]) / 60000))
    mi = dist * MI_PER_KM
    return {
        "startedAt": open_t["anchorAt"],
        "endedAt": end_at,
        "minutes": mins,
        "distanceKm": _round(dist, 1),
        "distanceMi": _round(mi, 1),
        "usedPct": _round(used_pct, 1) if used_pct is not None else None,
        "kwh": _round(kwh, 2),
        "miPerKwh": _round(mi / kwh, 2) if (kwh is not None and kwh > 0) else None,
        "kwhPer100mi": _round(kwh / mi * 100, 1) if (kwh is not None and dist > 0) else None,
        "cost": _round(kwh * price, 2) if (kwh is not None and price > 0) else None,
        "pricePerKwh": price or None,
        "fromLat": open_t.get("anchorLat"), "fromLon": open_t.get("anchorLon"),
        "toLat": open_t.get("lastLat"), "toLon": open_t.get("lastLon"),
        "straightLineKm": _round(
            haversine_km(open_t.get("anchorLat"), open_t.get("anchorLon"),
                         open_t.get("lastLat"), open_t.get("lastLon")), 1),
        "chargedDuring": bool(open_t.get("chargedSince")),
    }


def update(open_t, cur, opts=None):
    """Fold one state sample into trip tracking.

    open_t: dict | None   trip in progress
    cur:    {"t", "odometerKm", "batteryPct", "charging", "carOn",
             "locationLat", "locationLon"}
    opts:   {"pricePerKwh", "capacityKwh", "minKm", "parkGapMin"}
    -> {"open": dict|None, "closed": dict|None}
    """
    opts = opts or {}
    t = _num(cur.get("t")) or (time.time() * 1000)
    odo = _num(cur.get("odometerKm"))
    pct = _num(cur.get("batteryPct"))
    lat = _num(cur.get("locationLat"))
    lon = _num(cur.get("locationLon"))
    charging = cur.get("charging") is True
    car_on = cur.get("carOn") is True
    gap_ms = (_num(opts.get("parkGapMin")) or PARK_GAP_MIN) * 60000

    if odo is None:
        return {"open": open_t, "closed": None}

    if not open_t:
        return {
            "open": {
                "anchorOdo": odo, "anchorPct": pct, "anchorAt": t,
                "anchorLat": lat, "anchorLon": lon,
                "lastOdo": odo, "lastPct": pct, "lastAt": t,
                "lastLat": lat, "lastLon": lon,
                "movedAt": t, "chargedSince": False,
            },
            "closed": None,
        }

    moved = odo > open_t["lastOdo"] + 0.05
    if charging or (pct is not None and open_t.get("lastPct") is not None
                    and pct > open_t["lastPct"] + 1):
        open_t["chargedSince"] = True

    if moved:
        open_t["lastOdo"] = odo
        open_t["movedAt"] = t
        if pct is not None:
            open_t["lastPct"] = pct
        if lat is not None:
            open_t["lastLat"] = lat
            open_t["lastLon"] = lon
        open_t["lastAt"] = t
        return {"open": open_t, "closed": None}

    if pct is not None:
        open_t["lastPct"] = pct
    if lat is not None and open_t["lastOdo"] == open_t["anchorOdo"]:
        open_t["anchorLat"] = lat
        open_t["anchorLon"] = lon
        if pct is not None:
            open_t["anchorPct"] = pct
    open_t["lastAt"] = t

    parked = (not car_on and t - open_t["movedAt"] >= gap_ms)
    if parked and open_t["lastOdo"] > open_t["anchorOdo"]:
        trip = _close(open_t, opts, open_t["movedAt"])
        return {
            "open": {
                "anchorOdo": open_t["lastOdo"], "anchorPct": open_t["lastPct"], "anchorAt": t,
                "anchorLat": open_t["lastLat"], "anchorLon": open_t["lastLon"],
                "lastOdo": open_t["lastOdo"], "lastPct": open_t["lastPct"], "lastAt": t,
                "lastLat": open_t["lastLat"], "lastLon": open_t["lastLon"],
                "movedAt": t, "chargedSince": False,
            },
            "closed": trip,
        }
    if parked:
        open_t["anchorOdo"] = open_t["lastOdo"]
        open_t["anchorPct"] = open_t["lastPct"]
        open_t["anchorAt"] = t
        open_t["anchorLat"] = open_t["lastLat"]
        open_t["anchorLon"] = open_t["lastLon"]
        open_t["chargedSince"] = False
    return {"open": open_t, "closed": None}


def summary(trips, days=30):
    cutoff = (time.time() * 1000) - days * 864e5
    km = kwh = cost = 0.0
    n = 0
    have_cost = have_kwh = False
    for tr in trips or []:
        if not tr or _num(tr.get("endedAt")) is None or tr["endedAt"] < cutoff:
            continue
        n += 1
        if tr.get("distanceKm") is not None:
            km += tr["distanceKm"]
        if tr.get("kwh") is not None:
            kwh += tr["kwh"]
            have_kwh = True
        if tr.get("cost") is not None:
            cost += tr["cost"]
            have_cost = True
    mi = km * MI_PER_KM
    return {
        "count": n,
        "distanceKm": _round(km, 1),
        "distanceMi": _round(mi, 1),
        "kwh": _round(kwh, 1) if have_kwh else None,
        "cost": _round(cost, 2) if have_cost else None,
        "miPerKwh": _round(mi / kwh, 2) if (have_kwh and kwh > 0) else None,
        "costPerMi": _round(cost / mi, 3) if (have_cost and mi > 0) else None,
    }
