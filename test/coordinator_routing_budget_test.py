"""KiaAccessCoordinator._refresh_drive_times() against the routing budget:

  car away from home          -> no calls, straight-line estimates
  car at home                 -> only the mirror panel's rows are routed
                                 (TomTom: route calls, no matrix)
  inside the refresh interval -> no calls; after it -> one more pass
  HTTP 403 (no credits)       -> no retry, rest of the pass skipped, paused
  monthly budget used up      -> no calls
  Geoapify                    -> one matrix call, billed per destination
  car drives off              -> stale home routes no longer overlaid

Run: pip install homeassistant && python test/coordinator_routing_budget_test.py
"""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

from custom_components.kia_access import coordinator as coord_mod  # noqa: E402
from custom_components.kia_access.coordinator import KiaAccessCoordinator  # noqa: E402
from fake_ha import FakeConfig as _FakeConfig  # noqa: E402
from fake_ha import FakeStore as _FakeStore  # noqa: E402

HOME = (40.713088, -79.754636)
ZONES = {
    "zone.home": ("Home", HOME[0], HOME[1], 100),
    "zone.nana_s": ("Nana's", 40.52, -79.95, 100),
    "zone.dolleen": ("Dolleen", 40.53, -79.93, 100),
    "zone.the_parking_spot": ("The Parking Spot", 40.49, -80.24, 100),
}


class _State:
    def __init__(self, entity_id, name, lat, lon, radius):
        self.entity_id = entity_id
        self.attributes = {"friendly_name": name, "latitude": lat,
                           "longitude": lon, "radius": radius}


class _States:
    def __init__(self):
        self._s = {eid: _State(eid, *v) for eid, v in ZONES.items()}

    def get(self, entity_id):
        return self._s.get(entity_id)

    def async_all(self, domain):
        return [s for eid, s in self._s.items() if eid.startswith(domain + ".")]


class _Hass:
    def __init__(self):
        self.config = _FakeConfig()
        self.states = _States()


class _Entry:
    def __init__(self, options):
        self.entry_id = "e1"
        self.data = {}
        self.options = options


def make(options, at=HOME):
    c = object.__new__(KiaAccessCoordinator)
    c.entry = _Entry(options)
    c.hass = _Hass()
    c.vehicle = {"location_latitude": at[0], "location_longitude": at[1],
                 "ev_driving_range": 420, "ev_battery_percentage": 90}
    c._static_pois = []
    c._cal_pois = [
        {"name": "Lion King", "lat": 40.4431, "lon": -79.9996, "when": "2026-09-26T19:30"},
        {"name": "6th & Penn Garage", "lat": 40.4426, "lon": -80.0024,
         "when": "2026-09-26T18:00"},
    ]
    c._route_out = {}
    c._route_at = 0.0
    c._route_origin = None
    c._route_status = {}
    c._route_budget = {}
    c._route_store = _FakeStore({})
    c.calls = []
    c.reply = lambda req: {"routes": [{"summary": {
        "travelTimeInSeconds": 1800, "lengthInMeters": 30000,
        "noTrafficTravelTimeInSeconds": 1600}, "guidance": {"instructions": []}}]}

    async def _http_json(req):
        c.calls.append(req["url"])
        r = c.reply(req)
        if isinstance(r, Exception):
            raise r
        return r

    c._http_json = _http_json
    return c


async def _no_sleep(_s):
    return None


coord_mod.asyncio.sleep = _no_sleep

TOMTOM = {"drive_time_provider": "tomtom", "routing_api_key": "K",
          "zone_entities": "zone.nana_s\nzone.the_parking_spot",
          # same interval day and night so the test doesn't depend on the clock
          "drive_time_interval_min": 15, "drive_time_night_interval_min": 15}


async def main():
    # ---- away from home: nothing called ----
    c = make(TOMTOM, at=(40.44, -80.0))
    await c._refresh_drive_times()
    assert c.calls == [], c.calls
    assert c._route_status["skipped"] == "car not at home"

    # ---- at home: only the panel's 4 rows, TomTom route calls, no matrix ----
    c = make(TOMTOM)
    await c._refresh_drive_times()
    assert len(c.calls) == 4, c.calls
    assert all("calculateRoute" in u for u in c.calls), c.calls
    assert not any("matrix" in u for u in c.calls)
    assert len(c._route_out) == 4
    assert c._route_budget["used"] == 4 and c._route_budget["used_today"] == 4
    assert (await c._route_store.async_load())["used"] == 4  # persisted
    assert c._route_status["budget"]["used_month"] == 4

    # the overlay marks exactly those rows as routed
    rows = {p["name"]: p for p in c.range_reach["pois"]}
    assert rows["Nana's"]["routed"] and rows["Lion King"]["routed"]
    assert not rows["Dolleen"].get("routed")
    assert not rows["Home"].get("routed")

    # ---- inside the interval: no calls; after it: one more pass ----
    await c._refresh_drive_times()
    assert len(c.calls) == 4
    c._route_at = time.monotonic() - 16 * 60
    await c._refresh_drive_times()
    assert len(c.calls) == 8
    assert c._route_budget["used"] == 8

    # ---- car drives off: stale home routes aren't shown as live ----
    c.vehicle.update(location_latitude=40.30, location_longitude=-79.50)
    rows = {p["name"]: p for p in c.range_reach["pois"]}
    assert not any(p.get("routed") for p in rows.values()), rows
    await c._refresh_drive_times()
    assert len(c.calls) == 8  # and no routing while away

    # ---- back home inside the interval: arrival re-routes straight away ----
    c._route_at = time.monotonic()
    c.vehicle.update(location_latitude=HOME[0], location_longitude=HOME[1])
    await c._refresh_drive_times()
    assert len(c.calls) == 12, c.calls
    rows = {p["name"]: p for p in c.range_reach["pois"]}
    assert rows["Nana's"]["routed"]

    # ---- 403 (TomTom out of credits): no retry, stop the pass, pause ----
    c = make(TOMTOM)
    c.reply = lambda req: RuntimeError('HTTP 403: {"code":"InsufficientFunds"}')
    await c._refresh_drive_times()
    assert len(c.calls) == 1, c.calls
    assert c._route_budget["paused_until"] > time.time() + 5 * 3600
    c._route_at = 0.0
    await c._refresh_drive_times()
    assert len(c.calls) == 1
    assert c._route_status["skipped"] == "paused after an auth/credit error"

    # ---- 429: one back-off retry, then it counts both calls ----
    c = make(TOMTOM)
    seen = []

    def _flaky(req):
        seen.append(req["url"])
        return RuntimeError("HTTP 429: slow down") if len(seen) == 1 else make(TOMTOM).reply(req)

    c.reply = _flaky
    await c._refresh_drive_times()
    assert len(c.calls) == 5 and len(c._route_out) == 4
    assert c._route_budget["used"] == 5
    assert "paused_until" not in c._route_budget

    # ---- budget used up: no calls ----
    c = make({**TOMTOM, "routing_monthly_budget": 100})
    c._route_budget = {"month": time.strftime("%Y-%m"), "used": 98}
    await c._refresh_drive_times()
    assert c.calls == []
    assert "budget" in c._route_status["skipped"]

    # ---- Geoapify: one matrix call, billed as 4 ----
    c = make({**TOMTOM, "drive_time_provider": "geoapify"})
    c.reply = lambda req: {"sources_to_targets": [[
        {"target_index": i, "time": 1500, "distance": 25000} for i in range(4)]]}
    await c._refresh_drive_times()
    assert len(c.calls) == 1 and "routematrix" in c.calls[0]
    assert len(c._route_out) == 4
    assert c._route_budget["used"] == 4

    # ---- provider "estimate": nothing called ----
    c = make({**TOMTOM, "drive_time_provider": "estimate"})
    await c._refresh_drive_times()
    assert c.calls == []

    print("coordinator_routing_budget_test: ok")


asyncio.run(main())
