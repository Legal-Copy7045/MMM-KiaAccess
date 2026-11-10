"""Kia Access climate entity — remote climate / preconditioning.

A thin HVAC wrapper over start_climate / stop_climate so the standard
thermostat card, the voice assistants and generic climate automations work.
Duration, defrost, seat and steering-wheel preferences live on the separate
number / switch / select entities and are folded in on every start.
"""
from __future__ import annotations

from homeassistant.components.climate import (
    ATTR_HVAC_MODE,
    ClimateEntity,
    ClimateEntityFeature,
    HVACMode,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_TEMPERATURE, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .entity import KiaAccessEntity

_TRUE = {True, "true", "True", 1, "1", "on", "yes"}

# Home Assistant's native climate temperature API (native_temperature_unit /
# native_current_temperature / native_target_temperature). Releases before it
# only know the plain names -- see the aliases at the end of this file.
_NATIVE_API = hasattr(ClimateEntity, "native_temperature_unit")


def _num(x):
    try:
        return None if x is None or x == "" else float(x)
    except (TypeError, ValueError):
        return None


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([KiaAccessClimate(coordinator)])


class KiaAccessClimate(KiaAccessEntity, ClimateEntity):
    _attr_name = "Climate"
    _attr_icon = "mdi:air-conditioner"
    _attr_hvac_modes = [HVACMode.OFF, HVACMode.HEAT_COOL]
    _attr_supported_features = (
        ClimateEntityFeature.TARGET_TEMPERATURE
        | ClimateEntityFeature.TURN_ON
        | ClimateEntityFeature.TURN_OFF
    )
    _enable_turn_on_off_backwards_compatibility = False

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "climate")
        # The car's own unit (USA sends °F, everywhere else incl. Canada °C).
        # It follows the entry's region, which can't change without the entry
        # reloading, so it's set once. Home Assistant converts for display.
        unit = coordinator.climate_temp_unit()
        if _NATIVE_API:
            self._attr_native_temperature_unit = unit
        else:
            self._attr_temperature_unit = unit

    # ---- units / bounds ----
    @property
    def _fahrenheit(self) -> bool:
        return self.coordinator.climate_temp_unit() == UnitOfTemperature.FAHRENHEIT

    @property
    def min_temp(self) -> float:
        return 62 if self._fahrenheit else 16

    @property
    def max_temp(self) -> float:
        return 82 if self._fahrenheit else 30

    @property
    def target_temperature_step(self) -> float:
        return 1 if self._fahrenheit else 0.5

    # ---- state ----
    # In the native unit above. Home Assistant 2026.x+ reads these native_*
    # names (the old current_temperature / target_temperature / temperature_
    # unit overrides are deprecated, removed in 2027.11); older releases get
    # them through the aliases at the bottom of this file.
    @property
    def native_current_temperature(self):
        c = _num(self.coordinator.vehicle.get("air_temperature"))  # payload is °C
        if c is None:
            return None
        return round(c * 9 / 5 + 32) if self._fahrenheit else c

    @property
    def native_target_temperature(self):
        c = self.coordinator.climate_prefs.get("last_temp_c")
        if c is None:
            return None
        return round(c * 9 / 5 + 32) if self._fahrenheit else round(c * 2) / 2

    @property
    def hvac_mode(self) -> HVACMode:
        on = self.coordinator.vehicle.get("air_control_is_on") in _TRUE
        return HVACMode.HEAT_COOL if on else HVACMode.OFF

    # ---- commands ----
    def _to_celsius(self, temp: float) -> float:
        return (temp - 32) * 5 / 9 if self._fahrenheit else temp

    def _ctx(self):
        return getattr(self, "_context", None)

    async def _start(self, temp_c: float | None) -> None:
        if temp_c is not None:
            await self.coordinator.async_set_pref("last_temp_c", round(temp_c, 1))
        opts = self.coordinator.build_climate_options(temp_c)
        await self.coordinator.async_run_command(
            "start_climate", opts, context=self._ctx()
        )

    async def async_set_temperature(self, **kwargs) -> None:
        temp = kwargs.get(ATTR_TEMPERATURE)
        # climate.set_temperature can carry an hvac_mode: "off" with a
        # temperature must not start the car's climate -- remember the
        # temperature for next time and stop instead
        if kwargs.get(ATTR_HVAC_MODE) == HVACMode.OFF:
            if temp is not None:
                await self.coordinator.async_set_pref(
                    "last_temp_c", round(self._to_celsius(float(temp)), 1)
                )
            await self.coordinator.async_run_command("stop_climate", context=self._ctx())
            return
        if temp is None:
            if kwargs.get(ATTR_HVAC_MODE) is not None:
                await self.async_set_hvac_mode(kwargs[ATTR_HVAC_MODE])
            return
        await self._start(self._to_celsius(float(temp)))

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        if hvac_mode == HVACMode.OFF:
            await self.coordinator.async_run_command(
                "stop_climate", context=self._ctx()
            )
        else:
            await self._start(None)

    async def async_turn_on(self) -> None:
        await self._start(None)

    async def async_turn_off(self) -> None:
        await self.coordinator.async_run_command(
            "stop_climate", context=self._ctx()
        )


if not _NATIVE_API:
    # Home Assistant before the native climate API reads the plain names.
    # Attached only there: on current releases overriding them is deprecated.
    KiaAccessClimate.current_temperature = property(
        lambda self: self.native_current_temperature
    )
    KiaAccessClimate.target_temperature = property(
        lambda self: self.native_target_temperature
    )
