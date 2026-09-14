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
        EntitySelector,
        EntitySelectorConfig,
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

    def _zone_entity():
        return EntitySelector(EntitySelectorConfig(domain="zone"))

    def _sensor_entity():
        return EntitySelector(EntitySelectorConfig(domain=["sensor", "input_number"]))
except ImportError:  # pragma: no cover — very old HA

    def _number(lo, hi, step):
        return vol.All(vol.Coerce(float), vol.Range(min=lo, max=hi))

    def _zone_entity():
        return str

    def _sensor_entity():
        return str

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

def _account_uid(region: str, brand: str, username: str, vin: str) -> str:
    """The config-entry identity: one entry per account, VIN-scoped once a
    VIN is set (needed so a multi-vehicle account can have one entry per
    vehicle -- see kia_client.fetch()/run_command()'s VIN-required guards).
    A blank VIN keeps the original account-only form, so an ordinary
    single-vehicle setup is unaffected. Shared by the initial setup flow
    and the options flow's VIN-change handler so the two can never compute
    this differently."""
    uid = f"{region}:{brand}:{username.lower()}"
    vin = (vin or "").strip().upper()
    if vin:
        uid += f":{vin}"
    return uid


USER_SCHEMA = vol.Schema(
    {
        vol.Required("username"): str,
        vol.Required("password"): str,
        vol.Optional(CONF_PIN, default=""): str,
        vol.Optional(CONF_REGION, default="USA"): vol.In(REGIONS),
        vol.Optional(CONF_BRAND, default="KIA"): vol.In(BRANDS),
        vol.Optional(CONF_GEOCODE, default=False): bool,
    }
)
# VIN is deliberately not in USER_SCHEMA -- which vehicle to use is only
# knowable AFTER login (it comes from the account's own vehicle list, via
# async_step_vehicle() below), so asking for it up front would mean asking
# the user to already know and correctly type a VIN. A single-vehicle
# account never sees that step at all (see async_step_vehicle's caller).


class KiaAccessConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle the UI setup."""

    VERSION = 1

    def __init__(self) -> None:
        self._job: dict[str, Any] = {}
        self._vm = None
        self._reauth_entry = None
        self._token: dict | None = None
        self._vehicles: list[dict] = []
        self._vehicle_count: int | None = None

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
            # Unique-ID is deliberately NOT set here -- it's VIN-scoped (see
            # _account_uid()), and which VIN this entry is for isn't knowable
            # until after login, when the account's own vehicle list is
            # available (async_step_vehicle() below picks it, or _after_
            # login() auto-picks the sole vehicle). _finish_with_uid() sets
            # it once that's resolved, right before creating the entry.
            try:
                result = await self.hass.async_add_executor_job(self._try_login)
            except _NeedOtp:
                return await self.async_step_otp()
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("Kia login failed: %s", type(err).__name__)
                errors["base"] = "auth"
            else:
                return await self._after_login(result)

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
                return await self._after_login(token)

        return self.async_show_form(
            step_id="otp",
            data_schema=vol.Schema({vol.Required("code"): str}),
            errors=errors,
            description_placeholders={"dest": getattr(self, "_otp_dest", "")},
        )

    async def _after_login(self, token: dict | None) -> FlowResult:
        """Login (password or OTP) just succeeded -- self._vm.vehicles is
        already populated (VehicleManager.login()/verify_otp_and_complete_
        login() both call initialize_vehicles() internally). A single-
        vehicle account is auto-picked and never sees a vehicle step at
        all; only a genuine multi-vehicle account is asked to choose."""
        self._token = token
        vehicles = await self.hass.async_add_executor_job(self._list_vehicles)
        self._vehicle_count = len(vehicles)
        if len(vehicles) <= 1:
            self._job[CONF_VIN] = vehicles[0]["vin"] if vehicles else ""
            return await self._finish_with_uid()
        self._vehicles = vehicles
        return await self.async_step_vehicle()

    async def async_step_vehicle(self, user_input: dict | None = None) -> FlowResult:
        if user_input is not None:
            self._job[CONF_VIN] = user_input[CONF_VIN]
            return await self._finish_with_uid()

        choices = {
            v["vin"]: (
                f"{v['name']} ({v['model']} · {v['vin']})" if v["name"]
                else f"{v['model'] or 'Vehicle'} · {v['vin']}"
            )
            for v in self._vehicles
        }
        return self.async_show_form(
            step_id="vehicle",
            data_schema=vol.Schema({vol.Required(CONF_VIN): vol.In(choices)}),
        )

    async def _finish_with_uid(self) -> FlowResult:
        # VIN-scoped when set, so a multi-vehicle account can have one config
        # entry per vehicle -- without this, a second entry for the same
        # account's other vehicle would always abort on a unique-ID
        # collision with the first. A blank VIN (no vehicles returned) keeps
        # the original account-only ID.
        region = self._job.get(CONF_REGION, "USA")
        brand = self._job.get(CONF_BRAND, "KIA")
        vin = self._job.get(CONF_VIN, "")
        await self.async_set_unique_id(
            _account_uid(region, brand, self._job["username"], vin)
        )
        self._abort_if_unique_id_configured()
        # A single-vehicle account always resolves a real VIN here now (see
        # _after_login()), so its uid is VIN-scoped -- DIFFERENT from a
        # pre-v2.54 entry for the exact same account/car, which used the
        # account-only (blank-VIN) form. The check above alone can't catch
        # that mismatch (the two uids genuinely differ), so check for it
        # explicitly: re-running setup for an account you already configured
        # must not silently create a second entry for the same physical car.
        # (__init__.py's own migration repairs an EXISTING mismatched entry;
        # this is only about not creating a brand new duplicate here.)
        if vin and getattr(self, "_vehicle_count", None) == 1:
            blank_uid = _account_uid(region, brand, self._job["username"], "")
            if any(
                e.unique_id == blank_uid
                for e in self.hass.config_entries.async_entries(DOMAIN)
            ):
                return self.async_abort(reason="already_configured")
        return self._finish(self._token)

    def _list_vehicles(self) -> list[dict]:
        out = []
        for v in (getattr(self._vm, "vehicles", None) or {}).values():
            vin = str(getattr(v, "VIN", "") or "").strip().upper()
            if not vin:
                continue
            out.append({
                "vin": vin,
                "name": str(getattr(v, "name", "") or ""),
                "model": str(getattr(v, "model", "") or ""),
            })
        out.sort(key=lambda d: d["vin"])
        return out

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
            CONF_VIN: (self._job.get(CONF_VIN) or "").strip().upper(),
            CONF_GEOCODE: self._job.get(CONF_GEOCODE, False),
            CONF_TOKEN: token,
        }
        title = f"{self._job.get(CONF_BRAND, 'KIA')} ({self._job['username']})"
        if data[CONF_VIN]:
            title += f" — {data[CONF_VIN]}"
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
        errors: dict[str, str] = {}
        vin_default = self._entry.data.get(CONF_VIN, "")
        if user_input is not None:
            # VIN lives in entry.data (set at initial setup), not
            # entry.options like everything else this flow edits -- pull it
            # out and update entry.data directly instead of letting it land
            # in options. Without this, a multi-vehicle account set up
            # without a VIN (or with the wrong one) had no way to fix that
            # short of deleting and recreating the whole config entry.
            new_vin = (user_input.pop(CONF_VIN, "") or "").strip().upper()
            vin_default = new_vin
            if new_vin != (self._entry.data.get(CONF_VIN) or "").strip().upper():
                target_uid = _account_uid(
                    self._entry.data.get(CONF_REGION, "USA"),
                    self._entry.data.get(CONF_BRAND, "KIA"),
                    self._entry.data.get("username", ""),
                    new_vin,
                )
                # Updating entry.data[VIN] alone does NOT update entry.
                # unique_id -- HA's own duplicate-unique_id guard inside
                # async_update_entry is (as of when this was checked) only a
                # deprecated warning-log, not an actual block. Without this
                # explicit check, changing this entry's VIN to match one
                # already used by another entry would leave two coordinators
                # silently polling/alerting/logging sessions for the exact
                # same physical vehicle.
                other = next(
                    (
                        e for e in self.hass.config_entries.async_entries(DOMAIN)
                        if e.entry_id != self._entry.entry_id
                        and e.unique_id == target_uid
                    ),
                    None,
                )
                if other is not None:
                    errors[CONF_VIN] = "vin_in_use"
                else:
                    self.hass.config_entries.async_update_entry(
                        self._entry,
                        data={**self._entry.data, CONF_VIN: new_vin},
                        unique_id=target_uid,
                    )
            if not errors:
                return self.async_create_entry(title="", data=user_input)
        opts = dict(self._entry.options)
        return self.async_show_form(
            step_id="init",
            errors=errors,
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        CONF_VIN,
                        default=vin_default,
                        description={"suggested_value": vin_default},
                    ): str,
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
                        "block_automated_climate",
                        default=opts.get("block_automated_climate", False),
                    ): bool,
                    vol.Optional(
                        "price_per_kwh",
                        default=float(opts.get("price_per_kwh") or 0),
                    ): _number(0, 10, 0.001),
                    vol.Optional(
                        "away_price_per_kwh",
                        default=float(opts.get("away_price_per_kwh") or 0),
                    ): _number(0, 10, 0.001),
                    vol.Optional(
                        "home_charge_zone",
                        description={
                            "suggested_value": opts.get("home_charge_zone", "")
                        },
                    ): _zone_entity(),
                    vol.Optional(
                        "charge_rates",
                        default=opts.get("charge_rates", ""),
                        description={
                            "suggested_value": opts.get("charge_rates", "")
                        },
                    ): _multiline(),
                    vol.Optional(
                        "away_cost_entity",
                        description={
                            "suggested_value": opts.get("away_cost_entity", "")
                        },
                    ): _sensor_entity(),
                    vol.Optional(
                        "away_cost_grace_min",
                        # `or 90` would show 90 in this form even after the
                        # user explicitly saved 0 (the field's own min bound)
                        default=float(
                            90 if opts.get("away_cost_grace_min") is None
                            else opts["away_cost_grace_min"]
                        ),
                    ): _number(0, 720, 5),
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
                        "zone_entities",
                        default=opts.get("zone_entities", ""),
                        description={
                            "suggested_value": opts.get("zone_entities", "")
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
