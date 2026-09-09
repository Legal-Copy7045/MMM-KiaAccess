"""Constants for the Kia Access integration."""
from __future__ import annotations

import json
from pathlib import Path

DOMAIN = "kia_access"
PLATFORMS = ["sensor", "binary_sensor", "button", "device_tracker"]

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


def _load(name: str, key: str) -> list[dict]:
    with open(_HERE / name, encoding="utf-8") as fh:
        return json.load(fh)[key]


# Synced from repo core/ by scripts/sync-core.js
ENTITIES: list[dict] = _load("entities.json", "entities")
COMMANDS: list[dict] = _load("commands.json", "commands")
