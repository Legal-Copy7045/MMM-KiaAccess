"""Kia Access selects — desired steering-wheel and seat heat/vent levels.

These are stored preferences applied on the next start_climate (there is no
API to set them independently). The USA seat level codes come from
KiaUvoApiUSA._seat_settings (see const.SEAT_LEVELS).
"""
from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SEAT_LEVELS, STEERING_WHEEL_LEVELS
from .entity import KiaAccessEntity

_SEATS = [
    ("front_left_seat", "Driver seat with climate"),
    ("front_right_seat", "Passenger seat with climate"),
    ("rear_left_seat", "Rear-left seat with climate"),
    ("rear_right_seat", "Rear-right seat with climate"),
]


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    ents: list = [
        KiaAccessPrefSelect(
            coordinator, "steering_wheel", "Steering wheel heat with climate",
            STEERING_WHEEL_LEVELS, "mdi:steering",
        )
    ]
    for pref, name in _SEATS:
        ents.append(
            KiaAccessPrefSelect(coordinator, pref, name, SEAT_LEVELS, "mdi:car-seat-heater")
        )
    async_add_entities(ents)


class KiaAccessPrefSelect(KiaAccessEntity, SelectEntity):
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator, pref: str, name: str, levels: dict, icon: str) -> None:
        super().__init__(coordinator, f"pref_{pref}")
        self._pref = pref
        self._levels = levels  # label -> int code
        self._by_code = {v: k for k, v in levels.items()}
        self._attr_name = name
        self._attr_icon = icon
        self._attr_options = list(levels)

    @property
    def available(self) -> bool:
        return True

    @property
    def current_option(self) -> str:
        code = int(self.coordinator.climate_prefs.get(self._pref) or 0)
        return self._by_code.get(code, next(iter(self._levels)))

    async def async_select_option(self, option: str) -> None:
        await self.coordinator.async_set_pref(self._pref, self._levels.get(option, 0))
