#!/usr/bin/env python3
"""One-time OTP enrollment for MMM-KiaAccess (Kia USA and any region that
requires a one-time passcode on a new client).

Run it once, on the mirror, with the module's venv Python. Pass the account
details in the KIA_JOB environment variable (keeps stdin free for the prompts
and keeps the password out of the process list):

    KIA_JOB='{"username":"you@example.com","password":"pw","pin":"1234",
              "region":"USA","brand":"KIA"}' \\
      ~/MagicMirror/modules/MMM-KiaAccess/venv/bin/python3 enroll.py

It logs in, asks Kia to send you a code (SMS or email), you type it back, and
the resulting long-lived refresh token is written to `token.json` next to this
script. `kia_bridge.py` then reuses that token and refreshes it silently — no
more OTP until Kia expires the refresh token (months), at which point just run
this again.

The job may also be given as argv[1] (a JSON string) or on stdin.
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


def open_tty():
    for mode in ("r+", "r"):
        try:
            return open("/dev/tty", mode)
        except OSError:
            continue
    return None


TERM = None


def ask(prompt):
    global TERM
    # 1) normal stdin if it's interactive
    if sys.stdin is not None and sys.stdin.isatty():
        try:
            return input(prompt).strip()
        except EOFError:
            pass
    # 2) the controlling terminal directly (stdin was a pipe)
    if TERM is None:
        TERM = open_tty()
    if TERM is not None:
        TERM.write(prompt)
        TERM.flush()
        line = TERM.readline()
        if line == "":
            raise SystemExit("\nNo input available on the terminal.")
        return line.strip()
    raise SystemExit(
        "\nThis script needs an interactive terminal for the OTP prompts.\n"
        "Run it directly (not piped) and pass the account details in KIA_JOB:\n"
        "  KIA_JOB='{...}' ./venv/bin/python3 enroll.py"
    )


def load_job():
    raw = os.environ.get("KIA_JOB")
    src = "KIA_JOB"
    if not raw and len(sys.argv) > 1:
        raw, src = sys.argv[1], "argv"
    if not raw and not sys.stdin.isatty():
        raw, src = sys.stdin.read(), "stdin"
    if not raw:
        raise SystemExit(
            "No account details given. Set KIA_JOB, e.g.:\n"
            "  KIA_JOB='{\"username\":\"you@example.com\",\"password\":\"pw\","
            "\"pin\":\"1234\",\"region\":\"USA\",\"brand\":\"KIA\"}' "
            "./venv/bin/python3 enroll.py"
        )
    try:
        return json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"Could not parse the JSON job ({src}): {exc}")


def main():
    job = load_job()

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
        choice = ask(f"Choose 1-{len(opts)} [1]: ") or "1"
        try:
            kind = opts[int(choice) - 1][0]
        except (ValueError, IndexError):
            kind = opts[0][0]

        vm.send_otp(OTP_NOTIFY_TYPE(kind))
        print(f"Code sent via {kind}.")
        code = ask("Enter the code: ")
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

    tok = vm.token.to_dict()
    tok["enrolled_at"] = __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc
    ).isoformat()
    with open(TOKEN_FILE, "w") as fh:
        json.dump(tok, fh, indent=2, default=str)
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
