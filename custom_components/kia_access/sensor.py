"""Kia Access sensors, generated from entities.json."""
from __future__ import annotations

import time
from datetime import timedelta

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL, EntityCategory, UnitOfLength
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from . import sessions as charge_sessions
from .const import DOMAIN, ENTITIES, SEAT_LEVELS
from .entity import KiaAccessEntity

_SEAT_BY_CODE = {v: k for k, v in SEAT_LEVELS.items()}
_SEATS = {
    "front_left_seat_status": "Driver seat",
    "front_right_seat_status": "Passenger seat",
    "rear_left_seat_status": "Rear-left seat",
    "rear_right_seat_status": "Rear-right seat",
}


def _num(x):
    try:
        return None if x is None or x == "" else float(x)
    except (TypeError, ValueError):
        return None


def _hm(minutes) -> str | None:
    """90 -> '1h 30m', 25 -> '25m'"""
    if minutes is None:
        return None
    m = int(round(minutes))
    return f"{m // 60}h {m % 60:02d}m" if m >= 60 else f"{m}m"


def _when_local(iso) -> str | None:
    """ISO datetime / date -> a short local label: 'Tue 9:00 AM' / 'Tue'."""
    if not iso:
        return None
    dt = dt_util.parse_datetime(str(iso))
    if dt is None:
        d = dt_util.parse_date(str(iso))
        return d.strftime("%a %d %b").replace(" 0", " ") if d else None
    return dt_util.as_local(dt).strftime("%a %I:%M %p").replace(" 0", " ")


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list = [
        KiaAccessSensor(coordinator, spec)
        for spec in ENTITIES
        if spec["domain"] == "sensor"
    ]
    entities.append(KiaAccessSummarySensor(coordinator))
    entities.append(KiaAccessLastChargeSensor(coordinator))
    entities.append(KiaAccessChargeSessionSensor(coordinator))
    entities.append(KiaAccessActionSensor(coordinator))
    entities.append(KiaAccessRangeReachSensor(coordinator))
    entities.append(KiaAccessLastTripSensor(coordinator))
    entities.append(KiaAccessCostPerMileSensor(coordinator))
    entities.append(KiaAccessParkedSensor(coordinator))
    entities += [
        KiaAccessSeatSensor(coordinator, key, name) for key, name in _SEATS.items()
    ]
    async_add_entities(entities)


class KiaAccessSensor(KiaAccessEntity, SensorEntity):
    def __init__(self, coordinator, spec: dict) -> None:
        super().__init__(coordinator, spec["key"])
        self._attr_name = spec["name"]
        self._attr_native_unit_of_measurement = spec.get("unit")
        if spec.get("device_class"):
            self._attr_device_class = spec["device_class"]
        if spec.get("state_class"):
            self._attr_state_class = spec["state_class"]
        if spec.get("icon"):
            self._attr_icon = spec["icon"]
        if spec.get("category") == "diagnostic":
            self._attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def native_value(self):
        val = self._raw()
        if val in (None, "", "null"):
            return None
        if self.device_class == SensorDeviceClass.TIMESTAMP:
            return dt_util.parse_datetime(str(val))
        try:
            num = float(val)
            return int(num) if num.is_integer() else num
        except (TypeError, ValueError):
            return val


class KiaAccessSeatSensor(KiaAccessEntity, SensorEntity):
    """Current heat/vent level of one seat, decoded to a label."""

    _attr_icon = "mdi:car-seat-heater"

    def __init__(self, coordinator, key: str, name: str) -> None:
        super().__init__(coordinator, key)
        self._attr_name = name

    @property
    def native_value(self):
        val = self._raw()
        if val in (None, ""):
            return None
        try:
            return _SEAT_BY_CODE.get(int(val), str(val))
        except (TypeError, ValueError):
            return str(val)


class KiaAccessActionSensor(KiaAccessEntity, SensorEntity):
    """The remote command currently running (or the last one and its result)."""

    _attr_icon = "mdi:cog-play"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "last_action")
        self._attr_name = "Remote action"

    @property
    def available(self) -> bool:
        return True

    @property
    def native_value(self):
        a = self.coordinator.last_action or {}
        name, status = a.get("name"), a.get("status")
        if not name:
            return "idle"
        return f"{name} ({status})" if status and status != "running" else name

    @property
    def extra_state_attributes(self) -> dict:
        return dict(self.coordinator.last_action or {})


class KiaAccessRangeReachSensor(KiaAccessEntity, SensorEntity):
    """How far the car can actually drive now (range, derated) + which zones
    are in reach. State = one-way distance; `pois` attribute has the details.
    """

    _attr_icon = "mdi:map-marker-radius"
    _attr_device_class = SensorDeviceClass.DISTANCE
    _attr_native_unit_of_measurement = UnitOfLength.KILOMETERS
    _attr_suggested_display_precision = 0
    # POI coordinates + diagnostic blobs ride in the attributes — keep them
    # out of the recorder / history
    _unrecorded_attributes = frozenset(
        {"pois", "in_reach", "calendar_status", "drive_time_status",
         "driving_times_debug"}
    )

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "range_reach")
        self._attr_name = "Range reach"

    def _reach(self) -> dict | None:
        return self.coordinator.range_reach

    @property
    def available(self) -> bool:
        return super().available and self._reach() is not None

    @property
    def native_value(self):
        r = self._reach()
        return round(r["oneWayKm"], 1) if r and r.get("oneWayKm") is not None else None

    @property
    def extra_state_attributes(self) -> dict:
        r = self._reach() or {}
        cal_names = {p["name"] for p in getattr(self.coordinator, "_cal_pois", [])}
        static_names = {p["name"] for p in getattr(self.coordinator, "_static_pois", [])}
        opts = self.coordinator.entry.options
        cs = getattr(self.coordinator, "_cal_status", {})
        rs = getattr(self.coordinator, "_route_status", {})
        pois_out = r.get("pois", [])
        debug = {
            "provider": opts.get("drive_time_provider") or "estimate",
            "routing_key_set": bool(opts.get("routing_api_key")),
            "geocoding_key_set": bool(opts.get("geocoding_api_key")),
            "static_configured": bool((opts.get("static_destinations") or "").strip()),
            "static_geocoded": cs.get("static_geocoded", 0),
            "calendars_configured": bool((opts.get("calendar_entities") or "").strip()),
            "calendar_geocoded": cs.get("geocoded", 0),
            "routes_enabled": rs.get("routes_enabled"),
            "with_roads": rs.get("with_roads", 0),
            "routed_pois": sum(1 for p in pois_out if p.get("routed")),
            "errors": (cs.get("geocode_errors", []) or [])[:3]
            + ([rs["error"]] if rs.get("error") else [])
            + ([rs["route_error"]] if rs.get("route_error") else []),
        }
        return {
            "calendar_status": cs,
            "drive_time_source": r.get("drive_time_source", "estimate"),
            "drive_time_status": rs,
            "driving_times_debug": debug,
            "one_way_km": r.get("oneWayKm"),
            "one_way_mi": round(r["oneWayKm"] * 0.621371, 1)
            if r.get("oneWayKm") is not None else None,
            "round_trip_km": r.get("roundTripKm"),
            "round_trip_mi": round(r["roundTripKm"] * 0.621371, 1)
            if r.get("roundTripKm") is not None else None,
            "reserve_pct": self.coordinator.entry.options.get("range_reserve_pct", 10),
            "factor": self.coordinator.entry.options.get("range_factor", 0.92),
            "in_reach": [p["name"] for p in r.get("pois", []) if p["reachable"]],
            "pois": [
                {
                    "name": p["name"],
                    "latitude": p.get("lat"),
                    "longitude": p.get("lon"),
                    "km": round(p["km"], 1),
                    "mi": round(p["km"] * 0.621371, 1),
                    "reachable": p["reachable"],
                    "one_way_reachable": r.get("oneWayKm") is not None
                    and p["km"] <= r["oneWayKm"],
                    "round_trip_reachable": r.get("roundTripKm") is not None
                    and p["km"] <= r["roundTripKm"],
                    "margin_km": round(p["marginKm"], 1)
                    if p["marginKm"] is not None
                    else None,
                    "arrival_pct": p.get("arrivalPct"),
                    "duration_min": p.get("durationMin"),
                    "duration": _hm(p.get("durationMin")),
                    "typical_min": p.get("typicalMin"),
                    "delay_min": p.get("delayMin"),
                    "delay_pct": (
                        round(p["delayMin"] / p["typicalMin"] * 100)
                        if p.get("typicalMin") and p.get("delayMin") is not None
                        else None
                    ),
                    "via": p.get("via"),
                    "when": p.get("when"),
                    "when_local": _when_local(p.get("when")),
                    "routed": bool(p.get("routed")),
                    "source": (
                        "calendar" if p["name"] in cal_names
                        else "static" if p["name"] in static_names
                        else "zone"
                    ),
                }
                for p in r.get("pois", [])
            ],
        }


class KiaAccessSummarySensor(KiaAccessEntity, SensorEntity):
    """One diagnostic sensor whose attributes carry the whole flat vehicle
    payload — the Lovelace card reads this instead of 20+ entities.

    Its attributes include VIN and GPS coordinates, so keep the whole
    attribute blob out of the recorder / history / logbook.
    """

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:car-info"
    _unrecorded_attributes = frozenset({MATCH_ALL})

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "summary")
        self._attr_name = "Status"

    @property
    def native_value(self):
        v = self.coordinator.vehicle
        return dt_util.parse_datetime(
            str(v.get("last_updated_at") or self.coordinator.meta.get("fetchedAt") or "")
        )

    @property
    def extra_state_attributes(self) -> dict:
        out: dict = {"kia_access_raw": True, "entry_id": self.coordinator.entry.entry_id}
        v = self.coordinator.vehicle
        out["vehicle_name"] = str(v.get("name") or v.get("model") or "Kia")
        for key, val in v.items():
            if key == "data" or isinstance(val, (dict, list)):
                continue
            out[key] = val
        note = self.coordinator.meta.get("note")
        if note:
            out["note"] = note
        return out


class KiaAccessLastChargeSensor(KiaAccessEntity, SensorEntity):
    """Cost (or kWh, if no price set) of the most recent completed charge.

    Attributes carry the session detail, the recent list, and 30-/90-day
    totals — feed the Energy dashboard from `last_kwh`, or chart the list.
    """

    _attr_icon = "mdi:cash-multiple"

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "last_charge")
        self._attr_name = "Last charge"

    def _log(self) -> dict:
        return self.coordinator.charge_log

    @property
    def available(self) -> bool:
        return self._log().get("last") is not None

    def _priced(self) -> bool:
        return (self.coordinator.entry.options.get("price_per_kwh") or 0) > 0

    @property
    def native_value(self):
        last = self._log().get("last")
        if not last:
            return None
        return last.get("cost") if self._priced() else last.get("kwh")

    @property
    def native_unit_of_measurement(self):
        return "USD" if self._priced() else "kWh"

    @property
    def extra_state_attributes(self) -> dict:
        log = self._log()
        last = log.get("last") or {}
        return {
            "started_at": last.get("startedAt"),
            "ended_at": last.get("endedAt"),
            "minutes": last.get("minutes"),
            "start_pct": last.get("startPct"),
            "end_pct": last.get("endPct"),
            "gained_pct": last.get("gainedPct"),
            "last_kwh": last.get("kwh"),
            "last_cost": last.get("cost"),
            "peak_kw": last.get("peakKw"),
            "avg_kw": last.get("avgKw"),
            "price_per_kwh": last.get("pricePerKwh"),
            "month_kwh": log["month"].get("kwh"),
            "month_cost": log["month"].get("cost"),
            "month_sessions": log["month"].get("count"),
            "last_3_months_kwh": log["last_3_months"].get("kwh"),
            "last_3_months_cost": log["last_3_months"].get("cost"),
            "sessions": log.get("recent"),
        }


class KiaAccessChargeSessionSensor(KiaAccessEntity, SensorEntity):
    """Live cost (or kWh) of the charge in progress — climbs while charging.

    Ticks every 60s on its own so the figure keeps moving between Kia polls.
    Unavailable when nothing is charging.
    """

    _attr_icon = "mdi:ev-station"

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "charge_session")
        self._attr_name = "Charge session"
        self._unsub = None

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._unsub = async_track_time_interval(
            self.hass, self._tick, timedelta(seconds=60)
        )

    async def async_will_remove_from_hass(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None

    def _tick(self, _now) -> None:
        if self.coordinator._open_session is not None:  # noqa: SLF001
            self.async_write_ha_state()

    def _priced(self) -> bool:
        return (self.coordinator.entry.options.get("price_per_kwh") or 0) > 0

    def _progress(self):
        c = self.coordinator
        v = c.vehicle
        return charge_sessions.progress(
            c._open_session,  # noqa: SLF001
            {
                "t": time.time() * 1000,
                "charging": v.get("ev_battery_is_charging"),
                "batteryPct": _num(v.get("ev_battery_percentage")),
                "chargeKw": _num(v.get("ev_charging_power")),
            },
            {
                "pricePerKwh": c.entry.options.get("price_per_kwh") or 0,
                "capacityKwh": c.entry.options.get("capacity_kwh")
                or _num(v.get("ev_battery_capacity")),
            },
        )

    @property
    def available(self) -> bool:
        return self.coordinator._open_session is not None  # noqa: SLF001

    @property
    def native_value(self):
        p = self._progress()
        if not p:
            return None
        return p.get("cost") if self._priced() else p.get("kwh")

    @property
    def native_unit_of_measurement(self):
        return "USD" if self._priced() else "kWh"

    @property
    def extra_state_attributes(self) -> dict:
        p = self._progress() or {}
        return {
            "kwh": p.get("kwh"),
            "cost": p.get("cost"),
            "gained_pct": p.get("gainedPct"),
            "minutes": p.get("minutes"),
        }


class KiaAccessLastTripSensor(KiaAccessEntity, SensorEntity):
    """The most recent auto-detected drive.

    State is the trip distance (miles); attributes carry the energy /
    efficiency / cost detail, the recent list, and rolling totals.
    """

    _attr_icon = "mdi:map-marker-path"
    _attr_device_class = SensorDeviceClass.DISTANCE
    _attr_native_unit_of_measurement = UnitOfLength.MILES

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "last_trip")
        self._attr_name = "Last trip"

    def _log(self) -> dict:
        return self.coordinator.trip_log

    @property
    def available(self) -> bool:
        return self._log().get("last") is not None

    @property
    def native_value(self):
        last = self._log().get("last")
        return last.get("distanceMi") if last else None

    @property
    def extra_state_attributes(self) -> dict:
        log = self._log()
        last = log.get("last") or {}
        m30 = log["last_30_days"]
        return {
            "started_at": last.get("startedAt"),
            "ended_at": last.get("endedAt"),
            "minutes": last.get("minutes"),
            "distance_km": last.get("distanceKm"),
            "used_pct": last.get("usedPct"),
            "kwh": last.get("kwh"),
            "mi_per_kwh": last.get("miPerKwh"),
            "kwh_per_100mi": last.get("kwhPer100mi"),
            "cost": last.get("cost"),
            "charged_during": last.get("chargedDuring"),
            "from_lat": last.get("fromLat"),
            "from_lon": last.get("fromLon"),
            "to_lat": last.get("toLat"),
            "to_lon": last.get("toLon"),
            "trips_30d": m30.get("count"),
            "miles_30d": m30.get("distanceMi"),
            "kwh_30d": m30.get("kwh"),
            "cost_30d": m30.get("cost"),
            "mi_per_kwh_30d": m30.get("miPerKwh"),
            "trips": log.get("recent"),
        }


class KiaAccessCostPerMileSensor(KiaAccessEntity, SensorEntity):
    """Running cost per mile from the trip log — 30-day figure as the state,
    90-day and lifetime in the attributes. Needs a price per kWh set."""

    _attr_icon = "mdi:cash-multiple"
    _attr_native_unit_of_measurement = "USD/mi"
    _attr_suggested_display_precision = 3

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "cost_per_mile")
        self._attr_name = "Cost per mile"

    def _log(self) -> dict:
        return self.coordinator.trip_log

    @property
    def available(self) -> bool:
        return (
            (self.coordinator.entry.options.get("price_per_kwh") or 0) > 0
            and self._log()["last_30_days"].get("costPerMi") is not None
        )

    @property
    def native_value(self):
        return self._log()["last_30_days"].get("costPerMi")

    @property
    def extra_state_attributes(self) -> dict:
        log = self._log()
        return {
            "cost_per_mile_90d": log["last_90_days"].get("costPerMi"),
            "cost_per_mile_lifetime": log["lifetime"].get("costPerMi"),
            "mi_per_kwh_30d": log["last_30_days"].get("miPerKwh"),
            "mi_per_kwh_lifetime": log["lifetime"].get("miPerKwh"),
            "miles_30d": log["last_30_days"].get("distanceMi"),
            "cost_30d": log["last_30_days"].get("cost"),
        }


class KiaAccessParkedSensor(KiaAccessEntity, SensorEntity):
    """Where the car was last seen parked. State is a short address (or
    "lat, lon"); attributes carry map deep-links + distance from home."""

    _attr_icon = "mdi:car-brake-parking"

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "parked")
        self._attr_name = "Parked"

    def _p(self) -> dict | None:
        return self.coordinator.parked_location

    @property
    def available(self) -> bool:
        return self._p() is not None

    @property
    def native_value(self):
        p = self._p()
        if not p:
            return None
        if p.get("address"):
            return str(p["address"])[:255]
        return f"{round(p['latitude'], 5)}, {round(p['longitude'], 5)}"

    @property
    def extra_state_attributes(self) -> dict:
        return self._p() or {}
