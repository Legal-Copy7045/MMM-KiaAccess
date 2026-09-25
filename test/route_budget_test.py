"""route_budget.py: when to route, which destinations, and the monthly call
budget. Pure -- no homeassistant needed. Run: python test/route_budget_test.py
"""
import importlib.util
import os
from datetime import datetime

_spec = importlib.util.spec_from_file_location(
    "route_budget",
    os.path.join(os.path.dirname(__file__), "..", "custom_components", "kia_access",
                 "route_budget.py"),
)
RB = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(RB)

# ---- interval: day vs overnight (11pm-6am) ----
day = datetime(2026, 9, 24, 14, 0)
assert RB.interval_seconds(day) == 15 * 60
assert RB.interval_seconds(day, 20, 90) == 20 * 60
for h in (23, 0, 3, 5):
    assert RB.interval_seconds(datetime(2026, 9, 24, h, 30)) == 60 * 60, h
for h in (6, 12, 22):
    assert RB.interval_seconds(datetime(2026, 9, 24, h, 30)) == 15 * 60, h
assert RB.interval_seconds(datetime(2026, 9, 24, 2, 0), 15, 120) == 120 * 60

# ---- zone filter parsing (same syntax as the mirror's mm_zone_filter) ----
assert RB.parse_zone_filter("zone.nana_s\nzone.the_parking_spot") == (
    ["nanas", "theparkingspot"], [])
assert RB.parse_zone_filter("Home, -Dolleen, !zone.debbie_s") == (
    ["home"], ["dolleen", "debbies"])
assert RB.parse_zone_filter("") == ([], [])
assert RB.parse_zone_filter(None) == ([], [])


# ---- select_routed: the real setup this was built for ----
def zone(name, eid, km):
    return {"name": name, "entity_id": eid, "source": "zone", "km": km}


def cal(name, when, km):
    return {"name": name, "source": "calendar", "when": when, "km": km}


pois = [
    zone("Home", "zone.home", 0.0),
    zone("Nana's", "zone.nana_s", 25.6),
    zone("Dolleen", "zone.dolleen", 25.9),
    zone("The Parking Spot", "zone.the_parking_spot", 48.4),
    zone("Dutch Wonderland", "zone.dutch_wonderland", 309.0),
    cal("6th & Penn Garage", "2026-09-26T18:00:00", 36.7),
    cal("Lion King", "2026-09-26T19:30:00", 36.5),
]
picked = RB.select_routed(pois, "zone.nana_s\nzone.the_parking_spot")
assert [p["name"] for p in picked] == [
    "6th & Penn Garage", "Lion King", "Nana's", "The Parking Spot"], picked

# no zone filter: every zone is eligible, calendar still first
picked = RB.select_routed(pois, "")
assert [p["name"] for p in picked][:2] == ["6th & Penn Garage", "Lion King"]
assert len(picked) == 7

# exclusions drop zones only
picked = RB.select_routed(pois, "-Dutch Wonderland\n-Home")
assert "Dutch Wonderland" not in [p["name"] for p in picked]
assert "Home" not in [p["name"] for p in picked]
assert "Lion King" in [p["name"] for p in picked]

# cap: pinned rows (static + whitelisted zones) survive, then the soonest events
many = [cal(f"Event {i}", f"2026-09-2{i}T10:00:00", 10 + i) for i in range(1, 8)]
static = {"name": "Office", "source": "static", "km": 12.0}
picked = RB.select_routed(many + [static] + pois[:2], "zone.nana_s", max_rows=4)
names = [p["name"] for p in picked]
assert len(names) == 4, names
assert "Office" in names and "Nana's" in names, names
assert names[:2] == ["Event 1", "Event 2"], names  # soonest first, display order kept

# default max is 8
assert len(RB.select_routed([dict(p) for p in many * 2], "")) == 8

# ---- budget: counters roll over by month and day ----
now = datetime(2026, 9, 24, 12, 0)
s = RB.roll(None, now)
assert s == {"month": "2026-09", "used": 0, "day": "2026-09-24", "used_today": 0}
s = RB.spend(s, 9)
assert s["used"] == 9 and s["used_today"] == 9
s2 = RB.roll(s, datetime(2026, 9, 25, 0, 5))
assert s2["used"] == 9 and s2["used_today"] == 0
s3 = RB.roll(s2, datetime(2026, 10, 1, 0, 5))
assert s3["used"] == 0 and s3["used_today"] == 0
# paused_until survives a roll-over
assert RB.roll({"paused_until": 123.0}, now)["paused_until"] == 123.0

# allowance: what's left spread over the remaining days (today included)
s = {"month": "2026-09", "used": 0, "day": "2026-09-01", "used_today": 0}
assert RB.daily_allowance(s, datetime(2026, 9, 1), 18000) == 600
s = {"month": "2026-09", "used": 12000, "day": "2026-09-24", "used_today": 0}
assert RB.daily_allowance(s, datetime(2026, 9, 24), 18000) == 6000 / 7
# today's own spend doesn't shrink today's allowance
s = {"month": "2026-09", "used": 12300, "day": "2026-09-24", "used_today": 300}
assert RB.daily_allowance(s, datetime(2026, 9, 24), 18000) == 6000 / 7
assert RB.daily_allowance({"used": 99999, "used_today": 0}, now, 18000) == 0

# can_spend: daily share and the hard monthly cap
s = {"month": "2026-09", "used": 596, "day": "2026-09-01", "used_today": 596}
assert RB.can_spend(s, datetime(2026, 9, 1), 4, 18000)
assert not RB.can_spend(s, datetime(2026, 9, 1), 5, 18000)
s = {"month": "2026-09", "used": 17998, "day": "2026-09-30", "used_today": 0}
assert RB.can_spend(s, datetime(2026, 9, 30), 2, 18000)
assert not RB.can_spend(s, datetime(2026, 9, 30), 3, 18000)
# default budget
assert RB.can_spend(RB.roll(None, now), now, 8)

# the schedule this was sized for fits the default budget: 4 rows every 15 min
# by day + hourly overnight, car home all month
passes = 17 * 4 + 7
assert passes * 4 * 30 < RB.DEFAULT_MONTHLY_BUDGET

# ---- auth errors pause instead of retrying ----
assert RB.is_auth_error(RuntimeError('HTTP 403: {"detailedError":{"code":"InsufficientFunds"}}'))
assert RB.is_auth_error("HTTP 401: bad key")
assert not RB.is_auth_error("HTTP 429: slow down")
assert not RB.is_auth_error("HTTP 4030")
assert not RB.is_auth_error("timeout")

print("route_budget_test: ok")
