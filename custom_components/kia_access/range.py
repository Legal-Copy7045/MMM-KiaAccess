"""Drive-range reachability - Python port of core/range.js.

Kept line-for-line with the JS; both are exercised in CI
(test/range.test.js / test/range_test.py).
"""
from __future__ import annotations

import math

DEFAULTS = {
    "factor": 0.92,
    "reservePct": 10,
    "reserveKm": None,
    "roundTrip": False,
    "circleFactor": 0.85,
}


def _opt(o, k):
    o = o or {}
    v = o.get(k)
    return DEFAULTS[k] if v is None else v


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def reach(range_km, o=None):
    """Usable one-way (or half, round trip) drive distance in km, or None."""
    r = _num(range_km)
    if r is None or r <= 0:
        return None
    reserve_km = _opt(o, "reserveKm")
    if reserve_km is not None:
        usable = r - float(reserve_km)
    else:
        usable = r * (1 - float(_opt(o, "reservePct")) / 100)
    if not usable > 0:
        return 0
    d = usable * float(_opt(o, "factor"))
    return d / 2 if _opt(o, "roundTrip") else d


R_EARTH_KM = 6371.0088
D2R = math.pi / 180


def haversine_km(lat1, lon1, lat2, lon2):
    d_lat = (lat2 - lat1) * D2R
    d_lon = (lon2 - lon1) * D2R
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat1 * D2R) * math.cos(lat2 * D2R) * math.sin(d_lon / 2) ** 2
    )
    return R_EARTH_KM * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def bearing_deg(lat1, lon1, lat2, lon2):
    y = math.sin((lon2 - lon1) * D2R) * math.cos(lat2 * D2R)
    x = math.cos(lat1 * D2R) * math.sin(lat2 * D2R) - math.sin(lat1 * D2R) * math.cos(
        lat2 * D2R
    ) * math.cos((lon2 - lon1) * D2R)
    return (math.atan2(y, x) / D2R + 360) % 360


def poi_status(lat, lon, pois, reach_km, trip=None):
    """Which saved places are in reach, nearest first.

    trip {batteryPct, rangeKm, roadFactor} also estimates arrival SoC.
    """
    if _num(lat) is None or _num(lon) is None or not isinstance(pois, list):
        return []
    trip = trip or {}
    pct = _num(trip.get("batteryPct"))
    rng = _num(trip.get("rangeKm"))
    road = _num(trip.get("roadFactor")) or 1.3
    can_arrive = pct is not None and rng is not None and rng > 0
    out = []
    for p in pois:
        if not p or _num(p.get("lat")) is None or _num(p.get("lon")) is None:
            continue
        km = haversine_km(lat, lon, float(p["lat"]), float(p["lon"]))
        arrival_pct = (
            round(max(0, pct * (1 - (km * road) / rng))) if can_arrive else None
        )
        out.append(
            {
                "name": p.get("name") or "",
                "km": km,
                "reachable": reach_km is not None and km <= reach_km,
                "marginKm": (reach_km - km) if reach_km is not None else None,
                "bearing": bearing_deg(lat, lon, float(p["lat"]), float(p["lon"])),
                "arrivalPct": arrival_pct,
            }
        )
    out.sort(key=lambda x: x["km"])
    return out


def circle_ring(lat, lon, km, n=64):
    """GeoJSON polygon ring (lon/lat) approximating a km-radius circle."""
    ring = []
    lat_r = km / 111.32
    lon_r = km / (111.32 * math.cos(lat * D2R) or 1e-6)
    for i in range(n + 1):
        t = (i / n) * 2 * math.pi
        ring.append([lon + lon_r * math.sin(t), lat + lat_r * math.cos(t)])
    return ring


def summary(car_lat, car_lon, range_km, pois=None, o=None):
    o = o or {}
    one = reach(range_km, {**o, "roundTrip": False})
    rnd = reach(range_km, {**o, "roundTrip": True})
    rt = bool(_opt(o, "roundTrip"))
    active = rnd if rt else one
    trip = {
        "batteryPct": o.get("batteryPct"),
        "rangeKm": range_km,
        "roadFactor": o.get("roadFactor"),
    }
    return {
        "roundTrip": rt,
        "oneWayKm": one,
        "roundTripKm": rnd,
        "reachKm": active,
        "pois": poi_status(car_lat, car_lon, pois or [], active, trip),
        "circle": circle_ring(car_lat, car_lon, active)
        if _num(car_lat) is not None and active
        else None,
    }
