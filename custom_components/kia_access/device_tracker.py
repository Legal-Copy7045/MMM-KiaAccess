"""Kia Access device tracker — the vehicle's GPS position, so HA's map,
zones, presence and location automations work natively."""
from __future__ import annotations

from homeassistant.components.device_tracker import SourceType, TrackerEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .entity import KiaAccessEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([KiaAccessDeviceTracker(coordinator)])


def _num(x):
    try:
        return None if x is None or x == "" else float(x)
    except (TypeError, ValueError):
        return None


class KiaAccessDeviceTracker(KiaAccessEntity, TrackerEntity):
    _attr_name = "Location"
    _attr_icon = "mdi:car"

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "location")

    @property
    def source_type(self) -> SourceType:
        return SourceType.GPS

    @property
    def latitude(self) -> float | None:
        return _num(self.coordinator.vehicle.get("location_latitude"))

    @property
    def longitude(self) -> float | None:
        return _num(self.coordinator.vehicle.get("location_longitude"))

    @property
    def location_accuracy(self) -> int:
        return 0  # the Kia API doesn't report a GPS accuracy

    @property
    def battery_level(self) -> int | None:
        pct = _num(self.coordinator.vehicle.get("ev_battery_percentage"))
        return round(pct) if pct is not None else None

    @property
    def available(self) -> bool:
        return (
            super().available
            and self.latitude is not None
            and self.longitude is not None
        )
