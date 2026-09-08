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
        # Stable identity: the config entry id. It never changes for the life of
        # the entry, and — crucially — it is what pre-2.1.1 entities already used
        # (that code fell back to entry_id whenever VIN was None, which it always
        # is before the car's first sync). Deriving identity from VIN, or from
        # entry.unique_id, would recreate every entity + the device on upgrade.
        ident = coordinator.entry.entry_id
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
