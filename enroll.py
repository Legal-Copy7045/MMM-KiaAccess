#!/usr/bin/env python3
"""One-time OTP enrollment for MMM-KiaAccess (Kia USA and any region that
requires a one-time passcode on a new client).

Run it once, on the mirror, with the module's venv Python:

    echo '{"username":"you@example.com","password":"pw","pin":"1234",
           "region":"USA","brand":"KIA"}' \\
      | ~/MagicMirror/modules/MMM-KiaAccess/venv/bin/python3 enroll.py

It logs in, asks Kia to send you a code (SMS or email), you type it back, and
the resulting long-lived refresh token is written to `token.json` next to this
script. `kia_bridge.py` then reuses that token and refreshes it silently — no
more OTP until Kia expires the refresh token (months), at which point just run
this again.

Prompts are read from /dev/tty so the JSON job can still come in on stdin.
"""

import json
import os
import stat
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(HERE, "token.json")

REGION_INT = {
    "EU": 1, "EUROPE": 1, "CA": 2, "CANADA": 2, "US": 3, "USA": 3,
    "CN": 4, "CHINA": 4, "AU": 5, "AUSTRALIA": 5, "IN": 7, "INDIA": 7,
    "NZ": 8, "BR": 9, "BRAZIL": 9,
}
BRAND_INT = {"KIA": 1, "HYUNDAI": 2, "GENESIS": 3}


def tty():
    try:
        return open("/dev/tty", "r+")
    except OSError:
        return None


def ask(prompt, term):
    if term:
        term.write(prompt)
        term.flush()
        return term.readline().strip()
    # fallback: no controlling tty (shouldn't happen in normal use)
    return input(prompt).strip()


def main():
    try:
        job = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        print(f"Could not read the JSON job on stdin: {exc}", file=sys.stderr)
        return 2

    from hyundai_kia_connect_api import VehicleManager
    from hyundai_kia_connect_api.ApiImpl import OTPRequest
    from hyundai_kia_connect_api.const import OTP_NOTIFY_TYPE

    region = REGION_INT.get(str(job.get("region", "USA")).upper())
    brand = BRAND_INT.get(str(job.get("brand", "KIA")).upper())
    if region is None or brand is None:
        print("Unknown region or brand in job.", file=sys.stderr)
        return 2

    vm = VehicleManager(
        region=region,
        brand=brand,
        username=job["username"],
        password=job["password"],
        pin=str(job.get("pin", "")),
    )

    term = tty()
    result = vm.login()

    if result is True:
        print("No OTP required — login succeeded directly.")
    elif isinstance(result, OTPRequest):
        opts = []
        if result.has_sms:
            opts.append(("SMS", result.sms))
        if result.has_email:
            opts.append(("EMAIL", result.email))
        if not opts:
            print("Kia offered no OTP destination (no phone/email on file).", file=sys.stderr)
            return 1

        print("Kia needs a one-time code. Where should it be sent?")
        for i, (kind, dest) in enumerate(opts, 1):
            print(f"  {i}) {kind}  {dest or ''}")
        choice = ask(f"Choose 1-{len(opts)} [1]: ", term) or "1"
        try:
            kind = opts[int(choice) - 1][0]
        except (ValueError, IndexError):
            kind = opts[0][0]

        vm.send_otp(OTP_NOTIFY_TYPE(kind))
        print(f"Code sent via {kind}.")
        code = ask("Enter the code: ", term)
        if not code:
            print("No code entered.", file=sys.stderr)
            return 1
        vm.verify_otp_and_complete_login(code)
        print("OTP verified.")
    else:
        print(f"Unexpected login result: {result!r}", file=sys.stderr)
        return 1

    if not vm.token:
        print("Login finished but no token was produced.", file=sys.stderr)
        return 1

    with open(TOKEN_FILE, "w") as fh:
        json.dump(vm.token.to_dict(), fh, indent=2, default=str)
    try:
        os.chmod(TOKEN_FILE, stat.S_IRUSR | stat.S_IWUSR)  # 0600
    except OSError:
        pass

    names = ", ".join(sorted(vm.vehicles and (v.name for v in vm.vehicles.values()) or []))
    print(f"\nSaved {TOKEN_FILE}")
    if names:
        print(f"Vehicles: {names}")
    print("You can now start MagicMirror.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
