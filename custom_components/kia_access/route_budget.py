"""Routing-call budget for the reachable-destinations drive times.

Decides WHEN to route (car at home only; one interval by day, a slower one
overnight), WHICH destinations to route (only the rows the MagicMirror panel
actually shows -- same rules as core/dest-planner.js planDestinations() in
its default "grouped" order), and whether this month's call budget still
allows it. Every routing provider bills per destination here (TomTom route
call = 1, a 1 x N TomTom or Geoapify matrix = N), so one pass costs one unit
per routed destination.

Pure: no Home Assistant imports, so test/route_budget_test.py runs without
`homeassistant` installed. The coordinator does the HTTP and the persisting.
"""
from __future__ import annotations

import calendar
import re
from datetime import datetime

NIGHT_START_HOUR = 23
NIGHT_END_HOUR = 6
DEFAULT_DAY_INTERVAL_MIN = 15
DEFAULT_NIGHT_INTERVAL_MIN = 60
DEFAULT_MONTHLY_BUDGET = 18000
DEFAULT_MAX_ROUTED = 8
# a 401/403 from the provider (bad key, or TomTom's "InsufficientFunds") won't
# fix itself on a retry a minute later -- stop calling for this long instead
AUTH_PAUSE_SECONDS = 6 * 3600
# the car's own spot: a destination this close to the origin needs no call
SKIP_NEAR_ORIGIN_KM = 0.5


def interval_seconds(now: datetime, day_min=None, night_min=None) -> float:
    """Minimum gap between routing passes at local time `now`."""
    day_min = float(day_min or DEFAULT_DAY_INTERVAL_MIN)
    night_min = float(night_min or DEFAULT_NIGHT_INTERVAL_MIN)
    night = now.hour >= NIGHT_START_HOUR or now.hour < NIGHT_END_HOUR
    return 60.0 * (night_min if night else day_min)


def _znorm(s) -> str:
    """'zone.nana_s' and "Nana's" -> the same key (see dest-planner.js znorm)."""
    return re.sub(r"[^a-z0-9]+", "", re.sub(r"^zone\.", "", str(s or "").lower()))


def parse_zone_filter(raw) -> tuple[list[str], list[str]]:
    """The zone_entities option (what the mirror reads as mm_zone_filter):
    newline/comma separated, a leading "-" or "!" excludes. -> (inc, exc)"""
    inc, exc = [], []
    for z in re.split(r"[\n,]", str(raw or "")):
        z = z.strip()
        if not z:
            continue
        if z[0] in "-!":
            exc.append(_znorm(z[1:]))
        else:
            inc.append(_znorm(z))
    return inc, exc


def select_routed(pois: list[dict], zone_filter_raw, max_rows=None) -> list[dict]:
    """The destinations the mirror's driving-times panel will show.

    pois: [{name, source: "zone"|"static"|"calendar", km, entity_id?, when?}]
    with km = straight-line distance from the car. Mirrors planDestinations():
    zones narrowed by the filter, calendar events soonest first, then static,
    then zones nearest first; pinned rows (static + whitelisted zones) always
    make the cut, the rest fill up to max_rows.
    """
    max_rows = int(max_rows or DEFAULT_MAX_ROUTED)
    inc, exc = parse_zone_filter(zone_filter_raw)

    def keys(p):
        return {k for k in (_znorm(p.get("name")), _znorm(p.get("entity_id"))) if k}

    rows = []
    for p in pois:
        if p.get("source") == "zone":
            k = keys(p)
            if k & set(exc) or (inc and not k & set(inc)):
                continue
        rows.append(p)

    rank = {"calendar": 0, "static": 1, "zone": 2}
    rows.sort(key=lambda p: (
        rank.get(p.get("source"), 3),
        str(p.get("when") or "") if p.get("source") == "calendar" else "",
        float(p.get("km") or 0),
    ))
    if len(rows) <= max_rows:
        return rows

    def pinned(p):
        return p.get("source") == "static" or (
            p.get("source") == "zone" and inc and bool(keys(p) & set(inc))
        )

    keep = [p for p in rows if pinned(p)][:max_rows]
    for p in rows:
        if len(keep) >= max_rows:
            break
        if not any(p is k for k in keep):
            keep.append(p)
    return [p for p in rows if any(p is k for k in keep)]


def roll(state: dict | None, now: datetime) -> dict:
    """Usage counters for `now`'s month and day (reset when either rolls over)."""
    s = dict(state or {})
    month, day = now.strftime("%Y-%m"), now.strftime("%Y-%m-%d")
    if s.get("month") != month:
        s["month"], s["used"] = month, 0
    if s.get("day") != day:
        s["day"], s["used_today"] = day, 0
    s.setdefault("used", 0)
    s.setdefault("used_today", 0)
    return s


def daily_allowance(state: dict, now: datetime, budget=None) -> float:
    """What's left of the month's budget spread evenly over the days left
    (today included) -- so a busy stretch slows routing down for the rest
    of the month instead of running dry before it ends."""
    budget = float(budget or DEFAULT_MONTHLY_BUDGET)
    days_left = calendar.monthrange(now.year, now.month)[1] - now.day + 1
    before_today = state.get("used", 0) - state.get("used_today", 0)
    return max(0.0, (budget - before_today) / days_left)


def can_spend(state: dict, now: datetime, cost: int, budget=None) -> bool:
    budget = float(budget or DEFAULT_MONTHLY_BUDGET)
    if state.get("used", 0) + cost > budget:
        return False
    return state.get("used_today", 0) + cost <= daily_allowance(state, now, budget)


def spend(state: dict, cost: int) -> dict:
    s = dict(state)
    s["used"] = s.get("used", 0) + cost
    s["used_today"] = s.get("used_today", 0) + cost
    return s


def is_auth_error(err) -> bool:
    """HTTP 401/403 from _http_json() -- a bad key or no credits left."""
    return bool(re.match(r"HTTP (401|403)\b", str(err)))
