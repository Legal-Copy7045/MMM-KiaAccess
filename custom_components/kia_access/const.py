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

DEFAULT_SCAN_INTERVAL_MINUTES = 30
DEFAULT_FORCE_REFRESH_TIMEOUT = 45

EVENT_STATE_CHANGED = "kia_access_alert"

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
