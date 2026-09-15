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
from .const import CONF_BRAND, CONF_REGION, DOMAIN

_LOGGER = logging.getLogger(__name__)

# Collapses near-simultaneous calls from sibling coordinators (e.g. several
# entries with the same scan_interval waking up in the same tick) into one
# real fetch. NOT a substitute for each coordinator's own scan_interval --
# a call outside this window always triggers a fresh fetch, so a longer-
# interval entry still gets data as fresh as it asks for.
DEDUP_WINDOW_SEC = 10.0

# {account_hash: AccountPoller}, one per (region, brand, username) account --
# shared by every config entry/coordinator for that account, however many
# vehicles it has. Deliberately its own top-level hass.data key, not nested
# under hass.data[DOMAIN] (which is {entry_id: coordinator} and unloading the
# LAST entry clears that dict entirely -- a distinct key means this survives
# any single entry's own reload independent of that). Lives here (not
# __init__.py, where it originated) so config_flow.py's Options-flow VIN
# discovery can also look up an already-running poller for this account
# without a circular import (__init__.py already imports FROM config_flow.py).
ACCOUNTS_KEY = f"{DOMAIN}_accounts"


def account_hash_for(entry) -> str:
    return kia_client._account_hash(  # noqa: SLF001
        entry.data.get(CONF_REGION, "USA"),
        entry.data.get(CONF_BRAND, "KIA"),
        entry.data.get("username", ""),
    )


def _wants_live_wakeup(job: dict) -> bool:
    """Same condition kia_client.fetch() itself uses to decide whether to
    wake the car (vs. just reading Kia's server-side cache) -- mirrored
    here so the dedup cache below can recognise it too. Every real caller
    (coordinator.py's _job(), config_flow.py's discovery job) always sets
    "refresh" explicitly, so this default only matters for a hypothetical
    caller that doesn't -- unlike kia_client.fetch()'s own "assume yes"
    default (right for a single direct API call), the SAFE default for a
    shared cache is "don't force", so an unset field never accidentally
    bypasses the dedup window."""
    raw_timeout = job.get("forceRefreshTimeout", 45)
    timeout = float(raw_timeout) if raw_timeout is not None else 45.0
    return bool(job.get("refresh", False)) and timeout > 0


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
        # a FAILED fetch (bad credentials, Kia outage, cooldown already
        # active) used to only be deduped by the asyncio.Lock's ordering --
        # each sibling coordinator waiting on the lock would still go on to
        # make its OWN independent (failing) kia_client.fetch() call once
        # its turn came, instead of reusing the failure that just happened.
        # That's the opposite of what this class exists for: several
        # coordinators hitting a broken login in the same tick would retry
        # that broken login several times over, which is exactly the
        # repeated-failure pattern kia_client.py's own auth-failure cooldown
        # (_record_auth_failure) is trying to detect and stop -- multiplying
        # how fast an account trips it. Cache the failure itself for the
        # same DEDUP_WINDOW_SEC so a sibling call within the window re-raises
        # the SAME failure instead of generating a fresh one.
        self._last_error: Exception | None = None
        self._last_error_at: float = 0.0

    async def async_fetch(self, job: dict) -> dict:
        """job's own "vin"/"allVehicles" are ignored -- always fetches every
        vehicle on the account in one call. Returns kia_client.fetch()'s
        normal {"ok", "vehicles": [...], "meta": {...}} shape, or re-raises
        whatever it raised -- either way, reused across every caller within
        DEDUP_WINDOW_SEC of the last real attempt (success OR failure) --
        UNLESS this job explicitly wants a live car wake-up (a manual
        "Refresh now", or "poll car directly" on): the dedup cache exists to
        collapse redundant server-cache-only reads from sibling coordinators
        waking up in the same tick, not to silently hand a genuinely
        requested live reading back as a few-seconds-stale cached one. A
        forced call always does its own real fetch, but its result is still
        cached afterward for any ordinary (non-forced) caller that follows
        within the window."""
        async with self._lock:
            now = time.time()
            forced = _wants_live_wakeup(job)
            if not forced:
                if self._last_payload is not None and (now - self._last_fetched_at) < DEDUP_WINDOW_SEC:
                    return self._last_payload
                if self._last_error is not None and (now - self._last_error_at) < DEDUP_WINDOW_SEC:
                    raise self._last_error
            call_job = dict(job)
            call_job["vin"] = ""
            call_job["allVehicles"] = True
            try:
                payload = await self.hass.async_add_executor_job(kia_client.fetch, call_job)
            except Exception as exc:  # noqa: BLE001
                self._last_error = exc
                self._last_error_at = now
                raise
            self._last_payload = payload
            self._last_fetched_at = now
            self._last_error = None
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
            # see kia_client._vehicle_key()'s docstring: falls back to the
            # vehicle's own `id` when the connected region's API never sets
            # VIN at all (confirmed: Kia USA, via KiaUvoApiUSA)
            if kia_client._vehicle_key_dict(v) == vin:  # noqa: SLF001
                return v
        if not vehicles:
            raise kia_client.ClientError(
                f"no vehicle on the account matches the configured VIN {vin!r} -- "
                "the account API returned 0 vehicles this poll (a transient gap, "
                "or the account temporarily has no cloud-connected vehicle)"
            )
        # a vehicle with neither a VIN nor an `id` (a badly degraded API
        # response) would otherwise key to "" and silently vanish from this
        # list -- worth still SHOWING that the account has one, even
        # unidentified, rather than a diagnostic that undercounts what the
        # account actually returned.
        seen = sorted({
            kia_client._vehicle_key_dict(v) or "(unidentified vehicle)"  # noqa: SLF001
            for v in vehicles
        })
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
