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
import logging
import os
import stat
import threading

_LOGGER = logging.getLogger(__name__)

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TOKEN_FILE = os.path.join(_HERE, "token.json")
# repo layout: <root>/core/commands.json ; HA vendored copy: alongside this file
COMMANDS_FILE = next(
    (p for p in (
        os.path.join(_HERE, "core", "commands.json"),
        os.path.join(_HERE, "commands.json"),
    ) if os.path.exists(p)),
    os.path.join(_HERE, "core", "commands.json"),
)

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


class CommandUnconfirmed(ClientError):
    """A control command's HTTP request timed out (or the car itself never
    answered) -- Kia's own protocol gives no ID-less way to ask afterward
    "did anything get queued for this vehicle?", so whether the command
    actually landed is genuinely unknown, not "failed". A subclass of
    ClientError so existing `except ClientError` callers keep working
    unchanged; callers that care about the distinction can catch this
    specifically to avoid treating a blind retry as safe."""


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

    # The library pairs each temperature / distance with the account's local
    # unit (°F + miles for USA & Canada) but stores the raw value — while every
    # downstream formatter (state.js, visuals.js, the HA sensors' device classes)
    # assumes °C / km. Normalise here, the one place both surfaces share.
    _F = ("F", "°F", "FAHRENHEIT")
    _MI = ("MI", "MILES", "MILE")
    for base in ("air_temperature", "outside_temperature"):
        unit = getattr(vehicle, "_" + base + "_unit", None)
        val = out.get(base)
        if isinstance(val, (int, float)) and not isinstance(val, bool) and \
                str(unit).strip().upper() in _F:
            out[base] = round((val - 32) * 5.0 / 9.0, 1)
    for base in (
        "odometer", "ev_driving_range", "total_driving_range",
        "fuel_driving_range", "next_service_distance", "last_service_distance",
    ):
        unit = getattr(vehicle, "_" + base + "_unit", None)
        val = out.get(base)
        if isinstance(val, (int, float)) and not isinstance(val, bool) and \
                str(unit).strip().upper() in _MI:
            out[base] = round(val * 1.609344, 1)
            if base + "_unit" in out:
                out[base + "_unit"] = "km"

    return out


def load_commands():
    with open(COMMANDS_FILE, encoding="utf-8") as fh:
        return json.load(fh).get("commands", [])


# ---------------------------------------------------------------------------
# token.json
# ---------------------------------------------------------------------------
def _load_token(token_file, Token, token_dict=None):
    """Prefer an inline token dict (HA config entry); fall back to token.json."""
    raw = None
    if isinstance(token_dict, dict) and token_dict:
        raw = token_dict
    elif token_file and os.path.exists(token_file):
        try:
            with open(token_file, encoding="utf-8") as fh:
                raw = json.load(fh)
        except Exception:
            raw = None
    if not raw:
        return None, None
    try:
        return Token.from_dict(raw), raw.get("enrolled_at")
    except Exception:
        return None, None


def token_dict(vm, enrolled_at=None):
    """Serialise vm.token for storage, keeping the original enrolment time."""
    if vm.token is None:
        return None
    tok = vm.token.to_dict()
    tok["enrolled_at"] = enrolled_at or datetime.datetime.now(
        datetime.timezone.utc
    ).isoformat()
    return tok


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
    except Exception as exc:  # noqa: BLE001
        # non-fatal (the caller already has a good fetch to hand back this
        # cycle) but must NOT be silent -- a failed rotation here means the
        # next run authenticates with a stale token and fails for a reason
        # that's invisible without this line.
        _LOGGER.warning("Kia Access: could not persist rotated token to %s: %s",
                         token_file, exc)


# ---------------------------------------------------------------------------
# connect
# ---------------------------------------------------------------------------
def _region_brand(job):
    region = REGION_INT.get(str(job.get("region", "USA")).upper())
    brand = BRAND_INT.get(str(job.get("brand", "KIA")).upper())
    if region is None:
        raise ClientError(f"unknown region {job.get('region')!r}")
    if brand is None:
        raise ClientError(f"unknown brand {job.get('brand')!r}")
    return region, brand


def make_manager(job, saved_token=None):
    """Build a VehicleManager without logging in (used by the HA OTP flow)."""
    try:
        from hyundai_kia_connect_api import VehicleManager
    except Exception as exc:
        raise ClientError(
            "hyundai_kia_connect_api is not installed."
        ) from exc
    region, brand = _region_brand(job)
    geocode = bool(job.get("geocode", False))
    return VehicleManager(
        region=region,
        brand=brand,
        username=job["username"],
        password=job["password"],
        pin=str(job.get("pin", "")),
        token=saved_token,
        geocode_api_enable=geocode,
        geocode_api_use_email=geocode,
    )


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

    region, brand = _region_brand(job)

    saved_token, enrolled_at = _load_token(token_file, Token, job.get("token"))
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

    # Persist the rotated token to token.json only for the file-based caller
    # (the MagicMirror bridge, which never puts a "token" key in the job). When
    # the caller manages the token itself (Home Assistant passes it in the job
    # and reads it back from fetch()'s meta["token"]), don't write anything into
    # the HACS-managed integration folder.
    if "token" not in job:
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
    _raw_to = job.get("forceRefreshTimeout", 45)
    timeout = float(_raw_to) if _raw_to is not None else 45.0
    # refresh:false (MM) or a zero/negative wake-up timeout (HA "Live wake-up
    # timeout = 0") both mean: don't wake the car, just read Kia's server cache.
    if job.get("refresh", True) and timeout > 0:
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
            # The background thread is still inside force_refresh_all_vehicles_
            # states(), which mutates `vm`'s vehicle objects in place -- reading
            # them now (update_all_vehicles_with_cached_state() + dump_vehicle()
            # below) would race an unsynchronized write from another thread on
            # the very same objects, up to and including a mid-iteration
            # RuntimeError. Fail this fetch cleanly instead: the caller
            # (coordinator.py / node_helper.js) already has a "keep serving the
            # last known good state" fallback for exactly this case, which is a
            # strictly better outcome than a torn/corrupted live read. The
            # orphaned thread finishes on its own (it's daemonized) against a
            # `vm` nothing else will ever touch again.
            raise ClientError(
                f"live wake-up timed out after {int(timeout)}s — will retry next cycle"
            )
        elif "e" in err:
            meta_note = f"live wake-up failed: {err['e']}"
    vm.update_all_vehicles_with_cached_state()

    selected = _select_vehicles(vm, job.get("vin", ""))
    if not selected:
        raise ClientError("no matching vehicles on the account")
    if not job.get("vin") and len(selected) > 1:
        # Reads used to silently fall back to "vehicle 1" here, same as the
        # control path used to before it was locked down (see run_command()).
        # Without an explicit VIN, which physical car that is can change
        # between polls (the account API's own vehicle order isn't
        # guaranteed stable) -- silently mixing two cars' data into one set
        # of entities/history/sessions/trips/alerts is worse than a clear,
        # one-time setup error asking for a VIN. Fail loudly instead of
        # guessing, for both callers of this shared function (MM and HA).
        raise ClientError(
            f"{len(selected)} vehicles on this account — set a VIN in the "
            "config to pick one (reads need an explicit target, same as "
            "control commands)"
        )
    vehicles = [dump_vehicle(v) for v in selected]

    meta = {}
    if meta_note:
        meta["note"] = meta_note
    if enrolled_at:
        meta["tokenEnrolledAt"] = enrolled_at
    # hand back the (possibly rotated) token so an in-process caller (HA) can
    # persist it; the MM bridge ignores this and relies on token.json
    tok = token_dict(vm, enrolled_at)
    if tok:
        meta["token"] = tok
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
    if not job.get("vin") and len(selected) > 1:
        # Reads can reasonably default to "vehicle 1" (see fetch()) -- a
        # remote command cannot. Without an explicit VIN, `selected[0]` is
        # whichever vehicle the account API happened to list first THIS
        # call, which is not guaranteed stable; sending lock/unlock/climate/
        # charge to an arbitrary, possibly-wrong physical vehicle is a real
        # safety issue, not just a data-quality one.
        raise ClientError(
            f"{len(selected)} vehicles on this account — set a VIN before "
            f"running '{name}' (control commands need an explicit target)"
        )
    vehicle_id = selected[0].id

    method = getattr(vm, spec["method"], None)
    if method is None:
        raise ClientError(
            f"hyundai_kia_connect_api has no '{spec['method']}' — library too old?"
        )

    opts = job.get("options") or {}
    opt_specs = spec.get("options") or {}
    call = spec.get("call", "bare")
    # options like start_climate's set_temp carry a region-specific "metric"
    # variant of default/min/max (see core/commands.json's $comment) --
    # everything else about the catalogue is region-agnostic, so only the
    # DEFAULT substitution needs this; an explicitly-passed value (e.g. from
    # the HA climate entity, which already converts correctly) is trusted
    # as-is and never reinterpreted here.
    fahrenheit = str(job.get("region", "USA")).upper() in ("USA", "CA")

    def _with_default(key):
        spec_for_key = opt_specs.get(key) or {}
        metric = spec_for_key.get("metric")
        if key in opts:
            val = opts[key]
            # Defense in depth for a region-ambiguous option (currently just
            # set_temp): the HA service schema's min/max is a UNION of both
            # regions' ranges (it can't be region-scoped, see core/commands.
            # json's $comment), so schema validation alone lets a Fahrenheit
            # value through to a metric vehicle and vice versa. The native
            # climate entity's build_climate_options() always sends an
            # already-correctly-converted value for THIS vehicle's region,
            # so it will never trip this; a raw/automation service call
            # sending the wrong region's value now gets a clear error
            # instead of silently reaching the vehicle wrong.
            if metric and isinstance(val, (int, float)) and not isinstance(val, bool):
                bounds = spec_for_key if fahrenheit else metric
                lo, hi = bounds.get("min"), bounds.get("max")
                if (lo is not None and val < lo) or (hi is not None and val > hi):
                    unit = bounds.get("unit") or ""
                    raise ClientError(
                        f"{key}={val!r} is outside the valid range for this "
                        f"vehicle's region ({lo}-{hi}{' ' + unit if unit else ''})"
                        " -- omit it to use the region's default"
                    )
            return val
        if not fahrenheit and metric:
            return metric.get("default")
        return spec_for_key.get("default")

    action_id = None
    try:
        # VehicleManager's control methods (lock/unlock/start_climate/...)
        # each return Kia's own server-issued job id ("Xid") for the
        # request -- previously discarded here. check_action_status(vehicle_
        # id, action_id) can later poll whether it actually completed; that
        # polling isn't wired up yet (Kia USA's implementation of it is a
        # weak one-shot check, not worth building on without more research),
        # but surfacing the id now means it's at least available for a
        # caller/log line to reference, rather than lost the moment this
        # function returns.
        if call == "climate_options":
            try:
                from hyundai_kia_connect_api.ApiImpl import ClimateRequestOptions
            except Exception as exc:  # noqa: BLE001
                raise ClientError(
                    "this hyundai_kia_connect_api version has no ClimateRequestOptions"
                ) from exc
            co = ClimateRequestOptions()
            for key in opt_specs:
                val = _with_default(key)
                if val is not None and hasattr(co, key):
                    setattr(co, key, val)
            action_id = method(vehicle_id, co)
        elif call == "positional":
            args = [_with_default(a) for a in spec.get("args", [])]
            action_id = method(vehicle_id, *args)
        elif call == "poi":
            action_id = method(vehicle_id, [_build_poi(opts)])
        else:
            action_id = method(vehicle_id)
    except ClientError:
        raise
    except NotImplementedError as exc:
        raise ClientError(
            f"'{name}' isn't available for this region yet "
            "(waiting on a hyundai_kia_connect_api implementation)"
        ) from exc
    except Exception as exc:  # noqa: BLE001
        # A request timeout (the HTTP call itself, or "the server fails to
        # establish a connection with the car" -- see the library's own
        # ApiImplSession, which wraps requests.exceptions.Timeout into
        # exactly this) means we genuinely don't know whether the command
        # reached the vehicle -- Kia's protocol has no ID-less way to check
        # afterward. That's categorically different from a clear rejection
        # (bad PIN, unsupported command, etc.), so it needs its own
        # exception type rather than a flat "failed", so a caller can avoid
        # treating an immediate blind retry as obviously safe.
        try:
            from hyundai_kia_connect_api.exceptions import RequestTimeoutError
        except Exception:  # noqa: BLE001
            RequestTimeoutError = ()  # noqa: N806 -- library too old to have it
        if RequestTimeoutError and isinstance(exc, RequestTimeoutError):
            raise CommandUnconfirmed(
                f"'{name}' request timed out -- Kia's servers may or may not "
                "have received it; the vehicle's actual state is unknown "
                "until its next status refresh"
            ) from exc
        raise ClientError(f"{spec['method']} failed: {type(exc).__name__}: {exc}") from exc

    return {"ok": True, "command": name, "vehicleId": vehicle_id, "actionId": action_id}


def _geocode(address):
    """address string -> (lat, lon, display_name) via OpenStreetMap Nominatim."""
    import json as _json
    import urllib.parse
    import urllib.request

    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": address, "format": "json", "limit": 1}
    )
    req = urllib.request.Request(url, headers={"User-Agent": "MMM-KiaAccess (kia_client)"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            rows = _json.load(resp)
    except Exception as exc:  # noqa: BLE001
        raise ClientError(f"geocoding failed for {address!r}: {exc}") from exc
    if not rows:
        raise ClientError(f"could not find a location for {address!r}")
    row = rows[0]
    return float(row["lat"]), float(row["lon"]), row.get("display_name") or address


def _build_poi(opts):
    """opts {name, address?, latitude?, longitude?} -> a POIInfo (geocoding the
    address when no explicit lat/lon is given)."""
    try:
        from hyundai_kia_connect_api.ApiImpl import POICoord, POIInfo
    except Exception as exc:  # noqa: BLE001
        raise ClientError(
            "this hyundai_kia_connect_api version has no POIInfo (send-to-car)"
        ) from exc

    lat = opts.get("latitude")
    lon = opts.get("longitude")
    addr = (opts.get("address") or "").strip()
    if lat is None or lon is None:
        if not addr:
            raise ClientError("send-to-car needs latitude + longitude, or an address")
        lat, lon, resolved = _geocode(addr)
        addr = addr or resolved
    return POIInfo(
        name=(opts.get("name") or "").strip() or addr or "Destination",
        addr=addr,
        coord=POICoord(lat=float(lat), lon=float(lon)),
    )
