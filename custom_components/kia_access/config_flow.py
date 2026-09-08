"""Config flow for Kia Access (username/password + optional OTP)."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult

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

REGIONS = ["USA", "CA", "EU", "AU", "NZ", "IN", "BR", "CN"]
BRANDS = ["KIA", "HYUNDAI", "GENESIS"]

USER_SCHEMA = vol.Schema(
    {
        vol.Required("username"): str,
        vol.Required("password"): str,
        vol.Optional(CONF_PIN, default=""): str,
        vol.Optional(CONF_REGION, default="USA"): vol.In(REGIONS),
        vol.Optional(CONF_BRAND, default="KIA"): vol.In(BRANDS),
        vol.Optional(CONF_VIN, default=""): str,
        vol.Optional(CONF_GEOCODE, default=False): bool,
    }
)


class KiaAccessConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle the UI setup."""

    VERSION = 1

    def __init__(self) -> None:
        self._job: dict[str, Any] = {}
        self._vm = None

    async def async_step_user(self, user_input: dict | None = None) -> FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            self._job = dict(user_input)
            await self.async_set_unique_id(
                f"{user_input[CONF_REGION]}:{user_input[CONF_BRAND]}:"
                f"{user_input['username'].lower()}"
            )
            self._abort_if_unique_id_configured()
            try:
                result = await self.hass.async_add_executor_job(self._try_login)
            except _NeedOtp:
                return await self.async_step_otp()
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("Kia login failed", exc_info=True)
                errors["base"] = "auth"
            else:
                return self._finish(result)

        return self.async_show_form(
            step_id="user", data_schema=USER_SCHEMA, errors=errors
        )

    async def async_step_otp(self, user_input: dict | None = None) -> FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                token = await self.hass.async_add_executor_job(
                    self._verify_otp, user_input["code"]
                )
            except Exception:  # noqa: BLE001
                _LOGGER.debug("OTP verify failed", exc_info=True)
                errors["base"] = "otp"
            else:
                return self._finish(token)

        return self.async_show_form(
            step_id="otp",
            data_schema=vol.Schema({vol.Required("code"): str}),
            errors=errors,
            description_placeholders={"dest": getattr(self, "_otp_dest", "")},
        )

    # -- executor helpers ---------------------------------------------------
    def _try_login(self) -> dict:
        from hyundai_kia_connect_api.ApiImpl import OTPRequest
        from hyundai_kia_connect_api.const import OTP_NOTIFY_TYPE

        vm = kia_client.make_manager(self._job)
        res = vm.login()
        self._vm = vm
        if res is True or not isinstance(res, OTPRequest):
            return kia_client.token_dict(vm)

        kind = "SMS" if getattr(res, "has_sms", False) else "EMAIL"
        self._otp_dest = getattr(res, "sms", "") or getattr(res, "email", "")
        vm.send_otp(OTP_NOTIFY_TYPE(kind))
        raise _NeedOtp()

    def _verify_otp(self, code: str) -> dict:
        self._vm.verify_otp_and_complete_login(code.strip())
        return kia_client.token_dict(self._vm)

    def _finish(self, token: dict | None) -> FlowResult:
        data = {
            "username": self._job["username"],
            "password": self._job["password"],
            CONF_PIN: self._job.get(CONF_PIN, ""),
            CONF_REGION: self._job.get(CONF_REGION, "USA"),
            CONF_BRAND: self._job.get(CONF_BRAND, "KIA"),
            CONF_VIN: self._job.get(CONF_VIN, ""),
            CONF_GEOCODE: self._job.get(CONF_GEOCODE, False),
            CONF_TOKEN: token,
        }
        title = f"{self._job.get(CONF_BRAND, 'KIA')} ({self._job['username']})"
        return self.async_create_entry(title=title, data=data)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return KiaAccessOptionsFlow(config_entry)


class KiaAccessOptionsFlow(config_entries.OptionsFlow):
    def __init__(self, config_entry) -> None:
        self.config_entry = config_entry

    async def async_step_init(self, user_input: dict | None = None) -> FlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)
        opts = self.config_entry.options
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        "scan_interval",
                        default=opts.get("scan_interval", DEFAULT_SCAN_INTERVAL_MINUTES),
                    ): vol.All(vol.Coerce(int), vol.Range(min=5, max=1440)),
                    vol.Optional(
                        "force_refresh_timeout",
                        default=opts.get(
                            "force_refresh_timeout", DEFAULT_FORCE_REFRESH_TIMEOUT
                        ),
                    ): vol.All(vol.Coerce(int), vol.Range(min=0, max=180)),
                }
            ),
        )


class _NeedOtp(Exception):
    """Internal: login returned an OTP challenge."""
