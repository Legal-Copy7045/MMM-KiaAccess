"""Kia Access sensors, generated from entities.json."""
from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN, ENTITIES
from .entity import KiaAccessEntity


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
    payload — the Lovelace card reads this instead of 20+ entities."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:car-info"

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
