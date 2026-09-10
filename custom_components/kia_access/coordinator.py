"""Data coordinator for Kia Access."""
from __future__ import annotations

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

    async def async_load_prefs(self) -> None:
        data = await self._prefs_store.async_load() or {}
        self.climate_prefs = {**DEFAULT_CLIMATE_PREFS, **data}

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

    def _zone_pois(self) -> list[dict]:
        """Every zone.* as {name, lat, lon} for the range-reach readout."""
        out = []
        for st in self.hass.states.async_all("zone"):
            lat = st.attributes.get("latitude")
            lon = st.attributes.get("longitude")
            if lat is None or lon is None:
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
        o = {
            "factor": opts.get("range_factor") or drive_range.DEFAULTS["factor"],
            "reservePct": opts.get("range_reserve_pct")
            if opts.get("range_reserve_pct") is not None
            else drive_range.DEFAULTS["reservePct"],
            "batteryPct": _n(self.vehicle.get("ev_battery_percentage")),
            "roadFactor": 1.3,
        }
        return drive_range.summary(lat, lon, rng, self._zone_pois(), o)

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
            # server-side cache: forceRefreshTimeout 0 tells kia_client not to
            # wake the car. When on, we wait up to force_refresh_timeout seconds
            # for a live reading before falling back to the cache.
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
        job = self._job(refresh=True)
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

    async def async_run_command(self, command: str, options: dict | None = None) -> None:
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
