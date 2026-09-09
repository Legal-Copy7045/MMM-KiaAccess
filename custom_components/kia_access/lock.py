"""Kia Access lock entity — wraps the lock / unlock commands."""
from __future__ import annotations

from homeassistant.components.lock import LockEntity
from homeassistant.config_entries import ConfigEntry
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
    async_add_entities([KiaAccessLock(coordinator)])


class KiaAccessLock(KiaAccessEntity, LockEntity):
    _attr_name = "Doors"

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "lock")
        self._optimistic: bool | None = None

    @property
    def is_locked(self) -> bool | None:
        if self._optimistic is not None:
            return self._optimistic
        val = self.coordinator.vehicle.get("is_locked")
        if val in _TRUE:
            return True
        if val in _FALSE:
            return False
        return None

    async def async_lock(self, **kwargs) -> None:
        self._optimistic = True
        self.async_write_ha_state()
        await self.coordinator.async_run_command("lock")
        self._optimistic = None

    async def async_unlock(self, **kwargs) -> None:
        self._optimistic = False
        self.async_write_ha_state()
        await self.coordinator.async_run_command("unlock")
        self._optimistic = None
