#!/usr/bin/env python3
"""Shared Kia/Hyundai client used by the MagicMirror bridge and (vendored) by
the Home Assistant integration.

Wraps hyundai_kia_connect_api.VehicleManager with:
  * region / brand name -> int maps
  * token.json load + save (preserving the original enrolment timestamp)
  * connect()  -> an authenticated VehicleManager (raises OtpRequired if not enrolled)
  * fetch(job) -> {"ok": True, "vehicles": [...], "meta": {...}}  (read path)
  * run_command(job) -> {"ok": True, "command": "...", ...}       (control path)

The control commands are described by core/commands.json so the HA integration,
the Lovelace card and this module all agree on names and arguments.
"""

import datetime
import json
import os
import stat
import threading

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TOKEN_FILE = os.path.join(_HERE, "token.json")
COMMANDS_FILE = os.path.join(_HERE, "core", "commands.json")

ENROLL_HINT = (
    "OTP enrollment required. Run once on the mirror: "
    "echo '<same JSON>' | venv/bin/python3 enroll.py  (see README)"
)

REGION_INT = {
    "EU": 1, "EUROPE": 1,
    "CA": 2, "CANADA": 2,
    "US": 3, "USA": 3,
    "CN": 4, "CHINA": 4,
    "AU": 5, "AUSTRALIA": 5,
    "IN": 7, "INDIA": 7,
    "NZ": 8,
    "BR": 9, "BRAZIL": 9,
}
BRAND_INT = {"KIA": 1, "HYUNDAI": 2, "GENESIS": 3}


class OtpRequired(Exception):
    """The saved token is missing/expired and interactive OTP enrollment is needed."""


class ClientError(Exception):
    """Any other failure worth reporting to the caller verbatim."""


# ---------------------------------------------------------------------------
# JSON helpers (shared with the bridge's vehicle dump)
# ---------------------------------------------------------------------------
def jsonable(value):
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, datetime.timezone):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _flatten_scalar_seq(val):
    if isinstance(val, (list, tuple)):
        parts = [str(x) for x in val if x is not None and x != ""]
        return ", ".join(parts) if parts else None
    return val


def dump_vehicle(vehicle):
    """Every readable public attribute + property off the Vehicle object."""
    out = {}
    for attr in dir(vehicle):
        if attr.startswith("_"):
            continue
        try:
            val = getattr(vehicle, attr)
        except Exception:
            continue
        if callable(val):
            continue
        if isinstance(val, (list, tuple)) and all(
            not isinstance(x, (list, tuple, dict)) for x in val
        ):
            val = _flatten_scalar_seq(val)
        try:
            out[attr] = jsonable(val)
        except Exception:
            out[attr] = repr(val)
    try:
        out["data"] = jsonable(getattr(vehicle, "data", {}) or {})
    except Exception:
        pass
    return out


def load_commands():
    with open(COMMANDS_FILE, encoding="utf-8") as fh:
        return json.load(fh).get("commands", [])


# ---------------------------------------------------------------------------
# token.json
# ---------------------------------------------------------------------------
def _load_token(token_file, Token):
    if not os.path.exists(token_file):
        return None, None
    try:
        with open(token_file, encoding="utf-8") as fh:
            raw = json.load(fh)
        return Token.from_dict(raw), raw.get("enrolled_at")
    except Exception:
        return None, None


def _save_token(token_file, vm, enrolled_at):
    if vm.token is None:
        return
    try:
        tok = vm.token.to_dict()
        tok["enrolled_at"] = enrolled_at or datetime.datetime.now(
            datetime.timezone.utc
        ).isoformat()
        with open(token_file, "w", encoding="utf-8") as fh:
            json.dump(tok, fh, indent=2, default=str)
        os.chmod(token_file, stat.S_IRUSR | stat.S_IWUSR)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# connect
# ---------------------------------------------------------------------------
def connect(job, token_file=None):
    """Return (vm, enrolled_at). Raises OtpRequired / ClientError."""
    token_file = token_file or job.get("tokenFile") or DEFAULT_TOKEN_FILE
    try:
        from hyundai_kia_connect_api import VehicleManager
        from hyundai_kia_connect_api.Token import Token
    except Exception as exc:
        raise ClientError(
            "hyundai_kia_connect_api is not installed. Run: "
            "pip3 install hyundai_kia_connect_api"
        ) from exc

    try:
        from hyundai_kia_connect_api.exceptions import AuthenticationOTPRequired
    except Exception:
        class AuthenticationOTPRequired(Exception):
            pass

    region = REGION_INT.get(str(job.get("region", "USA")).upper())
    brand = BRAND_INT.get(str(job.get("brand", "KIA")).upper())
    if region is None:
        raise ClientError(f"unknown region {job.get('region')!r}")
    if brand is None:
        raise ClientError(f"unknown brand {job.get('brand')!r}")

    saved_token, enrolled_at = _load_token(token_file, Token)
    geocode = bool(job.get("geocode", False))
    vm = VehicleManager(
        region=region,
        brand=brand,
        username=job["username"],
        password=job["password"],
        pin=str(job.get("pin", "")),
        token=saved_token,
        geocode_api_enable=geocode,
        geocode_api_use_email=geocode,
    )
    try:
        vm.check_and_refresh_token()
    except AuthenticationOTPRequired as exc:
        raise OtpRequired(ENROLL_HINT) from exc

    _save_token(token_file, vm, enrolled_at)
    return vm, enrolled_at


def _select_vehicles(vm, vin):
    vin = str(vin or "").upper()
    out = []
    for vehicle in vm.vehicles.values():
        if vin and str(getattr(vehicle, "VIN", "")).upper() != vin:
            continue
        out.append(vehicle)
    return out


# ---------------------------------------------------------------------------
# read path
# ---------------------------------------------------------------------------
def fetch(job, token_file=None):
    vm, enrolled_at = connect(job, token_file)

    meta_note = None
    if job.get("refresh", True):
        timeout = float(job.get("forceRefreshTimeout", 45) or 45)
        err = {}

        def _do_refresh():
            try:
                vm.force_refresh_all_vehicles_states()
            except Exception as exc:
                err["e"] = exc

        th = threading.Thread(target=_do_refresh, daemon=True)
        th.start()
        th.join(timeout)
        if th.is_alive():
            meta_note = f"live wake-up timed out after {int(timeout)}s — using cached data"
        elif "e" in err:
            meta_note = f"live wake-up failed: {err['e']}"
    vm.update_all_vehicles_with_cached_state()

    selected = _select_vehicles(vm, job.get("vin", ""))
    if not selected:
        raise ClientError("no matching vehicles on the account")
    vehicles = [dump_vehicle(v) for v in selected]

    meta = {}
    if meta_note:
        meta["note"] = meta_note
    if enrolled_at:
        meta["tokenEnrolledAt"] = enrolled_at
    first = vehicles[0]
    if not first.get("last_updated_at") and not (first.get("data") or {}):
        meta["warning"] = (
            "Kia returned an empty state for this vehicle. Open the Kia app "
            "once to force a sync, or try again shortly."
        )
    return {"ok": True, "vehicles": vehicles, "meta": meta}


# ---------------------------------------------------------------------------
# control path
# ---------------------------------------------------------------------------
def run_command(job, token_file=None):
    name = job.get("command")
    spec = next((c for c in load_commands() if c["key"] == name), None)
    if spec is None:
        raise ClientError(f"unknown command {name!r}")

    vm, _ = connect(job, token_file)
    vm.update_all_vehicles_with_cached_state()
    selected = _select_vehicles(vm, job.get("vin", ""))
    if not selected:
        raise ClientError("no matching vehicles on the account")
    vehicle_id = selected[0].id

    method = getattr(vm, spec["method"], None)
    if method is None:
        raise ClientError(
            f"hyundai_kia_connect_api has no '{spec['method']}' — library too old?"
        )

    kwargs = {}
    opts = job.get("options") or {}
    for opt_name in (spec.get("options") or {}):
        if opt_name in opts:
            kwargs[opt_name] = opts[opt_name]

    try:
        if spec.get("options"):
            method(vehicle_id, **kwargs) if kwargs else method(vehicle_id)
        else:
            method(vehicle_id)
    except TypeError:
        # some library versions take a ClimateRequestOptions object; fall back
        method(vehicle_id)
    return {"ok": True, "command": name, "vehicleId": vehicle_id}
