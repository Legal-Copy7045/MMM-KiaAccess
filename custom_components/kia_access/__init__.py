"""The Kia Access integration.

Reads vehicle state from the Kia/Hyundai cloud (via the shared kia_client.py,
identical to the MagicMirror bridge) and exposes it as sensors / binary sensors,
plus buttons and services for lock / unlock / climate / charging generated from
core/commands.json.
"""
from __future__ import annotations

import logging
import os

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
import homeassistant.helpers.config_validation as cv

from .const import COMMANDS, DOMAIN, PLATFORMS
from .coordinator import KiaAccessCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Kia Access from a config entry."""
    coordinator = KiaAccessCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _register_services(hass)
    await _register_frontend(hass)
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


CARD_URL = f"/{DOMAIN}/kia-access-card.js"
_CARD_PATH = os.path.join(os.path.dirname(__file__), "frontend", "kia-access-card.js")


async def _register_frontend(hass: HomeAssistant) -> None:
    """Serve and auto-load the Lovelace card (best-effort)."""
    if hass.data[DOMAIN].get("_frontend"):
        return
    hass.data[DOMAIN]["_frontend"] = True
    if not os.path.exists(_CARD_PATH):
        _LOGGER.warning("Kia Access card bundle missing at %s", _CARD_PATH)
        return
    try:
        try:
            from homeassistant.components.http import StaticPathConfig

            await hass.http.async_register_static_paths(
                [StaticPathConfig(CARD_URL, _CARD_PATH, False)]
            )
        except ImportError:  # HA < 2024.7
            hass.http.register_static_path(CARD_URL, _CARD_PATH, False)

        from homeassistant.components.frontend import add_extra_js_url

        add_extra_js_url(hass, CARD_URL)
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("Could not auto-register Kia Access card: %s", err)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
        if not hass.data[DOMAIN]:
            for spec in COMMANDS:
                hass.services.async_remove(DOMAIN, spec["key"])
    return unload_ok


async def _async_reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


def _coordinator_for(hass: HomeAssistant, call: ServiceCall) -> KiaAccessCoordinator:
    store = hass.data.get(DOMAIN, {})
    entry_id = call.data.get("entry_id")
    if entry_id and entry_id in store:
        return store[entry_id]
    if len(store) == 1:
        return next(iter(store.values()))
    raise HomeAssistantError(
        "Multiple Kia Access accounts configured — pass entry_id in the service call."
    )


def _register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, COMMANDS[0]["key"]):
        return

    for spec in COMMANDS:
        opt_schema = {vol.Optional("entry_id"): cv.string}
        for opt_name, meta in (spec.get("options") or {}).items():
            typ = {
                "int": vol.Coerce(int),
                "float": vol.Coerce(float),
                "bool": cv.boolean,
            }.get(meta.get("type"), cv.string)
            opt_schema[vol.Optional(opt_name)] = typ

        def _make_handler(command_key: str):
            async def _handler(call: ServiceCall) -> None:
                coordinator = _coordinator_for(hass, call)
                options = {
                    k: v for k, v in call.data.items() if k != "entry_id"
                }
                try:
                    await coordinator.async_run_command(command_key, options)
                except Exception as err:  # noqa: BLE001
                    raise HomeAssistantError(
                        f"Kia Access '{command_key}' failed: {err}"
                    ) from err

            return _handler

        hass.services.async_register(
            DOMAIN, spec["key"], _make_handler(spec["key"]), schema=vol.Schema(opt_schema)
        )
