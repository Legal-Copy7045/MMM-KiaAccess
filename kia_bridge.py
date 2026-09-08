#!/usr/bin/env python3
"""Bridge between MMM-KiaAccess (Node) and hyundai_kia_connect_api (Python).

Reads a JSON job on stdin:
    {"username": "...", "password": "...", "pin": "...",
     "brand": "KIA", "region": "USA", "vin": "", "refresh": true}

Writes a JSON result on stdout:
    {"ok": true, "vehicles": [ {<flattened vehicle attrs>} , ... ]}
    {"ok": false, "error": "..."}

Why a Python bridge instead of the Node `bluelinky` library:
Kia USA sits behind Cloudflare bot protection that blocks bluelinky's
American controller (HTTP 403). hyundai_kia_connect_api carries the
Cloudflare bot-management handling and is actively maintained (it powers
the Home Assistant Kia/Hyundai integration).
"""

import datetime
import json
import os
import stat
import sys

TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "token.json")
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


def flatten_scalar_seq(val):
    """Tuples/lists of plain scalars (geocode, location, ...) -> one ', ' string,
    so the frontend shows a single row instead of `.0`, `.1` index rows."""
    if isinstance(val, (list, tuple)):
        parts = [str(x) for x in val if x is not None and x != ""]
        return ", ".join(parts) if parts else None
    return val


def dump_vehicle(vehicle):
    """Collect every readable public attribute + property off the Vehicle object."""
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
            val = flatten_scalar_seq(val)
        try:
            out[attr] = jsonable(val)
        except Exception:
            out[attr] = repr(val)
    # keep the raw API payload under its own key too
    try:
        out["data"] = jsonable(getattr(vehicle, "data", {}) or {})
    except Exception:
        pass
    return out


def main():
    try:
        job = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"bad job payload: {exc}"}))
        return 0

    try:
        from hyundai_kia_connect_api import VehicleManager
        from hyundai_kia_connect_api.Token import Token
    except Exception:  # noqa: BLE001
        print(json.dumps({
            "ok": False,
            "error": "hyundai_kia_connect_api is not installed. Run: "
                     "pip3 install hyundai_kia_connect_api",
        }))
        return 0

    try:
        from hyundai_kia_connect_api.exceptions import AuthenticationOTPRequired
    except Exception:  # noqa: BLE001
        class AuthenticationOTPRequired(Exception):
            pass

    saved_token = None
    enrolled_at = None
    if os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE) as fh:
                raw_token = json.load(fh)
            saved_token = Token.from_dict(raw_token)
            enrolled_at = raw_token.get("enrolled_at")
        except Exception:  # noqa: BLE001
            saved_token = None

    region = REGION_INT.get(str(job.get("region", "USA")).upper())
    brand = BRAND_INT.get(str(job.get("brand", "KIA")).upper())
    if region is None:
        print(json.dumps({"ok": False, "error": f"unknown region {job.get('region')!r}"}))
        return 0
    if brand is None:
        print(json.dumps({"ok": False, "error": f"unknown brand {job.get('brand')!r}"}))
        return 0

    geocode = bool(job.get("geocode", False))
    try:
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
        except AuthenticationOTPRequired:
            print(json.dumps({"ok": False, "error": ENROLL_HINT}))
            return 0

        # persist the (possibly refreshed / rotated) token for next time,
        # keeping the original enrolment timestamp
        if vm.token is not None:
            try:
                tok = vm.token.to_dict()
                tok["enrolled_at"] = enrolled_at or datetime.datetime.now(
                    datetime.timezone.utc
                ).isoformat()
                with open(TOKEN_FILE, "w") as fh:
                    json.dump(tok, fh, indent=2, default=str)
                os.chmod(TOKEN_FILE, stat.S_IRUSR | stat.S_IWUSR)
            except Exception:  # noqa: BLE001
                pass

        want_refresh = job.get("refresh", True)
        _meta_note = None
        if want_refresh:
            # Ask the car for a live reading, but time-box it in a daemon
            # thread: the remote wake-up can hang indefinitely for a vehicle
            # that has never synced. Whatever happens, follow with a cached
            # read so the Vehicle objects are populated.
            import threading

            timeout = float(job.get("forceRefreshTimeout", 45) or 45)
            err = {}

            def _do_refresh():
                try:
                    vm.force_refresh_all_vehicles_states()
                except Exception as exc:  # noqa: BLE001
                    err["e"] = exc

            th = threading.Thread(target=_do_refresh, daemon=True)
            th.start()
            th.join(timeout)
            if th.is_alive():
                _meta_note = f"live wake-up timed out after {int(timeout)}s — using cached data"
            elif "e" in err:
                _meta_note = f"live wake-up failed: {err['e']}"
        vm.update_all_vehicles_with_cached_state()

        vin_filter = str(job.get("vin", "") or "").upper()
        vehicles = []
        for vehicle in vm.vehicles.values():
            if vin_filter and str(getattr(vehicle, "VIN", "")).upper() != vin_filter:
                continue
            vehicles.append(dump_vehicle(vehicle))

        if not vehicles:
            print(json.dumps({"ok": False, "error": "no matching vehicles on the account"}))
            return 0

        meta = {}
        if _meta_note:
            meta["note"] = _meta_note
        if enrolled_at:
            meta["tokenEnrolledAt"] = enrolled_at
        first = vehicles[0]
        if not first.get("last_updated_at") and not (first.get("data") or {}):
            meta["warning"] = (
                "Kia returned an empty state for this vehicle. Open the Kia app "
                "once to force a sync, or try again shortly."
            )
        print(json.dumps({"ok": True, "vehicles": vehicles, "meta": meta}))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
