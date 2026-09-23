"""Data coordinator for Kia Access."""
from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util
from homeassistant.util.unit_system import METRIC_SYSTEM

from . import account_poll
from . import analytics as observed_analytics
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
    DEFAULT_STALE_AFTER_MINUTES,
    DOMAIN,
    EVENT_KIA_ACCESS_ALERT,
    brand_display_name,
)

# USA only, NOT Canada -- see kia_client.py's matching comment (root, and
# its synced custom_components copy) on `fahrenheit`: KiaUvoApiCA.
# start_climate takes set_temp in Celsius and raises an unhandled ValueError
# on any Fahrenheit-range value, so classifying CA as Fahrenheit here broke
# remote climate start for every Canadian account.
_FAHRENHEIT_REGIONS = {"USA"}

# Below this, a `charger_power_entity` reading counts as "not really
# charging" -- BMS balancing / 12V-system idle draw on a plugged-in car can
# sit in the low tens of watts even once the traction battery itself is
# done, so this needs to clear that noise floor without being so high it
# ignores genuine trickle-charging near a full battery.
CHARGER_POWER_ACTIVE_THRESHOLD_W = 50

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
        # set by __init__.py's async_setup_entry right after construction,
        # before this coordinator's first refresh -- see account_poll.py
        self.account_poller: account_poll.AccountPoller | None = None
        self.vehicle: dict = {}
        self.meta: dict = {}
        # set at the end of every SUCCESSFUL update (fetch_err is None,
        # below) -- distinct from DataUpdateCoordinator's own
        # last_update_success (a bool, flips back to True the moment a poll
        # merely succeeds again) and from vehicle.last_updated_at (the CAR's
        # own self-reported check-in time, which a successful poll can
        # legitimately echo back unchanged for a while). This is "when did
        # WE last hear anything at all from Kia's cloud", used alongside
        # is_stale (below) to distinguish "poll is failing" (HA already
        # marks entities unavailable for that) from "polls keep succeeding,
        # but the car itself hasn't reported anything new in a while".
        self.last_successful_update: datetime | None = None
        self._prev_cond: dict = {}
        self._announced: dict = {}
        self._first_alert_run = True
        self._home_unplugged_since: float | None = None
        self._last_parked: dict | None = None
        self._moved_since: float | None = None
        self._parked: dict | None = None
        # in-progress session on the *external* charger_status_entity (Emporia,
        # ChargePoint, any HA integration exposing a charging-status entity) --
        # entirely separate from self._open_session (the car-reported session
        # sessions.py tracks for the cost log): this one exists purely to time
        # a start/stop pair for the charger_charging_started/_stopped alerts,
        # so it works the same regardless of which charger brand is plugged
        # into this option. None when no session is open OR no
        # charger_status_entity is configured.
        self._charger_session: dict | None = None
        self._was_on: bool | None = None
        self._awaiting_park_fix: bool = False
        self._calendar_lock = asyncio.Lock()
        # DataUpdateCoordinator's debouncer only serializes debounced
        # async_request_refresh() calls against EACH OTHER -- the scheduled
        # interval timer calls _async_refresh()/_async_update_data() directly,
        # bypassing that debouncer entirely. So a manual "Refresh now" (which
        # goes through async_request_refresh()) landing while a scheduled
        # poll is already mid-flight can genuinely run this method
        # concurrently with itself, racing self.vehicle / self._force_next_
        # refresh / _update_sessions() / _update_trips() / _emit_alerts()'s
        # shared state. Serialize the whole update instead.
        self._update_lock = asyncio.Lock()
        # async_run_command() had no lock at all -- two nearly-simultaneous
        # calls (an automation firing stop_charge right as a user taps
        # "Start charge" from a different session, say) each independently
        # popped self._unconfirmed_commands and ran their own executor job,
        # fully concurrently. Whichever one's success/failure handler ran
        # LAST silently overwrote self.last_action regardless of actual
        # completion order, and both dispatched to Kia's API with no
        # ordering guarantee at all -- for a stateful pair like start/stop
        # charge, that's two contradictory commands in flight at once with
        # no serialization. Same fix as _update_lock above: run the whole
        # command body under one lock so a second call waits for the first
        # to actually finish (and reflects the truthful last-completed
        # state) instead of racing it.
        self._command_lock = asyncio.Lock()
        # wall-clock (time.time(), not time.monotonic()) so a HA restart mid-
        # "how long has this been continuously true" window doesn't silently
        # reset the clock on the not-plugged-in-at-home / moved-while-parked
        # alert timers -- loaded back in async_load_prefs(), saved in
        # _emit_alerts() whenever either value actually changes.
        self._timers_store = Store(hass, 1, f"{DOMAIN}_timers_{entry.entry_id}")
        self._geo_cache: dict = {}
        self._geo_store = Store(hass, 1, f"{DOMAIN}_geocache_{entry.entry_id}")
        self._cal_pois: list[dict] = []
        self._static_pois: list[dict] = []
        self._cal_status: dict = {}
        # keep the assembled destinations across a reload (option changes reload
        # the entry a lot; without this the calendar list blinks out for ~30 min)
        self._cal_store = Store(hass, 1, f"{DOMAIN}_caldest_{entry.entry_id}")
        # real drive-times from a routing provider, keyed by _poi_key(lat, lon)
        self._route_out: dict = {}
        self._route_at: float = 0.0
        self._route_origin: tuple | None = None
        self._route_status: dict = {}
        self._sessions: list[dict] = []
        self._open_session: dict | None = None
        self._ext_pending: dict | None = None  # away session awaiting a public cost
        self._sessions_store = Store(hass, 1, f"{DOMAIN}_sessions_{entry.entry_id}")
        self._trips: list[dict] = []
        self._open_trip: dict | None = None
        self._trips_store = Store(hass, 1, f"{DOMAIN}_trips_{entry.entry_id}")
        self._prefs_store = Store(hass, 1, f"{DOMAIN}_prefs_{entry.entry_id}")
        self.climate_prefs: dict = dict(DEFAULT_CLIMATE_PREFS)
        # last control command, for the "action in progress" sensor
        self.last_action: dict = {"name": None, "status": "idle", "at": None}
        # command key -> {"since", "message"} for a command whose request
        # timed out (kia_client.CommandUnconfirmed) -- Kia's protocol gives
        # no way to ask afterward whether it actually reached the vehicle,
        # so a blind retry isn't necessarily safe (most consequential for
        # the climate/charge start-vs-stop pairs). Cleared the moment that
        # same command is attempted again, successfully or not -- the point
        # is only to flag the retry itself, not track it indefinitely.
        self._unconfirmed_commands: dict[str, dict] = {}
        # set for exactly one _job() call by async_force_refresh() -- lets the
        # manual "Refresh now" button wake the car even when "poll car
        # directly" is off for the regular scheduled polls
        self._force_next_refresh = False

    async def async_load_sessions(self) -> None:
        data = await self._sessions_store.async_load() or {}
        self._sessions = data.get("sessions") or []
        self._open_session = data.get("open") or None
        self._ext_pending = data.get("ext_pending") or None
        tdata = await self._trips_store.async_load() or {}
        self._trips = tdata.get("trips") or []
        self._open_trip = tdata.get("open") or None
        cdata = await self._cal_store.async_load() or {}
        self._cal_pois = cdata.get("cal_pois") or []
        self._static_pois = cdata.get("static_pois") or []
        self._cal_status = cdata.get("cal_status") or {}

    @staticmethod
    def _valid_ll(v) -> bool:
        if not (
            isinstance(v, (list, tuple))
            and len(v) >= 2
            and isinstance(v[0], (int, float)) and not isinstance(v[0], bool)
            and isinstance(v[1], (int, float)) and not isinstance(v[1], bool)
        ):
            return False
        lat, lon = v[0], v[1]
        # isinstance(float("nan"), float) and isinstance(float("inf"), float)
        # are both True -- a malformed geocoder response (e.g. a provider
        # returning the literal string "NaN"/"Infinity", which float()
        # happily parses) could otherwise poison the persistent geo cache.
        return (
            math.isfinite(lat) and math.isfinite(lon)
            and -90 <= lat <= 90 and -180 <= lon <= 180
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
        tmdata = await self._timers_store.async_load() or {}
        self._home_unplugged_since = tmdata.get("home_unplugged_since")
        self._moved_since = tmdata.get("moved_since")
        # _last_parked (the moved-while-parked/tow-theft anchor) used to be
        # in-memory only -- a HA restart (routine: updates, crashes) reset it
        # to None, and the car's position on the FIRST post-restart poll
        # became the new anchor unconditionally (see the `else` branch
        # below). A vehicle towed/moved WHILE HA was down would be silently
        # adopted as "where it's always been parked" instead of being
        # detected as having moved -- the exact scenario this whole
        # detector exists to catch. Restore it the same way as the other
        # two timers.
        self._last_parked = tmdata.get("last_parked")
        self._charger_session = tmdata.get("charger_session")

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
        zone_rate, zone_label = self._charge_rate()
        res = charge_sessions.update(
            self._open_session,
            {
                "t": time.time() * 1000,
                "charging": v.get("ev_battery_is_charging"),
                "plugged": v.get("ev_battery_is_plugged_in"),
                "batteryPct": _num(v.get("ev_battery_percentage")),
                "chargeKw": _num(v.get("ev_charging_power")),
                "atHome": self._charge_at_home(),
                "rate": zone_rate,
                "rateLabel": zone_label,
            },
            {
                "pricePerKwh": opts.get("price_per_kwh") or 0,
                "awayPricePerKwh": opts.get("away_price_per_kwh"),
                "capacityKwh": opts.get("capacity_kwh") or _num(v.get("ev_battery_capacity")),
                # sessions.py's DEFAULT_CAPACITY_KWH fallback is the EV9's
                # own pack size -- it only applies when this vehicle's own
                # model actually looks like an EV9 (see _resolve_cap()),
                # so it never silently borrows the EV9's battery size for
                # some other model with no configured/reported capacity.
                "model": v.get("model"),
            },
        )
        changed = res["open"] != self._open_session
        self._open_session = res["open"]
        if res["closed"]:
            s = res["closed"]
            if s.get("location") not in (None, "home"):
                ext = self._external_away_cost(s)
                if ext is not None:
                    s = charge_sessions.apply_cost(s, ext, "external")
                elif (opts.get("away_cost_entity") or "").strip():
                    # cost usually posts a few min after unplug — keep watching
                    # `or 90` would silently turn an explicitly-configured 0
                    # (the number selector's own min bound, "apply the cost
                    # the instant it's available") into 90 -- 0 is falsy.
                    _grace_opt = opts.get("away_cost_grace_min")
                    grace_min = 90 if _grace_opt is None else _grace_opt
                    self._ext_pending = {
                        "startedAt": s["startedAt"],
                        "until": (time.time() * 1000) + float(grace_min) * 60000,
                    }
            self._sessions.append(s)
            keep_after = (time.time() * 1000) - 180 * 864e5
            self._sessions = [
                x for x in self._sessions if x and x.get("endedAt", 0) >= keep_after
            ][-300:]
            changed = True
            _LOGGER.info(
                "Kia Access charge session logged: %s kWh%s (%s)",
                s.get("kwh"),
                f" / {s.get('cost')}" if s.get("cost") else "",
                s.get("costSource") or "no price",
            )

        # a just-closed away session may still be waiting for its public cost
        if self._ext_pending and self._resolve_ext_pending():
            changed = True

        if changed:
            await self._sessions_store.async_save(
                {"sessions": self._sessions, "open": self._open_session,
                 "ext_pending": self._ext_pending}
            )

    def _external_away_cost(self, session: dict) -> float | None:
        """Cost from the configured `away_cost_entity`, if it reported a fresh
        figure within this session's window (start - 10 min .. end + grace)."""
        eid = (self.entry.options.get("away_cost_entity") or "").strip()
        if not eid:
            return None
        st = self.hass.states.get(eid)
        if st is None:
            return None
        try:
            cost = float(st.state)
        except (TypeError, ValueError):
            return None
        # NaN/Infinity both fail a plain `<= 0` check (any comparison with
        # NaN is False) and would otherwise read as "we have a valid cost" --
        # sessions.py's apply_cost() already rejects them before persisting
        # (via its own _num() call), so this was never a data-integrity risk,
        # but returning a non-None "cost" here wrongly skips the caller's
        # _ext_pending retry path below, permanently missing the real cost
        # once the entity recovers and reports a proper value.
        if not math.isfinite(cost) or cost <= 0:
            return None
        # same falsy-zero pitfall as the other away_cost_grace_min read above
        _grace_opt2 = self.entry.options.get("away_cost_grace_min")
        grace = float(90 if _grace_opt2 is None else _grace_opt2) * 60000
        changed_ms = (st.last_changed or dt_util.utcnow()).timestamp() * 1000
        started = float(session.get("startedAt") or 0)
        ended = float(session.get("endedAt") or started)
        if started - 10 * 60000 <= changed_ms <= ended + grace:
            return cost
        return None

    def _resolve_ext_pending(self) -> bool:
        """Re-check the away-cost entity for a session we're still waiting on."""
        pend = self._ext_pending
        if not pend:
            return False
        if (time.time() * 1000) > pend.get("until", 0):
            self._ext_pending = None
            return False
        target = next(
            (x for x in self._sessions if x.get("startedAt") == pend["startedAt"]),
            None,
        )
        if target is None or target.get("costSource") == "external":
            self._ext_pending = None
            return False
        cost = self._external_away_cost(target)
        if cost is None:
            return False
        idx = self._sessions.index(target)
        self._sessions[idx] = charge_sessions.apply_cost(target, cost, "external")
        self._ext_pending = None
        _LOGGER.info("Kia Access: applied public charge cost %s to the %s session",
                     cost, dt_util.utc_from_timestamp(pend["startedAt"] / 1000).isoformat())
        return True

    async def set_charge_cost(self, cost: float, started_at: float | None = None) -> None:
        """Override a logged session's cost by hand (a public-charging receipt).
        `started_at` picks a session by its startedAt ms; default = most recent."""
        if not self._sessions:
            raise ValueError("no charge sessions logged yet")
        if started_at is not None:
            target = next(
                (s for s in self._sessions if s.get("startedAt") == started_at), None
            )
            if target is None:
                raise ValueError(f"no session started at {started_at}")
        else:
            target = max(self._sessions, key=lambda s: s.get("endedAt", 0))
        idx = self._sessions.index(target)
        self._sessions[idx] = charge_sessions.apply_cost(target, cost, "manual")
        self._ext_pending = None
        await self._sessions_store.async_save(
            {"sessions": self._sessions, "open": self._open_session,
             "ext_pending": self._ext_pending}
        )
        self.async_update_listeners()

    async def _update_trips(self) -> None:
        v = self.vehicle

        def _num(x):
            try:
                return None if x is None or x == "" else float(x)
            except (TypeError, ValueError):
                return None

        # carOn (and charging) must use the SAME canonical definition the
        # rest of the app uses (build_state()'s anyTrue(engine_is_running,
        # accessory_on, ign3, remote_ignition)) -- a hand-picked
        # `v.get("engine_is_running")` here would let trip tracking disagree
        # with the alert engine about whether the car is actually driving.
        flat = {f"vehicle.{k}": val for k, val in v.items()
                if not isinstance(val, (dict, list))}
        state = build_state(flat, {})

        opts = self.entry.options
        res = drive_trips.update(
            self._open_trip,
            {
                "t": time.time() * 1000,
                "odometerKm": state.get("odometerKm"),
                "batteryPct": state.get("batteryPct"),
                "charging": state.get("charging"),
                "carOn": state.get("carOn"),
                "locationLat": state.get("locationLat"),
                "locationLon": state.get("locationLon"),
                # fed to analytics.py's rangeAccuracy()/observedEfficiency()
                # via the closed trip record -- both already computed by
                # build_state() above, no new data needed (mirrors
                # node_helper.js's tripState.rangeKm/outsideTempC)
                "rangeKm": state.get("rangeKm"),
                "outsideTempC": state.get("outsideTempC"),
            },
            {
                "pricePerKwh": opts.get("price_per_kwh") or 0,
                "capacityKwh": opts.get("capacity_kwh") or _num(v.get("ev_battery_capacity")),
                # see _update_sessions()'s identical comment above
                "model": v.get("model"),
                # hybrid trips can't have their whole distance attributed to
                # the battery -- see trips.py's _close() comment
                "powertrain": state.get("powertrain"),
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

    @property
    def analytics(self) -> dict:
        """Observed real-world range/efficiency -- see analytics.py. Pure
        aggregation over self._trips/self._sessions (mirrors node_helper.js's
        s.analytics, but computed on each read like trip_log above rather
        than cached, since a HA sensor read is not a hot path)."""
        units = "metric" if self.hass.config.units is METRIC_SYSTEM else "imperial"
        opts = {"units": units}
        return {
            "observedEfficiency": observed_analytics.observed_efficiency(self._trips, opts),
            "rangeAccuracy": observed_analytics.range_accuracy(self._trips, opts),
            "chargingPerformance": observed_analytics.charging_performance(self._sessions),
            "drivingPatterns": observed_analytics.driving_patterns(self._trips, opts),
        }

    # A destination further than this from home is treated as "not really
    # drivable, someone's zone for a place on another continent" and
    # excluded from calendar/static/zone destinations -- generous relative
    # to any real single-charge EV range, so it never excludes a genuine
    # same-country (or even same-continent) destination. This replaced a
    # hardcoded North-America-only bounding box that silently discarded
    # every calendar/static destination for any of the 7 non-US/CA regions
    # this project otherwise advertises supporting -- the box's real intent
    # ("keep an obviously-unreachable zone like a relative's house abroad
    # out of the list") only ever needed to be relative to the user's own
    # home, not a hardcoded country.
    _MAX_PLAUSIBLE_DESTINATION_KM = 500

    def _plausible_destination(self, lat, lon) -> bool:
        if lat is None or lon is None:
            return False
        hlat, hlon, _ = self._home_point()
        km = self._haversine_km(lat, lon, hlat, hlon)
        if km is None:
            # no zone.home configured (or no fix) -- nothing to judge
            # distance against, so don't block on it
            return True
        return km <= self._MAX_PLAUSIBLE_DESTINATION_KM

    def _zone_pois(self) -> list[dict]:
        """Every plausibly-reachable zone.* as {name, lat, lon} (see
        _plausible_destination). This is the full set — Home Assistant
        (dashboard / sensor) always sees all of them. The `zone_entities`
        option only narrows the MagicMirror panel, and the mirror applies
        that itself (via the mm_zone_filter attribute)."""
        out = []
        for st in self.hass.states.async_all("zone"):
            lat = st.attributes.get("latitude")
            lon = st.attributes.get("longitude")
            if not self._plausible_destination(lat, lon):
                continue
            out.append(
                {
                    "name": st.attributes.get("friendly_name")
                    or st.entity_id.split(".", 1)[-1].replace("_", " ").title(),
                    "entity_id": st.entity_id,
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
        if not self._plausible_destination(lat, lon):
            _LOGGER.debug(
                "Kia Access: %r geocoded implausibly far from home, skipping", address
            )
            self._cal_status.setdefault("geocode_errors", []).append(
                f"{address!r}: too far from home ({round(lat, 3)},{round(lon, 3)})"
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
            # richer form (matches the sibling _cal_status["pois"] convention);
            # a prior version overwrote this with a bare name list right after
            # assigning it, silently discarding the per-entry "geocoded" flag
            self._cal_status["static"] = [
                {"name": n, "geocoded": any(p["name"] == n[:40] for p in pois)}
                for n, _ in pairs
            ]

    async def async_refresh_calendar_pois(self) -> None:
        """Pull locations off the configured calendars for the next N hours,
        geocode them (skipping anything implausibly far from home — see
        _plausible_destination), and cache as POIs for the range-reach readout."""
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
        # don't wipe a good list when a refresh geocoded nothing but events with
        # a location exist (transient rate-limit / provider hiccup)
        if pois or self._cal_status["with_location"] == 0:
            self._cal_pois = pois[:12]
        else:
            self._cal_status["errors"].append(
                f"kept {len(self._cal_pois)} cached destination(s) — this "
                "refresh geocoded 0 of "
                f"{self._cal_status['with_location']}"
            )
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
        try:
            await self._cal_store.async_save({
                "cal_pois": self._cal_pois,
                "static_pois": self._static_pois,
                "cal_status": self._cal_status,
            })
        except Exception:  # noqa: BLE001
            _LOGGER.debug("could not persist calendar destinations", exc_info=True)

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
        zone_id = {z["name"]: z.get("entity_id") for z in self._zone_pois()}
        reach_km = out.get("reachKm")
        for p in out.get("pois") or []:
            if p["name"] in zone_id:
                p["zone_id"] = zone_id[p["name"]]
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
    def unconfirmed_commands(self) -> dict:
        """{command_key: {"since", "message"}} for a command whose request
        timed out and hasn't been retried yet -- see async_run_command()."""
        return dict(self._unconfirmed_commands)

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
        # async_force_refresh() sets this for exactly one call to make a manual
        # "Refresh now" wake the car even when "poll car directly" is off.
        forced = self._force_next_refresh
        self._force_next_refresh = False
        poll_now = self._poll_car_directly() or forced
        timeout = (
            self.entry.options.get(
                "force_refresh_timeout", DEFAULT_FORCE_REFRESH_TIMEOUT
            )
            if poll_now
            else 0
        )
        if forced and not timeout:
            # a manual refresh should always actually wake the car, even if
            # the configured wait is 0 (which only makes sense for the
            # battery-friendly scheduled polls)
            timeout = DEFAULT_FORCE_REFRESH_TIMEOUT
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
            "refresh": poll_now,
            "forceRefreshTimeout": timeout,
        }
        job.update(extra)
        return job

    async def _refresh_calendar_and_routes(self) -> None:
        """Calendar destinations + drive times. Called from two places:
        every _async_update_data() poll (regardless of whether the Kia
        vehicle fetch that cycle succeeded — a Kia cloud hiccup used to
        abort the whole cycle before this ever ran), AND a separate 1-min
        timer in __init__.async_setup_entry so a new/changed calendar event
        shows up quickly without waiting on the (often much longer,
        battery-friendly) vehicle scan_interval.

        async_refresh_calendar_pois() has no real throttle need: it reads
        events from HA's own calendar entity (calendar.get_events is local
        — it does not poll Google/etc itself, that integration has its own
        schedule) and _geocode_cached() only ever calls out for an address
        it hasn't seen before, so back-to-back runs cost nothing extra.
        _refresh_drive_times() is the one with real external API calls
        (routing) and keeps its own separate 600s / car-moved throttle, so
        calling this every minute doesn't hammer that provider either.

        The two callers above mean this can genuinely run concurrently with
        itself (a poll cycle running long enough to overlap the next 1-min
        tick) -- and the body below mutates shared, non-atomic state
        (_cal_pois, _static_pois, _cal_status, _geo_cache, _route_at) across
        multiple awaits (geocoding, calendar reads, routing calls, store
        saves). async_refresh_calendar_pois() in particular *reassigns*
        self._cal_status wholesale at its start, so an overlapping call can
        make an in-progress call's later writes land in the wrong (newer)
        dict. Serialize the whole refresh so only one is ever in flight."""
        async with self._calendar_lock:
            try:
                await self.async_refresh_calendar_pois()
            except Exception:  # noqa: BLE001
                _LOGGER.debug("calendar POI refresh failed", exc_info=True)
            try:
                await self._refresh_drive_times()
            except Exception:  # noqa: BLE001
                _LOGGER.debug("drive-time refresh failed", exc_info=True)

    async def _async_update_data(self) -> dict:
        async with self._update_lock:
            job = self._job()
            fetch_err: Exception | None = None
            otp_required = False
            try:
                # every coordinator for this account shares one login/fetch
                # (see account_poll.py) -- this always requests every
                # vehicle on the account; select_own_vehicle() below picks
                # this coordinator's own one back out of that shared result
                result = await self.account_poller.async_fetch(job)
            except kia_client.OtpRequired as err:
                otp_required = True
                fetch_err = err
            except kia_client.ClientError as err:
                fetch_err = err
            except Exception as err:  # noqa: BLE001
                fetch_err = err

            vehicle = None
            if fetch_err is None:
                try:
                    vehicle = account_poll.select_own_vehicle(
                        result.get("vehicles") or [], self.entry.data.get(CONF_VIN, "")
                    )
                except kia_client.ClientError as err:
                    fetch_err = err

            if fetch_err is None:
                self.meta = result.get("meta", {}) or {}
                # persist a rotated refresh token back into the config entry.
                # async_update_entry fires the update listener, but
                # _async_options_updated ignores data-only changes so this
                # does not reload the integration. self.meta is the SHARED
                # AccountPoller payload's own dict -- pop() here would mutate
                # it out from under every sibling coordinator reusing the
                # same cached fetch within the dedup window, so copy first.
                self.meta = dict(self.meta)
                new_token = self.meta.pop("token", None)
                if new_token and new_token != self.entry.data.get(CONF_TOKEN):
                    self.hass.config_entries.async_update_entry(
                        self.entry,
                        data={**self.entry.data, CONF_TOKEN: new_token},
                    )
                self.vehicle = vehicle
                self.last_successful_update = dt_util.utcnow()
                await self._update_sessions()
                await self._update_trips()

            await self._refresh_calendar_and_routes()

            if fetch_err is not None:
                if otp_required:
                    # triggers HA's reauth flow instead of an endless retry
                    raise ConfigEntryAuthFailed(
                        "Kia needs re-enrollment (one-time code)."
                    ) from fetch_err
                if isinstance(fetch_err, kia_client.ClientError):
                    raise UpdateFailed(str(fetch_err)) from fetch_err
                raise UpdateFailed(
                    f"{type(fetch_err).__name__}: {fetch_err}"
                ) from fetch_err

            await self._emit_alerts()
            return self.vehicle

    @property
    def stale_after_minutes(self) -> float:
        raw = self.entry.options.get("stale_after_minutes", DEFAULT_STALE_AFTER_MINUTES)
        try:
            minutes = float(raw)
        except (TypeError, ValueError):
            return float(DEFAULT_STALE_AFTER_MINUTES)
        return minutes if minutes > 0 else float(DEFAULT_STALE_AFTER_MINUTES)

    @property
    def vehicle_reported_at(self) -> datetime | None:
        """The CAR's own self-reported last-check-in time
        (vehicle.last_updated_at), parsed -- None if missing or unparseable,
        which is itself informative (an older/degraded API response, or a
        vehicle that has never reported)."""
        raw = (self.vehicle or {}).get("last_updated_at")
        if not raw:
            return None
        parsed = dt_util.parse_datetime(str(raw))
        if parsed is None:
            return None
        return dt_util.as_utc(parsed)

    @property
    def data_age_seconds(self) -> float | None:
        reported = self.vehicle_reported_at
        if reported is None:
            return None
        return max(0.0, (dt_util.utcnow() - reported).total_seconds())

    @property
    def is_stale(self) -> bool | None:
        """True once the CAR's own last-reported reading is older than
        stale_after_minutes -- distinct from last_update_success (which HA
        already reflects as entities going unavailable when polling itself
        fails): this can be True even while every poll keeps succeeding, if
        the car just hasn't reported anything new. None (not True/False)
        when there's no reported timestamp to judge staleness from at all
        -- e.g. before the very first successful poll -- so a consumer
        doesn't mistake "we don't know yet" for "definitely fresh"."""
        age = self.data_age_seconds
        if age is None:
            return None
        return age > self.stale_after_minutes * 60

    @staticmethod
    def _haversine_km(a_lat, a_lon, b_lat, b_lon) -> float | None:
        # Single choke point for every distance calc in this file -- harden
        # here rather than at each of the many call sites that independently
        # float()-parse a raw vehicle/zone coordinate. float("nan")/float("inf")
        # both pass a bare `is None` check (and isinstance(x, float)), so a
        # malformed live GPS reading could otherwise silently propagate NaN
        # through every downstream distance/range comparison.
        for v in (a_lat, a_lon, b_lat, b_lon):
            if v is None or not isinstance(v, (int, float)) or isinstance(v, bool) \
                    or not math.isfinite(v):
                return None
        if not (-90 <= a_lat <= 90 and -90 <= b_lat <= 90):
            return None
        if not (-180 <= a_lon <= 180 and -180 <= b_lon <= 180):
            return None
        r, p = 6371.0, math.pi / 180.0
        a = (
            0.5
            - math.cos((b_lat - a_lat) * p) / 2
            + math.cos(a_lat * p) * math.cos(b_lat * p) * (1 - math.cos((b_lon - a_lon) * p)) / 2
        )
        return r * 2 * math.asin(math.sqrt(a))

    @staticmethod
    def _zone_radius_m(zone_or_state) -> float:
        """A zone/state's `radius` attribute, defaulting to and falling back
        to 100m on anything malformed -- missing, non-numeric, NaN, Infinity,
        or negative. Used everywhere a zone's radius is read (_home_point,
        _charge_at_home, _charge_rate) so a bad attribute degrades to a
        sane default instead of raising (this can be reached from inside
        the locked update body with no surrounding guard, where an
        unhandled exception would fail the entire coordinator update) or
        silently matching/never-matching everything (float("nan")/float(
        "inf") both pass a bare isinstance/TypeError-ValueError check)."""
        try:
            raw = zone_or_state.attributes.get("radius", 100)
            radius_m = 100.0 if raw is None else float(raw)
            if not math.isfinite(radius_m) or radius_m < 0:
                return 100.0
            return radius_m
        except (TypeError, ValueError):
            return 100.0

    def _home_point(self) -> tuple[float | None, float | None, float]:
        zone = self.hass.states.get("zone.home")
        if zone is None:
            return None, None, 100.0
        return (
            zone.attributes.get("latitude"),
            zone.attributes.get("longitude"),
            self._zone_radius_m(zone),
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

    def _charge_at_home(self) -> bool | None:
        """Is the car in the 'home charging' zone right now? Used to pick the
        home vs away per-kWh rate. None (= use the home rate) when no zone is
        configured, the zone is missing, or there's no GPS fix."""
        zid = (self.entry.options.get("home_charge_zone") or "").strip()
        if not zid:
            return None
        st = self.hass.states.get(zid)
        if st is None:
            return None
        radius_m = self._zone_radius_m(st)

        def _n(x):
            try:
                return None if x in (None, "") else float(x)
            except (TypeError, ValueError):
                return None

        km = self._haversine_km(
            _n(self.vehicle.get("location_latitude")),
            _n(self.vehicle.get("location_longitude")),
            st.attributes.get("latitude"),
            st.attributes.get("longitude"),
        )
        if km is None:
            return None
        return km * 1000 <= radius_m

    @staticmethod
    def _parse_charge_rates(raw) -> list[tuple[str, float]]:
        """Parse the 'charge_rates' option — one `zone.x = 0.NN` per line — into
        an ordered [(zone_entity_id, rate_per_kwh)] list. First match wins, so
        order in the box is the priority order."""
        out: list[tuple[str, float]] = []
        for line in (raw or "").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            for sep in ("=", "|", ":"):
                if sep in line:
                    name, _, val = line.partition(sep)
                    break
            else:
                continue
            zid = name.strip()
            if "." not in zid:
                zid = "zone." + zid.lower().replace(" ", "_")
            try:
                rate = float(str(val).strip().lstrip("$").strip())
            except (TypeError, ValueError):
                continue
            # float("Infinity")/float("inf") both parse successfully and are
            # >= 0 -- reject here rather than relying on sessions.py's own
            # _num() to filter it back out downstream (it does, but this
            # function's contract shouldn't depend on that).
            if zid and math.isfinite(rate) and rate >= 0:
                out.append((zid, rate))
        return out

    def _charge_rate(self) -> tuple[float | None, str | None]:
        """The per-kWh rate + location label for wherever the car is charging
        now, from the 'charge_rates' zone list. (None, None) when nothing is
        configured or the car isn't in any listed zone."""
        entries = self._parse_charge_rates(self.entry.options.get("charge_rates"))
        if not entries:
            return None, None

        def _n(x):
            try:
                return None if x in (None, "") else float(x)
            except (TypeError, ValueError):
                return None

        car_lat = _n(self.vehicle.get("location_latitude"))
        car_lon = _n(self.vehicle.get("location_longitude"))
        if car_lat is None or car_lon is None:
            return None, None

        home_zid = (self.entry.options.get("home_charge_zone") or "").strip()
        for zid, rate in entries:
            st = self.hass.states.get(zid)
            if st is None:
                continue
            radius_m = self._zone_radius_m(st)
            km = self._haversine_km(
                car_lat, car_lon,
                st.attributes.get("latitude"), st.attributes.get("longitude"),
            )
            if km is None or km * 1000 > radius_m:
                continue
            is_home = zid == home_zid or (not home_zid and zid == "zone.home")
            label = "home" if is_home else (
                st.attributes.get("friendly_name") or zid.split(".", 1)[-1]
            )
            return rate, label
        return None, None

    def _build_alert_state(self) -> dict:
        """Flatten self.vehicle into a buildState()-style dict, then fold in
        the timer-derived context (home/unplugged duration, distance to
        home, moved-while-parked) that conditions.py's checks need but
        build_state() itself has no way to compute -- it needs no `self`,
        build_state() does. Mutates self._home_unplugged_since/
        self._moved_since/self._last_parked as a side effect of computing
        those timers; caller is responsible for persisting them (see
        _emit_alerts()) -- kept a plain side effect rather than returning
        the new timer values separately, since every one of these timers
        already lives on `self` everywhere else in this class."""
        flat = {f"vehicle.{k}": v for k, v in self.vehicle.items()
                if not isinstance(v, (dict, list))}
        if self.meta.get("tokenEnrolledAt"):
            flat["_meta.tokenEnrolledAt"] = self.meta["tokenEnrolledAt"]
        units = "metric" if self.hass.config.units is METRIC_SYSTEM else "imperial"
        state = build_state(flat, {"units": units})

        # home / not-plugged-in context. time.time() (wall clock), not
        # time.monotonic() -- this measures "how long has this been
        # continuously true", which must survive a HA restart (routine:
        # updates, crashes) without silently resetting the clock and
        # delaying the alert by another full graceMin/sustainedMin.
        state["atHome"] = self._at_home(state)
        home_unplugged = state["atHome"] is True and state.get("plugged") is not True
        if home_unplugged and self._home_unplugged_since is None:
            self._home_unplugged_since = time.time()
        if not home_unplugged:
            self._home_unplugged_since = None
        state["homeUnpluggedMin"] = (
            (time.time() - self._home_unplugged_since) / 60
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
            if moved is not None and moved >= 0.3048:  # 1000 ft -- real move, not GPS jitter
                if self._moved_since is None:
                    self._moved_since = time.time()
                state["movedWhileParkedKm"] = moved
                state["movedWhileParkedMin"] = (time.time() - self._moved_since) / 60
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

        return state

    def _track_parking(self, car_on: bool, lat, lon) -> None:
        """"Where did I park" snapshot -- self._parked feeds the `Parked`
        sensor (map deep-links, distance from home), a feature entirely
        unrelated to alert conditions; it just happens to run on the same
        poll cycle as _emit_alerts() because it needs the same car_on/lat/
        lon that were already computed there. Split out (not folded into
        _build_alert_state(), which is genuinely about the conditions.py
        state dict) so this can be reasoned about and tested on its own.

        Snapshots on the drive->park transition (and once on startup if the
        car is already parked with a fix). If the car turns off with no GPS
        fix yet (weak signal, e.g. entering an underground/covered garage —
        exactly where this matters most), `just_parked` would only be true
        for that one cycle and then be lost forever once _was_on flips to
        False; _awaiting_park_fix keeps the transition "pending" until a
        fix actually arrives."""
        just_parked = self._was_on is True and not car_on
        if just_parked and lat is None:
            self._awaiting_park_fix = True
        if (
            (just_parked or self._parked is None or self._awaiting_park_fix)
            and not car_on and lat is not None
        ):
            self._parked = {
                "lat": lat,
                "lon": lon,
                "at": dt_util.utcnow().isoformat(),
                "address": self.vehicle.get("location_name")
                or self.vehicle.get("geocode"),
            }
            self._awaiting_park_fix = False
        self._was_on = car_on

    def _fire_condition_edges(self, state: dict, cfg: dict) -> None:
        """Evaluate conditions.py against `state` and fire kia_access_alert
        for every edge-triggered change, using the exact same rules as the
        MagicMirror module. A condition-evaluation failure is caught HERE
        (logged, nothing fired) rather than left to propagate out of
        _emit_alerts() -- it must never skip persisting this cycle's timer
        state (see _emit_alerts()): those timers are a genuinely
        independent piece of state from whether alert firing itself
        succeeded, and skipping their persistence on every condition-
        evaluation failure was a real, if narrow, bug."""
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

        # kia_client._vehicle_key_dict()'s VIN-or-id fallback -- see its
        # docstring: Kia USA never reports a real VIN at all, so a bare
        # self.vehicle.get("VIN") was always None for those accounts,
        # silently breaking any automation (e.g. a multi-car alert_to_phone
        # routing setup) that filters/routes kia_access_alert events by
        # event.data.vin.
        vin = kia_client._vehicle_key_dict(self.vehicle) or None  # noqa: SLF001
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
                    EVENT_KIA_ACCESS_ALERT,
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

    def _default_alert_title(self) -> str:
        """"<Brand> <Model>" (or just "<Brand>" with no model yet) --
        conditions.py's own DEFAULTS["title"] is the static literal
        "Kia EV9", fine as ITS fallback (a bare unit-test import with no
        cfg at all), but strings.json's options-form copy promises "blank
        = the vehicle's own default" / "a generic default", not a
        hardcoded brand+model. This is the real one, using the account's
        own configured brand, so a Hyundai/Genesis owner (or anyone not
        driving an EV9) who leaves the alert-title field blank -- the
        documented, encouraged path -- doesn't get every alert titled for
        a car that isn't theirs."""
        model = self.vehicle.get("model")
        brand = brand_display_name(self.entry.data.get(CONF_BRAND))
        return f"{brand} {model}".strip() if model else brand

    def _alert_title(self) -> str:
        """The configured notifications.title, or _default_alert_title() when
        blank -- the one title every kia_access_alert source (condition-driven
        or the charger-status-entity alerts below) should agree on."""
        return (
            self.entry.options.get("notifications", {}) or {}
        ).get("title") or self._default_alert_title()

    async def _emit_alerts(self) -> None:
        """Fire kia_access_alert events on edge-triggered condition changes
        -- see _build_alert_state()/_track_parking()/_fire_condition_edges()
        for the four separable things this used to do as one 150-line
        method: build the conditions.py-facing state, track the unrelated
        "where did I park" snapshot, evaluate+fire, then persist whichever
        timers actually changed. The persist step now ALWAYS runs, even
        when _fire_condition_edges() hit its own (caught) evaluation
        failure -- see that method's docstring for why the old
        all-or-nothing early-return was a real bug, not just a style
        choice."""
        # a copy, not the stored dict itself -- self.entry.options["notifications"]
        # is the SAME object async_create_entry() persisted; mutating it in
        # place here would silently corrupt the saved config entry outside
        # of an actual options-flow save.
        cfg = dict(self.entry.options.get("notifications", {}) or {})
        if not cfg.get("title"):
            cfg["title"] = self._alert_title()
        timers_before = (self._home_unplugged_since, self._moved_since, self._last_parked)

        state = self._build_alert_state()
        self._track_parking(
            state.get("carOn") is True, state.get("locationLat"), state.get("locationLon")
        )
        self._fire_condition_edges(state, cfg)

        timers_after = (self._home_unplugged_since, self._moved_since, self._last_parked)
        if timers_after != timers_before:
            await self._save_timers()

    async def _save_timers(self) -> None:
        """Persist every timer this coordinator keeps in `_timers_store` --
        shared by _emit_alerts() (the home/moved/parked timers) and
        _async_charger_state_changed() (charger_session), so neither call
        site can silently drop the other's field by saving a partial dict."""
        await self._timers_store.async_save({
            "home_unplugged_since": self._home_unplugged_since,
            "moved_since": self._moved_since,
            "last_parked": self._last_parked,
            "charger_session": self._charger_session,
        })

    # ---- external charger (ChargePoint, Emporia, or any other HA
    # integration exposing a charging-status entity) start/stop alerts.
    # Independent of the car-reported chargingStarted/chargeComplete
    # conditions above: those depend on ev_battery_is_charging, which can lag
    # a home charger's own status by a full poll cycle (or more, with "poll
    # the car directly" off); this reacts to the status entity's own state
    # change instead, so it fires as soon as HA sees it, and works the same
    # for any charger brand -- everything below only ever reads generic HA
    # entity state (a truthy/falsy status string, a numeric kWh reading), never
    # anything ChargePoint- or Emporia-specific.

    @staticmethod
    def _charger_is_charging(state) -> bool | None:
        """state.state -> True/False/None(unrecognized or unavailable). Covers
        a binary_sensor's on/off, and the "Charging"/"Not Charging"-style
        string states several EVSE integrations (ChargePoint, Emporia) use
        for a plain sensor instead -- including ha-emporia-ev's own
        sensor.*_status ENUM values ("charging" / "plugged_in_idle" /
        "not_plugged_in" / "error"), which is the entity this integration's
        docs point Emporia users at (its switch.*_charging reflects whether
        charging is ENABLED, not whether current is actually flowing right
        now, so it can stay "on" for days with nothing plugged in -- wrong
        signal for a start/stop edge)."""
        if state is None:
            return None
        val = str(state.state).strip().lower().replace(" ", "_")
        if val in ("on", "true", "1", "yes", "charging"):
            return True
        if val in (
            "off", "false", "0", "no", "not_charging", "idle",
            "plugged_in", "disconnected", "unplugged", "stopped",
            "plugged_in_idle", "not_plugged_in",
        ):
            return False
        return None  # unknown/unavailable, or a state string we don't recognize

    def _charger_energy_reading(self) -> float | None:
        """Current numeric value of the configured `charger_energy_entity`
        (any unit the integration reports its own kWh sensor in -- start/stop
        readings are only ever differenced against each other, so as long as
        the entity's own unit is consistent between the two samples, this
        never needs to know what that unit actually is)."""
        eid = (self.entry.options.get("charger_energy_entity") or "").strip()
        if not eid:
            return None
        st = self.hass.states.get(eid)
        if st is None:
            return None
        try:
            val = float(st.state)
        except (TypeError, ValueError):
            return None
        return val if math.isfinite(val) else None

    def _charger_rate(self) -> tuple[float | None, str | None]:
        """Per-kWh rate + location label to cost an external-charger session
        at -- "the defined rate in the app": the same per-zone `charge_rates`
        lookup _update_sessions() prices the car-reported sessions with,
        falling back to the home/away price_per_kwh pair keyed off whether
        the car itself is currently in the configured home-charging zone."""
        rate, label = self._charge_rate()
        if rate is not None:
            return rate, label
        home = self.entry.options.get("price_per_kwh") or 0
        away = self.entry.options.get("away_price_per_kwh")
        at_home = self._charge_at_home()
        try:
            home = float(home)
        except (TypeError, ValueError):
            home = 0.0
        try:
            away = float(away) if away not in (None, "") else None
        except (TypeError, ValueError):
            away = None
        # away_price_per_kwh's own documented semantics (strings.json):
        # "0 = fall back to the home rate" -- `away is not None` alone
        # treats an explicit 0 as a real (free) away rate instead, pricing
        # any away session at $0/kWh. `if away:` also excludes it, same as
        # every other 0-means-unset numeric option in this file.
        if at_home is False and away:
            return away, "away"
        return (home or None), ("home" if home else None)

    def _vehicle_display_name(self) -> str:
        """Same precedence as entity.py's DeviceInfo.name / sensor.py's
        vehicle_name attribute (kept as its own copy here for the same
        reason entity.py's docstring gives for its own duplicate: no shared
        base those three could hang a common helper off without a bigger
        refactor than this warrants)."""
        v = self.vehicle
        return str(v.get("name") or v.get("model") or brand_display_name(self.entry.data.get(CONF_BRAND)))

    def _month_to_date_totals(self) -> dict:
        """Charging cost/kWh + miles driven since local midnight on the 1st of
        this calendar month, for the charger_charging_stopped alert's
        "this month" figures. Deliberately calendar-month, unlike
        charge_log["month"]/trip_log["last_30_days"] (both a rolling 30-day
        window, despite the "month" key name on the former -- see its own
        docstring) -- those sensors keep their existing rolling-window
        meaning; this is its own, narrower calculation, Python/HA-only (no
        core/*.js mirror) since it only ever feeds this HA-only alert."""
        start_local = dt_util.now().replace(
            day=1, hour=0, minute=0, second=0, microsecond=0
        )
        start_ms = dt_util.as_utc(start_local).timestamp() * 1000

        cost = 0.0
        have_cost = False
        for s in self._sessions or []:
            ended = s.get("endedAt") if s else None
            if ended is None or ended < start_ms:
                continue
            if s.get("cost") is not None:
                cost += s["cost"]
                have_cost = True

        km = 0.0
        for t in self._trips or []:
            ended = t.get("endedAt") if t else None
            if ended is None or ended < start_ms:
                continue
            if t.get("distanceKm") is not None:
                km += t["distanceKm"]
        miles = round(km * 0.621371, 1)

        cost_out = round(cost, 2) if have_cost else None
        cost_per_mile = (
            round(cost / miles, 3) if have_cost and miles > 0 else None
        )
        return {"cost": cost_out, "miles": miles, "costPerMile": cost_per_mile}

    async def _async_charger_power_changed(self, event) -> None:
        """entry.async_on_unload(async_track_state_change_event(...)) target
        for the optional `charger_power_entity` -- while a charger session
        is open (self._charger_session is not None), records the moment of
        every reading at/above CHARGER_POWER_ACTIVE_THRESHOLD_W as
        `lastActivePowerAt`. Purely a passive data source: it never opens,
        closes, or fires an alert for a session itself (that stays entirely
        driven by `charger_status_entity`, in _async_charger_state_changed)
        -- so a brief post-finish top-off blip just moves this timestamp
        later, it can never re-trigger a start/stop alert pair on its own.
        _async_charger_state_changed reads this back at stop time to report
        when charging actually finished, instead of whenever the status
        entity's own session happens to end (some integrations -- ha-
        emporia-ev observed -- keep a session's status as "charging" until
        a scheduled end time well after the car stopped drawing current).
        In-memory only (not persisted every tick, unlike the session's own
        open/close, to avoid a disk write on every power sample) -- a HA
        restart mid-session loses only this refinement, not the session
        itself, falling back to the status-entity edge's own timestamp."""
        try:
            if self._charger_session is None:
                return
            new_state = event.data.get("new_state")
            if new_state is None:
                return
            try:
                power = float(new_state.state)
            except (TypeError, ValueError):
                return
            if math.isfinite(power) and power >= CHARGER_POWER_ACTIVE_THRESHOLD_W:
                self._charger_session["lastActivePowerAt"] = time.time() * 1000
        except Exception:  # noqa: BLE001
            _LOGGER.debug("charger power tracking failed", exc_info=True)

    @staticmethod
    def _accumulate_charger_energy(session: dict, reading: float | None) -> None:
        """Fold one more charger_energy_entity reading into `session`'s
        running total, in place -- shared by _async_charger_energy_changed
        (every live state change, against self._charger_session) and
        _async_charger_state_changed's stop path (one final manual sample
        against its own local `session` var, taken after
        self._charger_session has already been cleared -- in case the
        entity's real last tick of the session landed before that last
        state-change event reached us, or it ticks slower than the status
        entity does). A static method, not an instance one, precisely so
        it can be handed either."""
        if reading is None or not math.isfinite(reading):
            return
        last = session.get("lastEnergyReading")
        if last is not None:
            delta = reading - last
            if delta > 0:
                session["accumulatedKwh"] = (session.get("accumulatedKwh") or 0.0) + delta
            # delta <= 0: a reset (or a flat repeat) -- never subtracted,
            # just re-bases the comparison for next time
        session["lastEnergyReading"] = reading

    async def _async_charger_energy_changed(self, event) -> None:
        """entry.async_on_unload(async_track_state_change_event(...)) target
        for `charger_energy_entity` -- while a session is open, integrates
        every increase into self._charger_session["accumulatedKwh"] instead
        of the plain (reading-at-stop minus reading-at-start) delta this
        replaced. That naive snapshot silently undercounted any session
        whose energy entity resets mid-session for a reason unrelated to
        the charging session itself -- confirmed live: ha-emporia-ev's
        "Energy Today" resets at local midnight, so an ordinary overnight
        session (started before midnight, ended after) had its whole
        pre-midnight portion subtracted away by the stop-time snapshot,
        undercounting both the kWh and its cost. Integrating deltas as they
        happen is immune to that regardless of WHEN or WHY the entity
        resets (or which timezone it resets in): a decrease is recognized
        as a reset and simply re-bases the running comparison rather than
        being (wrongly) subtracted, so nothing between two real increases
        is ever lost. A ChargePoint-style entity that already resets to 0
        at each session's own start behaves identically to the old
        snapshot approach, so this is a strict improvement, not a
        trade-off."""
        try:
            if self._charger_session is None:
                return
            new_state = event.data.get("new_state")
            if new_state is None:
                return
            try:
                reading = float(new_state.state)
            except (TypeError, ValueError):
                return
            self._accumulate_charger_energy(self._charger_session, reading)
        except Exception:  # noqa: BLE001
            _LOGGER.debug("charger energy tracking failed", exc_info=True)

    async def _async_charger_state_changed(self, event) -> None:
        """entry.async_on_unload(async_track_state_change_event(...)) target
        for `charger_status_entity` -- fires charger_charging_started /
        _stopped kia_access_alert events on each real on<->off edge. The
        `value` payload is deliberately self-contained (battery %, charge
        power, ETA, vehicle name on start; energy/cost/duration/month
        spend-and-miles on stop) so a notification automation can read
        event.data.value.* directly instead of having to guess this
        installation's actual entity_id slugs for five different sensors.
        On stop, folds in the energy consumed (from `charger_energy_entity`,
        accumulated live throughout the session -- see
        _accumulate_charger_energy()/_async_charger_energy_changed(), not a
        plain start/stop snapshot) and its cost at _charger_rate(). Wrapped
        in a broad except, same as
        _fire_condition_edges(): a bad reading here must never crash the
        listener and silently stop watching the entity for the rest of the
        HA run."""
        try:
            new_state = event.data.get("new_state")
            charging = self._charger_is_charging(new_state)
            if charging is None:
                return
            was_open = self._charger_session is not None
            if charging == was_open:
                return  # not a real start/stop edge (e.g. a duplicate on->on)

            def _num(x):
                try:
                    return None if x is None or x == "" else float(x)
                except (TypeError, ValueError):
                    return None

            # self.vehicle is only as fresh as the last scheduled Kia poll --
            # up to a full scan_interval old (30 min by default) -- so
            # without this, a charger-status edge that lands between polls
            # reports stale leftovers instead of this session's real numbers
            # (0 kW / a previous session's stale ETA at start; a stale % at
            # stop). Force a live pull now: the car is actively
            # charging/just finished, so unlike waking a parked, idle car
            # this doesn't cost anything charging itself isn't already
            # covering. Same technique as async_force_refresh() (the manual
            # "Refresh now" button). Left unguarded -- DataUpdateCoordinator
            # .async_request_refresh() already swallows a failed poll
            # internally (last_update_success flips False, self.vehicle
            # just stays whatever it was), so this never raises out to the
            # outer except and abort the alert entirely over a bad poll.
            self._force_next_refresh = True
            await self.async_request_refresh()

            title = self._alert_title()
            vin = kia_client._vehicle_key_dict(self.vehicle) or None  # noqa: SLF001
            vehicle_name = self._vehicle_display_name()
            pct = _num(self.vehicle.get("ev_battery_percentage"))

            if charging:
                self._charger_session = {
                    "startedAt": time.time() * 1000,
                    # seeds the baseline _async_charger_energy_changed
                    # compares its first live reading against; that
                    # listener (not this snapshot) does the actual
                    # accumulation from here on -- see its own docstring
                    "lastEnergyReading": self._charger_energy_reading(),
                    "accumulatedKwh": 0.0,
                }
                await self._save_timers()
                self.hass.bus.async_fire(
                    EVENT_KIA_ACCESS_ALERT,
                    {
                        "entry_id": self.entry.entry_id,
                        "reason": "charger_charging_started",
                        "level": "info",
                        "active": True,
                        "title": title,
                        "message": "Charging started",
                        "value": {
                            "pct": pct,
                            "kw": _num(self.vehicle.get("ev_charging_power")),
                            # Kia's own live estimate, in minutes, of time
                            # remaining to the car's configured charge target
                            # (100% unless a lower charge limit is set) --
                            # nothing this integration computes itself.
                            "etaMin": _num(
                                self.vehicle.get("ev_estimated_current_charge_duration")
                            ),
                            "vehicleName": vehicle_name,
                        },
                        "vin": vin,
                    },
                )
                return

            session = self._charger_session or {}
            self._charger_session = None
            # one final catch-up sample against the now-detached local
            # `session` dict -- see _accumulate_charger_energy's own
            # docstring for why this (not another reading-at-stop-minus-
            # reading-at-start snapshot) is still correct even across a
            # mid-session counter reset (ha-emporia-ev's "Energy Today"
            # resets at local midnight, breaking any plain overnight-session
            # snapshot delta -- confirmed live).
            self._accumulate_charger_energy(session, self._charger_energy_reading())
            await self._save_timers()

            accumulated = session.get("accumulatedKwh")
            kwh = accumulated if accumulated and accumulated > 0 else None

            cost, rate_label = None, None
            if kwh is not None and kwh > 0:
                rate, rate_label = self._charger_rate()
                if rate is not None:
                    cost = round(kwh * rate, 2)

            started_at = _num(session.get("startedAt"))
            # charger_power_entity tracks the last moment power was actually
            # flowing (see _async_charger_power_changed) -- some chargers
            # (ha-emporia-ev observed) keep reporting "charging" on their
            # status entity until a scheduled session end, well after the
            # car stopped actually drawing current. Prefer that real
            # last-active moment for duration/finish time; fall back to
            # "now" (the status-entity edge itself) when no power entity is
            # configured or no activity was ever observed this session --
            # the exact previous behavior.
            stopped_at = _num(session.get("lastActivePowerAt")) or (time.time() * 1000)
            duration_min = (
                (stopped_at - started_at) / 60000 if started_at is not None else None
            )

            mtd = self._month_to_date_totals()

            currency = str(self.entry.options.get("currency") or "USD").upper()
            parts = ["Charging stopped"]
            detail = []
            if kwh is not None:
                detail.append(f"{round(kwh, 1)} kWh")
            if cost is not None:
                detail.append(f"{cost} {currency}" + (f" ({rate_label})" if rate_label else ""))
            if detail:
                parts.append(" - " + ", ".join(detail))
            message = "".join(parts)

            self.hass.bus.async_fire(
                EVENT_KIA_ACCESS_ALERT,
                {
                    "entry_id": self.entry.entry_id,
                    "reason": "charger_charging_stopped",
                    "level": "info",
                    "active": False,
                    "title": title,
                    "message": message,
                    "value": {
                        "kwh": kwh,
                        "cost": cost,
                        "rateLabel": rate_label,
                        "currency": currency,
                        "pct": pct,
                        "durationMin": duration_min,
                        "chargingStoppedAt": dt_util.utc_from_timestamp(
                            stopped_at / 1000
                        ).isoformat(),
                        "vehicleName": vehicle_name,
                        "monthCost": mtd["cost"],
                        "monthMiles": mtd["miles"],
                        "costPerMile": mtd["costPerMile"],
                    },
                    "vin": vin,
                },
            )
        except Exception:  # noqa: BLE001
            _LOGGER.debug("charger status alert failed", exc_info=True)

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
        # Serializes every command through this coordinator -- see the lock's
        # own comment in __init__ for why: without it, two nearly-
        # simultaneous calls could dispatch to Kia concurrently with no
        # ordering guarantee, and whichever one's handler happened to finish
        # last would silently clobber self.last_action regardless of which
        # command actually completed last.
        async with self._command_lock:
            job = self._job(command=command, options=options or {})
            # A new attempt of this command resolves any prior "unconfirmed"
            # flag for it -- the point is only to warn about the retry
            # itself, not to track an unresolved ambiguity forever.
            self._unconfirmed_commands.pop(command, None)
            self.last_action = {
                "name": command,
                "status": "running",
                "at": dt_util.utcnow().isoformat(),
            }
            self.async_update_listeners()
            try:
                await self.hass.async_add_executor_job(kia_client.run_command, job)
                self.last_action = {**self.last_action, "status": "done"}
            except kia_client.CommandUnconfirmed as err:
                # The request timed out -- Kia's protocol has no ID-less way
                # to ask afterward whether the vehicle actually received it,
                # so this is genuinely unknown, not a clear failure. Flag it
                # so a caller (the card, before letting a climate/charge
                # start-vs-stop retry through) can ask the user to confirm
                # rather than silently sending a second command on top of an
                # unresolved one.
                self.last_action = {**self.last_action, "status": "unconfirmed"}
                self._unconfirmed_commands[command] = {
                    "since": dt_util.utcnow().isoformat(),
                    "message": str(err),
                }
                raise
            except Exception:
                self.last_action = {**self.last_action, "status": "failed"}
                raise
            finally:
                self.async_update_listeners()
                await self.async_request_refresh()

    async def async_force_refresh(self) -> None:
        """Manual 'refresh now' -- wakes the car for one live pull from Kia's
        servers immediately, overriding the 'poll car directly' battery-
        friendly default for just this one cycle. Surfaced as a button
        entity and the Lovelace card's refresh icon."""
        self.last_action = {
            "name": "refresh_now",
            "status": "running",
            "at": dt_util.utcnow().isoformat(),
        }
        self.async_update_listeners()
        self._force_next_refresh = True
        try:
            await self.async_request_refresh()
        finally:
            self.last_action = {
                **self.last_action,
                "status": "done" if self.last_update_success else "failed",
            }
            self.async_update_listeners()
