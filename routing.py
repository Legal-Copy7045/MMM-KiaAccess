"""Drive-time matrix helpers - Python port of core/routing.js.

Kept line-for-line with the JS; both are exercised in CI
(test/routing.test.js / test/routing_test.py).

Turns "car here, N saved places there" into real road distance + drive time
from a routing provider. Pure: builds the request dict and parses the
response. The caller (coordinator) does the HTTP and the caching.
"""
from __future__ import annotations

import json as _json
import urllib.parse as _up

PROVIDERS = ["geoapify", "tomtom"]


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _pt(p):
    if p is None:
        return (None, None)
    if isinstance(p, dict):
        return (_num(p.get("lat")), _num(p.get("lon")))
    if isinstance(p, (list, tuple)) and len(p) >= 2:
        return (_num(p[0]), _num(p[1]))
    return (None, None)


def _ok(pt):
    return pt[0] is not None and pt[1] is not None


def matrix_request(provider, origin, targets, api_key, o=None):
    """One origin -> many targets. Returns a request dict or None.

    dict: {"url", "method": "POST", "headers", "body": <json str>}
    """
    o = o or {}
    src = _pt(origin)
    tgts = [t for t in (_pt(x) for x in (targets or [])) if _ok(t)]
    if not api_key or not _ok(src) or not tgts:
        return None
    traffic = o.get("traffic") is not False

    if provider == "geoapify":
        mode = o.get("mode") or "drive"
        return {
            "url": "https://api.geoapify.com/v1/routematrix?apiKey=" + str(api_key),
            "method": "POST",
            "headers": {"Content-Type": "application/json"},
            "body": _json.dumps(
                {
                    "mode": mode,
                    "sources": [{"location": [src[1], src[0]]}],
                    "targets": [{"location": [t[1], t[0]]} for t in tgts],
                }
            ),
        }
    if provider == "tomtom":
        return {
            "url": "https://api.tomtom.com/routing/matrix/2?key=" + str(api_key),
            "method": "POST",
            "headers": {"Content-Type": "application/json"},
            "body": _json.dumps(
                {
                    "origins": [
                        {"point": {"latitude": src[0], "longitude": src[1]}}
                    ],
                    "destinations": [
                        {"point": {"latitude": t[0], "longitude": t[1]}}
                        for t in tgts
                    ],
                    "options": {
                        "travelMode": "truck" if o.get("mode") == "truck" else "car",
                        "traffic": "live" if traffic else "historical",
                    },
                }
            ),
        }
    return None


def parse_matrix(provider, data, target_count):
    """Parse a matrix response, aligned to request target order.

    Returns [{"durationMin", "distanceKm"} | None] of length target_count.
    """
    out = [None] * target_count
    if not data:
        return out

    if provider == "geoapify":
        rows = data.get("sources_to_targets") or []
        row = rows[0] if rows else []
        for cell in row:
            if not cell:
                continue
            idx = cell.get("target_index")
            if idx is None or idx < 0 or idx >= target_count:
                continue
            if cell.get("time") is None or cell.get("distance") is None:
                continue
            out[idx] = {
                "durationMin": round(float(cell["time"]) / 60),
                "distanceKm": float(cell["distance"]) / 1000,
            }
        return out
    if provider == "tomtom":
        for cell in data.get("data") or []:
            if not cell:
                continue
            idx = cell.get("destinationIndex")
            if idx is None or idx < 0 or idx >= target_count:
                continue
            summ = cell.get("routeSummary") or {}
            if summ.get("travelTimeInSeconds") is None or summ.get("lengthInMeters") is None:
                continue
            out[idx] = {
                "durationMin": round(float(summ["travelTimeInSeconds"]) / 60),
                "distanceKm": float(summ["lengthInMeters"]) / 1000,
            }
        return out
    return out


def geocode_request(provider, text, api_key):
    """Forward-geocode request (address -> lat/lon), US-biased.

    Returns {"url", "method": "GET"} or None.
    """
    if not api_key or not text:
        return None
    q = _up.quote(str(text), safe="")
    if provider == "geoapify":
        return {
            "url": "https://api.geoapify.com/v1/geocode/search?text=" + q
            + "&limit=1&filter=countrycode:us&apiKey=" + str(api_key),
            "method": "GET",
        }
    if provider == "tomtom":
        return {
            "url": "https://api.tomtom.com/search/2/geocode/" + q
            + ".json?limit=1&countrySet=US&key=" + str(api_key),
            "method": "GET",
        }
    return None


def parse_geocode(provider, data):
    """Parse a forward-geocode response. Returns {"lat","lon","name"} or None."""
    if not data:
        return None
    if provider == "geoapify":
        feats = data.get("features") or []
        p = (feats[0] or {}).get("properties") if feats else None
        if not p or p.get("lat") is None or p.get("lon") is None:
            return None
        return {"lat": float(p["lat"]), "lon": float(p["lon"]),
                "name": p.get("formatted") or p.get("address_line1") or ""}
    if provider == "tomtom":
        res = data.get("results") or []
        pos = (res[0] or {}).get("position") if res else None
        if not pos or pos.get("lat") is None or pos.get("lon") is None:
            return None
        addr = (res[0] or {}).get("address") or {}
        return {"lat": float(pos["lat"]), "lon": float(pos["lon"]),
                "name": addr.get("freeformAddress") or ""}
    return None
