"""_check_command_authorized() -- the control services (lock/unlock/climate/
charge/...) are registered as DOMAIN services (hass.services.async_register),
not entity services, so HA's own authorization never checks which entity a
call actually controls -- a restricted user whose entity policy hides
lock.<vehicle> could otherwise still call kia_access.unlock directly. This
approximates entity-level authorization by checking CONTROL permission on
the vehicle's own lock entity.

Run: pip install homeassistant && python test/service_authorization_test.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("hyundai_kia_connect_api", type(sys)("hyundai_kia_connect_api"))

from homeassistant.exceptions import Unauthorized  # noqa: E402

import custom_components.kia_access as kia_access  # noqa: E402


class _FakeUser:
    def __init__(self, is_admin=False, allowed_entities=None):
        self.is_admin = is_admin
        self.permissions = self
        self._allowed = set(allowed_entities or [])

    def check_entity(self, entity_id, policy):
        return entity_id in self._allowed


class _FakeAuth:
    def __init__(self, users):
        self._users = users

    def async_get_user(self, user_id):
        return self._users.get(user_id)


class _FakeHass:
    def __init__(self, users):
        self.auth = _FakeAuth(users)


class _FakeContext:
    def __init__(self, user_id):
        self.user_id = user_id


class _FakeCall:
    def __init__(self, context):
        self.context = context


class _FakeEntry:
    def __init__(self, entry_id):
        self.entry_id = entry_id


class _FakeCoordinator:
    def __init__(self, entry_id):
        self.entry = _FakeEntry(entry_id)


ENTRY_ID = "entry1"
LOCK_ENTITY_ID = "lock.my_car_doors"


class _FakeRegistry:
    def __init__(self, mapping):
        self._mapping = mapping

    def async_get_entity_id(self, domain, integration_domain, unique_id):
        return self._mapping.get((domain, integration_domain, unique_id))


def _install_registry(mapping):
    kia_access.er.async_get = lambda hass: _FakeRegistry(mapping)


_REGISTRY_MAP = {("lock", kia_access.DOMAIN, f"{ENTRY_ID}_lock"): LOCK_ENTITY_ID}


def _check(hass, call, coordinator):
    kia_access._check_command_authorized(hass, call, coordinator)


coordinator = _FakeCoordinator(ENTRY_ID)

# ---- no context at all (an internal/system call) -- allowed unchecked ----
_install_registry(_REGISTRY_MAP)
_check(_FakeHass({}), _FakeCall(context=None), coordinator)

# ---- context with no attributable user (an automation/script call, not a
# signed-in HA user) -- allowed unchecked, matching how HA's own per-entity
# permission checks treat non-user-attributed calls ----
_check(_FakeHass({}), _FakeCall(_FakeContext(None)), coordinator)

# ---- an admin user -- always allowed regardless of entity permissions ----
hass = _FakeHass({"u1": _FakeUser(is_admin=True, allowed_entities=[])})
_check(hass, _FakeCall(_FakeContext("u1")), coordinator)

# ---- a non-admin user WITH control permission on the lock entity -- allowed ----
hass = _FakeHass({"u1": _FakeUser(is_admin=False, allowed_entities=[LOCK_ENTITY_ID])})
_check(hass, _FakeCall(_FakeContext("u1")), coordinator)

# ---- a non-admin user WITHOUT control permission -- the actual bypass this
# fix closes: must be rejected, not silently let through ----
hass = _FakeHass({"u1": _FakeUser(is_admin=False, allowed_entities=[])})
try:
    _check(hass, _FakeCall(_FakeContext("u1")), coordinator)
    raise AssertionError("a non-admin user without control permission must be rejected")
except Unauthorized as exc:
    assert exc.entity_id == LOCK_ENTITY_ID
    assert exc.permission == "control"

# ---- a user_id that doesn't resolve to any real user -- fails open (can't
# check permissions for a user that doesn't exist; matches other HA
# integrations' own handling of this edge case) ----
_check(_FakeHass({}), _FakeCall(_FakeContext("ghost")), coordinator)

# ---- no lock entity registered for this entry_id (shouldn't happen -- every
# entry gets one) -- fails open rather than blocking a legitimate call over
# a lookup that should always succeed ----
_install_registry({})
hass = _FakeHass({"u1": _FakeUser(is_admin=False, allowed_entities=[])})
_check(hass, _FakeCall(_FakeContext("u1")), coordinator)
_install_registry(_REGISTRY_MAP)

print("all service authorization tests passed")
