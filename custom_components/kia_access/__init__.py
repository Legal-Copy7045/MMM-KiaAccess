"""The Kia Access integration.

Reads vehicle state from the Kia/Hyundai cloud (via the shared kia_client.py,
identical to the MagicMirror bridge) and exposes it as sensors / binary sensors,
plus buttons and services for lock / unlock / climate / charging generated from
core/commands.json.
"""
from __future__ import annotations

import logging
import os
from datetime import timedelta

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
import homeassistant.helpers.config_validation as cv
from homeassistant.helpers.event import async_track_time_interval

from .const import COMMANDS, DOMAIN, EVENT_STATE_CHANGED, PLATFORMS, VERSION
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

    # Calendar destinations + drive-time routing on their own 1-min timer,
    # independent of the (often much longer, battery-friendly) vehicle
    # scan_interval -- reading calendar.get_events and the geocode cache is
    # local/free, so there's no reason a new calendar event should wait on
    # the vehicle poll cadence to show up. _refresh_drive_times() keeps its
    # own separate throttle for the actual external routing calls.
    async def _calendar_tick(_now) -> None:
        await coordinator._refresh_calendar_and_routes()  # noqa: SLF001
        coordinator.async_update_listeners()

    entry.async_on_unload(
        async_track_time_interval(hass, _calendar_tick, timedelta(minutes=1))
    )
    return True


CARD_URL = f"/{DOMAIN}/kia-access-card.js"
_CARD_PATH = os.path.join(os.path.dirname(__file__), "frontend", "kia-access-card.js")


async def _register_frontend(hass: HomeAssistant) -> None:
    """Serve and auto-load the Lovelace card (best-effort, once per HA start)."""
    global _FRONTEND_REGISTERED
    if _FRONTEND_REGISTERED:
        return
    if not await hass.async_add_executor_job(os.path.exists, _CARD_PATH):
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

    # add_extra_js_url alone races Lovelace's own dashboard rendering: on a
    # cold app/browser launch straight into a view with our card, Lovelace
    # can construct <kia-access-card>/<kia-range-map-card> before the extra
    # module has finished loading, showing a "Configuration error" that only
    # self-heals with a reload. A resource added the normal way (Settings ->
    # Dashboards -> Resources) IS awaited before Lovelace builds any view, so
    # also registering one here (best-effort, private API, never fatal) fixes
    # that race for storage-mode dashboards without the user doing it by hand.
    await _ensure_lovelace_resource(hass, CARD_URL)


async def _ensure_lovelace_resource(hass: HomeAssistant, url: str) -> None:
    """Best-effort: register CARD_URL as a real Lovelace resource so the
    frontend awaits it before rendering any dashboard (see _register_frontend).
    No-ops quietly for YAML-mode dashboards, if lovelace hasn't set up yet, or
    if this private API changes shape in a future HA release -- add_extra_js_url
    above is the fallback that still works either way."""
    try:
        from homeassistant.components.lovelace.const import (
            CONF_RESOURCE_TYPE_WS,
            LOVELACE_DATA,
        )
        from homeassistant.components.lovelace.resources import (
            ResourceStorageCollection,
        )
        from homeassistant.const import CONF_URL

        lovelace_data = hass.data.get(LOVELACE_DATA)
        if lovelace_data is None:
            return
        resources = lovelace_data.resources
        if not isinstance(resources, ResourceStorageCollection):
            return  # YAML-managed resources -- nothing we can add programmatically

        # lovelace's own setup doesn't load this collection eagerly (only the
        # dashboards collection) -- async_create_item below calls this same
        # guarded helper internally, but we need self.data populated first
        # too, for the dedup check right after
        await resources._async_ensure_loaded()  # noqa: SLF001
        # no query string here: the static path already disables caching
        # (register_static_path(..., cache_headers=False) above), so this
        # entry keeps working across future version bumps without edits
        if any(item.get(CONF_URL) == url for item in resources.async_items()):
            return
        await resources.async_create_item(
            {CONF_RESOURCE_TYPE_WS: "module", CONF_URL: url}
        )
    except Exception:  # noqa: BLE001
        _LOGGER.debug(
            "Could not auto-register Kia Access card as a Lovelace resource "
            "(non-fatal, add_extra_js_url still covers it)",
            exc_info=True,
        )


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
        if not hass.data.get(DOMAIN):
            for spec in COMMANDS:
                hass.services.async_remove(DOMAIN, spec["key"])
            hass.services.async_remove(DOMAIN, "refresh_calendar_destinations")
            hass.services.async_remove(DOMAIN, "set_charge_cost")
            hass.services.async_remove(DOMAIN, "test_alert")
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
                    await coordinator.async_run_command(
                        command_key, options, context=call.context
                    )
                except HomeAssistantError:
                    raise
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
        # calendar refresh has no throttle to clear (every poll runs it); the
        # routing throttle still needs clearing so the new/changed POIs route
        coordinator._route_at = 0.0  # noqa: SLF001 — re-route the new POIs too
        try:
            await coordinator.async_refresh_calendar_pois()
        except Exception as err:  # noqa: BLE001
            _LOGGER.exception("Kia Access calendar refresh failed")
            raise HomeAssistantError(
                f"Kia Access calendar refresh failed: {err}"
            ) from err
        try:
            await coordinator._refresh_drive_times()  # noqa: SLF001
        except Exception:  # noqa: BLE001
            _LOGGER.debug("drive-time refresh failed", exc_info=True)
        coordinator.async_update_listeners()

    hass.services.async_register(
        DOMAIN,
        "refresh_calendar_destinations",
        _refresh_calendar,
        schema=vol.Schema({vol.Optional("entry_id"): cv.string}),
    )

    async def _set_charge_cost(call: ServiceCall) -> None:
        coordinator = _coordinator_for(hass, call)
        try:
            await coordinator.set_charge_cost(
                float(call.data["cost"]), call.data.get("started_at")
            )
        except (ValueError, KeyError) as err:
            raise HomeAssistantError(f"Kia Access set_charge_cost: {err}") from err

    hass.services.async_register(
        DOMAIN,
        "set_charge_cost",
        _set_charge_cost,
        schema=vol.Schema({
            vol.Required("cost"): vol.Coerce(float),
            vol.Optional("started_at"): vol.Coerce(float),
            vol.Optional("entry_id"): cv.string,
        }),
    )

    async def _test_alert(call: ServiceCall) -> None:
        """Fire a synthetic kia_access_alert event — no real condition needed.
        For checking a notify target / the alert_to_phone blueprint / quiet
        hours / action buttons without waiting for the real thing to happen."""
        coordinator = _coordinator_for(hass, call)
        reason = call.data.get("reason", "unlocked")
        level = call.data.get("level", "warning")
        active = call.data.get("active", True)
        label = reason.replace("_", " ")
        hass.bus.async_fire(
            EVENT_STATE_CHANGED,
            {
                "entry_id": coordinator.entry.entry_id,
                "reason": reason,
                "level": level,
                "active": active,
                "title": f"Kia Access test — {label}",
                "message": (
                    f"Test alert: {label}" if active
                    else f"Test alert cleared: {label}"
                ),
                "value": {},
                "vin": coordinator.vehicle.get("VIN"),
            },
        )

    hass.services.async_register(
        DOMAIN,
        "test_alert",
        _test_alert,
        schema=vol.Schema({
            vol.Optional("reason", default="unlocked"): cv.string,
            vol.Optional("level", default="warning"): vol.In(
                ["info", "warning", "critical"]
            ),
            vol.Optional("active", default=True): cv.boolean,
            vol.Optional("entry_id"): cv.string,
        }),
    )
