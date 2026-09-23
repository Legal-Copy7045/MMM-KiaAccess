"""Config flow for Kia Access (username/password + optional OTP)."""
from __future__ import annotations

import logging
import re
from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.data_entry_flow import section

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
        SelectSelector,
        SelectSelectorConfig,
        SelectSelectorMode,
        TextSelector,
        TextSelectorConfig,
    )

    def _panel_destinations(zone_options):
        # a multi-select dropdown of the existing zones that ALSO accepts a
        # typed value (a "Name | address" fixed destination)
        return SelectSelector(
            SelectSelectorConfig(
                options=zone_options,
                multiple=True,
                custom_value=True,
                mode=SelectSelectorMode.DROPDOWN,
            )
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

    def _charger_status_entity():
        # any HA integration's own charging-status entity (ChargePoint's
        # binary_sensor.*_charging, Emporia's sensor.*_status ENUM, ...) --
        # "switch" included too since some integrations only expose a
        # charging-state switch, even though it's the wrong pick for
        # ha-emporia-ev specifically (its switch reflects "enabled", not
        # "currently drawing current" -- see _charger_is_charging's
        # docstring). Kept generic so this isn't tied to one vendor's
        # domain choice.
        return EntitySelector(
            EntitySelectorConfig(domain=["binary_sensor", "sensor", "input_boolean", "switch"])
        )
except ImportError:  # pragma: no cover — very old HA

    def _panel_destinations(zone_options):
        return [str]

    def _number(lo, hi, step):
        return vol.All(vol.Coerce(float), vol.Range(min=lo, max=hi))

    def _zone_entity():
        return str

    def _sensor_entity():
        return str

    def _charger_status_entity():
        return str

    def _multiline():
        return str

from . import kia_client
from .account_poll import ACCOUNTS_KEY, account_hash_for
from .const import (
    CONF_BRAND,
    CONF_GEOCODE,
    CONF_PIN,
    CONF_REGION,
    CONF_TOKEN,
    CONF_VIN,
    DEFAULT_FORCE_REFRESH_TIMEOUT,
    DEFAULT_SCAN_INTERVAL_MINUTES,
    DEFAULT_STALE_AFTER_MINUTES,
    DOMAIN,
    brand_display_name,
)

_LOGGER = logging.getLogger(__name__)

REGIONS = ["USA", "CA", "EU", "AU", "NZ", "IN", "BR", "CN"]
BRANDS = ["KIA", "HYUNDAI", "GENESIS"]

# The options form's field groups (was one flat 22+-field wall in a single
# async_step_init -- see async_step_init's own comment on why the section
# keys need flattening back onto user_input before saving). Order here is
# display order in the form; keep in sync with strings.json/en.json's
# options.step.init.sections and with async_step_init's data_schema.
_OPTIONS_SECTIONS = ("battery_and_cost", "polling_advanced", "destinations", "alerts")


def _znorm(value) -> str:
    """Same normalisation as core/dest-planner.js's znorm(): "zone.nana_s" and
    "Nana's" compare equal."""
    text = str(value or "").lower()
    if text.startswith("zone."):
        text = text[5:]
    return re.sub(r"[^a-z0-9]+", "", text)


def _zone_options(hass) -> list[dict]:
    """Every zone.* as a dropdown option (entity id as the value, friendly
    name as the label), so a zone can be picked instead of typed."""
    states = getattr(hass, "states", None)
    if states is None:
        return []
    options = [
        {"value": st.entity_id, "label": str(st.attributes.get("friendly_name") or st.entity_id)}
        for st in states.async_all("zone")
    ]
    return sorted(options, key=lambda o: o["label"].lower())


def _panel_destination_defaults(opts) -> list[str]:
    """The combined "fixed destinations & zones" field's current value, built
    from the two options it replaced (still what is stored, so nothing needs
    migrating): zone_entities entries, then static_destinations lines."""
    zones = [z.strip() for z in re.split(r"[\n,]", opts.get("zone_entities") or "")]
    fixed = [line.strip() for line in (opts.get("static_destinations") or "").splitlines()]
    seen: set[str] = set()
    out: list[str] = []
    for item in zones + fixed:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _split_panel_destinations(values, zone_options) -> tuple[str, str]:
    """Split the combined field back into (zone_entities, static_destinations).

    A zone is what the dropdown produces ("zone.work"), a "-Name" exclusion,
    or a bare name matching an existing zone. Anything with a "|", "=" or ";"
    separator is a fixed destination ("Name | address"), and so is a bare
    value that matches no zone (an address typed without a name)."""
    known: set[str] = set()
    for option in zone_options:
        known.add(_znorm(option["value"]))
        known.add(_znorm(option["label"]))
    zones: list[str] = []
    fixed: list[str] = []
    for raw in values or []:
        value = str(raw).strip()
        if not value:
            continue
        if value[0] in "-!" or value.lower().startswith("zone."):
            zones.append(value)
        elif any(sep in value for sep in "|=;"):
            fixed.append(value)
        elif _znorm(value) and _znorm(value) in known:
            zones.append(value)
        else:
            fixed.append(value)
    return "\n".join(zones), "\n".join(fixed)

def _discovery_job(entry) -> dict:
    d = entry.data
    return {
        "username": d.get("username"),
        "password": d.get("password"),
        "pin": d.get(CONF_PIN, ""),
        "region": d.get(CONF_REGION, "USA"),
        "brand": d.get(CONF_BRAND, "KIA"),
        "vin": "",
        "geocode": False,
        "token": d.get(CONF_TOKEN),
        "refresh": False,
        "forceRefreshTimeout": 0,
        "allVehicles": True,
    }


async def _discover_vehicles_for_entry(hass, entry) -> list[dict] | None:
    """Auto-discover every vehicle currently on this entry's account (server-
    cache only, no car wake-up) for the options flow's VIN picker below --
    the same live discovery the INITIAL setup flow already uses (see
    _list_vehicles), so "Configure" doesn't fall back to a free-typed VIN
    (the one way this integration let a user's own typo silently point a
    config entry at the wrong -- or no -- vehicle) unless discovery itself
    fails. Returns None on any failure (offline, cooldown, etc.) so the
    caller can fall back to the plain text field rather than blocking
    Configure on a transient Kia API hiccup.

    Prefers this account's already-running AccountPoller (account_poll.py)
    when the entry is currently loaded -- sharing its lock/dedup-window/
    failure-cache instead of making an unshared kia_client.fetch() call of
    its own every time Configure is opened. That mattered for two reasons:
    it was extra Kia API traffic outside the very AccountPoller built to
    cut that down, AND (worse) it still went through kia_client.connect()'s
    OWN auth-failure cooldown file for this account -- an unshared discovery
    attempt with broken credentials could trip (or accelerate tripping) the
    account-wide cooldown that then blocks every coordinator's regular poll,
    just from a user opening Configure. Falls back to a direct, unshared
    fetch only when no poller is running yet (e.g. the entry failed its
    first setup and isn't loaded) -- there's nothing to share with then
    anyway."""
    job = _discovery_job(entry)
    poller = hass.data.get(ACCOUNTS_KEY, {}).get(account_hash_for(entry))
    try:
        if poller is not None:
            result = await poller.async_fetch(job)
        else:
            result = await hass.async_add_executor_job(kia_client.fetch, job)
    except Exception as err:  # noqa: BLE001
        # a silent `return None` here means Configure falls back to the old
        # free-text VIN box with NOTHING in the logs to explain why -- log
        # it (once discovery actually fails) so that fallback is diagnosable
        # instead of looking like the feature just isn't there
        _LOGGER.warning(
            "Kia Access: could not auto-discover vehicles for entry %s "
            "(falling back to a plain VIN field in Configure): %s: %s",
            entry.entry_id, type(err).__name__, err,
        )
        return None
    out = []
    for v in result.get("vehicles") or []:
        # see kia_client._vehicle_key()'s docstring: Kia USA accounts never
        # get a real VIN back from the API at all -- fall back to the
        # vehicle's own `id` rather than dropping every vehicle from the list
        vin = kia_client._vehicle_key_dict(v)  # noqa: SLF001
        if not vin:
            continue
        out.append({
            "vin": vin,
            "name": str(v.get("name") or ""),
            "model": str(v.get("model") or ""),
        })
    out.sort(key=lambda x: x["vin"])
    if not out:
        _LOGGER.warning(
            "Kia Access: vehicle discovery for entry %s succeeded but "
            "returned 0 usable vehicles (falling back to a plain VIN field "
            "in Configure) -- raw fetch returned %s vehicle(s)",
            entry.entry_id, len(result.get("vehicles") or []),
        )
        return None
    return out


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
            # see kia_client._vehicle_key()'s docstring: a Kia USA account's
            # vehicles never carry a real VIN at all -- without this
            # fallback, EVERY vehicle here got silently dropped, making the
            # "choose a vehicle" step (and therefore this whole integration,
            # for a second/third car) impossible to complete on Kia USA
            vin = kia_client._vehicle_key(v)  # noqa: SLF001
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
        title = f"{brand_display_name(self._job.get(CONF_BRAND))} ({self._job['username']})"
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
        discovered = await _discover_vehicles_for_entry(self.hass, self._entry)
        if user_input is not None:
            # This form groups most of its ~25 fields into collapsible
            # sections (was one flat 22+-field wall) -- section()-wrapped
            # keys arrive from the frontend as NESTED dicts under the
            # section's own key, not flattened, so every field-specific
            # handler below (VIN, alert_title/quiet_while_driving) and the
            # final async_create_entry() -- which must still save a flat
            # options dict, since every other module reads e.g.
            # opts.get("price_per_kwh") flat -- needs them promoted back to
            # the top level first.
            for _section_key in _OPTIONS_SECTIONS:
                _nested = user_input.pop(_section_key, None)
                if isinstance(_nested, dict):
                    user_input.update(_nested)
            # the combined "fixed destinations & zones" field is stored as the
            # two options it replaced (zone_entities / static_destinations)
            # that the coordinator and the MagicMirror panel already read.
            # Only when it was actually submitted: a section missing from the
            # submission keeps whatever was saved (see the merge below).
            if "panel_destinations" in user_input:
                (
                    user_input["zone_entities"],
                    user_input["static_destinations"],
                ) = _split_panel_destinations(
                    user_input.pop("panel_destinations"), _zone_options(self.hass)
                )
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
            # "alert_title"/"quiet_while_driving" are flat form fields that
            # fold into the nested notifications dict conditions.py actually
            # reads (cfg.get("title")/cfg.get("quietWhileDriving")) -- every
            # other field here saves flat, but this whole form is otherwise
            # the only place an HA user can override the notification
            # title, which defaulted to the literal "Kia EV9" for every
            # Hyundai/Genesis install with no way to change it.
            existing_notifications = dict(self._entry.options.get("notifications", {}))
            # If the "alerts" section didn't come back in this submission at
            # all (whatever the cause -- collapsed-section frontend
            # behavior, a non-standard programmatic caller), setdefault()
            # seeds these from the previously saved values instead of the
            # pop()s below silently treating "missing" the same as "user
            # cleared it", which would erase a saved custom title.
            user_input.setdefault("alert_title", existing_notifications.get("title", ""))
            user_input.setdefault(
                "quiet_while_driving", existing_notifications.get("quietWhileDriving", True)
            )
            alert_title = (user_input.pop("alert_title", "") or "").strip()
            quiet_while_driving = user_input.pop("quiet_while_driving", True)
            existing_notifications["quietWhileDriving"] = quiet_while_driving
            if alert_title:
                existing_notifications["title"] = alert_title
            else:
                existing_notifications.pop("title", None)
            user_input["notifications"] = existing_notifications
            if not errors:
                # Merge onto the existing saved options rather than treating
                # user_input as the complete final state -- the same
                # protection as above, generalized to every OTHER section:
                # a section entirely missing from this submission keeps its
                # previously saved fields instead of reverting to blank
                # schema defaults. A section that DID arrive already carries
                # every one of its own fields (voluptuous validates the
                # whole nested schema), including intentional blanks, so
                # this changes nothing for a normal, fully-rendered submit.
                merged = dict(self._entry.options)
                merged.update(user_input)
                return self.async_create_entry(title="", data=merged)
        opts = dict(self._entry.options)
        notif_opts = opts.get("notifications", {}) or {}
        zone_options = _zone_options(self.hass)

        if discovered:
            choices = {
                v["vin"]: (
                    f"{v['name']} ({v['model']} · {v['vin']})" if v["name"]
                    else f"{v['model'] or 'Vehicle'} · {v['vin']}"
                )
                for v in discovered
            }
            if len(discovered) == 1:
                # a single-vehicle account works fine with no VIN configured
                # at all (AccountPoller's select_own_vehicle() auto-picks the
                # one vehicle it gets back) -- offer that as the default
                # rather than forcing a VIN to be set
                choices = {"": "Auto (this account has one vehicle)", **choices}
            elif vin_default and vin_default not in choices:
                # the stored VIN isn't one Kia is reporting for this account
                # right now (stale after a car swap, a fetch hiccup, or --
                # the scenario this whole picker replaces -- a past typo);
                # keep it selectable so the form doesn't silently discard it
                choices = {vin_default: f"{vin_default} (not currently seen)", **choices}
            vin_field = vol.Optional(CONF_VIN, default=vin_default)
            vin_selector = vol.In(choices)
        else:
            # discovery failed (offline, cooldown, etc.) -- fall back to the
            # old free-text field rather than blocking Configure entirely
            vin_field = vol.Optional(
                CONF_VIN,
                default=vin_default,
                description={"suggested_value": vin_default},
            )
            vin_selector = str

        return self.async_show_form(
            step_id="init",
            errors=errors,
            data_schema=vol.Schema(
                {
                    # Kept out of any section -- these two are the fields
                    # people come back to this form to change most often
                    # (which vehicle, how often to poll), so they stay
                    # visible instead of behind a collapsed section header.
                    vin_field: vin_selector,
                    vol.Optional(
                        "scan_interval",
                        default=opts.get("scan_interval", DEFAULT_SCAN_INTERVAL_MINUTES),
                    ): _number(5, 1440, 1),
                    vol.Optional("battery_and_cost"): section(
                        vol.Schema(
                            {
                                vol.Optional(
                                    "price_per_kwh",
                                    default=float(opts.get("price_per_kwh") or 0),
                                ): _number(0, 10, 0.001),
                                vol.Optional(
                                    "away_price_per_kwh",
                                    default=float(opts.get("away_price_per_kwh") or 0),
                                ): _number(0, 10, 0.001),
                                vol.Optional(
                                    "currency",
                                    default=opts.get("currency", "USD"),
                                    description={
                                        "suggested_value": opts.get("currency", "USD")
                                    },
                                ): str,
                                vol.Optional(
                                    "capacity_kwh",
                                    default=float(opts.get("capacity_kwh") or 0),
                                ): _number(0, 300, 0.1),
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
                                    "charger_status_entity",
                                    description={
                                        "suggested_value": opts.get("charger_status_entity", "")
                                    },
                                ): _charger_status_entity(),
                                vol.Optional(
                                    "charger_energy_entity",
                                    description={
                                        "suggested_value": opts.get("charger_energy_entity", "")
                                    },
                                ): _sensor_entity(),
                                vol.Optional(
                                    "charger_power_entity",
                                    description={
                                        "suggested_value": opts.get("charger_power_entity", "")
                                    },
                                ): _sensor_entity(),
                            }
                        ),
                        options={"collapsed": False},
                    ),
                    vol.Optional("polling_advanced"): section(
                        vol.Schema(
                            {
                                vol.Optional(
                                    "stale_after_minutes",
                                    # how old the CAR's own last-reported reading can
                                    # get before binary_sensor.<vehicle>_data_stale
                                    # turns on
                                    default=opts.get(
                                        "stale_after_minutes", DEFAULT_STALE_AFTER_MINUTES
                                    ),
                                ): _number(5, 1440, 5),
                                vol.Optional(
                                    "poll_car_directly",
                                    # infer from the old seconds-based option the
                                    # first time this form is opened, then persist
                                    # the choice explicitly
                                    default=opts.get(
                                        "poll_car_directly",
                                        float(opts.get("force_refresh_timeout", 0) or 0) > 0,
                                    ),
                                ): bool,
                                vol.Optional(
                                    "force_refresh_timeout",
                                    # min 0: pre-toggle installs stored 0 here to
                                    # mean "cached only" and must still be able to
                                    # save the form
                                    default=opts.get(
                                        "force_refresh_timeout", DEFAULT_FORCE_REFRESH_TIMEOUT
                                    ),
                                ): _number(0, 180, 1),
                                vol.Optional(
                                    "block_automated_climate",
                                    default=opts.get("block_automated_climate", False),
                                ): bool,
                            }
                        ),
                        options={"collapsed": True},
                    ),
                    vol.Optional("destinations"): section(
                        vol.Schema(
                            {
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
                                # ONE field for what used to be two: fixed
                                # destinations ("static_destinations") and
                                # the zones to show on the MagicMirror panel
                                # ("zone_entities"). Pick zones from the
                                # dropdown or type a "Name | address"; on
                                # save it is split back into those two
                                # options, so stored data is unchanged.
                                vol.Optional(
                                    "panel_destinations",
                                    default=_panel_destination_defaults(opts),
                                ): _panel_destinations(zone_options),
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
                        options={"collapsed": True},
                    ),
                    vol.Optional("alerts"): section(
                        vol.Schema(
                            {
                                vol.Optional(
                                    "alert_title",
                                    # default "" (not "Kia EV9"): an empty value
                                    # here means "use conditions.py's own
                                    # default", so a Hyundai/Genesis owner who
                                    # never touches this field still gets that
                                    # generic default rather than this form
                                    # silently writing a wrong brand name into
                                    # their notifications.
                                    default=notif_opts.get("title", ""),
                                    description={
                                        "suggested_value": notif_opts.get("title", "")
                                    },
                                ): str,
                                vol.Optional(
                                    "quiet_while_driving",
                                    default=notif_opts.get("quietWhileDriving", True),
                                ): bool,
                            }
                        ),
                        options={"collapsed": True},
                    ),
                }
            ),
        )


class _NeedOtp(Exception):
    """Internal: login returned an OTP challenge."""
