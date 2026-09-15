"""KiaAccessCoordinator.analytics -- the HA-side wiring of analytics.py.

Spinning up a real KiaAccessCoordinator needs a live hass/ConfigEntry (its
DataUpdateCoordinator base, Store, etc.), too heavy for a unit test. Instead
this exercises the REAL `analytics` property function (not a reimplementation
of it) via `.fget()` bound to a minimal duck-typed stand-in that only has the
attributes the property actually reads: self.hass.config.units and
self._trips / self._sessions. That's exactly what
KiaAccessCoordinator._update_trips() populates (from build_state()'s
rangeKm/outsideTempC, mirroring node_helper.js's tripState.rangeKm/
outsideTempC -- see test/node_helper.test.js's onPayload()->analytics
integration test for that side).

Run: pip install homeassistant && python test/coordinator_analytics_test.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

from homeassistant.util.unit_system import IMPERIAL_SYSTEM, METRIC_SYSTEM  # noqa: E402
from custom_components.kia_access.coordinator import KiaAccessCoordinator  # noqa: E402


class _FakeConfig:
    def __init__(self, units):
        self.units = units


class _FakeHass:
    def __init__(self, units):
        self.config = _FakeConfig(units)


class _FakeCoordinator:
    def __init__(self, units, trips, sessions):
        self.hass = _FakeHass(units)
        self._trips = trips
        self._sessions = sessions


trips = [
    {"distanceKm": 40, "usedPct": 15, "minutes": 45, "endedAt": 1, "chargedDuring": False,
     "startRangeKm": 300, "startPct": 80, "outsideTempC": -10},
    {"distanceKm": 60, "usedPct": 22, "minutes": 68, "endedAt": 2, "chargedDuring": False,
     "startRangeKm": 310, "startPct": 85, "outsideTempC": -8},
]
sessions = [
    {"startPct": 20, "endPct": 45, "minutes": 100, "kwh": 25, "avgKw": 15, "location": "home", "cost": 3.5},
]

# ---- the actual property function, bound to a fake self -- proves the
# coordinator wires analytics.py's 4 functions to self._trips/self._sessions
# and picks units from self.hass.config.units exactly like _emit_alerts()
# already does (coordinator.py:~1331) ----
fake = _FakeCoordinator(IMPERIAL_SYSTEM, trips, sessions)
a = KiaAccessCoordinator.analytics.fget(fake)
assert a["observedEfficiency"] is not None
assert a["observedEfficiency"]["unit"] == "mi/%", "imperial hass.config.units must select mi/%, not km/%"
assert a["rangeAccuracy"] is not None
assert a["rangeAccuracy"]["tripsSampled"] == 2
assert a["chargingPerformance"] is not None
assert a["chargingPerformance"]["home"]["count"] == 1
assert a["drivingPatterns"] is None, "endedAt=1/2 (epoch ms) is outside the 30-day window -- must be None, not crash"

fake_metric = _FakeCoordinator(METRIC_SYSTEM, trips, sessions)
a2 = KiaAccessCoordinator.analytics.fget(fake_metric)
assert a2["observedEfficiency"]["unit"] == "km/%", "metric hass.config.units must select km/%"

# ---- empty history -> every key None, not a crash (a freshly added vehicle
# with no trips/sessions yet must not break sensor.py's availability check) ----
empty = _FakeCoordinator(IMPERIAL_SYSTEM, [], [])
a3 = KiaAccessCoordinator.analytics.fget(empty)
assert a3 == {
    "observedEfficiency": None, "rangeAccuracy": None,
    "chargingPerformance": None, "drivingPatterns": None,
}

print("all coordinator analytics tests passed")
