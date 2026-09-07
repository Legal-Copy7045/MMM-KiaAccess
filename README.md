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

The newest `hyundai_kia_connect_api` (with current Kia USA Cloudflare handling)
requires **Python 3.12+**. `setup_python.js` picks the highest `python3.x` on your PATH:

| Your `python3` | What gets installed | Kia USA |
|---|---|---|
| 3.12 / 3.13 / 3.14 | latest (4.29+) | ✅ |
| 3.10 / 3.11 | 4.23.0 (pip auto-selects) | usually ✅ |
| ≤ 3.9 | nothing — pip finds no compatible release | ❌ |

Check with `python3 --version`. If it's < 3.12 and the module misbehaves, install a
newer Python and re-run `npm install`:

```bash
# Debian / Raspberry Pi OS, if python3.12 is in apt:
sudo apt install python3.12 python3.12-venv
# otherwise use pyenv:  https://github.com/pyenv/pyenv
#   pyenv install 3.12   &&   pyenv local 3.12
rm -rf venv && npm install
```

If venv creation fails: `sudo apt install python3-venv`.

To point at a specific interpreter, set `pythonBin` in config (e.g.
`pythonBin: "/home/pi/.pyenv/versions/3.12.8/bin/python3"`).

### First-login / OTP note (Kia USA)

Kia USA may demand a one-time code the first time a new client logs in. If you see an
`AuthenticationOTPRequired` error, log in once with the official Kia app on the same
account, then let the module retry. Persistent OTP prompts are a Kia-side change, not a
module bug.

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
| `units` | `"imperial"` | `"imperial"` or `"metric"` for distance/temp/speed formatters |
| `decimals` | `1` | rounding for numeric formatters |
| `nullText` | `"—"` | shown for `null` / `undefined` |
| `include` | `[]` | glob paths to show; empty = all |
| `exclude` | `["vehicle.data.*", "vehicle.VIN"]` | glob paths to hide |
| `order` | `[]` | glob paths shown first, in listed order |
| `labels` | `{}` | key path → display label |
| `formatters` | see defaults | key path → formatter name |
| `showHeaderCount` | `true` | append attribute count to the header |
| `showUpdatedFooter` | `true` | show "updated HH:MM:SS" footer |
| `maxWidth` | `"420px"` | CSS max-width |
| `animationSpeed` | `500` | DOM update fade (ms) |
| `debug` | `false` | extra logging |

### Formatters

`raw`, `boolean` (→ Yes/No), `percent`, `distanceKm`, `distanceMi`, `temperatureC`,
`speedKph`, `datetime`, `relativeTime`. Distance/temp/speed honour `units`.

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
