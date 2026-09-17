"""Kia Access binary sensors, generated from entities.json -- plus one
bespoke entity (KiaAccessDataStaleBinarySensor) that isn't catalogue-driven,
since it reflects coordinator-computed metadata (how old the car's own
last-reported reading is), not a raw vehicle attribute."""
from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
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
        [KiaAccessDataStaleBinarySensor(coordinator)]
        + [
            KiaAccessBinarySensor(coordinator, spec)
            for spec in ENTITIES
            if spec["domain"] == "binary_sensor"
        ]
    )


class KiaAccessBinarySensor(KiaAccessEntity, BinarySensorEntity):
    def __init__(self, coordinator, spec: dict) -> None:
        super().__init__(coordinator, spec["key"])
        self._attr_name = spec["name"]
        self._invert = bool(spec.get("invert"))
        if spec.get("device_class"):
            self._attr_device_class = spec["device_class"]
        if spec.get("category") == "diagnostic":
            self._attr_entity_category = EntityCategory.DIAGNOSTIC

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


class KiaAccessDataStaleBinarySensor(KiaAccessEntity, BinarySensorEntity):
    """On when the CAR's own last-reported reading (vehicle.last_updated_at)
    is older than the configured stale_after_minutes -- distinct from a
    failed poll, which HA already reflects by making every entity
    unavailable (see KiaAccessEntity.available / last_update_success). A
    poll can keep succeeding while the car itself just hasn't checked in.
    """

    _attr_name = "Data stale"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "data_stale")

    @property
    def is_on(self) -> bool | None:
        return self.coordinator.is_stale

    @property
    def extra_state_attributes(self) -> dict:
        reported = self.coordinator.vehicle_reported_at
        succeeded = self.coordinator.last_successful_update
        age = self.coordinator.data_age_seconds
        return {
            "last_reported": reported.isoformat() if reported else None,
            "last_successful_update": succeeded.isoformat() if succeeded else None,
            "data_age_minutes": round(age / 60, 1) if age is not None else None,
            "stale_after_minutes": self.coordinator.stale_after_minutes,
        }
