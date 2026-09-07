# MMM-KiaAccess

A [MagicMirror²](https://magicmirror.builders/) module that shows **configurable**
data from a Kia Connect / Bluelink account. Built for a **Kia EV9 (Kia USA)** but works
with any Hyundai/Kia/Genesis supported by
[`hyundai_kia_connect_api`](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api).

The node helper runs a small Python bridge (`kia_bridge.py`) that pulls **every**
attribute the library exposes for your vehicle. The frontend flattens that into
`path → value` rows, and you choose exactly which ones appear, in what order, with what
labels and units.

> **Why a Python bridge and not a Node library?**
> Kia USA sits behind Cloudflare bot protection that returns **HTTP 403** to the Node
> `bluelinky` library. `hyundai_kia_connect_api` (the library behind the Home Assistant
> Kia/Hyundai integration) handles it and is actively maintained.

---

## Install

```bash
cd ~/MagicMirror/modules
git clone https://github.com/Legal-Copy7045/MMM-KiaAccess.git
cd MMM-KiaAccess
npm install          # runs setup_python.js: builds ./venv and installs the Python dep
```

Restart MagicMirror afterwards. `node_helper` automatically uses `./venv/bin/python3`.

### Python version

`hyundai_kia_connect_api` needs **Python ≥ 3.10** (current releases: 3.12+).
Anything older than 3.10 can only install v3.24.0, which **can no longer log in to
Kia USA**. Raspberry Pi OS *Bullseye* ships Python 3.9 — too old.

`setup_python.js` (run automatically by `npm install`) handles this:

1. Looks for the newest `python3.x` ≥ 3.10 — system, `pyenv`, or a previous download.
2. If none, on Linux it downloads a **self-contained CPython 3.12** from
   [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
   into `./python-standalone/` (no compiler, ~2 min; arm64 / armv7-hf / x86_64).
3. Builds `./venv` from whichever it found and installs the library.

So on a Pi 3.9 box you normally just run `npm install` and it sorts itself out.

| Situation | Result |
|---|---|
| system Python ≥ 3.12 | latest library, used directly |
| system Python 3.10 / 3.11 | library ≥ 3.24.1, used directly |
| system Python ≤ 3.9 (Linux) | standalone CPython 3.12 downloaded automatically |
| offline / download blocked | set `MMM_KIA_NO_DOWNLOAD=1`; install Python ≥ 3.10 yourself, then re-run |

Overrides (env vars): `MMM_KIA_PYTHON=/abs/path/python3` to force an interpreter,
`MMM_KIA_PBS_RELEASE=<tag>` to pin a different standalone release.
Or set `pythonBin` in the module config to an absolute path.

If venv creation fails on Debian/RPi OS: `sudo apt install python3-venv`.

### One-time OTP enrollment (Kia USA)

Kia USA requires a one-time passcode when a new client first logs in. Run the enrollment
script **once**, on the mirror, using the module's venv Python:

```bash
cd ~/MagicMirror/modules/MMM-KiaAccess
KIA_JOB='{"username":"you@example.com","password":"pw","pin":"1234","region":"USA","brand":"KIA"}' \
  ./venv/bin/python3 enroll.py
```

(Passing the details in `KIA_JOB` leaves the terminal free for the prompts and keeps the
password out of `ps`. `argv[1]` or stdin also work.)

It asks where to send the code (SMS / email), you paste the code back, and it writes
`token.json` (git-ignored, `chmod 600`) next to the script. `kia_bridge.py` then reuses
and silently refreshes that token — no more prompts until Kia expires the refresh token
(months away), at which point just run `enroll.py` again. If the module ever shows
*"OTP enrollment required"*, that's the signal.

## Configuration

```js
{
  module: "MMM-KiaAccess",
  position: "bottom_right",
  header: "Kia EV9",
  config: {
    // --- Kia Connect / Bluelink account ---
    username: "you@example.com",
    password: "••••••••",
    pin: "1234",
    brand: "KIA",            // KIA | HYUNDAI | GENESIS
    region: "USA",           // USA | CA | EU | AU | CN | IN | NZ | BR
    vin: "",                 // blank = first vehicle on the account

    // --- runtime ---
    pythonBin: "python3",    // command that runs kia_bridge.py
    fetchTimeout: 90,        // seconds before the bridge is killed

    // --- polling ---
    updateInterval: 30 * 60 * 1000,  // 30 min — see "Battery" note
    retryInterval: 5 * 60 * 1000,
    refresh: true,           // true = poll the car; false = Kia's cached copy
    units: "imperial",       // imperial | metric

    // --- which attributes to show ([] = show everything) ---
    include: [
      "vehicle.ev_battery_percentage",
      "vehicle.ev_battery_is_charging",
      "vehicle.ev_battery_is_plugged_in",
      "vehicle.ev_driving_range",
      "vehicle.ev_estimated_current_charge_duration",
      "vehicle.car_battery_percentage",
      "vehicle.odometer",
      "vehicle.is_locked",
      "vehicle.*_door_is_open",
      "vehicle.trunk_is_open",
      "vehicle.hood_is_open",
      "vehicle.air_control_is_on",
      "vehicle.tire_pressure_*",
      "vehicle.last_updated_at",
      "_meta.fetchedAt"
    ],
    exclude: ["vehicle.data.*", "vehicle.VIN"],
    order: ["vehicle.ev_*", "vehicle.odometer", "vehicle.*_door_*"],
    labels: {
      "vehicle.ev_battery_percentage": "Battery",
      "vehicle.ev_driving_range": "Range",
      "vehicle.ev_battery_is_charging": "Charging",
      "vehicle.ev_battery_is_plugged_in": "Plugged In",
      "vehicle.car_battery_percentage": "12V Battery",
      "vehicle.odometer": "Odometer",
      "vehicle.is_locked": "Locked",
      "vehicle.last_updated_at": "Car Last Reported",
      "_meta.fetchedAt": "Last Fetched"
    },
    formatters: {
      "vehicle.ev_battery_percentage": "percent",
      "vehicle.car_battery_percentage": "percent",
      "vehicle.ev_driving_range": "distanceKm",
      "vehicle.odometer": "distanceKm",
      "vehicle.ev_battery_is_charging": "boolean",
      "vehicle.ev_battery_is_plugged_in": "boolean",
      "vehicle.is_locked": "boolean",
      "vehicle.air_control_is_on": "boolean",
      "vehicle.last_updated_at": "relativeTime",
      "_meta.fetchedAt": "relativeTime"
    }
  }
}
```

### Discovering every available attribute

Set `include: []` and `exclude: []`, restart, and every attribute renders. Each row's
hover tooltip is its exact key path — copy the ones you want. Everything lives under
`vehicle.` (plus `_meta.`). The full raw API response is under `vehicle.data.*`.

Common EV9 (US) paths:

| Path | Meaning |
|---|---|
| `vehicle.ev_battery_percentage` | Drive battery state of charge (%) |
| `vehicle.ev_battery_soh_percentage` | Battery state of health (%) |
| `vehicle.ev_battery_is_charging` / `ev_battery_is_plugged_in` | Charging / plugged in |
| `vehicle.ev_driving_range` (+ `_unit`) | Estimated EV range |
| `vehicle.ev_charging_power` | Current charge rate (kW) |
| `vehicle.ev_estimated_current_charge_duration` | Minutes to target |
| `vehicle.ev_charge_limits_ac` / `ev_charge_limits_dc` | Charge target % |
| `vehicle.car_battery_percentage` | 12V battery (%) |
| `vehicle.odometer` (+ `odometer_unit`) | Mileage |
| `vehicle.is_locked` | Doors locked |
| `vehicle.front_left_door_is_open` … `back_right_door_is_open` | Individual doors |
| `vehicle.trunk_is_open` / `hood_is_open` | Trunk / frunk |
| `vehicle.*_window_is_open` | Windows |
| `vehicle.air_control_is_on` / `defrost_is_on` / `steering_wheel_heater_is_on` | Climate |
| `vehicle.air_temperature` / `outside_temperature` | Temperatures |
| `vehicle.tire_pressure_front_left` … `tire_pressure_rear_right` | Tyre pressures |
| `vehicle.tire_pressure_*_warning_is_on` | Tyre pressure warnings |
| `vehicle.location_latitude` / `location_longitude` | GPS |
| `vehicle.last_updated_at` / `last_scanned_at` | Freshness timestamps |
| `_meta.fetchedAt` | When this module last fetched |

## Config options

| Option | Default | Notes |
|---|---|---|
| `username` / `password` / `pin` | `""` | Kia Connect / Bluelink credentials. **Required.** |
| `brand` | `"KIA"` | `KIA` \| `HYUNDAI` \| `GENESIS` |
| `region` | `"USA"` | `USA` `CA` `EU` `AU` `CN` `IN` `NZ` `BR` |
| `vin` | `""` | Blank = first vehicle on the account |
| `pythonBin` | `"python3"` | Command used to run the bridge (`PYTHON` env var also works) |
| `fetchTimeout` | `90` | Seconds before the bridge process is killed |
| `updateInterval` | `1800000` | ms between fetches |
| `retryInterval` | `300000` | ms before retrying after an error |
| `refresh` | `true` | `true` wakes the car; `false` uses Kia's server cache (no battery cost) |
| `geocode` | `false` | resolve `vehicle.geocode` to a street address via OpenStreetMap |
| `units` | `"imperial"` | `"imperial"` or `"metric"` for distance/temp/speed formatters |
| `decimals` | `1` | rounding for numeric formatters |
| `nullText` | `"—"` | shown for `null` / `undefined` |
| `include` | `[]` | glob paths to show; empty = all |
| `exclude` | `["vehicle.data.*", "vehicle.VIN"]` | glob paths to hide |
| `hideWhenFalsy` | `[]` | glob paths whose row is dropped when the value is `false` / `0` / `null` / `""` / `"—"` (use for "only show when true / non-zero") |
| `order` | `[]` | glob paths shown first, in listed order |
| `labels` | `{}` | key path → display label |
| `formatters` | see defaults | key path → formatter name |
| `visuals.enabled` | `false` | master switch for the graphical widgets |
| `visuals.car` / `.battery` / `.rowIcons` | `true` | individual widget toggles (need `visuals.enabled`) |
| `visuals.width` | `210` | px width of the car SVG |
| `visuals.batteryDetail` | range + charge rate/current + 4 charge-time estimates | keys shown under the car and removed from the table |
| `icons` | `{}` | key path → Font Awesome class, overrides the built-in row-icon map |
| `showHeaderCount` | `true` | append attribute count to the header |
| `showUpdatedFooter` | `true` | show "updated HH:MM:SS" footer |
| `maxWidth` | `"420px"` | CSS max-width |
| `animationSpeed` | `500` | DOM update fade (ms) |
| `debug` | `false` | extra logging |

### Graphical mode

Set `visuals.enabled: true` to add pictorial widgets above the table. Each part
toggles independently:

```js
visuals: {
  enabled: true,
  car: true,          // top-down SUV diagram, front at the top (fixed size —
                      //   the car never moves or resizes between states)
  battery: true,      // a vertical battery in the centre of the car (terminal
                      //   to the front), filling bottom-up, coloured
                      //   green/amber/red, with the % inside and an animated
                      //   bolt when charging
  rowIcons: true,     // Font Awesome icon before every table row
  width: 210,         // px width of the car SVG
  batteryDetail: [    // readouts under the car (and removed from the table).
    "vehicle.ev_driving_range",              // Rendered with your labels /
    "vehicle.ev_charging_power",             // formatters, and hidden by
    "vehicle.ev_charging_current",           // hideWhenFalsy just like rows —
    "vehicle.ev_estimated_current_charge_duration",   // so the charge-time
    "vehicle.ev_estimated_fast_charge_duration",      // lines only appear
    "vehicle.ev_estimated_station_charge_duration",   // while actually
    "vehicle.ev_estimated_portable_charge_duration"   // charging
  ]
}
```

The car diagram:

- **lock state = body outline colour** — green (locked) / red (unlocked) / grey
  (unknown). There is no lock icon or text; drop the `is_locked` row from the
  table and let the outline carry it.
- **doors and tailgate** flash red and swing out when open; the **frunk** (a small
  box near the windscreen) just turns red.
- **headlights** solid white when on, hollow outline when off/unknown.
- **taillights** solid red when the car is running / in accessory mode
  (`engine_is_running` / `accessory_on` / `ign3` / `remote_ignition`), outline when off.
- **wheels** show a `!` on a per-tyre pressure warning (all four for the
  "all tyres" warning).
- **plugged in** → a wall-box + cable appear at the rear-right charge port.
  Charging: the port pulses green and particles flow charger → car. Exporting
  (`ev_v2l_status` / `ev_v2x_status`): the flow reverses in cyan. Plugged but
  idle: a static amber cable.

`ev_battery_percentage` and every `batteryDetail` key are dropped from the table
automatically so nothing is duplicated. The diagram always reads the real
`vehicle.*` values, so it stays complete even for rows you've hidden.

Row icons come from a built-in map (battery → battery, range → road, lock → lock,
charging → bolt, door → car-side, …) with keyword fallbacks. Override any of them:

```js
icons: {
  "vehicle.ev_battery_percentage": "fa-solid fa-bolt",
  "vehicle.geocode": "fa-solid fa-house"
}
```

### Formatters

`raw`, `boolean` (→ Yes/No), `percent`, `distanceKm`, `distanceMi`, `temperatureC`,
`speedKph`, `durationMin` (minutes → `2h 14m`), `datetime`, `relativeTime`.
Distance/temp/speed honour `units`.

### Glob syntax

`*` matches within one path segment, `**` across segments, `?` one char. A plain string
with no wildcard matches that exact path **or** anything beneath it.

## Notes

- **12V battery:** every `refresh: true` poll wakes the car. Kia's own app polls roughly
  every 30–60 min. Lower risks draining the 12V battery in cold weather. Use
  `refresh: false` for frequent updates from Kia's cache.
- Read-only: no lock/unlock/charge commands are exposed.
- Test the bridge directly:
  ```bash
  echo '{"username":"you@example.com","password":"pw","pin":"1234","region":"USA","brand":"KIA","refresh":false}' | python3 kia_bridge.py
  ```
- Trigger an immediate refresh from another module with
  `this.sendNotification("MMM_KIA_ACCESS_REFRESH")`.

## Tests

```bash
npm test
```

## Credits

- [`hyundai_kia_connect_api`](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api)
- Formatter/flatten design informed by [`bluelinky`](https://github.com/Hacksore/bluelinky)

## License

MIT
