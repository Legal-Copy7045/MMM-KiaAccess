"""_map_keys_for_entry() -- custom:kia-range-map-card's alternative to
typing api_key/tomtom_key into the dashboard: it pulls the geocoding/
routing keys straight from a config entry's own Options (already stored
there for range_reach's drive-time lookups) instead of duplicating a real
API key into Lovelace YAML.

Run: pip install homeassistant && python test/map_keys_test.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

from custom_components.kia_access import _map_keys_for_entry  # noqa: E402


class _FakeEntry:
    def __init__(self, options):
        self.options = options


# ---- tomtom provider: routing_api_key IS a tomtom key, and gets returned
# as tomtom_key alongside the geocoding key ----
e = _FakeEntry({
    "drive_time_provider": "tomtom",
    "routing_api_key": "tt-secret",
    "geocoding_api_key": "geo-secret",
})
keys = _map_keys_for_entry(e)
assert keys == {"api_key": "geo-secret", "tomtom_key": "tt-secret"}, keys

# ---- geoapify provider: routing_api_key is a GEOAPIFY key, not a tomtom
# one -- must never be handed to the card as tomtom_key (it would either
# silently fail the TomTom call, or leak a geoapify key to TomTom) ----
e2 = _FakeEntry({
    "drive_time_provider": "geoapify",
    "routing_api_key": "geoapify-routing-secret",
    "geocoding_api_key": "geo-secret",
})
keys2 = _map_keys_for_entry(e2)
assert keys2 == {"api_key": "geo-secret", "tomtom_key": None}, (
    "a geoapify routing key must never be surfaced as tomtom_key: " + str(keys2)
)

# ---- estimate provider (no routing key in play at all) ----
e3 = _FakeEntry({"drive_time_provider": "estimate", "routing_api_key": "", "geocoding_api_key": "geo-secret"})
keys3 = _map_keys_for_entry(e3)
assert keys3 == {"api_key": "geo-secret", "tomtom_key": None}, keys3

# ---- nothing configured at all -> both None, not a crash ----
e4 = _FakeEntry({})
keys4 = _map_keys_for_entry(e4)
assert keys4 == {"api_key": None, "tomtom_key": None}, keys4

# ---- tomtom provider selected but the key was never actually filled in ----
e5 = _FakeEntry({"drive_time_provider": "tomtom", "routing_api_key": "", "geocoding_api_key": ""})
keys5 = _map_keys_for_entry(e5)
assert keys5 == {"api_key": None, "tomtom_key": None}, keys5

print("all map_keys tests passed")
