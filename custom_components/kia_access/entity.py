"""Shared entity base for Kia Access."""
from __future__ import annotations

from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import KiaAccessCoordinator


class KiaAccessEntity(CoordinatorEntity[KiaAccessCoordinator]):
    """Common device info + availability."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: KiaAccessCoordinator, key: str) -> None:
        super().__init__(coordinator)
        self._key = key
        # Stable identity: never derive from VIN. A brand-new car reports VIN=None
        # until its first sync; if identity flipped to the VIN later, every entity
        # and the device would be recreated. entry.unique_id is region:brand:user
        # (set in the config flow) and never changes.
        ident = coordinator.entry.unique_id or coordinator.entry.entry_id
        self._attr_unique_id = f"{ident}_{key}"
        vin = coordinator.vehicle.get("VIN")
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, ident)},
            manufacturer=str(coordinator.vehicle.get("manufacturer") or "Kia"),
            model=str(coordinator.vehicle.get("model") or ""),
            name=str(
                coordinator.vehicle.get("name")
                or coordinator.vehicle.get("model")
                or "Kia"
            ),
            serial_number=str(vin) if vin else None,
        )

    @property
    def available(self) -> bool:
        return super().available and bool(self.coordinator.vehicle)

    def _raw(self):
        return self.coordinator.vehicle.get(self._key)
