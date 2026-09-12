"""Kia Access buttons.

Most buttons here are generated from commands.json: only the no-argument
commands (lock, unlock, stop climate, start/stop charge, flash hazards,
flash + honk, open/close charge port) get one. The parameterised commands
(start_climate, set_charge_limits, send_to_car) are services only — the
Lovelace card gives start_climate a proper panel.

`KiaAccessRefreshButton` below is hand-written (not commands.json-driven) --
it triggers a coordinator-level "pull fresh data now" rather than a
kia_client control command.
"""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import COMMANDS, DOMAIN
from .entity import KiaAccessEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [KiaAccessRefreshButton(coordinator)]
        + [
            KiaAccessButton(coordinator, spec)
            for spec in COMMANDS
            if not spec.get("options")
        ]
    )


class KiaAccessRefreshButton(KiaAccessEntity, ButtonEntity):
    """Manual 'pull fresh data from Kia's servers now' button -- wakes the
    car for a live update even when the integration is set to poll from
    Kia's cache only."""

    _attr_name = "Refresh now"
    _attr_icon = "mdi:refresh"

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "refresh_now")

    async def async_press(self) -> None:
        await self.coordinator.async_force_refresh()


class KiaAccessButton(KiaAccessEntity, ButtonEntity):
    def __init__(self, coordinator, spec: dict) -> None:
        super().__init__(coordinator, f"cmd_{spec['key']}")
        self._command = spec["key"]
        self._attr_name = spec["name"]
        if spec.get("icon"):
            self._attr_icon = spec["icon"]

    async def async_press(self) -> None:
        await self.coordinator.async_run_command(
            self._command, context=getattr(self, "_context", None)
        )
