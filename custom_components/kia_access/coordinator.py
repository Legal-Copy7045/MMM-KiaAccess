"""Data coordinator for Kia Access."""
from __future__ import annotations

import logging
from datetime import timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from . import kia_client
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
)

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
        self.vehicle: dict = {}
        self.meta: dict = {}

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
            raise UpdateFailed(
                "Kia needs re-enrollment (OTP). Re-add the integration."
            ) from err
        except kia_client.ClientError as err:
            raise UpdateFailed(str(err)) from err
        except Exception as err:  # noqa: BLE001
            raise UpdateFailed(f"{type(err).__name__}: {err}") from err

        self.meta = result.get("meta", {}) or {}
        # persist a rotated refresh token back into the config entry
        new_token = self.meta.pop("token", None)
        if new_token and new_token != self.entry.data.get(CONF_TOKEN):
            self.hass.config_entries.async_update_entry(
                self.entry,
                data={**self.entry.data, CONF_TOKEN: new_token},
            )
        self.vehicle = (result.get("vehicles") or [{}])[0]
        return self.vehicle

    async def async_run_command(self, command: str, options: dict | None = None) -> None:
        job = self._job(command=command, options=options or {})
        await self.hass.async_add_executor_job(kia_client.run_command, job)
        await self.async_request_refresh()
