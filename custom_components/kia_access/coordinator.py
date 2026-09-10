"""Data coordinator for Kia Access."""
from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util
from homeassistant.util.unit_system import METRIC_SYSTEM

from . import kia_client
from . import range as drive_range
from . import routing as drive_routing
from . import sessions as charge_sessions
from . import trips as drive_trips
from .conditions import evaluate as evaluate_conditions
from .const import (
    CONF_BRAND,
    CONF_GEOCODE,
    CONF_PIN,
    CONF_REGION,
    CONF_TOKEN,
    CONF_VIN,
    DEFAULT_CLIMATE_PREFS,
    DEFAULT_FORCE_REFRESH_TIMEOUT,
    DEFAULT_SCAN_INTERVAL_MINUTES,
    DOMAIN,
    EVENT_STATE_CHANGED,
)

_FAHRENHEIT_REGIONS = {"USA", "CA"}
from .vehicle_state import build_state

_LOGGER = logging.getLogger(__name__)


class KiaAccessCoordinator(DataUpdateCoordinator):
    """Polls the Kia cloud via the shared kia_client and caches the last state."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        minutes = entry.options.get("scan_interval", DEFAULT_SCAN_INTERVAL_MINUTES)
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(minutes=minutes),
        )
        self.entry = entry
        self.last_options: dict = dict(entry.options)
        self.vehicle: dict = {}
        self.meta: dict = {}
        self._prev_cond: dict = {}
        self._announced: dict = {}
        self._first_alert_run = True
        self._home_unplugged_since: float | None = None
        self._last_parked: dict | None = None
        self._moved_since: float | None = None
        self._parked: dict | None = None
        self._was_on: bool | None = None
        self._geo_cache: dict = {}
        self._geo_store = Store(hass, 1, f"{DOMAIN}_geocache_{entry.entry_id}")
        self._cal_pois: list[dict] = []
        self._static_pois: list[dict] = []
        self._cal_pois_at: float = 0.0
        self._cal_status: dict = {}
        # real drive-times from a routing provider, keyed by _poi_key(lat, lon)
        self._route_out: dict = {}
        self._route_at: float = 0.0
        self._route_origin: tuple | None = None
        self._route_status: dict = {}
        self._sessions: list[dict] = []
        self._open_session: dict | None = None
        self._sessions_store = Store(hass, 1, f"{DOMAIN}_sessions_{entry.entry_id}")
        self._trips: list[dict] = []
        self._open_trip: dict | None = None
        self._trips_store = Store(hass, 1, f"{DOMAIN}_trips_{entry.entry_id}")
        self._prefs_store = Store(hass, 1, f"{DOMAIN}_prefs_{entry.entry_id}")
        self.climate_prefs: dict = dict(DEFAULT_CLIMATE_PREFS)
        # last control command, for the "action in progress" sensor
        self.last_action: dict = {"name": None, "status": "idle", "at": None}

    async def async_load_sessions(self) -> None:
        data = await self._sessions_store.async_load() or {}
        self._sessions = data.get("sessions") or []
        self._open_session = data.get("open") or None
        tdata = await self._trips_store.async_load() or {}
        self._trips = tdata.get("trips") or []
        self._open_trip = tdata.get("open") or None

    @staticmethod
    def _valid_ll(v) -> bool:
        return (
            isinstance(v, (list, tuple))
            and len(v) >= 2
            and isinstance(v[0], (int, float))
            and isinstance(v[1], (int, float))
        )

    async def async_load_prefs(self) -> None:
        data = await self._prefs_store.async_load() or {}
        self.climate_prefs = {**DEFAULT_CLIMATE_PREFS, **data}
        raw = (await self._geo_store.async_load() or {}).get("geo", {})
        # older versions cached `None` (or a 3-tuple) on a failed geocode, which
        # then stuck forever — keep only clean [lat, lon] pairs
        self._geo_cache = {
            k: [v[0], v[1]] for k, v in raw.items() if self._valid_ll(v)
        }
        if len(self._geo_cache) != len(raw):
            await self._geo_store.async_save({"geo": self._geo_cache})

    async def async_set_pref(self, key: str, value) -> None:
        self.climate_prefs[key] = value
        await self._prefs_store.async_save(self.climate_prefs)
        self.async_update_listeners()

    @property
    def region(self) -> str:
        return str(self.entry.data.get(CONF_REGION, "USA")).upper()

    def climate_temp_unit(self) -> str:
        from homeassistant.const import UnitOfTemperature

        return (
            UnitOfTemperature.FAHRENHEIT
            if self.region in _FAHRENHEIT_REGIONS
            else UnitOfTemperature.CELSIUS
        )

    def build_climate_options(self, temp_c: float | None = None) -> dict:
        """climate_prefs (+ an optional target °C) -> start_climate options."""
        p = self.climate_prefs
        if temp_c is None:
            temp_c = p.get("last_temp_c") or DEFAULT_CLIMATE_PREFS["last_temp_c"]
        if self.region in _FAHRENHEIT_REGIONS:
            set_temp = round(temp_c * 9 / 5 + 32)
        else:
            set_temp = round(temp_c * 2) / 2
        return {
            "set_temp": set_temp,
            "duration": int(p.get("duration") or 10),
            "climate": True,
            "defrost": bool(p.get("front_defrost")),
            "heating": 1 if p.get("rear_defrost") else 0,
            "steering_wheel": int(p.get("steering_wheel") or 0),
            "front_left_seat": int(p.get("front_left_seat") or 0),
            "front_right_seat": int(p.get("front_right_seat") or 0),
            "rear_left_seat": int(p.get("rear_left_seat") or 0),
            "rear_right_seat": int(p.get("rear_right_seat") or 0),
        }

    async def _update_sessions(self) -> None:
        v = self.vehicle

        def _num(x):
            try:
                return None if x is None or x == "" else float(x)
            except (TypeError, ValueError):
                return None

        opts = self.entry.options
        res = charge_sessions.update(
            self._open_session,
            {
                "t": time.time() * 1000,
                "charging": v.get("ev_battery_is_charging"),
                "plugged": v.get("ev_battery_is_plugged_in"),
                "batteryPct": _num(v.get("ev_battery_percentage")),
                "chargeKw": _num(v.get("ev_charging_power")),
            },
            {
                "pricePerKwh": opts.get("price_per_kwh") or 0,
                "capacityKwh": opts.get("capacity_kwh") or _num(v.get("ev_battery_capacity")),
            },
        )
        changed = res["open"] != self._open_session
        self._open_session = res["open"]
        if res["closed"]:
            self._sessions.append(res["closed"])
            keep_after = (time.time() * 1000) - 180 * 864e5
            self._sessions = [
                s for s in self._sessions if s and s.get("endedAt", 0) >= keep_after
            ][-300:]
            changed = True
            _LOGGER.info(
                "Kia Access charge session logged: %s kWh%s",
                res["closed"].get("kwh"),
                f" / {res['closed'].get('cost')}" if res["closed"].get("cost") else "",
            )
        if changed:
            await self._sessions_store.async_save(
                {"sessions": self._sessions, "open": self._open_session}
            )

    async def _update_trips(self) -> None:
        v = self.vehicle

        def _num(x):
            try:
                return None if x is None or x == "" else float(x)
            except (TypeError, ValueError):
                return None

        opts = self.entry.options
        res = drive_trips.update(
            self._open_trip,
            {
                "t": time.time() * 1000,
                "odometerKm": _num(v.get("odometer")),
                "batteryPct": _num(v.get("ev_battery_percentage")),
                "charging": v.get("ev_battery_is_charging"),
                "carOn": v.get("engine_is_running"),
                "locationLat": _num(v.get("location_latitude")),
                "locationLon": _num(v.get("location_longitude")),
            },
            {
                "pricePerKwh": opts.get("price_per_kwh") or 0,
                "capacityKwh": opts.get("capacity_kwh") or _num(v.get("ev_battery_capacity")),
            },
        )
        changed = res["open"] != self._open_trip
        self._open_trip = res["open"]
        if res["closed"]:
            self._trips.append(res["closed"])
            keep_after = (time.time() * 1000) - 365 * 864e5
            self._trips = [
                t for t in self._trips if t and t.get("endedAt", 0) >= keep_after
            ][-500:]
            changed = True
            _LOGGER.info(
                "Kia Access trip logged: %s mi%s",
                res["closed"].get("distanceMi"),
                f" @ {res['closed'].get('miPerKwh')} mi/kWh" if res["closed"].get("miPerKwh") else "",
            )
        if changed:
            await self._trips_store.async_save(
                {"trips": self._trips, "open": self._open_trip}
            )

    @property
    def trip_log(self) -> dict:
        """Data for the trip sensors + cost-per-mile."""
        recent = sorted(self._trips, key=lambda t: t.get("endedAt", 0), reverse=True)
        return {
            "last": recent[0] if recent else None,
            "recent": recent[:30],
            "last_30_days": drive_trips.summary(self._trips, 30),
            "last_90_days": drive_trips.summary(self._trips, 90),
            "lifetime": drive_trips.summary(self._trips, 36500),
        }

    # continental US + Alaska + Hawaii bounding boxes — keeps foreign zones
    # (e.g. UK "Parent's") out of the reachable-destinations list
    _US_BOXES = (
        (24.4, 49.5, -125.0, -66.9),
        (51.0, 71.6, -179.9, -129.0),
        (18.8, 22.3, -160.5, -154.7),
    )

    @classmethod
    def _in_us(cls, lat, lon) -> bool:
        if lat is None or lon is None:
            return False
        return any(a <= lat <= b and c <= lon <= d for a, b, c, d in cls._US_BOXES)

    def _zone_pois(self) -> list[dict]:
        """Every US zone.* as {name, lat, lon}. This is the full set — Home
        Assistant (dashboard / sensor) always sees all of them. The
        `zone_entities` option only narrows the MagicMirror panel, and the
        mirror applies that itself (via the mm_zone_filter attribute)."""
        out = []
        for st in self.hass.states.async_all("zone"):
            lat = st.attributes.get("latitude")
            lon = st.attributes.get("longitude")
            if not self._in_us(lat, lon):
                continue
            out.append(
                {
                    "name": st.attributes.get("friendly_name")
                    or st.entity_id.split(".", 1)[-1].replace("_", " ").title(),
                    "lat": lat,
                    "lon": lon,
                }
            )
        return out

    async def _geocode_provider(self, provider: str, key: str, address: str):
        """Forward-geocode via the routing provider (Geoapify / TomTom). Raises
        on any failure so the caller can record the reason."""
        req = drive_routing.geocode_request(provider, address, key)
        if not req:
            raise RuntimeError("no geocode request")
        hit = drive_routing.parse_geocode(provider, await self._http_json(req))
        if not hit:
            raise RuntimeError("no match")
        return hit["lat"], hit["lon"]

    async def _geocode_cached(self, address: str):
        """address -> (lat, lon). Tries the routing provider's geocoder first
        (Nominatim increasingly blocks generic clients), then Nominatim.
        Successful lookups persist; failures are NOT cached and the reason is
        stashed on _cal_status. Returns [lat, lon] or None."""
        key = " ".join(address.lower().split())[:200]
        if key in self._geo_cache:
            ll = self._geo_cache[key]
            if self._valid_ll(ll):
                self._cal_status.setdefault("geocoded_ok", []).append(
                    {"address": address, "lat": round(ll[0], 4),
                     "lon": round(ll[1], 4), "via": "cache"}
                )
                return [ll[0], ll[1]]
            self._geo_cache.pop(key, None)  # stale bad entry — fall through

        opts = self.entry.options
        provider = (opts.get("drive_time_provider") or "").strip()
        rkey = (opts.get("routing_api_key") or "").strip()
        gkey = (opts.get("geocoding_api_key") or "").strip()
        # geocoder chain: an explicit Geoapify geocoding key first (its free
        # geocoding is reliable and unlike TomTom is always on a plain key),
        # then the routing provider's own geocoder, then Nominatim.
        chain: list[tuple[str, str]] = []
        if gkey:
            chain.append(("geoapify", gkey))
        if rkey and (provider in drive_routing.PROVIDERS):
            chain.append((provider, rkey))
        elif rkey and not gkey:
            chain.append(("geoapify", rkey))
        attempts: list[str] = []
        latlon = None
        via = None

        for gc_provider, gc_key in chain:
            if latlon is not None:
                break
            try:
                latlon = await self._geocode_provider(gc_provider, gc_key, address)
                via = gc_provider
            except Exception as err:  # noqa: BLE001
                attempts.append(f"{gc_provider}: {err}")

        if latlon is None:
            try:
                lat, lon, _ = await self.hass.async_add_executor_job(
                    kia_client._geocode, address  # noqa: SLF001
                )
                latlon = (lat, lon)
                via = "nominatim"
            except Exception as err:  # noqa: BLE001
                attempts.append(f"nominatim: {err}")

        if latlon is None:
            msg = f"{address!r}: " + "; ".join(attempts)
            _LOGGER.warning("Kia Access: could not geocode %s", msg)
            self._cal_status.setdefault("geocode_errors", []).append(msg)
            return None

        lat, lon = latlon
        if not self._in_us(lat, lon):
            _LOGGER.debug("Kia Access: %r geocoded outside the US, skipping", address)
            self._cal_status.setdefault("geocode_errors", []).append(
                f"{address!r}: outside US ({round(lat, 3)},{round(lon, 3)})"
            )
            return None
        self._geo_cache[key] = [lat, lon]
        await self._geo_store.async_save({"geo": self._geo_cache})
        self._cal_status.setdefault("geocoded_ok", []).append(
            {"address": address, "lat": round(lat, 4), "lon": round(lon, 4),
             "via": via}
        )
        return [lat, lon]

    @staticmethod
    def _parse_static_destinations(raw: str) -> list[tuple[str, str]]:
        """'Museum | 100 Main St\\nAirport = 1 Terminal Rd' -> [(name, address), ...]"""
        out = []
        for line in (raw or "").replace(";", "\n").splitlines():
            line = line.strip()
            if not line:
                continue
            for sep in ("|", "="):
                if sep in line:
                    name, addr = line.split(sep, 1)
                    out.append((name.strip(), addr.strip()))
                    break
            else:
                out.append((line.split(",")[0].strip(), line))
        return [(n, a) for n, a in out if a]

    async def _refresh_static_pois(self) -> None:
        """Geocode the fixed 'static_destinations' addresses (cached)."""
        raw = self.entry.options.get("static_destinations") or ""
        pairs = self._parse_static_destinations(raw)
        pois: list[dict] = []
        for name, addr in pairs[:12]:
            ll = await self._geocode_cached(addr)
            if ll:
                pois.append({"name": name[:40], "lat": ll[0], "lon": ll[1]})
        self._static_pois = pois
        self._cal_status["static_raw_len"] = len(raw)
        self._cal_status["static_parsed"] = len(pairs)
        self._cal_status["static_geocoded"] = len(pois)
        if pairs:
            self._cal_status["static"] = [
                {"name": n, "geocoded": any(p["name"] == n[:40] for p in pois)}
                for n, _ in pairs
            ]
        if pairs:
            self._cal_status["static"] = [p["name"] for p in pois]

    async def async_refresh_calendar_pois(self) -> None:
        """Pull locations off the configured calendars for the next N hours,
        geocode them (US only), and cache as POIs for the range-reach readout."""
        raw = self.entry.options.get("calendar_entities") or ""
        cals = [c.strip() for c in raw.replace(",", " ").split() if c.strip()]
        self._cal_status = {"calendars": cals, "events": 0, "with_location": 0,
                            "geocoded": 0, "errors": [], "seen": []}
        await self._refresh_static_pois()
        if not cals:
            self._cal_pois = []
            if not self._static_pois:
                self._cal_status["errors"].append(
                    "no calendars or static_destinations configured (Settings -> "
                    "Devices -> Kia Access -> Configure)"
                )
            return
        hours = float(self.entry.options.get("calendar_lookahead_hours") or 72)
        start = dt_util.now()
        end = start + timedelta(hours=hours)
        pois: list[dict] = []
        seen: set[str] = set()
        for cal in cals:
            if self.hass.states.get(cal) is None:
                self._cal_status["errors"].append(f"{cal}: no such entity")
                continue
            try:
                resp = await self.hass.services.async_call(
                    "calendar", "get_events",
                    {"entity_id": cal, "start_date_time": start.isoformat(),
                     "end_date_time": end.isoformat()},
                    blocking=True, return_response=True,
                )
            except Exception as err:  # noqa: BLE001
                self._cal_status["errors"].append(f"{cal}: {err}")
                continue
            # response shapes vary: {cal: {events: [...]}} or {events: [...]}
            block = (resp or {}).get(cal) if isinstance(resp, dict) else None
            events = (block or resp or {}).get("events", []) if isinstance(
                block or resp or {}, dict) else []
            if not events:
                self._cal_status["errors"].append(
                    f"{cal}: no events in the next {hours:g}h "
                    f"(response keys: {list(resp.keys()) if isinstance(resp, dict) else type(resp).__name__})"
                )
            self._cal_status["events"] += len(events)
            for ev in events:
                loc = (ev.get("location") or "").strip()
                summary = (ev.get("summary") or "Event").strip()
                when = ev.get("start") or ev.get("start_time") or None
                if not loc:
                    self._cal_status["seen"].append(
                        {"summary": summary[:40], "location": None, "result": "no location"}
                    )
                    continue
                self._cal_status["with_location"] += 1
                if loc.lower() in seen:
                    continue
                seen.add(loc.lower())
                ll = await self._geocode_cached(loc)
                if ll:
                    self._cal_status["geocoded"] += 1
                    self._cal_status["seen"].append(
                        {"summary": summary[:40], "location": loc,
                         "result": f"ok -> {round(ll[0], 4)},{round(ll[1], 4)}"}
                    )
                    pois.append({"name": summary[:40], "lat": ll[0],
                                 "lon": ll[1], "when": when})
                else:
                    self._cal_status["seen"].append(
                        {"summary": summary[:40], "location": loc,
                         "result": "geocode failed (see geocode_errors)"}
                    )
        self._cal_pois = pois[:12]
        self._cal_status["pois"] = [
            {"name": p["name"], "lat": round(p["lat"], 4), "lon": round(p["lon"], 4)}
            for p in self._cal_pois
        ]
        _LOGGER.info(
            "Kia Access calendar destinations: %s event(s), %s with a location, "
            "%s geocoded%s",
            self._cal_status["events"], self._cal_status["with_location"],
            self._cal_status["geocoded"],
            f" — {'; '.join(self._cal_status['errors'])}"
            if self._cal_status["errors"] else "",
        )

    @staticmethod
    def _poi_key(lat, lon) -> str:
        return f"{round(float(lat), 4)},{round(float(lon), 4)}"

    def _reach_pois(self) -> list[dict]:
        """Zone + static + calendar POIs, de-duped by name (earlier list wins)."""
        out = self._zone_pois() + self._static_pois
        seen = {p["name"] for p in out}
        for p in self._cal_pois:
            if p["name"] not in seen:
                out.append(p)
                seen.add(p["name"])
        return out

    @property
    def range_reach(self) -> dict | None:
        """How far the car can drive now + which zones are in reach."""

        def _n(x):
            try:
                return None if x in (None, "") else float(x)
            except (TypeError, ValueError):
                return None

        lat = _n(self.vehicle.get("location_latitude"))
        lon = _n(self.vehicle.get("location_longitude"))
        rng = _n(self.vehicle.get("ev_driving_range")) or _n(
            self.vehicle.get("total_driving_range")
        )
        if lat is None or lon is None or not rng:
            return None
        opts = self.entry.options
        pct = _n(self.vehicle.get("ev_battery_percentage"))
        o = {
            "factor": opts.get("range_factor") or drive_range.DEFAULTS["factor"],
            "reservePct": opts.get("range_reserve_pct")
            if opts.get("range_reserve_pct") is not None
            else drive_range.DEFAULTS["reservePct"],
            "batteryPct": pct,
            "roadFactor": 1.3,
        }
        out = drive_range.summary(lat, lon, rng, self._reach_pois(), o)

        # overlay real road distance + drive time where the routing provider
        # gave us a number (straight-line estimate is the fallback)
        cal_when = {c["name"]: c.get("when") for c in self._cal_pois}
        reach_km = out.get("reachKm")
        for p in out.get("pois") or []:
            if p["name"] in cal_when and cal_when[p["name"]]:
                p["when"] = cal_when[p["name"]]
            rt = self._route_out.get(self._poi_key(p["lat"], p["lon"]))
            if not rt:
                continue
            p["km"] = rt["distanceKm"]
            p["durationMin"] = rt["durationMin"]
            p["routed"] = True
            if rt.get("typicalMin") is not None:
                p["typicalMin"] = rt["typicalMin"]
                p["delayMin"] = rt.get("delayMin")
            if rt.get("via"):
                p["via"] = rt["via"]
            if reach_km is not None:
                p["reachable"] = rt["distanceKm"] <= reach_km
                p["marginKm"] = reach_km - rt["distanceKm"]
            if pct is not None and rng:
                p["arrivalPct"] = round(max(0, pct * (1 - rt["distanceKm"] / rng)))
        out["pois"] = sorted(out.get("pois") or [], key=lambda x: x["km"])
        out["drive_time_source"] = (
            self.entry.options.get("drive_time_provider") or "estimate"
        )
        return out

    async def _refresh_drive_times(self) -> None:
        """Ask the configured routing provider for real car -> POI drive times.

        Throttled to 10 min, but also re-runs whenever the car has moved > 1 km
        since the last matrix so the ETAs track the drive.
        """
        provider = (self.entry.options.get("drive_time_provider") or "estimate").strip()
        key = (self.entry.options.get("routing_api_key") or "").strip()
        self._route_status = {"provider": provider, "targets": 0, "routed": 0,
                              "at": None, "error": None}
        if provider not in drive_routing.PROVIDERS or not key:
            self._route_out = {}
            return

        def _n(x):
            try:
                return None if x in (None, "") else float(x)
            except (TypeError, ValueError):
                return None

        lat = _n(self.vehicle.get("location_latitude"))
        lon = _n(self.vehicle.get("location_longitude"))
        if lat is None or lon is None:
            return
        pois = self._reach_pois()
        if not pois:
            self._route_out = {}
            return

        moved = (
            self._route_origin is None
            or self._haversine_km(lat, lon, self._route_origin[0], self._route_origin[1])
            > 1.0
        )
        if not moved and time.monotonic() - self._route_at < 600:
            return

        self._route_status["targets"] = len(pois)
        origin = {"lat": lat, "lon": lon}
        out: dict = {}

        # 1) one matrix call for a fast baseline (time + distance for all)
        req = drive_routing.matrix_request(
            provider, origin, [{"lat": p["lat"], "lon": p["lon"]} for p in pois],
            key, {"traffic": True},
        )
        if req:
            try:
                data = await self._http_json(req)
                for p, row in zip(
                    pois, drive_routing.parse_matrix(provider, data, len(pois))
                ):
                    if row:
                        out[self._poi_key(p["lat"], p["lon"])] = dict(row)
            except Exception as err:  # noqa: BLE001
                self._route_status["error"] = f"matrix: {err}"
                _LOGGER.warning("Kia Access: drive-time matrix (%s) failed: %s",
                                provider, err)

        # 2) per-destination route calls enrich with the road breakdown + the
        #    free-flow time (for the traffic-delay colouring). TomTom only, and
        #    only when `drive_time_routes` isn't turned off.
        do_routes = (
            provider == "tomtom"
            and self.entry.options.get("drive_time_routes", True)
        )
        self._route_status["routes_enabled"] = do_routes
        n_routed = 0
        route_errs: dict = {}
        if do_routes:
            if req:
                await asyncio.sleep(0.5)  # gap after the matrix call
            for i, p in enumerate(pois):
                if i:
                    await asyncio.sleep(0.5)  # some TomTom keys cap at ~1-2 req/s
                rreq = drive_routing.route_request(
                    provider, origin, {"lat": p["lat"], "lon": p["lon"]}, key,
                    {"traffic": True},
                )
                if not rreq:
                    continue
                parsed = None
                for attempt in (1, 2):
                    try:
                        rdata = await self._http_json(rreq)
                        parsed = drive_routing.parse_route(provider, rdata)
                        if not parsed:
                            raise RuntimeError("no route in response")
                        break
                    except Exception as err:  # noqa: BLE001
                        msg = str(err)[:160]
                        if attempt == 1 and ("429" in msg or "403" in msg):
                            await asyncio.sleep(1.5)  # back off once on a rate limit
                            continue
                        route_errs[p["name"]] = msg
                        _LOGGER.warning("Kia Access: route call for %r failed: %s",
                                        p["name"], err)
                        break
                if parsed:
                    out.setdefault(self._poi_key(p["lat"], p["lon"]), {}).update(parsed)
                    n_routed += 1
        if route_errs:
            self._route_status["route_errors"] = route_errs
            self._route_status["route_error"] = next(iter(route_errs.values()))

        self._route_out = out
        self._route_origin = (lat, lon)
        self._route_at = time.monotonic()
        self._route_status["routed"] = len(out)
        self._route_status["with_roads"] = n_routed
        self._route_status["at"] = dt_util.utcnow().isoformat()
        _LOGGER.info(
            "Kia Access drive times (%s): %s/%s routed, %s with road detail",
            provider, len(out), len(pois), n_routed,
        )

    async def _http_json(self, req: dict):
        """GET/POST a routing request dict and return parsed JSON."""
        from homeassistant.helpers.aiohttp_client import async_get_clientsession

        session = async_get_clientsession(self.hass)
        method = (req.get("method") or "GET").upper()
        async with asyncio.timeout(20):
            if method == "POST":
                ctx = session.post(
                    req["url"], data=req.get("body"), headers=req.get("headers"),
                )
            else:
                ctx = session.get(req["url"])
            async with ctx as resp:
                if resp.status >= 400:
                    body = (await resp.text())[:200]
                    raise RuntimeError(f"HTTP {resp.status}: {body}")
                return await resp.json(content_type=None)

    @staticmethod
    def _clean_address(v) -> str | None:
        """The geocoder hands back a (name, display_name, raw_dict) tuple — pull
        a short readable street/area out of whatever shape it is."""
        if v in (None, "", "—"):
            return None
        if isinstance(v, str):
            return v
        if isinstance(v, (list, tuple)):
            strs = [x for x in v if isinstance(x, str) and x.strip()]
            if strs:
                # the first element is usually the short name, the second the
                # long "display name" — prefer the short one, cap the long one
                short = strs[0]
                return short if len(short) <= 60 else short[:57] + "…"
            for x in v:
                got = KiaAccessCoordinator._clean_address(x)
                if got:
                    return got
            return None
        if isinstance(v, dict):
            for keys in (
                ("house_number", "road"), ("road",), ("neighbourhood", "suburb"),
                ("hamlet", "village", "town"), ("city", "county"),
            ):
                parts = [str(v[k]) for k in keys if v.get(k)]
                if parts:
                    return " ".join(parts) if len(keys) == 2 else parts[0]
            return None
        return str(v)

    @property
    def parked_location(self) -> dict | None:
        """Where the car was last seen parked, with map links + distance home."""
        p = self._parked
        if not p:
            return None
        lat, lon = p.get("lat"), p.get("lon")
        if lat is None or lon is None:
            return None
        hlat, hlon, _ = self._home_point()
        km_home = self._haversine_km(lat, lon, hlat, hlon)
        ll = f"{lat},{lon}"
        return {
            "latitude": lat,
            "longitude": lon,
            "address": self._clean_address(p.get("address")),
            "parked_at": p.get("at"),
            "km_from_home": round(km_home, 2) if km_home is not None else None,
            "mi_from_home": round(km_home * 0.621371, 2) if km_home is not None else None,
            "google_maps": f"https://www.google.com/maps/search/?api=1&query={ll}",
            "apple_maps": f"https://maps.apple.com/?ll={ll}&q=Car",
            "osm": f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=18/{lat}/{lon}",
        }

    @property
    def charge_log(self) -> dict:
        """Data for the last-charge sensor."""
        recent = sorted(
            self._sessions, key=lambda s: s.get("endedAt", 0), reverse=True
        )
        return {
            "last": recent[0] if recent else None,
            "recent": recent[:20],
            "month": charge_sessions.summary(self._sessions, 30),
            "last_3_months": charge_sessions.summary(self._sessions, 90),
        }

    def _poll_car_directly(self) -> bool:
        """Master switch: wake the car for live data (vs. Kia's server cache)."""
        opts = self.entry.options
        if "poll_car_directly" in opts:
            return bool(opts["poll_car_directly"])
        # pre-toggle installs: infer from the old seconds-based option
        try:
            return float(opts.get("force_refresh_timeout", 0) or 0) > 0
        except (TypeError, ValueError):
            return False

    def _job(self, **extra) -> dict:
        d = self.entry.data
        job = {
            "username": d["username"],
            "password": d["password"],
            "pin": d.get(CONF_PIN, ""),
            "region": d.get(CONF_REGION, "USA"),
            "brand": d.get(CONF_BRAND, "KIA"),
            "vin": d.get(CONF_VIN, ""),
            "geocode": d.get(CONF_GEOCODE, False),
            "token": d.get(CONF_TOKEN),
            # "Poll the car directly" is the master switch. When it's off (the
            # default — kinder to the 12V battery) every update takes Kia's
            # server-side cache. Two independent guards enforce that, either of
            # which alone stops kia_client from waking the car:
            #   refresh: False           -> the wake branch is skipped entirely
            #   forceRefreshTimeout: 0   -> ...and even if it ran, 0s wait
            "refresh": self._poll_car_directly(),
            "forceRefreshTimeout": (
                self.entry.options.get(
                    "force_refresh_timeout", DEFAULT_FORCE_REFRESH_TIMEOUT
                )
                if self._poll_car_directly()
                else 0
            ),
        }
        job.update(extra)
        return job

    async def _async_update_data(self) -> dict:
        job = self._job()
        try:
            result = await self.hass.async_add_executor_job(kia_client.fetch, job)
        except kia_client.OtpRequired as err:
            # triggers HA's reauth flow instead of an endless retry
            raise ConfigEntryAuthFailed(
                "Kia needs re-enrollment (one-time code)."
            ) from err
        except kia_client.ClientError as err:
            raise UpdateFailed(str(err)) from err
        except Exception as err:  # noqa: BLE001
            raise UpdateFailed(f"{type(err).__name__}: {err}") from err

        self.meta = result.get("meta", {}) or {}
        # persist a rotated refresh token back into the config entry.
        # async_update_entry fires the update listener, but _async_options_updated
        # ignores data-only changes so this does not reload the integration.
        new_token = self.meta.pop("token", None)
        if new_token and new_token != self.entry.data.get(CONF_TOKEN):
            self.hass.config_entries.async_update_entry(
                self.entry,
                data={**self.entry.data, CONF_TOKEN: new_token},
            )
        self.vehicle = (result.get("vehicles") or [{}])[0]
        await self._update_sessions()
        await self._update_trips()
        # refresh calendar destinations at most every 30 min (each is a geocode)
        if time.monotonic() - self._cal_pois_at > 1800:
            self._cal_pois_at = time.monotonic()
            try:
                await self.async_refresh_calendar_pois()
            except Exception:  # noqa: BLE001
                _LOGGER.debug("calendar POI refresh failed", exc_info=True)
        try:
            await self._refresh_drive_times()
        except Exception:  # noqa: BLE001
            _LOGGER.debug("drive-time refresh failed", exc_info=True)
        self._emit_alerts()
        return self.vehicle

    @staticmethod
    def _haversine_km(a_lat, a_lon, b_lat, b_lon) -> float | None:
        if None in (a_lat, a_lon, b_lat, b_lon):
            return None
        r, p = 6371.0, math.pi / 180.0
        a = (
            0.5
            - math.cos((b_lat - a_lat) * p) / 2
            + math.cos(a_lat * p) * math.cos(b_lat * p) * (1 - math.cos((b_lon - a_lon) * p)) / 2
        )
        return r * 2 * math.asin(math.sqrt(a))

    def _home_point(self) -> tuple[float | None, float | None, float]:
        zone = self.hass.states.get("zone.home")
        if zone is None:
            return None, None, 100.0
        return (
            zone.attributes.get("latitude"),
            zone.attributes.get("longitude"),
            float(zone.attributes.get("radius", 100)),
        )

    def _at_home(self, state: dict) -> bool | None:
        """Within zone.home's radius? None if the zone or a GPS fix is missing."""
        hlat, hlon, radius_m = self._home_point()
        lat = state.get("locationLat")
        lon = state.get("locationLon")
        km = self._haversine_km(lat, lon, hlat, hlon)
        if km is None:
            return None
        return km * 1000 <= radius_m

    def _emit_alerts(self) -> None:
        """Fire kia_access_alert events on edge-triggered condition changes,
        using the exact same rules as the MagicMirror module (conditions.py)."""
        flat = {f"vehicle.{k}": v for k, v in self.vehicle.items()
                if not isinstance(v, (dict, list))}
        if self.meta.get("tokenEnrolledAt"):
            flat["_meta.tokenEnrolledAt"] = self.meta["tokenEnrolledAt"]
        cfg = self.entry.options.get("notifications", {}) or {}
        units = "metric" if self.hass.config.units is METRIC_SYSTEM else "imperial"
        state = build_state(flat, {"units": units})

        # home / not-plugged-in context
        state["atHome"] = self._at_home(state)
        home_unplugged = state["atHome"] is True and state.get("plugged") is not True
        if home_unplugged and self._home_unplugged_since is None:
            self._home_unplugged_since = time.monotonic()
        if not home_unplugged:
            self._home_unplugged_since = None
        state["homeUnpluggedMin"] = (
            (time.monotonic() - self._home_unplugged_since) / 60
            if self._home_unplugged_since is not None
            else None
        )

        # distance car -> home for the "can't get home" check
        hlat, hlon, _ = self._home_point()
        state["homeDistanceKm"] = self._haversine_km(
            state.get("locationLat"), state.get("locationLon"), hlat, hlon
        )

        # moved-while-parked (tow / theft): GPS shifted while the odometer stayed
        # put and the car was off
        lat, lon = state.get("locationLat"), state.get("locationLon")
        odo = state.get("odometerKm")
        p = self._last_parked
        odo_stable = p is not None and odo is not None and abs(odo - p["odo"]) < 0.1
        if odo_stable and state.get("carOn") is not True and lat is not None:
            moved = self._haversine_km(p["lat"], p["lon"], lat, lon)
            if moved is not None and moved >= 0.15:
                if self._moved_since is None:
                    self._moved_since = time.monotonic()
                state["movedWhileParkedKm"] = moved
                state["movedWhileParkedMin"] = (time.monotonic() - self._moved_since) / 60
            else:
                self._moved_since = None
                state["movedWhileParkedKm"] = 0
                state["movedWhileParkedMin"] = 0
        else:
            self._moved_since = None
            if lat is not None and odo is not None:
                self._last_parked = {"lat": lat, "lon": lon, "odo": odo}
            state["movedWhileParkedKm"] = 0 if self._last_parked else None
            state["movedWhileParkedMin"] = 0

        # "where did I park" — snapshot on the drive->park transition (and once
        # on startup if the car is already parked with a fix)
        car_on = state.get("carOn") is True
        just_parked = self._was_on is True and not car_on
        if (just_parked or self._parked is None) and not car_on and lat is not None:
            self._parked = {
                "lat": lat,
                "lon": lon,
                "at": dt_util.utcnow().isoformat(),
                "address": self.vehicle.get("location_name")
                or self.vehicle.get("geocode"),
            }
        self._was_on = car_on

        try:
            res = evaluate_conditions(state, cfg, self._prev_cond)
        except Exception:  # noqa: BLE001
            _LOGGER.debug("condition evaluation failed", exc_info=True)
            return

        startup = self._first_alert_run
        # match the MagicMirror module: on the first run after (re)start, only
        # fire what `notifyOnStartup` allows (default: critical only)
        startup_mode = cfg.get("notifyOnStartup", "critical")

        def _startup_allows(level: str) -> bool:
            return startup_mode is True or (startup_mode == "critical" and level == "critical")

        vin = self.vehicle.get("VIN")
        for c in res["conditions"]:
            reason = c["reason"]
            was = self._prev_cond.get(reason)
            became = c["active"] is True and was is not True
            cleared = (
                not c["oneShot"] and c["active"] is False and was is True
                and self._announced.get(reason)
            )
            if startup:
                fire = became and _startup_allows(c["level"])
            else:
                fire = became or cleared
            if became and fire:
                self._announced[reason] = True
            if cleared:
                self._announced[reason] = False
            if fire:
                self.hass.bus.async_fire(
                    EVENT_STATE_CHANGED,
                    {
                        "entry_id": self.entry.entry_id,
                        "reason": reason,
                        "level": c["level"],
                        "active": c["active"],
                        "title": c["title"],
                        "message": c["message"],
                        "value": c["value"],
                        "vin": vin,
                    },
                )

        # keep the last *known* state per reason (don't clobber with None when a
        # value is temporarily unknown) — matches conditions.js hysteresis intent
        for c in res["conditions"]:
            if c["active"] is not None:
                self._prev_cond[c["reason"]] = c["active"]
        self._prev_cond["_charging"] = res["meta"]["charging"]
        self._first_alert_run = False

    # commands gated by the "block automated climate" option
    _CLIMATE_COMMANDS = frozenset({"start_climate", "stop_climate"})

    def _climate_blocked(self, command: str, context) -> bool:
        """True when this is an automated climate call and the user has asked
        for climate to be manual-only. A direct UI / Developer-Tools / card
        action carries a user_id in its context; an automation/script/scene
        does not."""
        if command not in self._CLIMATE_COMMANDS:
            return False
        if not self.entry.options.get("block_automated_climate"):
            return False
        return getattr(context, "user_id", None) is None

    async def async_run_command(
        self, command: str, options: dict | None = None, context=None
    ) -> None:
        if self._climate_blocked(command, context):
            from homeassistant.exceptions import HomeAssistantError

            raise HomeAssistantError(
                "Kia Access: automated climate control is disabled "
                "('Block automated climate' option). Start it by hand from the "
                "card, the button, or Developer Tools."
            )
        job = self._job(command=command, options=options or {})
        self.last_action = {
            "name": command,
            "status": "running",
            "at": dt_util.utcnow().isoformat(),
        }
        self.async_update_listeners()
        try:
            await self.hass.async_add_executor_job(kia_client.run_command, job)
            self.last_action = {**self.last_action, "status": "done"}
        except Exception:
            self.last_action = {**self.last_action, "status": "failed"}
            raise
        finally:
            self.async_update_listeners()
            await self.async_request_refresh()
