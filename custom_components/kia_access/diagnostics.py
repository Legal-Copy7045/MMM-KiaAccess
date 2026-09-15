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
    "location",           # combined "lon, lat" string on the summary sensor
    "location_latitude",
    "location_longitude",
    "latitude",
    "longitude",
    "geocode",
    "key",                # per-vehicle API key/uuid
    "routing_api_key",    # TomTom key, entry.options -- live, usable if leaked
    "geocoding_api_key",  # Geoapify key, entry.options -- ditto
    "static_destinations",  # entry.options free text -- typically home/frequent addresses
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
            # entry.options carries routing_api_key/geocoding_api_key (live,
            # usable API keys) and static_destinations (typically home/
            # frequent addresses) -- this was never redacted at all before,
            # so downloading diagnostics to attach to a bug report (exactly
            # what HA's own UI invites a user to do) leaked them in plain
            # text into whatever's read that file.
            "options": async_redact_data(dict(entry.options), _REDACT),
        },
        "meta": async_redact_data(dict(getattr(coordinator, "meta", {}) or {}), _REDACT),
        "last_action": getattr(coordinator, "last_action", None),
        "climate_prefs": getattr(coordinator, "climate_prefs", None),
        "vehicle": async_redact_data(vehicle, _REDACT),
    }
