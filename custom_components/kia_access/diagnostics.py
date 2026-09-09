"""Diagnostics for Kia Access (Settings -> device -> Download diagnostics)."""
from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_REDACT = {
    "username",
    "password",
    "pin",
    "token",
    "VIN",
    "vin",
    "location_latitude",
    "location_longitude",
    "latitude",
    "longitude",
    "geocode",
}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    coordinator = hass.data.get(DOMAIN, {}).get(entry.entry_id)
    vehicle = dict(getattr(coordinator, "vehicle", {}) or {})
    # the raw API dump can be huge and carries the same sensitive fields
    vehicle.pop("data", None)
    return {
        "entry": {
            "data": async_redact_data(dict(entry.data), _REDACT),
            "options": dict(entry.options),
        },
        "meta": getattr(coordinator, "meta", {}),
        "last_action": getattr(coordinator, "last_action", None),
        "climate_prefs": getattr(coordinator, "climate_prefs", None),
        "vehicle": async_redact_data(vehicle, _REDACT),
    }
