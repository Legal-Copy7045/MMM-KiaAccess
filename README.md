# MMM-KiaAccess

A [MagicMirror²](https://magicmirror.builders/) module that shows **configurable** data
from a Kia Connect / Bluelink account. Built for a **Kia EV9** (US region) but works with
any Hyundai/Kia supported by [`bluelinky`](https://github.com/Hacksore/bluelinky).

The node helper fetches the *entire* vehicle payload (`status`, `rawStatus`, `odometer`,
`location`, optionally `fullStatus`) and the frontend flattens it to `path → value` rows.
You then decide exactly which attributes appear, in what order, with what labels and units.

![placeholder](https://via.placeholder.com/420x260?text=MMM-KiaAccess)

---

## Install

```bash
cd ~/MagicMirror/modules
git clone https://github.com/Legal-Copy7045/MMM-KiaAccess.git
cd MMM-KiaAccess
npm install
```

`npm install` pulls in `bluelinky`. Restart MagicMirror afterwards.

## Configuration

Add to `~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-KiaAccess",
  position: "top_left",
  header: "Kia EV9",
  config: {
    username: "you@example.com",   // Kia Connect account
    password: "••••••••",
    pin: "1234",                   // Kia Connect PIN
    brand: "kia",
    region: "US",                  // US | CA | EU | AU | KR
    vin: "",                       // optional; blank = first vehicle on the account

    updateInterval: 30 * 60 * 1000, // 30 min — see "Battery" note below
    refresh: true,                  // true = live poll of the car, false = Kia's cached copy
    units: "imperial",              // imperial | metric

    // Show only these (glob-friendly). Empty array = show everything.
    include: [
      "status.engine.batteryCharge",
      "status.engine.range",
      "status.engine.charging",
      "status.engine.plugedTo",
      "status.chassis.locked",
      "status.chassis.openDoors.*",
      "status.climate.*",
      "odometer.value",
      "status.lastupdate",
      "_meta.fetchedAt"
    ],

    exclude: ["rawStatus.*", "_meta.vin"],

    order: ["status.engine.*", "status.chassis.*", "odometer.*"],

    labels: {
      "status.engine.batteryCharge": "Battery",
      "status.engine.range": "Range",
      "status.engine.charging": "Charging",
      "status.engine.plugedTo": "Plugged in",
      "status.chassis.locked": "Locked",
      "odometer.value": "Odometer",
      "status.lastupdate": "Car last reported",
      "_meta.fetchedAt": "Module last fetched"
    },

    formatters: {
      "status.engine.batteryCharge": "percent",
      "status.engine.range": "distanceKm",
      "status.engine.charging": "boolean",
      "status.chassis.locked": "boolean",
      "status.climate.temperatureSetpoint": "temperatureC",
      "odometer.value": "distanceKm",
      "status.lastupdate": "relativeTime",
      "_meta.fetchedAt": "relativeTime"
    }
  }
}
```

### Discovering every available attribute

Set `include: []` (show everything) and `exclude: []` once. Every row's label tooltip
(hover) is its exact key path — copy the ones you want into `include` / `labels` /
`formatters`. Keys depend on region and vehicle; common EV9 (US) paths:

| Path | Meaning |
|---|---|
| `status.engine.batteryCharge` | Drive battery state of charge (%) |
| `status.engine.batteryCharge12v` | 12V battery (%) |
| `status.engine.charging` | Currently charging |
| `status.engine.range` | Estimated range (km, before unit conversion) |
| `status.engine.plugedTo` | Charge connector type |
| `status.climate.active` | HVAC running |
| `status.climate.temperatureSetpoint` | Climate setpoint |
| `status.climate.defrost` / `steeringwheelHeat` / `sideMirrorHeat` / `rearWindowHeat` | Heating features |
| `status.chassis.locked` | Doors locked |
| `status.chassis.hoodOpen` / `trunkOpen` | Hood / trunk open |
| `status.chassis.openDoors.frontLeft` … `backRight` | Individual door states |
| `status.chassis.tirePressureWarningLamp.*` | Tyre pressure warnings |
| `status.lastupdate` | When the car last reported to Kia |
| `odometer.value` / `odometer.unit` | Mileage |
| `location.latitude` / `location.longitude` / `location.speed` / `location.heading` | GPS |
| `_meta.fetchedAt` | When this module last pulled data |

## Config options

| Option | Default | Notes |
|---|---|---|
| `username` / `password` / `pin` | `""` | Kia Connect / Bluelink credentials. **Required.** |
| `brand` | `"kia"` | `"kia"` or `"hyundai"` |
| `region` | `"US"` | `US` `CA` `EU` `AU` `KR` |
| `vin` | `""` | Blank = first vehicle on the account |
| `updateInterval` | `1800000` | ms between fetches |
| `retryInterval` | `300000` | ms before retrying after an error |
| `refresh` | `true` | `true` polls the car directly; `false` uses Kia's server cache (no battery cost) |
| `loginTimeout` | `30` | seconds to wait for login |
| `units` | `"imperial"` | `"imperial"` or `"metric"` for distance/temp/speed formatters |
| `decimals` | `1` | rounding for numeric formatters |
| `nullText` | `"—"` | shown for `null` / `undefined` values |
| `include` | `[]` example populated | glob paths to show; empty = all |
| `exclude` | `["rawStatus.*", "_meta.vin"]` | glob paths to hide |
| `order` | `[]` | glob paths shown first, in listed order |
| `labels` | `{}` | key path → display label |
| `formatters` | see defaults | key path → formatter name |
| `showHeaderCount` | `true` | append attribute count to the header |
| `showUpdatedFooter` | `true` | show "updated HH:MM:SS" footer |
| `maxWidth` | `"420px"` | CSS max-width of the module |
| `animationSpeed` | `500` | DOM update fade (ms) |
| `debug` | `false` | extra logging |

### Formatters

`raw`, `boolean` (→ Yes/No), `percent`, `distanceKm`, `distanceMi`, `temperatureC`,
`speedKph`, `datetime`, `relativeTime`. Distance/temp/speed formatters honour `units`.

### Glob syntax

`*` matches within one path segment, `**` matches across segments, `?` matches one char.
A plain string with no wildcard matches that exact path **or** anything beneath it
(`status.chassis` matches `status.chassis.locked`).

## Notes

- **12V battery:** every `refresh: true` poll wakes the car. Kia's own app polls
  roughly every 30–60 min. Going lower risks draining the 12V battery, especially in
  cold weather. Use `refresh: false` for frequent updates from Kia's cache.
- **Credentials** live in `config.js`. `config.js` and `secrets.json` are git-ignored here.
- Control commands (lock/unlock/start charge) are intentionally **not** exposed — this
  module is read-only.
- Trigger an immediate refresh from another module with
  `this.sendNotification("MMM_KIA_ACCESS_REFRESH")`.

## Tests

```bash
npm test
```

## Credits

- [`bluelinky`](https://github.com/Hacksore/bluelinky) — Node Kia/Hyundai Connect client
- API behaviour cross-referenced with
  [`hyundai_kia_connect_api`](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api)

## License

MIT
