"""Small in-memory stand-ins for real Home Assistant objects, shared by every
test that builds a KiaAccessCoordinator via object.__new__() + duck-typed
attributes instead of a full hass fixture (test/coordinator_stress_test.py,
test/coordinator_stale_test.py, test/coordinator_alerts_test.py,
test/ha_import_check.py). These three used to be copy-pasted into each of
those files near-verbatim -- a real drift risk (only one copy getting
updated for a homeassistant API change), and the self-audit that caught it
is why this file exists now.

Only pulls in the pieces genuinely identical across every caller. A test
file that needs something MORE (event bus, config_entries, locks, ...)
still builds its own richer fake around these -- see coordinator_stress_test
.py's own _FakeHass for that pattern.
"""
from homeassistant.util.unit_system import IMPERIAL_SYSTEM


class FakeStore:
    """In-memory stand-in for homeassistant.helpers.storage.Store."""

    def __init__(self, initial=None):
        self._data = initial

    async def async_load(self):
        return self._data

    async def async_save(self, data):
        self._data = data


class FakeConfig:
    units = IMPERIAL_SYSTEM


class FakeStates:
    def get(self, entity_id):
        return None  # no zone.home etc configured -- keeps _emit_alerts() simple

    def async_all(self, domain):
        return []
