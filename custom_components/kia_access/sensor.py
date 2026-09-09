"""Kia Access sensors, generated from entities.json."""
from __future__ import annotations

import time
from datetime import timedelta

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL, EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from . import sessions as charge_sessions
from .const import DOMAIN, ENTITIES
from .entity import KiaAccessEntity


def _num(x):
    try:
        return None if x is None or x == "" else float(x)
    except (TypeError, ValueError):
        return None


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
