"""Data coordinator for Kia Access."""
from __future__ import annotations

import logging
from datetime import timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from . import kia_client
from .conditions import evaluate as evaluate_conditions
from .const import (
    CONF_BRAND,
    CONF_GEOCODE,
    CONF_PIN,
    CONF_REGION,
    CONF_TOKEN,
    CONF_VIN,
    DEFAULT_FORCE_REFRESH_TIMEOUT,
    DEFAULT_SCAN_INTERVAL_MINUTES,
    DOMAIN,
    EVENT_STATE_CHANGED,
)
from .vehicle_state import build_state

_LOGGER = logging.getLogger(__name__)


class KiaAccessCoordinator(DataUpdateCoordinator):
    """Polls the Kia cloud via the shared kia_client and caches the last state."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        minutes = entry.options.get("scan_interval", DEFAULT_SCAN_INTERVAL_MINUTES)
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(minutes=minutes),
        )
        self.entry = entry
        self.last_options: dict = dict(entry.options)
        self.vehicle: dict = {}
        self.meta: dict = {}
        self._prev_cond: dict = {}
        self._announced: dict = {}
        self._first_alert_run = True

    def _job(self, **extra) -> dict:
        d = self.entry.data
        job = {
            "username": d["username"],
            "password": d["password"],
            "pin": d.get(CONF_PIN, ""),
            "region": d.get(CONF_REGION, "USA"),
            "brand": d.get(CONF_BRAND, "KIA"),
            "vin": d.get(CONF_VIN, ""),
            "geocode": d.get(CONF_GEOCODE, False),
            "token": d.get(CONF_TOKEN),
            "forceRefreshTimeout": self.entry.options.get(
                "force_refresh_timeout", DEFAULT_FORCE_REFRESH_TIMEOUT
            ),
        }
        job.update(extra)
        return job

    async def _async_update_data(self) -> dict:
        job = self._job(refresh=True)
        try:
            result = await self.hass.async_add_executor_job(kia_client.fetch, job)
        except kia_client.OtpRequired as err:
            # triggers HA's reauth flow instead of an endless retry
            raise ConfigEntryAuthFailed(
                "Kia needs re-enrollment (one-time code)."
            ) from err
        except kia_client.ClientError as err:
            raise UpdateFailed(str(err)) from err
        except Exception as err:  # noqa: BLE001
            raise UpdateFailed(f"{type(err).__name__}: {err}") from err

        self.meta = result.get("meta", {}) or {}
        # persist a rotated refresh token back into the config entry.
        # async_update_entry fires the update listener, but _async_options_updated
        # ignores data-only changes so this does not reload the integration.
        new_token = self.meta.pop("token", None)
        if new_token and new_token != self.entry.data.get(CONF_TOKEN):
            self.hass.config_entries.async_update_entry(
                self.entry,
                data={**self.entry.data, CONF_TOKEN: new_token},
            )
        self.vehicle = (result.get("vehicles") or [{}])[0]
        self._emit_alerts()
        return self.vehicle

    def _emit_alerts(self) -> None:
        """Fire kia_access_alert events on edge-triggered condition changes,
        using the exact same rules as the MagicMirror module (conditions.py)."""
        flat = {f"vehicle.{k}": v for k, v in self.vehicle.items()
                if not isinstance(v, (dict, list))}
        if self.meta.get("tokenEnrolledAt"):
            flat["_meta.tokenEnrolledAt"] = self.meta["tokenEnrolledAt"]
        cfg = self.entry.options.get("notifications", {}) or {}
        state = build_state(flat, {})
        try:
            res = evaluate_conditions(state, cfg, self._prev_cond)
        except Exception:  # noqa: BLE001
            _LOGGER.debug("condition evaluation failed", exc_info=True)
            return

        startup = self._first_alert_run
        # match the MagicMirror module: on the first run after (re)start, only
        # fire what `notifyOnStartup` allows (default: critical only)
        startup_mode = cfg.get("notifyOnStartup", "critical")

        def _startup_allows(level: str) -> bool:
            return startup_mode is True or (startup_mode == "critical" and level == "critical")

        vin = self.vehicle.get("VIN")
        for c in res["conditions"]:
            reason = c["reason"]
            was = self._prev_cond.get(reason)
            became = c["active"] is True and was is not True
            cleared = (
                not c["oneShot"] and c["active"] is False and was is True
                and self._announced.get(reason)
            )
            if startup:
                fire = became and _startup_allows(c["level"])
            else:
                fire = became or cleared
            if became and fire:
                self._announced[reason] = True
            if cleared:
                self._announced[reason] = False
            if fire:
                self.hass.bus.async_fire(
                    EVENT_STATE_CHANGED,
                    {
                        "entry_id": self.entry.entry_id,
                        "reason": reason,
                        "level": c["level"],
                        "active": c["active"],
                        "title": c["title"],
                        "message": c["message"],
                        "value": c["value"],
                        "vin": vin,
                    },
                )

        # keep the last *known* state per reason (don't clobber with None when a
        # value is temporarily unknown) — matches conditions.js hysteresis intent
        for c in res["conditions"]:
            if c["active"] is not None:
                self._prev_cond[c["reason"]] = c["active"]
        self._prev_cond["_charging"] = res["meta"]["charging"]
        self._first_alert_run = False

    async def async_run_command(self, command: str, options: dict | None = None) -> None:
        job = self._job(command=command, options=options or {})
        await self.hass.async_add_executor_job(kia_client.run_command, job)
        await self.async_request_refresh()
