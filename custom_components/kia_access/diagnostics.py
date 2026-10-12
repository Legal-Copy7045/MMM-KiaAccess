"""Diagnostics for Kia Access (Settings -> device -> Download diagnostics)."""
from __future__ import annotations

from datetime import timedelta
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as pkg_version
from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import __version__ as HA_VERSION
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration
from homeassistant.util import dt as dt_util

from .const import CONF_TOKEN, DOMAIN

# Kia's remember-me login lasts about this long before it needs a new
# one-time code (the same figure the otp_expiring alert defaults to).
LOGIN_LIFETIME_DAYS = 30

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


def _parse(raw) -> Any:
    """ISO string -> aware UTC datetime, or None. The library's unset
    valid_until is datetime.min ("0001-01-01T00:00:00"): converting that
    from a timezone east of UTC overflows, which used to break the whole
    diagnostics download -- treat it, and anything unparseable, as unset."""
    if not raw:
        return None
    try:
        parsed = dt_util.parse_datetime(str(raw))
        if parsed is None or parsed.year < 2000:
            return None
        return dt_util.as_utc(parsed)
    except (OverflowError, ValueError, TypeError):
        return None


def _auth_meta(token: Any) -> dict[str, Any]:
    """Secret-free view of the saved login: when it was enrolled, when it's
    due for renewal, and the current access token's expiry. The token's
    own strings never leave this function."""
    if not isinstance(token, dict):
        return {"token_saved": False}
    now = dt_util.utcnow()
    enrolled = _parse(token.get("enrolled_at"))
    renew_by = enrolled + timedelta(days=LOGIN_LIFETIME_DAYS) if enrolled else None
    access_until = _parse(token.get("valid_until"))
    return {
        "token_saved": True,
        "enrolled_at": enrolled.isoformat() if enrolled else None,
        "renew_by_estimate": renew_by.isoformat() if renew_by else None,
        "days_until_renewal": (
            round((renew_by - now).total_seconds() / 86400, 1) if renew_by else None
        ),
        "access_token_valid_until": access_until.isoformat() if access_until else None,
        "device_id_present": bool(token.get("device_id")),
    }


async def _versions(hass: HomeAssistant) -> dict[str, Any]:
    """Integration / library / HA versions -- the first thing to check on a
    bug report. A lookup that fails just reports None; diagnostics must
    still download."""
    integration_version = library_version = None
    try:
        integration = await async_get_integration(hass, DOMAIN)
        integration_version = str(integration.version) if integration.version else None
    except Exception:  # noqa: BLE001
        pass
    try:
        library_version = await hass.async_add_executor_job(
            pkg_version, "hyundai_kia_connect_api"
        )
    except (PackageNotFoundError, Exception):  # noqa: BLE001
        pass
    return {
        "integration": integration_version,
        "hyundai_kia_connect_api": library_version,
        "home_assistant": HA_VERSION,
    }


def _iso(value) -> Any:
    return value.isoformat() if hasattr(value, "isoformat") else value


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    coordinator = hass.data.get(DOMAIN, {}).get(entry.entry_id)
    vehicle = dict(getattr(coordinator, "vehicle", {}) or {})
    # the raw API dump can be huge and carries the same sensitive fields
    vehicle.pop("data", None)
    return {
        "versions": await _versions(hass),
        "auth": _auth_meta(entry.data.get(CONF_TOKEN)),
        "polling": {
            "last_successful_update": _iso(getattr(coordinator, "last_successful_update", None)),
            "car_reported_at": _iso(getattr(coordinator, "vehicle_reported_at", None)),
            "data_age_seconds": getattr(coordinator, "data_age_seconds", None),
            "is_stale": getattr(coordinator, "is_stale", None),
        },
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
