"""Shared entity base for Kia Access."""
from __future__ import annotations

from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_BRAND, DOMAIN
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
        self._ident = coordinator.entry.entry_id
        self._attr_unique_id = f"{self._ident}_{key}"

    @property
    def device_info(self) -> DeviceInfo:
        # A @property (recomputed on every access), not a fixed
        # self._attr_device_info set once in __init__: the FIRST successful
        # fetch that lets async_setup_entry() reach entity creation at all
        # can still be a genuinely near-empty Kia record (documented
        # elsewhere as "Kia returned an empty state for this vehicle, open
        # the Kia app once to force a sync") -- a real vehicle dict, just
        # with model/name/VIN not filled in yet. A one-time-built
        # DeviceInfo would freeze the device's registry entry at that
        # incomplete snapshot forever, even once a later poll brings in the
        # real values -- this way it reflects whatever the coordinator
        # currently has, same as every other property here.
        v = self.coordinator.vehicle
        vin = v.get("VIN")
        brand_name = self._brand_name()
        return DeviceInfo(
            identifiers={(DOMAIN, self._ident)},
            manufacturer=str(v.get("manufacturer") or brand_name),
            model=str(v.get("model") or ""),
            name=str(v.get("name") or v.get("model") or brand_name),
            serial_number=str(vin) if vin else None,
        )

    def _brand_name(self) -> str:
        # "KIA"/"HYUNDAI"/"GENESIS" (config_flow.py's BRANDS) -> "Kia"/
        # "Hyundai"/"Genesis" -- this integration validates all three
        # brands at setup, so a bare "Kia" fallback mislabeled every
        # Hyundai/Genesis vehicle wherever the cloud hadn't reported its
        # own manufacturer/name field yet. ONE canonical brand-display
        # resolver, used by device_info here AND by sensor.py's
        # vehicle_name attribute -- the earlier fix only touched
        # device_info, leaving the same hardcoded "Kia" in sensor.py.
        return str(self.coordinator.entry.data.get(CONF_BRAND) or "KIA").title()

    def _currency(self) -> str:
        # ISO 4217-ish display code for the cost sensors -- purely a label,
        # no conversion happens anywhere; price_per_kwh/away_price_per_kwh
        # are already in whatever currency the user's own rate is in. "USD"
        # was hardcoded here for every non-US install until this option
        # existed.
        return str(self.coordinator.entry.options.get("currency") or "USD").upper()

    @property
    def available(self) -> bool:
        return super().available and bool(self.coordinator.vehicle)

    def _raw(self):
        return self.coordinator.vehicle.get(self._key)
