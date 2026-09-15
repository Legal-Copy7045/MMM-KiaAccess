"""Shares ONE Kia login/session and one full-account fetch across every
KiaAccessCoordinator for the same (region, brand, username) account.

Before this, an N-vehicle account under HA meant N independent config
entries, each with its own KiaAccessCoordinator, each on its own poll
schedule independently calling kia_client.fetch() -- its own login/
token-refresh, its own "get vehicle list", its own "wake all vehicles"
call. hyundai_kia_connect_api.VehicleManager's own methods (get_vehicles,
update_all_vehicles_with_cached_state, force_refresh_all_vehicles_states)
are already ACCOUNT-scoped, not per-vehicle -- kia_client.fetch()'s
allVehicles:true (already used by MM's rotate-mode feature) returns every
vehicle on the account in one call. An N-vehicle HA account was doing
roughly N times the account-level Kia API traffic a single-vehicle
account does for the exact same underlying data, which is real exposure
to exactly the kind of rate-limiting/lockout risk the auth-failure
circuit breaker (see kia_client.py's _record_auth_failure) exists to
contain -- this fixes the cause instead of just cushioning the symptom.
"""
from __future__ import annotations

import asyncio
import logging
import time

from . import kia_client

_LOGGER = logging.getLogger(__name__)

# Collapses near-simultaneous calls from sibling coordinators (e.g. several
# entries with the same scan_interval waking up in the same tick) into one
# real fetch. NOT a substitute for each coordinator's own scan_interval --
# a call outside this window always triggers a fresh fetch, so a longer-
# interval entry still gets data as fresh as it asks for.
DEDUP_WINDOW_SEC = 10.0


class AccountPoller:
    """One per Kia account, shared via hass.data[ACCOUNTS_KEY][account_hash]
    (see __init__.py) by every KiaAccessCoordinator for that account,
    regardless of which vehicle each one represents."""

    def __init__(self, hass, account_hash: str) -> None:
        self.hass = hass
        self.account_hash = account_hash
        self.refcount = 0  # how many coordinators currently reference this poller
        self._lock = asyncio.Lock()
        self._last_payload: dict | None = None
        self._last_fetched_at: float = 0.0

    async def async_fetch(self, job: dict) -> dict:
        """job's own "vin"/"allVehicles" are ignored -- always fetches every
        vehicle on the account in one call. Returns kia_client.fetch()'s
        normal {"ok", "vehicles": [...], "meta": {...}} shape (or re-raises
        whatever it raised), reused across every caller within
        DEDUP_WINDOW_SEC of the last real fetch."""
        async with self._lock:
            now = time.time()
            if self._last_payload is not None and (now - self._last_fetched_at) < DEDUP_WINDOW_SEC:
                return self._last_payload
            call_job = dict(job)
            call_job["vin"] = ""
            call_job["allVehicles"] = True
            payload = await self.hass.async_add_executor_job(kia_client.fetch, call_job)
            self._last_payload = payload
            self._last_fetched_at = now
            return payload


def select_own_vehicle(vehicles: list[dict], vin: str) -> dict:
    """Pick THIS coordinator's own vehicle out of an AccountPoller's
    all-vehicles fetch result. Mirrors kia_client._no_match_error()'s
    diagnostic shape (naming the configured VIN and what the account
    actually returned) since this replaces the equivalent check that used
    to run inside kia_client._select_vehicles() before every coordinator
    called fetch() with its own VIN directly."""
    vin = str(vin or "").strip().upper()
    if vin:
        for v in vehicles:
            if str(v.get("VIN") or "").strip().upper() == vin:
                return v
        seen = sorted({str(v.get("VIN") or "").strip().upper() for v in vehicles} - {""})
        if not seen:
            raise kia_client.ClientError(
                f"no vehicle on the account matches the configured VIN {vin!r} -- "
                "the account API returned 0 vehicles this poll (a transient gap, "
                "or the account temporarily has no cloud-connected vehicle)"
            )
        raise kia_client.ClientError(
            f"no vehicle on the account matches the configured VIN {vin!r} -- "
            f"the account currently has: {', '.join(seen)}. If the car's real VIN "
            "isn't in that list, remove and re-add the integration to pick it up "
            "fresh; if it IS in that list, the config's stored VIN doesn't match "
            "it (re-run Configure and re-select the vehicle)."
        )
    if not vehicles:
        raise kia_client.ClientError(
            "no matching vehicles on the account (the account API returned "
            "0 vehicles this poll -- if this persists, check the Kia/Hyundai "
            "app itself shows the car, and that the account has cloud/remote "
            "access, not just Bluetooth-only connectivity)"
        )
    if len(vehicles) > 1:
        raise kia_client.ClientError(
            f"{len(vehicles)} vehicles on this account — set a VIN in the "
            "config to pick one (reads need an explicit target, same as "
            "control commands)"
        )
    return vehicles[0]
