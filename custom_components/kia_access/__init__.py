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

from .config_flow import _account_uid
from .const import (
    COMMANDS,
    CONF_BRAND,
    CONF_REGION,
    CONF_VIN,
    DOMAIN,
    EVENT_KIA_ACCESS_ALERT,
    PLATFORMS,
    VERSION,
)
from .coordinator import KiaAccessCoordinator

_LOGGER = logging.getLogger(__name__)

# module-level (not in hass.data[DOMAIN], which is the {entry_id: coordinator} map)
_FRONTEND_REGISTERED = False


def _migrate_unique_id(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Bring a pre-v2.54 entry's unique_id in line with what a fresh setup
    would produce today.

    Two ways an entry can end up with a VIN in entry.data but an
    account-only (no-VIN) unique_id: it was created before v2.52 added VIN
    scoping at all, or its VIN was set later via the Options flow before
    v2.53 fixed that flow to also update unique_id (v2.53's fix only
    prevented the mismatch going forward -- it never retroactively repaired
    entries the bug had already touched). Left alone, adding a SECOND entry
    for the same account (v2.54's setup flow always resolves a real VIN, even
    for a single-vehicle account) would get a different, VIN-scoped id and
    NOT collide with this one -- silently creating a duplicate coordinator,
    device and entity set polling the exact same physical car.
    """
    vin = str(entry.data.get(CONF_VIN, "") or "").strip().upper()
    if not vin:
        return  # nothing to reconcile -- a blank-VIN entry's id is already correct
    target = _account_uid(
        entry.data.get(CONF_REGION, "USA"),
        entry.data.get(CONF_BRAND, "KIA"),
        entry.data.get("username", ""),
        vin,
    )
    if entry.unique_id == target:
        return  # already correct
    other = next(
        (
            e
            for e in hass.config_entries.async_entries(DOMAIN)
            if e.entry_id != entry.entry_id and e.unique_id == target
        ),
        None,
    )
    if other is not None:
        # Both entries already exist and both look like they track this same
        # vehicle -- resolving that by silently deleting/merging one is too
        # destructive to do unattended (which one has the right options,
        # history, automations pointed at it?). Surface it instead.
        _LOGGER.warning(
            "Kia Access: entry %s (VIN %s) has a stale unique_id from before "
            "v2.53 and can't be auto-repaired -- entry %s already owns the "
            "correct id (%s). If these two entries track the same physical "
            "vehicle, remove the duplicate one manually.",
            entry.entry_id,
            vin,
            other.entry_id,
            target,
        )
        return
    hass.config_entries.async_update_entry(entry, unique_id=target)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Kia Access from a config entry."""
    _migrate_unique_id(hass, entry)

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


def _strict_int(value):
    """Like vol.Coerce(int), but rejects a genuinely fractional value
    instead of silently truncating it -- vol.Coerce(int)(80.9) == 80 with
    no error, which is surprising for a raw/automation service call (the
    HA UI's own number selector already prevents this for a human, so this
    only matters for a call that bypasses it). A whole-number float or
    numeric string (80.0, "80") is still accepted."""
    if isinstance(value, bool):
        raise vol.Invalid("must be a whole number, not a boolean")
    if isinstance(value, int):
        return value
    try:
        f = float(value)
    except (TypeError, ValueError) as exc:
        raise vol.Invalid(f"not a number: {value!r}") from exc
    if not f.is_integer():
        raise vol.Invalid(f"must be a whole number, got {value!r}")
    return int(f)


def _register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, COMMANDS[0]["key"]):
        return

    for spec in COMMANDS:
        opt_schema = {vol.Optional("entry_id"): cv.string}
        for opt_name, meta in (spec.get("options") or {}).items():
            base = {
                "int": _strict_int,
                "float": vol.Coerce(float),
                "bool": cv.boolean,
            }.get(meta.get("type"), cv.string)
            # This schema is registered once, globally, before any specific
            # vehicle/entry_id is known (a service call's entry_id is only
            # resolved inside the handler via _coordinator_for()) -- it can't
            # pick the Fahrenheit vs metric bounds per-vehicle the way the
            # native climate entity or kia_client.py's dispatch-time default-
            # filling do. An option with a `metric` variant (currently just
            # start_climate's set_temp) must therefore validate against the
            # UNION of both ranges here, or a real EU/Celsius value would be
            # hard-rejected before ever reaching the region-aware code.
            lo, hi = meta.get("min"), meta.get("max")
            if meta.get("metric"):
                m = meta["metric"]
                if lo is not None and m.get("min") is not None:
                    lo = min(lo, m["min"])
                if hi is not None and m.get("max") is not None:
                    hi = max(hi, m["max"])
            if meta.get("type") in ("int", "float") and (lo is not None or hi is not None):
                typ = vol.All(base, vol.Range(min=lo, max=hi))
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
        # Must share coordinator._calendar_lock with _refresh_calendar_and_routes()
        # (the poll-triggered / 1-min-timer path) -- calling
        # async_refresh_calendar_pois()/_refresh_drive_times() directly here
        # bypassed that lock entirely, so this manual service call could
        # still overlap a scheduled refresh and reintroduce the exact
        # self._cal_status race the lock exists to prevent.
        async with coordinator._calendar_lock:  # noqa: SLF001
            # calendar refresh has no throttle to clear (every poll runs it);
            # the routing throttle still needs clearing so new/changed POIs route
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
            EVENT_KIA_ACCESS_ALERT,
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
