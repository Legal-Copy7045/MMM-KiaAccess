"""Calendar geocoding: online meetings are skipped and failed lookups are
remembered, so a calendar refresh doesn't re-query the same text every time.

  is_online_location()          -> Teams / Zoom / Meet / Webex / links
  online location               -> no provider call, nothing cached
  failed lookup                 -> tried once, then skipped for 24 h
  new geocoding key             -> retried straight away
  miss older than 24 h          -> retried
  success after a miss          -> miss cleared, coordinate cached
  async_load_prefs()            -> restores fresh misses, drops expired ones

Run: pip install homeassistant && python test/coordinator_geocode_test.py
"""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

from custom_components.kia_access import coordinator as coord_mod  # noqa: E402
from custom_components.kia_access.coordinator import (  # noqa: E402
    GEO_MISS_TTL_SEC,
    KiaAccessCoordinator,
    is_online_location,
)
from fake_ha import FakeStore as _FakeStore  # noqa: E402

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print("FAIL:", msg)


# --- is_online_location -----------------------------------------------------
for text in [
    "Microsoft Teams Meeting", "Microsoft Teams Meeting; Room 4", "Teams",
    "Zoom", "https://zoom.us/j/123456", "Zoom Meeting", "Google Meet",
    "meet.google.com/abc-defg-hij", "Webex", "https://acme.webex.com/meet/x",
    "http://example.com", "www.example.com/room", "  ONLINE ", "Skype Meeting",
]:
    check(is_online_location(text), f"{text!r} should count as online")
for text in [
    "", None, "10 Downing Street, London", "Zoom Ridge Rd, Pittsburgh",
    "Teamster Hall, 7 Main St", "Meeting Room 2, 1 Station Rd", "Webster Ave 12",
]:
    check(not is_online_location(text), f"{text!r} should NOT count as online")


# --- _geocode_cached --------------------------------------------------------
class _Hass:
    def __init__(self):
        self.calls = 0

    async def async_add_executor_job(self, fn, *args):
        self.calls += 1
        return fn(*args)


class _Entry:
    def __init__(self, options):
        self.entry_id = "e1"
        self.data = {}
        self.options = options


def make(options=None):
    c = object.__new__(KiaAccessCoordinator)
    c.entry = _Entry(options or {})
    c.hass = _Hass()
    c._geo_cache = {}
    c._geo_miss = {}
    c._geo_store = _FakeStore({"geo": {}})
    c._cal_status = {}
    c._plausible_destination = lambda lat, lon: True
    c.provider_calls = []

    async def provider(name, key, address):
        c.provider_calls.append(name)
        raise RuntimeError("no match")

    c._geocode_provider = provider
    return c


def _nominatim_fails(address):
    raise RuntimeError("no match")


def _nominatim_ok(address):
    return 51.5, -0.12, address


orig_geocode = coord_mod.kia_client._geocode
try:
    coord_mod.kia_client._geocode = _nominatim_fails

    # online locations never reach a geocoder
    c = make({"geocoding_api_key": "g"})
    for loc in ["Microsoft Teams Meeting", "https://zoom.us/j/1", "Google Meet"]:
        check(asyncio.run(c._geocode_cached(loc)) is None, f"{loc!r} -> None")
    check(c.provider_calls == [] and c.hass.calls == 0, "online: no lookups made")
    check(c._geo_miss == {}, "online: nothing recorded as a miss")
    check(len(c._cal_status.get("skipped_online", [])) == 3, "online: listed as skipped")

    # a failed lookup is made once, then skipped
    c = make({"geocoding_api_key": "g"})
    check(asyncio.run(c._geocode_cached("Nowhere Lane 99")) is None, "miss -> None")
    check(c.provider_calls == ["geoapify"] and c.hass.calls == 1, "first miss looks it up")
    check("nowhere lane 99" in c._geo_miss, "miss recorded")
    check("nowhere lane 99" in (c._geo_store._data or {}).get("miss", {}), "miss persisted")
    asyncio.run(c._geocode_cached("Nowhere  Lane 99"))
    check(c.provider_calls == ["geoapify"] and c.hass.calls == 1,
          "second refresh doesn't look it up again")
    check(any("not retried" in e for e in c._cal_status.get("geocode_errors", [])),
          "skip is explained in the calendar status")

    # adding a routing key changes the geocoder set -> retried at once
    c.entry.options = {"geocoding_api_key": "g", "routing_api_key": "r",
                       "drive_time_provider": "tomtom"}
    asyncio.run(c._geocode_cached("Nowhere Lane 99"))
    check(c.hass.calls == 2, "changed geocoders -> retried")

    # an expired miss is retried
    c._geo_miss["nowhere lane 99"]["at"] = time.time() - GEO_MISS_TTL_SEC - 1
    asyncio.run(c._geocode_cached("Nowhere Lane 99"))
    check(c.hass.calls == 3, "expired miss -> retried")

    # success after a miss clears it and caches the coordinate
    coord_mod.kia_client._geocode = _nominatim_ok
    c._geo_miss["nowhere lane 99"]["at"] = time.time() - GEO_MISS_TTL_SEC - 1
    check(asyncio.run(c._geocode_cached("Nowhere Lane 99")) == [51.5, -0.12], "hit")
    check("nowhere lane 99" not in c._geo_miss, "hit clears the miss")
    check(c._geo_cache.get("nowhere lane 99") == [51.5, -0.12], "hit cached")
    check((c._geo_store._data or {}).get("miss") == {}, "cleared miss persisted")

    # a result too far from home is also not retried every refresh
    c = make()
    c._plausible_destination = lambda lat, lon: False
    asyncio.run(c._geocode_cached("Paris"))
    asyncio.run(c._geocode_cached("Paris"))
    check(c.hass.calls == 1 and "paris" in c._geo_miss, "too-far result remembered")
finally:
    coord_mod.kia_client._geocode = orig_geocode


# --- async_load_prefs restores misses ---------------------------------------
class _PrefsCoord:
    _valid_ll = staticmethod(KiaAccessCoordinator._valid_ll)
    async_load_prefs = KiaAccessCoordinator.async_load_prefs
    _save_geo = KiaAccessCoordinator._save_geo

    def __init__(self, geo):
        self._prefs_store = _FakeStore({})
        self._geo_store = _FakeStore(geo)
        self._timers_store = _FakeStore({})
        self._route_store = _FakeStore({})


now = time.time()
p = _PrefsCoord({"geo": {"a": [1.0, 2.0]}, "miss": {
    "fresh": {"at": now - 60, "sig": "", "reason": "no match"},
    "old": {"at": now - GEO_MISS_TTL_SEC - 5, "sig": "", "reason": "no match"},
    "junk": "x",
}})
asyncio.run(p.async_load_prefs())
check(set(p._geo_miss) == {"fresh"}, f"load keeps only fresh misses: {sorted(p._geo_miss)}")
check(p._geo_cache == {"a": [1.0, 2.0]}, "load keeps the cache")
legacy = _PrefsCoord({"geo": {"a": [1.0, 2.0]}})
asyncio.run(legacy.async_load_prefs())
check(legacy._geo_miss == {}, "store without 'miss' loads fine")

# --- calendar refresh skips online meetings ---------------------------------
class _CalServices:
    def __init__(self, events):
        self.events = events

    async def async_call(self, domain, service, data, **kw):
        return {data["entity_id"]: {"events": self.events}}


class _CalStates:
    def get(self, entity_id):
        return object()


cal = make({"calendar_entities": "calendar.work"})
cal.hass.services = _CalServices([
    {"summary": "Standup", "location": "Microsoft Teams Meeting", "start": "2026-11-11T09:00"},
    {"summary": "1:1", "location": "https://zoom.us/j/42", "start": "2026-11-11T10:00"},
    {"summary": "Dentist", "location": "1 High St", "start": "2026-11-11T15:00"},
])
cal.hass.states = _CalStates()
cal._cal_pois = [{"name": "old", "lat": 1.0, "lon": 2.0}]
cal._cal_store = _FakeStore({})


async def _no_static():
    cal._static_pois = []


cal._refresh_static_pois = _no_static
looked_up = []


async def _geo(address):
    looked_up.append(address)
    return [51.5, -0.12]


cal._geocode_cached = _geo
asyncio.run(cal.async_refresh_calendar_pois())
check(looked_up == ["1 High St"], f"only the real address is geocoded: {looked_up}")
check(cal._cal_status["with_location"] == 1, "online meetings don't count as locations")
check([p["name"] for p in cal._cal_pois] == ["Dentist"], "only Dentist becomes a destination")
check(sum(1 for s in cal._cal_status["seen"] if "online" in s["result"]) == 2,
      "online meetings shown as skipped")

if failures:
    print(f"\n{len(failures)} failure(s)")
    sys.exit(1)
print("coordinator_geocode_test: all checks passed")
