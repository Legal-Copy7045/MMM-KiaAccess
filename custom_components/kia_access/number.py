"""Kia Access numbers — AC / DC charge limits and the climate run time."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE, EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
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
    async_add_entities(
        [
            KiaAccessChargeLimit(coordinator, "ac"),
            KiaAccessChargeLimit(coordinator, "dc"),
            KiaAccessClimateDuration(coordinator),
        ]
    )


class KiaAccessChargeLimit(KiaAccessEntity, NumberEntity):
    _attr_native_min_value = 50
    _attr_native_max_value = 100
    _attr_native_step = 10
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_mode = NumberMode.SLIDER
    _attr_icon = "mdi:battery-lock"

    def __init__(self, coordinator, which: str) -> None:
        super().__init__(coordinator, f"charge_limit_{which}")
        self._which = which  # "ac" | "dc"
        self._attr_name = f"{which.upper()} charge limit"

    @property
    def native_value(self):
        return _num(self.coordinator.vehicle.get(f"ev_charge_limits_{self._which}"))

    async def async_set_native_value(self, value: float) -> None:
        v = self.coordinator.vehicle
        ac = _num(v.get("ev_charge_limits_ac")) or 80
        dc = _num(v.get("ev_charge_limits_dc")) or 100
        if self._which == "ac":
            ac = value
        else:
            dc = value
        await self.coordinator.async_run_command(
            "set_charge_limits", {"ac_limit": int(ac), "dc_limit": int(dc)}
        )


class KiaAccessClimateDuration(KiaAccessEntity, NumberEntity):
    """Stored preference: how long a remote climate run lasts."""

    _attr_name = "Climate run time"
    _attr_native_min_value = 1
    _attr_native_max_value = 30
    _attr_native_step = 1
    _attr_native_unit_of_measurement = UnitOfTime.MINUTES
    _attr_mode = NumberMode.BOX
    _attr_icon = "mdi:timer-cog"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "climate_duration")

    @property
    def available(self) -> bool:
        return True

    @property
    def native_value(self):
        return self.coordinator.climate_prefs.get("duration", 10)

    async def async_set_native_value(self, value: float) -> None:
        await self.coordinator.async_set_pref("duration", int(value))
