"""Kia Access switches — charging on/off and the climate defrost preferences."""
from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .entity import KiaAccessEntity

_TRUE = {True, "true", "True", 1, "1", "on", "yes"}
_FALSE = {False, "false", "False", 0, "0", "off", "no"}


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            KiaAccessChargingSwitch(coordinator),
            KiaAccessPrefSwitch(
                coordinator, "front_defrost", "Front defrost with climate", "mdi:car-defrost-front"
            ),
            KiaAccessPrefSwitch(
                coordinator, "rear_defrost", "Rear defrost with climate", "mdi:car-defrost-rear"
            ),
        ]
    )


class KiaAccessChargingSwitch(KiaAccessEntity, SwitchEntity):
    _attr_name = "Charging"
    _attr_icon = "mdi:battery-charging"

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "charging_switch")

    @property
    def available(self) -> bool:
        return super().available and (
            self.coordinator.vehicle.get("ev_battery_is_plugged_in") in _TRUE
        )

    @property
    def is_on(self) -> bool | None:
        val = self.coordinator.vehicle.get("ev_battery_is_charging")
        if val in _TRUE:
            return True
        if val in _FALSE:
            return False
        return None

    async def async_turn_on(self, **kwargs) -> None:
        await self.coordinator.async_run_command("start_charge")

    async def async_turn_off(self, **kwargs) -> None:
        await self.coordinator.async_run_command("stop_charge")


class KiaAccessPrefSwitch(KiaAccessEntity, SwitchEntity):
    """A stored climate preference — applied on the next start_climate."""

    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator, pref: str, name: str, icon: str) -> None:
        super().__init__(coordinator, f"pref_{pref}")
        self._pref = pref
        self._attr_name = name
        self._attr_icon = icon

    @property
    def available(self) -> bool:
        return True  # a preference, editable even before the first sync

    @property
    def is_on(self) -> bool:
        return bool(self.coordinator.climate_prefs.get(self._pref))

    async def async_turn_on(self, **kwargs) -> None:
        await self.coordinator.async_set_pref(self._pref, True)

    async def async_turn_off(self, **kwargs) -> None:
        await self.coordinator.async_set_pref(self._pref, False)
