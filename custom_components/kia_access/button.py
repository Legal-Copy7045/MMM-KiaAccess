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
from .vehicle_state import can_plug_in_for


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    # no plug (gas, OR a conventional non-plug hybrid like a Kia Sportage
    # Hybrid/Hyundai Tucson Hybrid -- see can_plug_in_for()'s docstring) ->
    # no charge port, no charging commands. The commands.json "charge"
    # category is exactly (and only) those commands (start/stop charge,
    # open/close charge port), so it doubles as the gate here with no
    # separate per-command flag needed. Read once at setup:
    # async_config_entry_first_refresh() already ran (see __init__.py) so
    # coordinator.vehicle reflects the real engine_type by the time
    # platforms are set up, not whatever an empty pre-poll dict would
    # default to.
    can_plug_in = can_plug_in_for(coordinator.vehicle.get("engine_type"))
    async_add_entities(
        [KiaAccessRefreshButton(coordinator)]
        + [
            KiaAccessButton(coordinator, spec)
            for spec in COMMANDS
            if not spec.get("options")
            and not (not can_plug_in and spec.get("category") == "charge")
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
