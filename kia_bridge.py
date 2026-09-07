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
import sys

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
    except Exception:  # noqa: BLE001
        print(json.dumps({
            "ok": False,
            "error": "hyundai_kia_connect_api is not installed. Run: "
                     "pip3 install hyundai_kia_connect_api",
        }))
        return 0

    region = REGION_INT.get(str(job.get("region", "USA")).upper())
    brand = BRAND_INT.get(str(job.get("brand", "KIA")).upper())
    if region is None:
        print(json.dumps({"ok": False, "error": f"unknown region {job.get('region')!r}"}))
        return 0
    if brand is None:
        print(json.dumps({"ok": False, "error": f"unknown brand {job.get('brand')!r}"}))
        return 0

    try:
        vm = VehicleManager(
            region=region,
            brand=brand,
            username=job["username"],
            password=job["password"],
            pin=str(job.get("pin", "")),
        )
        vm.check_and_refresh_token()

        want_refresh = job.get("refresh", True)
        if want_refresh:
            try:
                vm.check_and_force_update_vehicles(0)
            except AttributeError:
                vm.force_refresh_all_vehicles_states()
                vm.update_all_vehicles_with_cached_state()
        else:
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

        print(json.dumps({"ok": True, "vehicles": vehicles}))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
