"""Kia Access sensors, generated from entities.json."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN, ENTITIES
from .entity import KiaAccessEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        KiaAccessSensor(coordinator, spec)
        for spec in ENTITIES
        if spec["domain"] == "sensor"
    )


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
            self._attr_icon = spec["icon"].replace("mdi:", "mdi:")

    @property
    def native_value(self):
        val = self._raw()
        if val in (None, "", "null"):
            return None
        if self._attr_device_class == "timestamp":
            return dt_util.parse_datetime(str(val))
        try:
            num = float(val)
            return int(num) if num.is_integer() else num
        except (TypeError, ValueError):
            return val
