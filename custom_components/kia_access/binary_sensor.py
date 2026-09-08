"""Kia Access binary sensors, generated from entities.json."""
from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, ENTITIES
from .entity import KiaAccessEntity

_TRUE = {True, "true", "True", 1, "1", "on", "yes"}
_FALSE = {False, "false", "False", 0, "0", "off", "no"}


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        KiaAccessBinarySensor(coordinator, spec)
        for spec in ENTITIES
        if spec["domain"] == "binary_sensor"
    )


class KiaAccessBinarySensor(KiaAccessEntity, BinarySensorEntity):
    def __init__(self, coordinator, spec: dict) -> None:
        super().__init__(coordinator, spec["key"])
        self._attr_name = spec["name"]
        self._invert = bool(spec.get("invert"))
        if spec.get("device_class"):
            self._attr_device_class = spec["device_class"]

    @property
    def is_on(self) -> bool | None:
        val = self._raw()
        if val in _TRUE:
            state = True
        elif val in _FALSE:
            state = False
        else:
            return None
        return (not state) if self._invert else state
