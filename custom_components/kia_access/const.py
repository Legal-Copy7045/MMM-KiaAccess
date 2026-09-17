"""Constants for the Kia Access integration."""
from __future__ import annotations

import json
from pathlib import Path

DOMAIN = "kia_access"
PLATFORMS = [
    "sensor",
    "binary_sensor",
    "button",
    "device_tracker",
    "lock",
    "climate",
    "number",
    "switch",
    "select",
]

# Climate preferences stored per config entry (Store key kia_access_prefs_<id>).
# The climate entity / start_climate button build a start_climate call from these
# plus a temperature; the number/switch/select entities edit them.
DEFAULT_CLIMATE_PREFS: dict = {
    "duration": 10,          # minutes the climate run lasts
    "front_defrost": False,  # -> ClimateRequestOptions.defrost
    "rear_defrost": False,   # -> .heating (rear window + mirrors)
    "steering_wheel": 0,     # 0 off / 1 low / 2 high
    "front_left_seat": 0,
    "front_right_seat": 0,
    "rear_left_seat": 0,
    "rear_right_seat": 0,
    "last_temp_c": 22.0,     # remembered target, so turn_on has something to send
}

# KiaUvoApiUSA._seat_settings level codes (0 off; 6/7/8 heat lo/md/hi;
# 3/4/5 cool lo/md/hi). Ordered dict: label -> code.
SEAT_LEVELS: dict = {
    "Off": 0,
    "Heat - low": 6,
    "Heat - medium": 7,
    "Heat - high": 8,
    "Cool - low": 3,
    "Cool - medium": 4,
    "Cool - high": 5,
}
STEERING_WHEEL_LEVELS: dict = {"Off": 0, "Low": 1, "High": 2}

CONF_REGION = "region"
CONF_BRAND = "brand"
CONF_PIN = "pin"
CONF_VIN = "vin"
CONF_TOKEN = "token"
CONF_GEOCODE = "geocode"


def brand_display_name(brand: str | None) -> str:
    """"KIA"/"HYUNDAI"/"GENESIS" (config_flow.py's BRANDS, stored uppercase
    in CONF_BRAND) -> "Kia"/"Hyundai"/"Genesis". ONE canonical resolver --
    config_flow.py's config-entry title used to show the raw uppercase code
    ("HYUNDAI (user@example.com)") while entity.py's device name/
    manufacturer title-cased it ("Hyundai"), two different displays of the
    same brand with no shared source."""
    return str(brand or "KIA").title()

DEFAULT_SCAN_INTERVAL_MINUTES = 30
DEFAULT_FORCE_REFRESH_TIMEOUT = 45
# how old the CAR's own last-reported reading (vehicle.last_updated_at) can
# get before binary_sensor.<vehicle>_data_stale turns on -- a poll to Kia's
# cloud can succeed (200 OK) while just echoing back a value the car itself
# hasn't refreshed in a while (asleep, poor signal, etc); that's a distinct
# condition from a failed poll, which HA already reflects as the entities
# going unavailable (CoordinatorEntity.available / last_update_success).
# Default is 2x the default scan interval, not a fixed number, since a
# reading that's merely one scan_interval old is expected, not stale.
DEFAULT_STALE_AFTER_MINUTES = DEFAULT_SCAN_INTERVAL_MINUTES * 2

# Named to avoid colliding with homeassistant.const.EVENT_STATE_CHANGED
# ("state_changed") -- this is our own custom bus event, unrelated to HA's.
EVENT_KIA_ACCESS_ALERT = "kia_access_alert"

_HERE = Path(__file__).parent

try:
    with open(_HERE / "manifest.json", encoding="utf-8") as _mf:
        VERSION: str = json.load(_mf).get("version", "0")
except Exception:  # noqa: BLE001
    VERSION = "0"


def _load(name: str, key: str) -> list[dict]:
    with open(_HERE / name, encoding="utf-8") as fh:
        return json.load(fh)[key]


# Synced from repo core/ by scripts/sync-core.js
ENTITIES: list[dict] = _load("entities.json", "entities")
COMMANDS: list[dict] = _load("commands.json", "commands")
