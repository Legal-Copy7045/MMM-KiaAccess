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
from homeassistant.auth.permissions.const import POLICY_CONTROL
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ConfigEntryNotReady, HomeAssistantError, Unauthorized
import homeassistant.helpers.config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)

from . import kia_client
from .account_poll import ACCOUNTS_KEY, AccountPoller, account_hash_for
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

# see account_poll.py's ACCOUNTS_KEY/account_hash_for() -- moved there so
# config_flow.py's Options-flow VIN discovery can share the same lookup
# without a circular import.
_ACCOUNTS_KEY = ACCOUNTS_KEY
_account_hash_for = account_hash_for


def _get_account_poller(hass: HomeAssistant, entry: ConfigEntry) -> AccountPoller:
    """The shared AccountPoller for this entry's account, creating it (with
    refcount 0) on first use. Callers must bump .refcount themselves --
    kept explicit here rather than folded into this getter, since setup and
    unload need to move the count in opposite, clearly-paired places."""
    accounts = hass.data.setdefault(_ACCOUNTS_KEY, {})
    h = _account_hash_for(entry)
    poller = accounts.get(h)
    if poller is None:
        poller = AccountPoller(hass, h)
        accounts[h] = poller
    return poller


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


def _map_keys_for_entry(entry: ConfigEntry) -> dict:
    """The geocoding/TomTom keys custom:kia-range-map-card needs, sourced
    from an entry's own Options instead of the dashboard -- pulled out of
    _ws_map_keys() below so it's testable without a real websocket
    connection (see test/coordinator_analytics_test.py's fake-self pattern
    for why: exercising the actual function beats reimplementing its
    logic in a test)."""
    opts = entry.options
    provider = (opts.get("drive_time_provider") or "").strip()
    return {
        "api_key": opts.get("geocoding_api_key") or None,
        # routing_api_key is only a TomTom key when the entry is actually
        # configured for that provider -- handing it to the card as
        # `tomtom_key` while provider is "geoapify" or "estimate" would
        # either silently fail the TomTom call or, worse, leak a Geoapify
        # key to a TomTom endpoint that then logs/rejects it.
        "tomtom_key": (opts.get("routing_api_key") or None) if provider == "tomtom" else None,
    }


@websocket_api.websocket_command({
    vol.Required("type"): "kia_access/map_keys",
    vol.Required("entry_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def _ws_map_keys(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """custom:kia-range-map-card's alternative to typing api_key/tomtom_key
    into the dashboard: the geocoding/routing keys already sit in this
    entry's own Options (used server-side for range_reach's drive times --
    see coordinator.py's _geocode_address/_route_status), so the card can
    ask for them here instead of duplicating them into Lovelace YAML, where
    they end up sitting in plain text in a place people paste around,
    screenshot, and hand to an LLM. require_admin: these ARE real API keys,
    still visible to the requesting browser session once returned (the
    card's own isochrone/tile fetches are plain client-side `fetch()` calls
    -- see _ring() -- so there was never a way to keep the key off the
    browser entirely), but the least this endpoint can do is refuse anyone
    who isn't already trusted with the HA instance's admin-level config.
    """
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(msg["id"], websocket_api.const.ERR_NOT_FOUND, "no such Kia Access entry")
        return
    connection.send_result(msg["id"], _map_keys_for_entry(entry))


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Domain-level setup, called once at HA startup regardless of any one
    entry's enabled/disabled state (unlike async_setup_entry below, which
    HA never calls for a disabled entry) -- runs the same unique_id
    migration for every entry up front, so a legacy entry left disabled
    across the v2.54/v2.55 upgrade still gets repaired instead of carrying
    a stale identity indefinitely (it would otherwise only self-heal the
    next time it's individually reloaded or re-enabled)."""
    websocket_api.async_register_command(hass, _ws_map_keys)
    for entry in hass.config_entries.async_entries(DOMAIN):
        _migrate_unique_id(hass, entry)
    return True


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
    # See account_poll.py's module docstring: every entry for the SAME Kia
    # account (same region+brand+username, any number of vehicles) shares
    # ONE AccountPoller, so an N-vehicle account does roughly the same
    # amount of Kia API traffic a single-vehicle account does, not N times
    # as much. Bumped here / dropped in async_unload_entry below -- but if
    # setup fails ANYWHERE below (first refresh, forwarding to platforms,
    # ...), the entry never reaches "loaded" and async_unload_entry is never
    # called for it -- HA just retries async_setup_entry from scratch. The
    # try/except must therefore cover this ENTIRE function body from here
    # on, not just the first-refresh call: an earlier version only wrapped
    # that, so a failure in async_forward_entry_setups (a platform module
    # raising on import/setup, say) still bumped refcount with no matching
    # decrement on every retry -- a slow, permanent leak in hass.data.
    account_poller = _get_account_poller(hass, entry)
    account_poller.refcount += 1
    coordinator.account_poller = account_poller
    try:
        # async_load_sessions()/async_load_prefs() call Store.async_load()
        # with no guard of their own -- a truncated/corrupted .storage file
        # (an interrupted write: power loss, OOM-kill; these aren't written
        # atomically the way kia_client._save_token() deliberately is) makes
        # that raise. Left as a bare exception, HA's config-entry framework
        # treats it as a hard SETUP_ERROR, not something it retries on its
        # own -- the integration stays broken until the user notices and
        # manually reloads. ConfigEntryNotReady is what tells HA "this is
        # transient, keep retrying on the normal backoff schedule" (the same
        # signal async_config_entry_first_refresh() below already raises on
        # its own failures) -- converting one here means a corrupted store
        # self-heals into an empty one on HA's own retry rather than staying
        # stuck.
        try:
            await coordinator.async_load_sessions()
            await coordinator.async_load_prefs()
        except Exception as err:  # noqa: BLE001
            raise ConfigEntryNotReady(
                f"could not load persisted sessions/trips/prefs: {err}"
            ) from err
        await coordinator.async_config_entry_first_refresh()
        hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except BaseException:
        account_poller.refcount -= 1
        if account_poller.refcount <= 0:
            hass.data.get(_ACCOUNTS_KEY, {}).pop(account_poller.account_hash, None)
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
        raise

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

    # Charger start/stop alerts (see coordinator._async_charger_state_changed):
    # an options change reloads the entry (see _async_options_updated below),
    # so re-reading the option once here at setup is enough -- no separate
    # listener-rewiring path needed when the user picks/changes the entity.
    charger_entity = (entry.options.get("charger_status_entity") or "").strip()
    if charger_entity:
        entry.async_on_unload(
            async_track_state_change_event(
                hass, [charger_entity], coordinator._async_charger_state_changed  # noqa: SLF001
            )
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
        coordinator = hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
        # drop this entry's share of its account's AccountPoller (see
        # account_poll.py) -- once nothing references it any more, remove it
        # entirely rather than leaving a dead poller (and its in-memory
        # last-fetch cache) sitting in hass.data forever
        poller = getattr(coordinator, "account_poller", None)
        if poller is not None:
            poller.refcount -= 1
            if poller.refcount <= 0:
                hass.data.get(_ACCOUNTS_KEY, {}).pop(poller.account_hash, None)
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


async def _check_command_authorized(hass: HomeAssistant, call: ServiceCall, coordinator) -> None:
    """The control commands (lock/unlock/climate/charge/...) are registered
    as DOMAIN services (hass.services.async_register), not entity services
    (async_register_entity_service) -- kia_access.unlock isn't "target this
    entity_id", it's "run this command against whichever account entry_id
    resolves to". HA's own authorization only checks that the calling user
    may call services in the kia_access domain AT ALL; it has no entity to
    apply the user's entity-level policy against, so a restricted user
    whose policy hides lock.<vehicle> (or the device entirely) could still
    call kia_access.unlock directly and physically unlock the car -- a real
    bypass of the permission model the lock entity implies.

    Approximates entity-level authorization for these domain services by
    checking CONTROL permission on the vehicle's own lock entity -- the one
    entity every config entry always has, and the most security-relevant
    one to gate physical vehicle control on. An admin, or a call with no
    attributable user (context.user_id is None: an automation, script, or
    internal call, not a signed-in HA user making a live decision) is
    allowed through unchecked, matching how HA's own per-entity permission
    checks already treat non-user-attributed calls."""
    if call.context is None or call.context.user_id is None:
        return
    user = await hass.auth.async_get_user(call.context.user_id)
    if user is None or user.is_admin:
        return
    registry = er.async_get(hass)
    entity_id = registry.async_get_entity_id(
        "lock", DOMAIN, f"{coordinator.entry.entry_id}_lock"
    )
    if entity_id is None:
        # nothing registered to check against (shouldn't happen -- every
        # entry gets a lock entity) -- fail open rather than block a
        # legitimate call over a lookup that should always succeed
        return
    if not user.permissions.check_entity(entity_id, POLICY_CONTROL):
        raise Unauthorized(
            context=call.context, entity_id=entity_id, permission=POLICY_CONTROL
        )


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
                await _check_command_authorized(hass, call, coordinator)
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
                # see coordinator.py's _emit_alerts() for why: Kia USA never
                # reports a real VIN, so this must fall back to the vehicle's
                # own id the same way, or a test_alert event for a Kia USA
                # account always carries vin: null.
                "vin": kia_client._vehicle_key_dict(coordinator.vehicle) or None,  # noqa: SLF001
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
