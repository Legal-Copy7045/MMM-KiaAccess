"""Config flow for Kia Access (username/password + optional OTP)."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback

try:  # HA moved / renamed this over the years — it's only a type hint
    from homeassistant.data_entry_flow import FlowResult
except ImportError:  # pragma: no cover
    FlowResult = dict  # type: ignore[assignment,misc]

try:
    from homeassistant.helpers.selector import (
        NumberSelector,
        NumberSelectorConfig,
        NumberSelectorMode,
        TextSelector,
        TextSelectorConfig,
    )

    def _number(lo, hi, step):
        return NumberSelector(
            NumberSelectorConfig(min=lo, max=hi, step=step, mode=NumberSelectorMode.BOX)
        )

    def _multiline():
        return TextSelector(TextSelectorConfig(multiline=True))
except ImportError:  # pragma: no cover — very old HA

    def _number(lo, hi, step):
        return vol.All(vol.Coerce(float), vol.Range(min=lo, max=hi))

    def _multiline():
        return str

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
        self._reauth_entry = None

    async def async_step_reauth(self, entry_data: dict) -> FlowResult:
        self._reauth_entry = self.hass.config_entries.async_get_entry(
            self.context["entry_id"]
        )
        self._job = dict(entry_data)
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict | None = None) -> FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            self._job.update(user_input)
            try:
                result = await self.hass.async_add_executor_job(self._try_login)
            except _NeedOtp:
                return await self.async_step_otp()
            except Exception as err:  # noqa: BLE001
                # no exc_info: the traceback can run through library frames that
                # hold the auth request — a one-line reason is enough here
                _LOGGER.debug("Kia reauth failed: %s", type(err).__name__)
                errors["base"] = "auth"
            else:
                return self._finish(result)

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema(
                {
                    vol.Required("password"): str,
                    vol.Optional(CONF_PIN, default=self._job.get(CONF_PIN, "")): str,
                }
            ),
            errors=errors,
            description_placeholders={"username": self._job.get("username", "")},
        )

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
                _LOGGER.debug("Kia login failed: %s", type(err).__name__)
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
        if self._reauth_entry is not None:
            self.hass.config_entries.async_update_entry(
                self._reauth_entry,
                data={
                    **self._reauth_entry.data,
                    "password": self._job["password"],
                    CONF_PIN: self._job.get(CONF_PIN, ""),
                    CONF_TOKEN: token,
                },
            )
            self.hass.async_create_task(
                self.hass.config_entries.async_reload(self._reauth_entry.entry_id)
            )
            return self.async_abort(reason="reauth_successful")

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
        # Keep our own reference. Do NOT assign self.config_entry — it's a
        # read-only property on HA >= 2024.11 and assigning it raises.
        self._entry = config_entry

    async def async_step_init(self, user_input: dict | None = None) -> FlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)
        opts = dict(self._entry.options)
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        "scan_interval",
                        default=opts.get("scan_interval", DEFAULT_SCAN_INTERVAL_MINUTES),
                    ): _number(5, 1440, 1),
                    vol.Optional(
                        "poll_car_directly",
                        # infer from the old seconds-based option the first time this
                        # form is opened, then persist the choice explicitly
                        default=opts.get(
                            "poll_car_directly",
                            float(opts.get("force_refresh_timeout", 0) or 0) > 0,
                        ),
                    ): bool,
                    vol.Optional(
                        "force_refresh_timeout",
                        # min 0: pre-toggle installs stored 0 here to mean
                        # "cached only" and must still be able to save the form
                        default=opts.get(
                            "force_refresh_timeout", DEFAULT_FORCE_REFRESH_TIMEOUT
                        ),
                    ): _number(0, 180, 1),
                    vol.Optional(
                        "price_per_kwh",
                        default=float(opts.get("price_per_kwh") or 0),
                    ): _number(0, 10, 0.001),
                    vol.Optional(
                        "capacity_kwh",
                        default=float(opts.get("capacity_kwh") or 0),
                    ): _number(0, 300, 0.1),
                    vol.Optional(
                        "range_factor",
                        default=float(opts.get("range_factor") or 0.92),
                    ): _number(0.5, 1, 0.01),
                    vol.Optional(
                        "range_reserve_pct",
                        default=float(opts.get("range_reserve_pct") or 10),
                    ): _number(0, 50, 1),
                    vol.Optional(
                        "calendar_entities",
                        default=opts.get("calendar_entities", ""),
                        description={
                            "suggested_value": opts.get("calendar_entities", "")
                        },
                    ): str,
                    vol.Optional(
                        "calendar_lookahead_hours",
                        default=float(opts.get("calendar_lookahead_hours") or 72),
                    ): _number(6, 336, 1),
                    vol.Optional(
                        "static_destinations",
                        default=opts.get("static_destinations", ""),
                        description={
                            "suggested_value": opts.get("static_destinations", "")
                        },
                    ): _multiline(),
                    vol.Optional(
                        "drive_time_provider",
                        default=opts.get("drive_time_provider", "estimate"),
                    ): vol.In(["estimate", "geoapify", "tomtom"]),
                    vol.Optional(
                        "routing_api_key",
                        default=opts.get("routing_api_key", ""),
                        description={
                            "suggested_value": opts.get("routing_api_key", "")
                        },
                    ): str,
                    vol.Optional(
                        "geocoding_api_key",
                        default=opts.get("geocoding_api_key", ""),
                        description={
                            "suggested_value": opts.get("geocoding_api_key", "")
                        },
                    ): str,
                    vol.Optional(
                        "drive_time_routes",
                        default=opts.get("drive_time_routes", True),
                    ): bool,
                }
            ),
        )


class _NeedOtp(Exception):
    """Internal: login returned an OTP challenge."""
