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

from .const import COMMANDS, DOMAIN, PLATFORMS, VERSION
from .coordinator import KiaAccessCoordinator

_LOGGER = logging.getLogger(__name__)

# module-level (not in hass.data[DOMAIN], which is the {entry_id: coordinator} map)
_FRONTEND_REGISTERED = False


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Kia Access from a config entry."""
    # Register the Lovelace card first, independent of the vehicle data fetch:
    # if the Kia cloud call below is slow or fails, HA raises ConfigEntryNotReady
    # and retries later -- but the card element must still be defined in the
    # browser, or every dashboard using it shows a bare "Configuration error".
    await _register_frontend(hass)

    coordinator = KiaAccessCoordinator(hass, entry)
    coordinator.last_options = dict(entry.options)
    await coordinator.async_load_sessions()
    await coordinator.async_load_prefs()
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _register_services(hass)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


CARD_URL = f"/{DOMAIN}/kia-access-card.js"
_CARD_PATH = os.path.join(os.path.dirname(__file__), "frontend", "kia-access-card.js")


async def _register_frontend(hass: HomeAssistant) -> None:
    """Serve and auto-load the Lovelace card (best-effort, once per HA start)."""
    global _FRONTEND_REGISTERED
    if _FRONTEND_REGISTERED:
        return
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

        # version query string busts the browser cache after a HACS update
        add_extra_js_url(hass, f"{CARD_URL}?v={VERSION}")
    except Exception as err:  # noqa: BLE001
        # leave _FRONTEND_REGISTERED False so the next entry setup retries
        _LOGGER.warning("Could not auto-register Kia Access card: %s", err)
        return
    _FRONTEND_REGISTERED = True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
        if not hass.data.get(DOMAIN):
            for spec in COMMANDS:
                hass.services.async_remove(DOMAIN, spec["key"])
            hass.services.async_remove(DOMAIN, "refresh_calendar_destinations")
    return unload_ok


async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload only when the user changed options — not when we persist a
    rotated token into entry.data (that fires this listener too)."""
    coordinator = hass.data.get(DOMAIN, {}).get(entry.entry_id)
    if coordinator is not None and getattr(coordinator, "last_options", None) == dict(entry.options):
        return
    await hass.config_entries.async_reload(entry.entry_id)


def _coordinator_for(hass: HomeAssistant, call: ServiceCall) -> KiaAccessCoordinator:
    store = {
        k: v
        for k, v in hass.data.get(DOMAIN, {}).items()
        if isinstance(v, KiaAccessCoordinator)
    }
    entry_id = call.data.get("entry_id")
    if entry_id and entry_id in store:
        return store[entry_id]
    if len(store) == 1:
        return next(iter(store.values()))
    if not store:
        raise HomeAssistantError("Kia Access is not set up.")
    raise HomeAssistantError(
        "Multiple Kia Access accounts configured — pass entry_id in the service call."
    )


def _register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, COMMANDS[0]["key"]):
        return

    for spec in COMMANDS:
        opt_schema = {vol.Optional("entry_id"): cv.string}
        for opt_name, meta in (spec.get("options") or {}).items():
            base = {
                "int": vol.Coerce(int),
                "float": vol.Coerce(float),
                "bool": cv.boolean,
            }.get(meta.get("type"), cv.string)
            if meta.get("type") in ("int", "float") and (
                meta.get("min") is not None or meta.get("max") is not None
            ):
                typ = vol.All(base, vol.Range(min=meta.get("min"), max=meta.get("max")))
            else:
                typ = base
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

    async def _refresh_calendar(call: ServiceCall) -> None:
        coordinator = _coordinator_for(hass, call)
        coordinator._cal_pois_at = 0.0  # noqa: SLF001 — clear the throttle
        coordinator._route_at = 0.0  # noqa: SLF001 — re-route the new POIs too
        await coordinator.async_refresh_calendar_pois()
        try:
            await coordinator._refresh_drive_times()  # noqa: SLF001
        except Exception:  # noqa: BLE001
            pass
        coordinator.async_update_listeners()

    hass.services.async_register(
        DOMAIN,
        "refresh_calendar_destinations",
        _refresh_calendar,
        schema=vol.Schema({vol.Optional("entry_id"): cv.string}),
    )
