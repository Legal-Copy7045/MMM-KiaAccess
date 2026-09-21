# Kia Access — one shared engine for Home Assistant **and** MagicMirror²

[![CI](https://github.com/Legal-Copy7045/MMM-KiaAccess/actions/workflows/ci.yml/badge.svg)](https://github.com/Legal-Copy7045/MMM-KiaAccess/actions/workflows/ci.yml)

## TL;DR

**Your Kia / Hyundai / Genesis, on Home Assistant and/or MagicMirror², from one
shared engine.** A HACS **Home Assistant integration** and a read-only
**MagicMirror² module**, both built from the same sensor / command / alert
definitions so they always agree. Works in every region
[`hyundai_kia_connect_api`](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api)
supports; built and tested on a Kia EV9 (Kia USA).

**Headline features**

- **Full state** — battery, range, charge, 12V, doors, windows, lock, plug,
  climate, tyres, odometer, service, GPS — as HA entities and/or a
  configurable table on the mirror.
- **Animated top-down car diagram** — every door / window / light / charge /
  climate / warning state at a glance, identical on both surfaces.
- **Remote control** (HA) — lock, climate / preconditioning, charge start-stop
  and limits, charge-port, flash / honk, as native `lock` / `climate` /
  `number` / `switch` / `select` entities.
- **Kinder to the 12V battery** — reads Kia's server-side cache by default;
  live wake-ups are opt-in and time-boxed.
- **Edge-triggered alerts** — left unlocked, door open, battery low, 12V drain,
  charge complete / interrupted, tow / theft, "can't get home" — as
  `kia_access_alert` events (HA) or on-screen notifications + webhook (mirror).
- **Range & reachability** — how far you can drive now, which places are in
  reach, arrival battery, and (with a routing key) real drive time + live
  traffic delay for calendar destinations, on an interactive map.
- **Charging & running costs** — per-session kWh + cost: separate home /
  public $ rates by geofence, or the real amount from a ChargePoint / Tesla
  integration; plus an automatic trip log
  with cost-per-mile, and a live "cost this charge" figure.
- **`device_tracker`** for HA maps, zones and presence automations.
- **Send-out** — MQTT (with HA MQTT-discovery), a per-event webhook, or
  InfluxDB / Prometheus, straight from the mirror.

### Pick a mode

| Mode | What runs | Car control | You need |
|---|---|---|---|
| **A — Home Assistant** | the HACS integration | ✅ | your Kia login; a one-time SMS/email code (Kia USA / CA) |
| **B — MagicMirror, standalone** | the module + a bundled Python bridge | – read-only | your Kia login + one-time code; Python ≥ 3.12 (auto-provisioned) |
| **C — MagicMirror, fed by Home Assistant** | HA polls the car; the mirror reads HA locally | ✅ via HA | mode A first, then a HA token on the mirror |

Home Assistant user → **A** (add a mirror later with **C**). Mirror only → **B**.
Both → **C** — the car is woken once, by HA; no Python or OTP on the mirror.

### Quick start

**A — Home Assistant** ([full steps](#a--home-assistant))
1. HACS → ⋮ → *Custom repositories* → add this repo, category **Integration** →
   Download → restart HA.
2. Settings → Devices & Services → **+ Add Integration → “Kia Access”** → enter
   your Kia login and region; paste the OTP when asked (Kia USA / CA).
3. Add the **Kia Access** dashboard card.

**B — MagicMirror, standalone** ([full steps](#b--magicmirror-only))
```bash
cd ~/MagicMirror/modules
git clone https://github.com/Legal-Copy7045/MMM-KiaAccess.git
cd MMM-KiaAccess && npm install        # builds ./venv + installs the Python dep
```
Then run the one-time OTP enrollment (`enroll.py`) and add the module block to
`~/MagicMirror/config/config.js`.

**C — MagicMirror, fed by Home Assistant** ([full steps](#c--magicmirror-fed-by-home-assistant))
Set up **mode A** first. Then `npm install` the module (as in B), create a HA
**long-lived access token**, and in `config.js` set `source: "homeassistant"`
with your HA URL + token. No Kia credentials, no OTP, no Python needed.

### Fresh readings vs. the 12V battery

The app can either **wake the car** for live data, or read the **cached values
Kia / Hyundai already hold** (default — which costs the car nothing in battery
power). Repeatedly waking a parked car flattens its 12V battery in the cold, so
cached reads are the safe default. If the live wake-up is selected, it is
time-boxed and falls back to the cache.
- **HA** — *Configure → Poll the car directly*: off (default) = cache only.
- **MagicMirror mode B** — `refresh: false` = cache. Mode C leaves this to HA.

---

## Supported vehicles

- **Brands** — Kia (Connect / UVO), Hyundai (Bluelink), Genesis
- **Regions** — USA, Canada, Europe, Australia, India, China, New Zealand, Brazil
- **Powertrains** — EV, PHEV, HEV, ICE. A gas-only vehicle doesn't get EV-only
  diagram parts or the "EV battery low" alert. Anything that means "has a
  plug" — the "home and not plugged in" alert, charging buttons,
  charge-limit sliders — is off for gas **and** for a conventional (non-plug)
  hybrid: Kia and Hyundai both sell an HEV alongside a PHEV version of the
  same car (Sportage/Sorento/Niro/Tucson/Santa Fe, etc.), and only the PHEV
  has a plug. A hybrid's trip log tracks distance but skips SOC-based
  efficiency/cost for any trip that may have run partly on gas (there's no
  way to attribute the split from the data the car reports).

Tested on a **Kia EV9 (Kia USA)** — other combinations use the same library but
are less battle-tested; [open an issue](https://github.com/Legal-Copy7045/MMM-KiaAccess/issues)
if something looks off. Kia USA / CA needs a **one-time OTP** (SMS / email code)
on first login — HA asks in the config flow, the mirror has `enroll.py`. The
Kia US / CA API reports °F / miles; the engine normalises to °C / km and the
formatters render your chosen units (climate set-point is sent in °F 62–82 for
USA, °C 16–30 elsewhere).

![Data flow for modes A, B and C](docs/data-flow.svg)

---

## What you get

### In Home Assistant (mode A / C)

- **Sensors & binary sensors** — battery %, range, charge rate / target, 12V,
  odometer, doors, lock, plug, climate, tyre warnings, next-service distance,
  battery health, valet mode, per-seat status, and everything else the car
  reports.
- **Native controls** — `lock`, `climate` (an HVAC entity), `number` (charge
  limits, climate run-time), `switch` (charging, defrost), `select` (seat / wheel
  heat), one-tap `button`s (lock / unlock, flash, charge port, start / stop
  charge, **refresh now** — force a live pull from Kia's servers on demand,
  even with "poll the car directly" off) and services (`start_climate` with
  seats, `set_charge_limits`, `send_to_car`).
- **`device_tracker.<v>_location`** — the car's GPS, so HA's map, zones and
  presence automations work natively.
- **Derived sensors**
  - **`Range reach`** — how far you can drive now (one-way / round-trip), which
    `zone.*` — plus calendar events and fixed addresses — are in reach, and the
    charge / kWh you'd arrive with. With a routing key: real road drive time, the
    roads taken, and a live traffic-delay figure.
  - **`Last trip`** / **`Cost per mile`** — from an automatic odometer-anchored
    trip log.
  - **`Observed range & efficiency`** — real-world mi/% (temperature- and
    speed-bucketed, plus a monthly trend), how far off Kia's own displayed
    range has actually run, home charging power by SoC band, and a driving
    usage profile — all from your own trip/charge history. Never claims
    "battery health" (the USA API has no true state-of-health).
  - **`Last charge`** / **`Charge session`** — kWh + cost per session, the live
    one climbing while charging.
  - **`Parked`** — where the car last parked, with map deep-links and distance
    from home.
  - **`binary_sensor.<v>_data_stale`** — a poll to Kia's cloud can succeed
    while just echoing back the car's own last-reported reading unchanged
    (asleep, poor signal); this turns on once that reading is older than
    `stale_after_minutes` (an option, default 60), with
    `last_reported` / `last_successful_update` / `data_age_minutes`
    attributes — so an automation can tell "current" apart from "old but
    technically successful," separately from the car's entities simply
    going unavailable when a poll actually *fails*.
- **`kia_access_alert` events** on the bus for every edge-triggered condition
  (battery low, unlocked, door open, charge complete / interrupted, 12V drain,
  tow / theft, can't-get-home, …) — for your automations.
- **Lovelace** — `custom:kia-access-card` (top-down car diagram + climate panel)
  and `custom:kia-range-map-card` (interactive reachable-area map).
- **Optional** — a drop-in ownership package (efficiency, seasonal range, lease
  tracker, maintenance countdown) and automation blueprints (calendar / weather
  preconditioning, phone alerts).

### On MagicMirror — standalone (mode B)

The mirror polls Kia directly through a bundled Python bridge. **Read-only** —
car control lives in the Home Assistant integration.

- The **animated car diagram** — every door / window / frunk / liftgate /
  sunroof / light / climate element / charge state / tyre warning, plus a
  warning triangle with reasons. The same SVG the HA card uses.
- A configurable **`key → value` table** — any attribute the car reports, with
  your own labels, units, formatters and order.
- **Widgets** (each opt-in) — battery gauge, charge-progress bar with "full at
  HH:MM" and a live running cost, SoC / 12V sparklines, range ring, trip stats,
  an auto trip log, an "observed range & efficiency" panel, a "how far can I
  drive" readout, a location map + a reachable-area image.
- **Edge-triggered notifications** — the same rules as HA's alerts, popped
  through MagicMirror's `alert` module and broadcast to other modules.
- **Push-out** — full state over **MQTT** (retained topics, optional HA
  discovery), a **webhook** (`POST` per event → Discord / Slack / a function), or
  **InfluxDB / Prometheus** export.

### On MagicMirror — fed by Home Assistant (mode C)

Everything in mode B — same diagram, table, widgets, notifications, MQTT /
webhook / exporter — but the data comes from your HA instance over the local
API, not from Kia. So:

- **Dropped** — Kia credentials, the Python bridge, the OTP enrollment, and the
  `refresh` / `forceRefreshTimeout` wake-vs-cache controls (HA owns that choice).
  The car is only ever woken by HA.
- **Added** — `source: "homeassistant"` plus a HA URL and long-lived token.
  `mode: "push"` streams state changes over a WebSocket the instant they happen.
- **Gained** — the **Driving-times panel**: your calendar destinations, fixed
  addresses and chosen zones, each with a live routed drive time, the roads, an
  ETA coloured by traffic delay, and the battery you'd arrive with. (Standalone
  mode only has a straight-line estimate over hard-coded `pois`.)
- **Not needed** — MQTT HA-discovery (you already have real entities) and the
  `otpExpiring` warning (no OTP on the mirror).

---

## Install & setup — in full

### A · Home Assistant

1. **Install the integration.** HACS → ⋮ → **Custom repositories** → add
   `https://github.com/Legal-Copy7045/MMM-KiaAccess`, category **Integration** →
   **Download** → **restart Home Assistant**.
   (Or copy `custom_components/kia_access/` into `config/custom_components/` and
   restart.)
2. **Add it.** **Settings → Devices & Services → + Add Integration → “Kia
   Access”**. Enter your Kia Connect / Hyundai Bluelink email / password / PIN
   and pick the region; enter the SMS or email **OTP** when prompted (Kia
   USA / CA). Tick *Reverse-geocode the parked location* if you want a street
   address for the car's position.
3. You now have one **device per vehicle** with all the entities, controls and
   events listed under [**What you get**](#what-you-get). **If your account has
   more than one vehicle**, one config entry only ever tracks one of them —
   after you sign in, a **"Choose a vehicle"** step appears automatically
   listing every car on the account (name, model, VIN); pick the one this
   entry should track. A single-vehicle account never sees this step — it's
   set up exactly as before. Run **+ Add Integration → "Kia Access"** again
   for each additional vehicle. Each vehicle's VIN uniquely identifies its
   config entry, so two entries for the same account (one per vehicle) can
   coexist — and the VIN is editable afterward too, in that entry's
   **Configure → VIN**, which (like the initial setup step) is a dropdown of
   whatever vehicles the account currently reports, not a box you type a VIN
   into — no risk of a fat-fingered VIN silently pointing an entry at the
   wrong car (or none). Every vehicle on one account shares a single Kia
   login/poll behind the scenes, so adding a second or third car's config
   entry doesn't multiply how much account-level API traffic Kia sees.
   A few notes:
   - `Last charge` / `Charge session` need a price — **Configure → Price per kWh**.
   - The **seat / wheel-heat `select`s and `Climate run time` are stored
     preferences**: there's no API to set them alone, so `climate.turn_on` and
     the `start_climate` button/service fold whatever they're set to into one
     call. Seat levels use `KiaUvoApiUSA` codes; other regions use the raw
     `start_climate` service.
   - `kia_access.send_to_car` (`name` + `address` or `latitude`/`longitude`),
     `kia_access.set_charge_limits`, `kia_access.refresh_calendar_destinations`
     and `kia_access.set_charge_cost` round out the services.
   - Commands the car or region doesn't support return a clear error.
4. **Add the dashboard card.** Edit a dashboard → **+ Add Card** → search “Kia
   Access”, or paste:
   ```yaml
   type: custom:kia-access-card
   # entity: sensor.<vehicle>_status   # optional; auto-detected otherwise
   # temperature_unit: F               # optional; "C" / "F" — otherwise follows HA
   # rows:                             # optional; picks which details-table rows
   #   - ev_battery_percentage         # show (an explicit allow-list, by `key` --
   #   - odometer                      # see core/entities.json for every key);
   #   - next_service_distance         # unset (the default) shows every populated
   #                                   # field, exactly as before this option existed
   ```
   The same bundle also provides **`custom:kia-range-map-card`** — an interactive
   map of how far you can drive (see [Location](#location--map)).
   The integration serves and auto-registers `/kia_access/kia-access-card.js`.

   **More than one vehicle on the account?** Leave `entity:` unset (the
   default) and the card shows a small vehicle dropdown next to the car's
   name — one card, switch between your cars, no extra config. It only
   appears once you actually have 2+ vehicles' worth of config entries; a
   single-vehicle setup looks exactly as before. Set `entity:` explicitly
   instead if you'd rather pin a card to one specific vehicle (e.g. one card
   per vehicle across different dashboard views). **Running more than one
   separate Kia Access *account* on the same Home Assistant instance** (not
   just more than one vehicle on one account)? The dropdown deliberately
   won't merge vehicles from different accounts together — it shows a
   message asking you to set `entity:` on each card instead, so a card never
   guesses which login's car to show.
   If the card doesn't show up, hard-refresh the browser, or add that path as a
   **Lovelace resource** (type: JavaScript Module) manually.

   The card has a **Climate panel**: a temperature stepper (shown in °C / °F per
   your HA unit system, or the `temperature_unit` option; sent to the car as °F),
   a run-time stepper, Defrost / Rear+mirrors / Heated-wheel toggles, and
   **Start climate** / **Stop** buttons. Your last settings are remembered in the
   browser. For a fixed one-tap warm-up, call `kia_access.start_climate` from a
   script or automation instead.

The integration's **Configure** dialog holds **Scan interval**, **Poll the car
directly** (+ **Live wake-up wait**), **Price per kWh** / **Away price per kWh**
/ **Home-charging zone** / **Per-zone charging rates** / **Away charge-cost
sensor** / **capacity**, **Range
reach factor** / **reserve %**, **Calendar entities** / **Calendar look-ahead
(hours)** / **Fixed destinations & zones**, and **Drive-time provider** / **Routing API key** / **Geocoding API
key** / **Per-destination routes**. Leave **Poll the
car directly** off (the default) to only ever read Kia's cached data and never
wake the car — with it off, every update sends both `refresh: false` **and**
`forceRefreshTimeout: 0`, either of which alone stops the wake (see the note at
the top of this README); turn it on for live readings, bounded by **Live
wake-up wait**. The rotated refresh token is stored in the config entry —
nothing is written into the HACS-managed folder.

**Ownership extras (optional):** [`examples/ha-ownership-package.yaml`](examples/ha-ownership-package.yaml)
is a drop-in HA package that adds an efficiency proxy, a seasonal-range
comparison (full-charge range now vs your 60-day best), a **lease-mileage
tracker** with an excess-mileage cost projection, and a **maintenance /
renewals countdown** with one-tap "done" buttons. Edit the entity prefix and
the lease block, drop it in `config/packages/`, restart.

**Automation blueprints (optional):** in [`blueprints/automation/kia_access/`](blueprints/automation/kia_access/) —
import each with **Settings → Automations → Blueprints → Import** and paste the
raw GitHub URL:

| Blueprint | What it does |
|---|---|
| `precondition_on_calendar.yaml` | warm/cool the car N minutes before a calendar event — plugged-in only |
| `precondition_on_weather.yaml` | at a set weekday time, cool if hot / warm+defrost if cold, else skip |
| `alert_to_phone.yaml` | every `kia_access_alert` → a phone push, quiet hours, re-notify criticals, Lock / Start-charge buttons |
| `notification_actions.yaml` | runs the Lock / Start-charge buttons (add once) |

**Testing `alert_to_phone` without waiting for a real alert:** call
**Developer Tools → Actions → `kia_access.test_alert`** — fires a fake
`kia_access_alert` event so you can check the notify target, quiet hours,
and the Lock / Start-charge action buttons (pick `unlocked` or
`charge_interrupted` for those) on demand. `active: false` sends the
matching "cleared" notification instead.

**What can start the climate / preconditioning?** Only: the card's **Climate
panel**, `button.<v>_stop_climate`, the `kia_access.start_climate` /
`stop_climate` services (Developer Tools, a script, an automation *you* wrote),
the `climate.<v>` entity (any automation / scene / voice that sets its mode or
temperature), the two **preconditioning blueprints** above if you imported
them, and the car's **own scheduled climate** set in the Kia app (the
integration only *shows* that, at `ev_first_departure_*`). The MagicMirror
module never sends commands. To make climate **manual-only**, tick
**Configure → Block automated climate**: `start_climate` / `stop_climate` are
then rejected unless the call came straight from a person (card, button,
Developer Tools, a hand-run script) — automations, scenes and the blueprints
get an error. It does not touch the car's own Kia-app schedule — turn that off
in the app.

### B · MagicMirror only

The module polls the Kia / Hyundai cloud directly through a small Python bridge
(`kia_bridge.py`).

```bash
cd ~/MagicMirror/modules
git clone https://github.com/Legal-Copy7045/MMM-KiaAccess.git
cd MMM-KiaAccess
npm install          # runs setup_python.js: builds ./venv and installs the Python dep
```

Then add to `~/MagicMirror/config/config.js` and restart MagicMirror:

```js
{
  module: "MMM-KiaAccess",
  position: "top_left",
  header: "Kia EV9",
  config: {
    username: "you@example.com",
    password: "••••••••",
    pin: "1234",
    brand: "KIA",            // KIA | HYUNDAI | GENESIS
    region: "USA",           // USA | CA | EU | AU | CN | IN | NZ | BR
    visuals: { enabled: true }
    // include / labels / formatters / notifications / mqtt — see Configuration
  }
}
```

Mode B needs two more things: a modern **Python** (auto-provisioned, below) and a
**one-time OTP** enrollment (Kia USA, below).

#### Python version (mode B)

`hyundai_kia_connect_api` requires **Python ≥ 3.12**. Older Python can only
install ancient releases that no longer log in to Kia. Many current OS
distributions still ship 3.11 or older by default, so `setup_python.js` (run
automatically by `npm install`) sorts it out:

1. Uses the system `python3` if it's ≥ 3.12 (or an earlier download, or `pyenv`).
2. Otherwise, **on Linux**, downloads a self-contained CPython 3.12 for your CPU
   architecture from
   [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
   into `./python-standalone/` — no compiler, ~2 min. The download's SHA-256 is
   checked against that release's own `SHA256SUMS` before anything is extracted;
   a mismatch discards the file and fails instead of silently installing it. On
   macOS / Windows without a new-enough Python it stops with instructions
   instead of downloading.
3. Builds `./venv` and installs `hyundai_kia_connect_api`, pinned in
   `requirements.txt` to an exact, tested version (not a floor/range) — bump it
   deliberately, in the same commit as `manifest.json`'s matching pin.

| Situation | Result |
|---|---|
| system Python ≥ 3.12 | used directly |
| Linux, system Python ≤ 3.11 | standalone CPython 3.12 downloaded automatically |
| macOS / Windows, system Python ≤ 3.11 | install Python ≥ 3.12 yourself, then re-run `npm install` |
| offline / download blocked | set `MMM_KIA_NO_DOWNLOAD=1`, install Python ≥ 3.12 yourself, re-run |

Overrides (env vars): `MMM_KIA_PYTHON=/abs/path/python3` to force an interpreter,
`MMM_KIA_PBS_RELEASE=<tag>` to pin a different standalone release. Or set
`pythonBin` in the module config to an absolute path.

If venv creation fails, install your OS's `python3-venv` package (on
Debian / Ubuntu: `sudo apt install python3-venv`).

#### One-time OTP enrollment (mode B, Kia USA / Canada)

Kia USA requires a one-time passcode when a new client first logs in. Run the enrollment
script **once**, on the mirror, using the module's venv Python:

```bash
cd ~/MagicMirror/modules/MMM-KiaAccess
KIA_JOB='{"username":"you@example.com","password":"pw","pin":"1234","region":"USA","brand":"KIA"}' \
  ./venv/bin/python3 enroll.py
```

(Passing the details in `KIA_JOB` leaves the terminal free for the prompts and keeps the
password out of `ps`. `argv[1]` or stdin also work.)

It asks where to send the code (SMS / email), you paste the code back, and it writes a
`token-<hash>.json` (git-ignored, `chmod 600`) next to the script, scoped to this
account so a second `enroll.py` run for a different Kia account never overwrites it.
`kia_bridge.py` then reuses and silently refreshes that token — no more prompts until
Kia expires the refresh token (months away), at which point just run `enroll.py` again
with the same `KIA_JOB`. If the module ever shows *"OTP enrollment required"*, that's
the signal.

Running two Kia accounts (two module blocks, or one rotating through vehicles on two
different accounts)? Run `enroll.py` once per account, each with that account's own
`KIA_JOB` — no extra configuration needed, each gets its own token file automatically.

### C · MagicMirror fed by Home Assistant

Do **mode A first** so Home Assistant is polling the car. Then the module reads
from HA over the local REST API — **no Kia credentials, no OTP, no Python bridge
on the mirror**, and the car is only ever woken by HA.

```bash
cd ~/MagicMirror/modules
git clone https://github.com/Legal-Copy7045/MMM-KiaAccess.git
cd MMM-KiaAccess
npm install
```

(`npm install` still builds the Python venv via `postinstall`; it's unused in
this mode and harmless. Set `MMM_KIA_NO_DOWNLOAD=1` to skip the download.)

In Home Assistant: your profile → **Security → Long-Lived Access Tokens →
Create Token**. Then in `~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-KiaAccess",
  position: "top_left",
  header: "Kia EV9",
  config: {
    source: "homeassistant",
    homeassistant: {
      url: "http://homeassistant.local:8123",   // or http://<ha-ip>:8123
      token: "<the long-lived access token>",
      entity: "sensor.my_ev9_status",            // optional; Developer Tools → States → filter your car
      mode: "push"                               // "push" (default) | "poll" — see below
    },
    visuals: { enabled: true }
    // include / labels / formatters / notifications / mqtt all work exactly as in mode B
  }
}
```

Check it before restarting MagicMirror (this runs the exact code path the module
uses):

```bash
cd ~/MagicMirror/modules/MMM-KiaAccess
node -e "require('./ha_source.js').fetchFromHA({url:'http://homeassistant.local:8123',token:'<token>',entity:'sensor.my_ev9_status'}).then(r=>console.log(JSON.stringify(r._meta,null,2))).catch(e=>console.error('FAIL:',e.message))"
```

Good output: `{ "source": "homeassistant", "haEntity": "…", … }`. The vehicle
values may be `null` until the car's first Kia sync — that only means the
connection works. A `FAIL:` line gives the exact reason (bad token, wrong URL,
entity not found).

From here the module behaves as in mode B — see
[What you get → fed by Home Assistant](#on-magicmirror--fed-by-home-assistant-mode-c)
for the short list of differences.

**How it stays current** — `homeassistant.mode`:

- **`"push"` (default)** — opens one persistent WebSocket to HA and gets
  `state_changed` events pushed the instant they happen (0 s lag). Needs
  **Node ≥ 22** for the built-in `WebSocket`; on older Node it automatically
  falls back to polling. `updateInterval` here is just a slow liveness/fallback
  check — defaults to **5 min**.
- **`"poll"`** — plain REST reads every `updateInterval`, which defaults to
  **30 s** in this mode. Use it if the WebSocket can't reach HA (proxy, auth
  quirk) or you're on older Node.

Either way the module only re-renders / re-checks conditions / writes its disk
cache when the data actually changed, so a fast rate costs almost nothing.

## MagicMirror module — configuration

> Everything from here to [Home Assistant — reference](#home-assistant--reference)
> is the **MagicMirror module** (modes B and C). Home Assistant's own settings
> live in its **Configure** dialog, not here. In mode C, drop
> `username` / `password` / `pin` and add the `source` / `homeassistant` block
> shown above; everything else below is the same.

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
    vin: "",                 // blank = fine for a single-vehicle account; required if you have more than one

    // --- multiple cars on one account (optional) ---
    // Two ways to show more than one vehicle:
    //  1. Add this module more than once, each with its own `vin:` above --
    //     every car gets its own fixed position on screen.
    //  2. Leave `vin:` blank and list every car here instead -- ONE module
    //     instance rotates through them on screen (each still gets its own
    //     isolated trip/charge-session history, exactly like option 1 does):
    // vehicles: [
    //   { vin: "5XY...", header: "My EV9" },
    //   { vin: "KND..." }            // header optional -- falls back to the car's own name
    // ],
    // vehicleRotateInterval: 20 * 1000,  // how long each vehicle stays on screen
    // Kia USA accounts: the account's own API never reports a car's real
    // VIN at all (a hyundai_kia_connect_api limitation, not this module's),
    // so `vin:` here must be the vehicle's own internal id instead -- if a
    // configured vehicle never shows up, check the log for a warning
    // naming exactly what each of the account's vehicles' id/VIN actually
    // is, and use that value.

    // --- runtime ---
    pythonBin: "python3",    // command that runs kia_bridge.py
    fetchTimeout: 90,        // seconds before the bridge is killed

    // --- polling ---
    updateInterval: 30 * 60 * 1000,  // 30 min (mode C default: 5 min / push)
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

Common paths (examples below are from a Kia EV9 on Kia USA; your car's set
depends on its brand, region and powertrain):

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
| `vehicle.next_service_distance` | Distance until the next service |
| `vehicle.ev_battery_precondition_enabled` | Winter battery preconditioning on |
| `vehicle.valet_mode_active` | Valet mode engaged |
| `vehicle.is_locked` | Doors locked |
| `vehicle.front_left_door_is_open` … `back_right_door_is_open` | Individual doors |
| `vehicle.trunk_is_open` / `hood_is_open` | Trunk / frunk |
| `vehicle.*_window_is_open` | Windows |
| `vehicle.air_control_is_on` / `defrost_is_on` / `steering_wheel_heater_is_on` | Climate |
| `vehicle.air_temperature` / `outside_temperature` | Climate set-point / outside temp — always normalised to °C (the Kia US/CA API reports °F); the `temperatureC` formatter and the diagram then show °C or °F per `units` |
| `vehicle.odometer`, `ev_driving_range`, `total_driving_range`, `next_service_distance` | Distances — always normalised to km (the Kia US/CA API reports miles); `distanceKm` / the HA `distance` device class then show mi or km |
| `vehicle.tire_pressure_front_left` … `tire_pressure_rear_right` | Tyre pressures |
| `vehicle.tire_pressure_*_warning_is_on` | Tyre pressure warnings |
| `vehicle.location_latitude` / `location_longitude` | GPS |
| `vehicle.last_updated_at` / `last_scanned_at` | Freshness timestamps |
| `_meta.fetchedAt` | When this module last fetched |

## Config options

| Option | Default | Notes |
|---|---|---|
| `source` | `"kia"` | `"kia"` = poll Kia directly (mode B). `"homeassistant"` = read from the native integration (mode C) |
| `homeassistant.url` | `""` | mode C only — e.g. `http://homeassistant.local:8123` |
| `homeassistant.token` | `""` | mode C only — a HA long-lived access token |
| `homeassistant.entity` | `""` | mode C only — the `…_status` summary sensor; auto-detected when blank |
| `homeassistant.mode` | `"push"` | mode C only — `"push"` (live WebSocket, Node ≥ 22) or `"poll"` (REST every `updateInterval`) |
| `username` / `password` / `pin` | `""` | Kia Connect / Bluelink credentials. **Required for mode B**; not used when `source: "homeassistant"` |
| `brand` | `"KIA"` | `KIA` \| `HYUNDAI` \| `GENESIS` (mode B) |
| `region` | `"USA"` | `USA` `CA` `EU` `AU` `CN` `IN` `NZ` `BR` (mode B) |
| `vin` | `""` | Blank is fine for a single-vehicle account; **required** if the account has more than one — which physical car "first" means isn't guaranteed stable between polls, so the bridge refuses rather than silently mixing two cars' data (mode B) |
| `pythonBin` | `"python3"` | mode B — command used to run the bridge (`PYTHON` env var also works) |
| `fetchTimeout` | `90` | Seconds before the bridge process is killed |
| `updateInterval` | `1800000` | ms between fetches. **Mode C** default: `300000` (push — fallback poll) or `30000` (poll) |
| `retryInterval` | `300000` | ms before retrying after an error (**mode C** default: `30000`) |
| `refresh` | `true` | `true` wakes the car; `false` uses Kia's server cache (no battery cost). Use `false` for a **brand-new car that hasn't synced yet** |
| `forceRefreshTimeout` | `45` | seconds to wait for the `refresh: true` wake-up before falling back to Kia's cached copy for that poll. `0` = never wake the car (same as `refresh: false`) |
| `backoffMax` | `8` | cap the post-failure exponential backoff at `retryInterval × this` |
| `maxRequestsPerHour` | `0` | `0` = no cap; otherwise pause fetches once the cap is hit (protects the account) |
| `historyDays` | `60` | days of SoC / 12V history kept on disk (`cache/`) for the sparkline + drain alert |
| `historyMinIntervalMinutes` | `30` | don't record history samples closer together than this |
| `otpLifetimeDays` | `30` | assumed Kia refresh-token lifetime, used for the expiry warning |
| `otpWarnDays` | `7` | start showing "OTP expires in N days" this far out |
| `geocode` | `false` | resolve `vehicle.geocode` to a street address via OpenStreetMap |
| `units` | `"imperial"` | `"imperial"` or `"metric"` for distance/temp/speed formatters |
| `decimals` | `1` | rounding for numeric formatters |
| `nullText` | `"—"` | shown for `null` / `undefined` |
| `include` | `[]` | glob paths to show; empty = all |
| `exclude` | `["vehicle.data.*", "vehicle.VIN"]` | glob paths to hide |
| `hideWhenFalsy` | `[]` | glob paths whose row is dropped when the value is `false` / `0` / `null` / `""` / `"—"` (use for "only show when true / non-zero"). Set to `"*"` to drop **every** empty row — keeps the table tidy before the car's first sync |
| `order` | `[]` | glob paths shown first, in listed order |
| `combine` | `{}` | `{ primaryKey: [otherKey, …] }` — fold the other rows onto the primary one as a `"value · value"` suffix (e.g. `{ "vehicle.geocode": ["vehicle.location_last_updated_at"] }` → one `Location: address · 5 min ago` line). The folded keys never render as their own rows; if the primary is also empty the whole row is dropped |
| `labels` | `{}` | key path → display label |
| `formatters` | see defaults | key path → formatter name |
| `visuals.enabled` | `false` | master switch for the graphical widgets |
| `visuals.car` / `.battery` / `.rowIcons` | `true` | individual widget toggles (need `visuals.enabled`) |
| `visuals.width` | `210` | px width of the car SVG (base size) |
| `visuals.scale` | `1` | multiplies the whole visuals block — diagram, its fonts, the sparklines / ring and the readout text. `1.3` = 130%. Clamped 0.5–3 |
| `visuals.compact` | `false` | one-line summary (`78% · 312 mi · 🔒`) instead of the diagram + table |
| `visuals.chargeProgress` | `true` | progress bar + `2h 45m → full at HH:MM` while plugged in |
| `visuals.rangeRing` | `false` | radial SoC / range gauge under the car |
| `visuals.socHistory` | `false` | EV-battery-% sparkline (`visuals.socHistoryDays`, default 14) |
| `visuals.v12History` | `false` | 12V-battery-% sparkline (`visuals.v12HistoryDays`, default 14) — spot vampire drain |
| `visuals.tripStats` | `false` | distance / consumption / regen from `month_trip_info` |
| `visuals.location` | `{ enabled:false }` | "N mi from home" + address, optional static `map`, and a `reach:true` "how far can I drive" readout (`reachFactor` / `reachReservePct` / `reachRoundTrip` / `pois`) — see [Location](#location--map) |
| `visuals.chargeCost` | `{ enabled:false }` | `pricePerKwh` / `currency` / `capacityKwh` power the live "cost this charge" line. `enabled:true` = est-to-target line; `log:true` = charge-session history widget (`logRows` 4, `logMonths` 3, `logRetentionDays` 180). `awayPricePerKwh` (with `location.homeLat/homeLon` set) costs sessions started away from home at a separate rate; `zoneRates` (`[{name,lat,lon,radiusKm,pricePerKwh}]`) gives a per-charger rate checked first; the log marks 🏠 / 📍 and splits the total |
| `visuals.tripLog` | `{ enabled:false }` | auto-detected drives (odometer delta + SoC drop): distance, **mi/kWh**, and cost per trip + a rolling total (`days` 30, `rows` 4). Uses `chargeCost.pricePerKwh` / `capacityKwh` for the £/kWh maths. HA side: `sensor.<v>_last_trip` + `sensor.<v>_cost_per_mile` |
| `visuals.analytics` | `{ enabled:false }` | **Observed range & efficiency** — real-world mi/% (or km/%, temperature- and speed-bucketed, plus a monthly trend), how far off Kia's own displayed range has actually run, home charging power by SoC band, and a trips/week usage profile — all derived from your own trip/charge history, never claiming "battery health" (the USA API has no true state-of-health). HA side: `sensor.<v>_observed_range` |
| `visuals.drivingTimes` | `{ enabled:false }` | standalone **Driving times** panel — destination, live drive time, `via <roads>`, ETA coloured by traffic delay (`delayStops`), calendar time + arrival battery. `source: "homeassistant"` only; reads `sensor.<v>_range_reach`. `max` 8, `order` "grouped", `zones` (panel-only whitelist / `-exclude`), `showVia`, `showConsumption` |
| `visuals.batteryDetail` | range + charge rate/current + 4 charge-time estimates | keys shown under the car and removed from the table |
| `icons` | `{}` | key path → Font Awesome class, overrides the built-in row-icon map |
| `notifications.enabled` | `false` | emit edge-triggered `KIA_ACCESS_STATE_CHANGED` / `alert` on state changes — see [Notifications](#notifications-state-changes) |
| `notifications.webhook` | `{ enabled:false }` | HTTP `POST` per event to `url` (`method` / `headers` / `events` / `levels` / `includeState` / `timeoutMs`) — see [Webhook](#webhook-http-post-per-event) |
| `notifications.alertSeconds` | `15` | seconds a **warning** `alert` stays before auto-dismissing |
| `notifications.criticalAlertSeconds` | `0` | **critical** `alert`: `0` = centre popup that stays until the condition clears; `>0` = corner growl that auto-dismisses after N s |
| `mqtt.enabled` | `false` | publish full state to retained MQTT topics — see [MQTT](#mqtt-state-publishing) |
| `showHeaderCount` | `true` | append attribute count to the header |
| `showUpdatedFooter` | `true` | show "updated HH:MM:SS" footer (when *we* last fetched) |
| `showReportedInHeader` | `false` | append `" - as of: <time>"` to the header from `vehicle.last_updated_at` (when the *car* last reported) and drop that row from the table. Shows `14:32` for today, `Sep 7 14:32` otherwise |
| `showTable` | `true` | `false` drops the details table entirely — the diagram + widgets carry the state. `visuals.batteryDetail` (Range, charge times…) still renders under the car |
| `maxWidth` | `"420px"` | CSS max-width |
| `animationSpeed` | `500` | fade (ms) when the module re-renders; **`0` = no fade**. The module only re-renders when the data changed, so at rest there's no fade regardless |
| `debug` | `false` | extra logging |

### Graphical mode

Set `visuals.enabled: true` to add pictorial widgets above the table. Each part
toggles independently:

```js
visuals: {
  enabled: true,
  car: true,          // top-down SUV diagram, front at the top (fixed size —
                      //   the car never moves or resizes between states)
  battery: true,      // a small vertical battery toward the rear of the cabin
                      //   (terminal to the front), filling bottom-up, coloured
                      //   green/amber/red, % shown underneath, animated bolt
                      //   when charging
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
- **doors** swing out ~50° and pulse red when open. A **window** open with the
  door shut leaves the door in place and pulses it red.
- **frunk** (small box by the windscreen) and the **SUV liftgate** (rear window +
  tailgate as one block) turn red / pulse when open.
- **sunroof** — a panel outline on the roof: grey shut, pulsing red outline open.
- **headlights** solid white when on, hollow outline when off/unknown.
- **taillights** solid red when the car is running / in accessory mode
  (`engine_is_running` / `accessory_on` / `ign3` / `remote_ignition`), outline when off.
- **defrost** (`defrost_is_on`) → orange element lines on the windscreen *and* the
  liftgate; **rear-window heater** (`back_window_heater_is_on`) → lines on the
  liftgate only. **Mirror heater** (`side_mirror_heater_is_on`) → the mirrors glow
  orange. **Steering-wheel heater** (`steering_wheel_heater_is_on`) → an orange
  ring in the driver's area.
- **air conditioning** (`air_control_is_on`) → four air streams from a front vent
  bar: **orange when heating, cyan when cooling** (inferred from `air_temperature`
  vs `outside_temperature`), neutral white when the direction is unknown. While
  climate is on the **set-point** (`air_temperature`) prints above the airflow.
- **outside temperature** (`outside_temperature`) → a small thermometer + reading
  in the top-left margin, always shown when the value is present.
- **12V battery** (`car_battery_percentage`) → a lead-acid battery icon in the
  front-left nose with the charge % inside, coloured green / amber / red.
- **find the car** — after a `flash_lights` / `find_car` command all four lamps
  pulse amber five times.
- **wheels** show a `!` on a per-tyre pressure warning (all four for the
  "all tyres" warning).
- **warning triangle** → a pulsing triangle in the front-right margin whenever
  any `warning`- or `critical`-level condition is active — **red** if anything is
  critical, **amber** otherwise — with the **reason(s) centred under it** (`Tyre`,
  `12V low`, `Door`, `Service`, … up to three, then `+N more`). The viewBox
  widens for the text while it's showing (the car stays the same size).
  Independent of whether `notifications` are on.
- **plugged in** → a wall-box + cable appear at the rear-right charge port.
  Charging: the port pulses green, particles flow charger → car, and the
  **kW being drawn** (`ev_charging_power`) + **current in amps**
  (`ev_charging_current`) print under the wall box — only while actually
  charging, and each line only when its value is present. Some cars (Kia USA)
  report kW but never a current; for AC charging (up to 19.2 kW) the amps are
  then estimated from the kW at 240 V — or 120 V below 3 kW, a Level 1
  trickle charge — and shown with a `~` (e.g. `~46A`). A current the car does
  report is always shown as-is, DC included. DC fast charging (above 19.2 kW)
  with no reported current shows kW only. Exporting
  (`ev_v2l_status` / `ev_v2x_status`): the flow reverses in cyan. Plugged but
  idle: a static amber cable, no readout.

**Anything a widget already shows is dropped from the table automatically** so
nothing is said twice — with `visuals.battery` on: `ev_battery_percentage` +
every `batteryDetail` key; with `visuals.car` on: `is_locked`,
`car_battery_percentage`, `air_temperature`, `outside_temperature`. You don't
need to list these in `exclude`. The diagram always reads the real `vehicle.*`
values, so it stays complete even for rows that never appear in the table.

#### Every state, visually

Every diagram state and every optional widget:

![Car diagram states and widgets](docs/car-states.png)

Open [`docs/car-states.html`](docs/car-states.html) for the same gallery with the
animations playing.

#### Extra widgets

Each is off by default and stacks under the car:

- **`compact`** — replaces everything with one line: `78% · 312 mi · 🔒 · ⚡ 7.4 kW`.
- **`chargeProgress`** — while plugged in, a bar (current + target) and either
  `2h 45m → full at 06:40` (or `→ 80%` for a sub-100 target) or "Plugged in,
  not charging". With `chargeCost.pricePerKwh` set it also shows a **live running
  cost** — `$1.85 this charge · 10.0 kWh` — that climbs (re-rendered every 30 s,
  extrapolated from the last kW between polls).
- **`rangeRing`** — a radial gauge: SoC on the ring, range in the centre.
- **`socHistory`** / **`v12History`** — battery-% sparklines (EV and 12V) over the
  last N days, from the history the helper keeps on disk. `v12History` is the one
  to watch for a slow parasitic drain.
- **`tripStats`** — this month's distance / average consumption / regen.
- **`chargeCost`** — `{ pricePerKwh: 0.185, currency: "$", capacityKwh: 99.8 }`.
  `enabled: true` adds the one-line "Est. cost to 80%: $6.40" while charging.
  `log: true` adds a **charge-session history** widget — the last `logRows` (4)
  sessions with kWh + cost, and a rolling `logMonths` (3) total. Sessions are
  detected from plug-in → unplug, stored on disk (`logRetentionDays`, 180).
  `capacityKwh` falls back to `ev_battery_capacity`, then 99.8 (EV9).
  **Home vs public rates** — set `awayPricePerKwh` and, in
  `visuals.location`, `homeLat` / `homeLon` (+ optional `homeRadiusKm`, 0.2):
  a session that *starts* outside that radius is costed at the away rate and
  marked 📍 in the log (home sessions 🏠), and the monthly total splits into
  home / away lines. Leave `homeLat` / `homeLon` unset and every session uses
  the home rate. (HA: **Away price per kWh** + **Home-charging zone** options;
  `sensor.<v>_last_charge` gets a `location` attr and `month_home_cost` /
  `month_away_cost`.)
  **Per-charger rates** — for a different price at each charger, set
  `chargeCost.zoneRates` to a list of `{ name, lat, lon, radiusKm, pricePerKwh }`
  (MM) or the **Per-zone charging rates** option — one `zone.work = 0.19` per
  line (HA). A session that starts inside a listed zone is costed at that rate
  and filed under the zone's name (first match wins); a line named `home` keeps
  its sessions in the home bucket, anything else counts as away. Zones fall back
  to the away rate, then the home rate.

**Real public-charging costs (Home Assistant).** The away $/kWh rate is an
estimate. To use what you actually paid:

- **Auto** — set **Configure → Away charge-cost sensor** to any sensor whose
  value is the cost of your latest public session (a **ChargePoint** or
  **Tesla** HA integration exposes one). When an away session ends and that
  sensor reported a figure within the session's window (+ **Away cost grace**,
  90 min, for a bill that posts late), it becomes the session's `cost` — the
  rate estimate is kept as `estimated_cost`, and `cost_source` reads
  `external`. Nothing installed for that network? Add a `template` sensor.
- **By hand** — `kia_access.set_charge_cost` with `cost:` (and optional
  `started_at:` from `sensor.<v>_last_charge` → `started_at_ms`; omit for the
  most recent). `cost_source` becomes `manual`.

A **preconditioning schedule** is shown automatically whenever one is set on the
car (`ev_first_departure_enabled`) — "Departure 07:00 · Mon–Fri · preheat 21°".

- **`drivingTimes`** — a standalone **Driving times** panel: each destination
  with its live drive time, the route (`via I-95 · Main St`), an ETA
  **coloured by traffic delay**, the calendar event time, and the battery
  you'd **arrive with**. Needs `source: "homeassistant"` and the integration's
  **Calendar entities** / **Fixed destinations & zones** / **Drive-time provider**
  (TomTom) set up — the mirror just renders `sensor.<v>_range_reach`. Without
  routed data it falls back to a straight-line estimate over `location.pois`.

  ```js
  drivingTimes: {
    enabled: true,
    header: "Driving times",
    max: 8,
    order: "grouped",      // 📅 calendar (by time) → ⭐ static → 📍 zones (by distance) | "nearest"
    zones: [],             // [] = every zone HA sent. ["Home", "Work"] whitelists;
                           //   "-Grandma" excludes. Listed zones + fixed destinations
                           //   always get a row; calendar events fill the rest.
    showVia: true,
    showConsumption: true, // "→78% ~14kWh"
    delayStops: [          // ETA colour by % slower than free-flow
      { pctOver: 10, color: "#ffff00" },
      { pctOver: 20, color: "#ff9900" },
      { pctOver: 35, color: "#ff5555" }
    ]
  }
  ```

  The zone list filters **only this panel** — the dashboard and
  `sensor.<v>_range_reach` always show every US zone. Set it in **either**
  place (the integration option wins if both are set):

  - the zones picked in the integration's **Configure → Fixed destinations &
    zones** (no `config.js` edit needed), or
  - `drivingTimes.zones` here in `config.js`.

  The **destinations** come from Home Assistant: your US `zone.*`, the fixed
  destinations typed into **Configure → Fixed destinations & zones**
  (`Name | address`), and **Calendar** event locations in the look-ahead
  window. When there are more than `max`, the zones you picked and the fixed
  destinations are kept and calendar events fill the remaining rows, soonest
  first — the furthest-out events drop off until an earlier one ends. TomTom (`Drive-time provider` + `Routing API key`, **Per-destination
  routes** on) supplies the road breakdown and the free-flow time behind the
  delay colour; Geoapify gives road names only; `estimate` gives neither.

#### Location & map

```js
visuals: {
  location: {
    enabled: true,
    homeLat: 40.7128,           // your home — both set -> "3.2 mi from home" / "At home"
    homeLon: -74.0060,
    map: true,                  // show a static map image
    mapZoom: 14,
    mapWidth: 210, mapHeight: 120,
    mapUrlTemplate: "https://staticmap.openstreetmap.de/staticmap.php?center={lat},{lon}&zoom={zoom}&size={w}x{h}&markers={lat},{lon},red-pushpin"
  }
}
```

`{lat} {lon} {zoom} {w} {h}` are substituted. The default keyless OpenStreetMap
endpoint is rate-limited and sometimes down — for a reliable map, point
`mapUrlTemplate` at your own provider (Geoapify / Mapbox / Google static maps).
Enabling `location` turns `geocode` on automatically so the address resolves.

**How far can I drive** — set `location.reach: true` to add a readout: the
derated distance the car can cover now (`ev_driving_range × reachFactor` after a
`reachReservePct` reserve), one-way and round-trip, plus which saved places are
in reach:

```js
location: {
  enabled: true, reach: true,
  reachFactor: 0.92,       // trim the car's own estimate
  reachReservePct: 10,     // arrive with 10% left
  reachRoundTrip: false,   // true -> lead with the "…and get back" distance
  reachPois: 4,
  pois: [                  // homeLat/homeLon adds an implicit "Home"
    { name: "Work", lat: 40.4406, lon: -79.9959 },
    { name: "Cabin", lat: 39.87, lon: -79.49 }
  ]
}
```

Home Assistant does the same automatically as **`sensor.<vehicle>_range_reach`**
(state = one-way distance; `pois` attribute lists reachable places with
`one_way_reachable` / `round_trip_reachable`, `arrival_pct`, `mi`, `duration` /
`duration_min`, `typical_min` / `delay_min` / `delay_pct`, `via`, `when` /
`when_local`, `routed`, `source` and lat/lon). `Range reach factor` and
`… reserve %` are in the **Configure** dialog.

**Destinations** are your **US** `zone.*` entities, plus (from the **Configure**
dialog):

- **Fixed destinations & zones** — one field for both. Pick zones from the
  dropdown (multi-select) and/or type a fixed destination as `Name | address`
  and press Enter, e.g. `White House | 1600 Pennsylvania Ave NW, Washington, DC`
  (geocoded once, cached, and also shown in Home Assistant). Everything you
  list always gets a row on the *mirror's* driving-times panel; calendar
  events fill whatever rows are left. Picking zones narrows which zones the
  mirror shows (the dashboard / sensor always show every US zone); pick none
  and every zone is eligible, but only after the calendar events. Type
  `-Name` to hide a zone.
- **Calendar entities** + **Calendar look-ahead (hours)** — any event with a
  location in the next N hours, geocoded and cached (a destination further
  than ~500 km from `zone.home` is skipped as implausible, not filtered by
  region). Call
  **`kia_access.refresh_calendar_destinations`** to re-read now instead of
  waiting for the ~30-min cycle; `calendar_status` shows what was found.

**Drive time + route.** By default `duration` is a straight-line estimate. Set
**Drive-time provider** = `geoapify` or `tomtom` + a **Routing API key** and
`duration` / `mi` / `arrival_pct` become **real road distance + live-traffic
drive time**. With `tomtom` and **Per-destination routes** on, each destination
also gets `via` (the main roads) and `typical_min` / `delay_min` / `delay_pct`
(vs the free-flow time) — that's what the mirror's Driving-times panel colours
the ETA by. A **Geoapify** key is also used to geocode calendar / static
locations even when the provider is `estimate` — HA's built-in Nominatim
geocoder is increasingly blocked.

**Reachable-area map.** A map of how far you can drive, shaded, with your saved
places pinned. Two providers, both free:

- **[Geoapify](https://www.geoapify.com/)** key (`apiKey` / `api_key`) — renders
  the map image / tiles, and does the road-network isochrone for a reach
  **under ~100 km / 60 mi** (its free-tier limit). Above that it's a
  straight-line circle.
- **[TomTom](https://developer.tomtom.com/)** key (`tomtomKey` / `tomtom_key`,
  optional) — a proper road-network isochrone at **any distance** (its
  Calculate Reachable Range API, up to 50 000 km). Add this and the map follows
  roads even on a full charge.

```js
location: {
  enabled: true,
  homeLat: 40.7128, homeLon: -74.0060,
  reach: true, pois: [{ name: "Work", lat: 40.75, lon: -73.99 }],
  rangeMap: {
    enabled: true,
    apiKey: "YOUR_GEOAPIFY_KEY",
    tomtomKey: "YOUR_TOMTOM_KEY", // optional — road isochrone at any distance
    style: "osm-bright-grey",     // any Geoapify map style
    width: 340, height: 220,
    mode: "drive"                 // drive | bicycle | walk
  }
}
```

`node_helper` fetches the polygon in the background (cached ~6 h; a parked car
makes no calls) and builds the image; the module shows the one-way or round-trip
shape per `reachRoundTrip`.

**Home Assistant** — two cards:

- **`custom:kia-range-map-card`** — an **interactive Leaflet map** (pan / zoom),
  auto-zoomed to the reachable area, with a **How far / & back** toggle and
  `zone.*` markers (only the ones near enough to matter). Tiles come from
  Geoapify when an `api_key` is set (styled), otherwise OpenStreetMap.
  With **no keys at all** it still works — a straight-line circle, drawn
  client-side, zero calls.

  ```yaml
  type: custom:kia-range-map-card
  height: 420
  ```

  You don't have to put a key in the dashboard at all: if you've already set
  **Geocoding API key** / **Routing API key** (with **Drive time provider**
  set to `tomtom`) in the integration's own **Options** — the same ones
  `sensor.<v>_range_reach` uses — the card pulls them from there automatically
  over an admin-only websocket call, so a real API key never has to sit in
  Lovelace YAML. An explicit `range_map.api_key` / `range_map.tomtom_key`
  still overrides that if you set one:

  ```yaml
  type: custom:kia-range-map-card
  height: 420
  range_map:
    api_key: YOUR_GEOAPIFY_KEY     # optional — overrides the integration's own key
    tomtom_key: YOUR_TOMTOM_KEY    # optional — overrides the integration's own key
    style: osm-bright-grey
    mode: drive
  ```

- **`custom:kia-access-card`** with a `range_map:` block — the same thing as a
  **static image** inside the main card (no Leaflet), for a lighter panel.
  Unlike the interactive card above, this one needs a Geoapify key for the
  image tiles themselves (there's no plain-OpenStreetMap fallback for a
  static map) — but it too pulls that key from the integration's Options
  automatically, so `range_map: {}` alone is enough as long as you've set
  **Geocoding API key** there:

  ```yaml
  type: custom:kia-access-card
  range_map: {}
  ```

  Or set `api_key` / `tomtom_key` here to override what the integration has:

  ```yaml
  type: custom:kia-access-card
  range_map:
    api_key: YOUR_GEOAPIFY_KEY
    style: osm-bright-grey
    height: 300
  ```

Both take POI markers from `zone.*` and derate with `factor` / `reserve_pct`
(defaulting to the `sensor.<vehicle>_range_reach` options).

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

## Notifications (state changes)

Set `notifications.enabled: true` to emit a notification whenever a monitored
condition changes — **edge-triggered**, so it fires once when the state flips,
not on every refresh.

```js
notifications: {
  enabled: true,
  alertModule: true,           // also pop MagicMirror's built-in `alert` module
  alertSeconds: 15,            // warning alerts auto-dismiss after this many seconds
  criticalAlertSeconds: 0,    // critical alerts: 0 = stay on screen until the condition clears
  notifyOnStartup: "critical", // false | "critical" | true — what fires on the
                               //   first data after a restart
  quietWhileDriving: true,     // suppress open-part / unlocked while the car is on
  checks: {
    evBatteryLow:  { belowPct: 20, clearPct: 25 },   // hysteresis: alert at ≤20,
    battery12vLow: { belowPct: 55, clearPct: 60 },    //   clear only at ≥25
    windowOpen: false,                                // disable a check entirely
    doorOpen: { level: "critical" },                  // promote to a persistent alert
    chargeInterrupted: { minGapPct: 3 }
  }
}
```

**Levels & persistence.** Each check has a `level` — `info` / `warning` /
`critical`. `alertModule` pops the `alert` module for `warning` and `critical`
only.

- a **`warning`** shows as a corner growl that auto-dismisses after
  `alertSeconds` (15 s);
- a **`critical`** shows as a **centre popup that stays until the condition
  clears** — set `criticalAlertSeconds` > 0 to make it a timed corner growl
  instead.

Override any check's level — `checks: { doorOpen: { level: "critical" } }` — to
promote it to a persistent critical.

**Built-in checks** (default level in brackets):

| check | default | fires when |
|---|---|---|
| `tyrePressure` | **critical** | a tyre-pressure warning is on |
| `vehicleFault` | **critical** | any real fault lamp the car reports is on — brake fluid, 12V system, ABS, airbag (not washer fluid / key-fob battery) |
| `evBatteryLow` | warning | drive battery ≤ `belowPct` (20) |
| `evBatteryCritical` | **critical** | drive battery ≤ `belowPct` (8) — a hard floor alongside `evBatteryLow` |
| `battery12vLow` | warning | 12V battery ≤ `belowPct` (55) |
| `battery12vCritical` | **critical** | 12V battery ≤ `belowPct` (40) — "the car may not start" |
| `battery12vDrain` | warning | 12V fell `dropPct` over `overHours` while parked — the "won't start on a cold morning" one |
| `unlocked` | warning | vehicle unlocked (muted while driving) |
| `doorOpen` / `hoodOpen` / `liftgateOpen` | warning | that part is open |
| `windowOpen` / `sunroofOpen` | info | *(info = no `alert` popup)* |
| `chargeComplete` | info | charging finished at target (one-shot) |
| `chargeInterrupted` | warning | charging stopped early (one-shot) |
| `chargingStarted` | info | charging just began — a "it plugged in OK" nudge (one-shot) |
| `serviceDue` | warning | `next_service_distance` ≤ `belowKm` (800 ≈ 500 mi) |
| `notPluggedInHome` | warning | car is home + unplugged for `graceMin` (20). Needs a home point — MM: `visuals.location.homeLat/homeLon`; HA: `zone.home`. Optional `afterHour` / `beforeHour` to only nag in an evening window |
| `unexpectedMove` | **critical** | GPS moved ≥ `thresholdKm` (0.5) for ≥ `sustainedMin` (3) while the odometer stayed put and the car was off — a tow or theft. Needs a home point / GPS. Can false-positive on a bad GPS fix; disable with `unexpectedMove: false` |
| `cantGetHome` | warning → **critical** | you're away from home and the reachable range (after `reservePct` 15) is below the drive home (straight-line × `roadFactor` 1.3). Warning while there's slack, critical once you can't make it. Needs a home point + `ev_driving_range` |
| `otpExpiring` | warning | OTP within `otpWarnDays` of expiry (mode B) |

`info`-level checks broadcast the `KIA_ACCESS_STATE_CHANGED` notification but
don't pop the `alert` module.

**For other modules** — a semantic notification is broadcast each time:

```js
this.sendNotification("KIA_ACCESS_STATE_CHANGED", {
  reason: "door_open",              // stable slug
  level: "warning",
  active: true,                     // true = entered, false = cleared
  title: "Kia EV9",
  message: "Front-left door is open",
  value: { corners: ["FL"] },
  vin: "…",
  at: "2026-09-08T18:20:00.000Z"
});
```

`chargeComplete` / `chargeInterrupted` / `chargingStarted` are one-shot (only
`active: true` fires). Everything else fires on both edges (entered / cleared).

### Webhook (HTTP POST per event)

`notifications.webhook` sends the **same events** to an HTTP endpoint — one
`POST` with a JSON body per fired event. This reaches services an MQTT broker
can't: Discord / Slack incoming webhooks, IFTTT / Zapier, a serverless function,
a cloud logger, a phone-notification service. `node_helper` does the request
(off the render process), retries once after 3 s on a network error, and logs a
non-2xx.

```js
notifications: {
  enabled: true,          // required; set alertModule: false for webhook-only
  webhook: {
    enabled: true,
    url: "https://example.com/hooks/kia",
    method: "POST",                       // default
    headers: { Authorization: "Bearer …" },
    events: "all",                        // or ["door_open", "chargeComplete", …]
    levels: "all",                        // or ["warning", "critical"]
    includeState: false,                  // add the full flat vehicle state
    timeoutMs: 8000
  }
}
```

Body (same shape as `KIA_ACCESS_STATE_CHANGED`, plus `source`):

```json
{
  "source": "MMM-KiaAccess",
  "reason": "door_open", "level": "warning", "active": true,
  "title": "Kia EV9", "message": "Front-left door is open",
  "value": { "corners": ["FL"] }, "vin": "…",
  "at": "2026-09-08T18:20:00.000Z"
}
```

Works in **mode B and mode C**. Home Assistant users don't need it — trigger an
automation on the `kia_access_alert` event and use `rest_command` / a `notify`
service.

## MQTT (state publishing)

> **Do you need this?** Only in **mode B**. If you run the native Home Assistant
> integration (mode A/C) you already have proper entities — don't also enable
> `mqtt.homeAssistant` or you'll get a second, duplicate set. MQTT here is the
> way to get a mode-A mirror's data into HA / Node-RED / dashboards *without*
> the integration.

Optional — publishes the **full flattened vehicle state** to retained topics
after every fetch. Needs the `mqtt`
package (an `optionalDependency`, installed by `npm install`; if it's missing the
module just logs a warning):

```js
mqtt: {
  enabled: true,
  url: "mqtt://192.168.1.8:1883",
  username: "mqttuser",
  password: "…",
  topicPrefix: "kia/ev9",
  retain: true,
  publishJson: true              // also <prefix>/state as one JSON blob
}
```

Topics are scoped by the vehicle's own VIN (for Kia USA, its account-issued
`id` — see [Reliability](#reliability)'s VIN-fallback note), always, for every vehicle with a
resolvable identity — not just in rotate mode: `kia/ev9/<VIN>/ev_battery_percentage`,
`kia/ev9/<VIN>/is_locked`, `kia/ev9/<VIN>/tire_pressure_front_left`, … plus
`kia/ev9/<VIN>/state` (JSON), `kia/ev9/<VIN>/_meta/fetched_at`,
`kia/ev9/<VIN>/_meta/stale`, and `kia/ev9/<VIN>/status` (`online`, refreshed on
every successful poll — see below for why this one isn't itself LWT-backed).
Current-state only — derive change triggers downstream, or use the
`KIA_ACCESS_STATE_CHANGED` notification above.
**Treat `kia/ev9/status/<mqtt-username-or-url>-<8-char-hash>` as the
canonical connection-level status topic** for anything that actually
needs to be right (an automation, an alert) — it's backed by that
specific connection's own Last-Will-and-Testament, so it always correctly
flips to `offline` if — and only if — that MQTT connection drops. The
readable segment is `mqtt.username` (the example above: `mqttuser`), or
`mqtt.url` if you're connecting anonymously — the MQTT broker's own
credentials, not your Kia account's (this doesn't distinguish which
vehicle on the account is/isn't reporting; use the per-vehicle
`kia/ev9/<VIN>/status` above for that, refreshed each successful poll and
flipped to `offline` the moment a vehicle is removed from config, but not
itself backed by an LWT — mqtt.js only supports one static LWT per
connection). The hash suffix keeps two different connections from ever
landing on the same topic even if their usernames/URLs happen to sanitise
to the same text. The plain `kia/ev9/status` is published `online` for
backward compatibility only: with a single connection it behaves the same
as before, but once more than one connection shares a broker + `topicPrefix`
it reflects whichever connection last (dis)connected rather than either
one specifically (a one-time warning is logged when this happens) and
should not be relied on.

The raw API dump (`vehicle.data.*`, which includes GPS) is **not** fanned out
to individual retained topics; set `mqtt.publishRaw: true` if you want it. The
`kia/ev9/state` JSON blob still contains everything (turn it off with
`publishJson: false`).

The VIN scoping above applies whether you're using `vehicles: [...]` to
rotate through several cars in one module block, running one module block
per car (each its own `vin:`), or even a single car with no `vehicles:` at
all — the latter two look like "just one vehicle" to any one module
instance, but two SEPARATE module blocks for two different cars can easily
end up pointed at the same broker + same `topicPrefix`, and without
per-vehicle scoping in that case too, they'd silently overwrite each
other's retained state (real cross-vehicle data corruption, not just an
inconvenience) — which is exactly why this isn't limited to rotate mode.
**If you're upgrading from before this changed:** a genuinely
lone single-vehicle setup's topics move from `kia/ev9/...` to
`kia/ev9/<VIN>/...` — repoint any dashboard/automation/HA MQTT sensor at
the new path (or subscribe to `kia/ev9/#` if you'd rather not hardcode the
VIN).
Remove a car from `vehicles:` and its own status topic is published
`offline` (retained) on the very next poll — even if that poll itself
fails to fetch anything (this diff only needs your config, not a
successful account response) — so it stops looking falsely available; its
individual value topics (`ev_battery_percentage` etc.) are left as-is,
same as any other retained MQTT value once nothing's updating it. A
vehicle that stays in `vehicles:` but stops appearing in the account
itself (sold, removed from the Kia app, …) is retired the same way after
a few consecutive successful polls that don't see it — one flaky/
incomplete account response alone won't retire a car that's still really
there.

### Home Assistant discovery (mode B only)

**Skip this if you use the native integration (mode A/C)** — it already gives
you these entities, better. This path is for a mode-A mirror that wants entities
in HA without installing the integration.

```js
mqtt: {
  enabled: true,
  url: "mqtt://192.168.1.8:1883",
  topicPrefix: "kia/ev9",
  homeAssistant: { enabled: true, discoveryPrefix: "homeassistant" }
}
```

Publishes retained `homeassistant/…/config` messages so a curated set of entities
(battery %, health, 12V, range, charge power, ETA, odometer, outside temp, last
reported; charging / plugged / locked / doors / frunk / liftgate / sunroof / tyre
warning / defrost / climate binary sensors) appear in Home Assistant
automatically, grouped under one device. Availability combines the
connection's own LWT-backed status (`kia/ev9/status/<mqtt-username-or-url>-<hash>`,
above) with this vehicle's own per-VIN status (`kia/ev9/<VIN>/status`) via
HA's `availability_mode: "all"` — the entities show available only when
BOTH the connection is actually up and this specific vehicle has reported
recently, not just whichever one happens to be true.

## Time-series export (InfluxDB / Prometheus)

Optional — pushes every numeric / boolean `vehicle.*` value straight to a
time-series DB after each fetch, no MQTT broker needed. Node built-ins only.

```js
exporter: {
  tags: { car: "ev9" },        // extra labels on every point (vin is automatic)
  influx: {
    url: "http://192.168.1.8:8086",   // InfluxDB v2 or v1.8 (/api/v2/write)
    org: "home", bucket: "vehicles", token: "…",
    measurement: "kia_vehicle"
  },
  prometheus: { enabled: true, port: 9110 }   // then scrape http://127.0.0.1:9110/metrics
}
```

Influx: one line-protocol `POST` per update (`kia_vehicle,vin=… ev_battery_percentage=63,…`).
Prometheus: an always-on `/metrics` endpoint — `kia_ev_battery_percentage{vin="…"} 63`,
plus `kia_stale`. `/metrics` has **no authentication of its own**, so it's
bound to **loopback only (`127.0.0.1`) by default** — scrape it from
something running on the same machine (a local Prometheus, or a reverse
proxy that adds its own auth), not directly from another machine on your
LAN. If you genuinely want to scrape it from elsewhere, set
`prometheus.host: "0.0.0.0"` explicitly — that's a deliberate choice to
expose live battery %, location and (in rotate mode) the VIN as a label to
anything that can reach that port, so make sure your network is one you
trust before doing that. Strings are skipped; booleans become `1`/`0`.
Rotating through multiple `vehicles:`? Every car's samples carry its own
`vin` tag/label — the
Prometheus endpoint shows one series per vehicle rather than one server
sharing a single, last-writer-wins snapshot. Remove a car from `vehicles:`
and its series is dropped from `/metrics` on the next poll, instead of
reporting its last-known numbers forever.

## Reliability

- **Live wake-up is time-boxed.** With `refresh: true` the bridge asks the car to
  report fresh data, but only waits `forceRefreshTimeout` seconds — if the
  wake-up hangs (common for a car that has **never synced**), it falls back to
  Kia's server-cached copy for that poll and notes it. A fresh EV9 should run
  `refresh: false` until it has checked in once.
- **Last-known-state cache.** The last good payload is saved to `cache/` and
  re-served (dimmed, with a "cached" footer and a warning strip) whenever a fetch
  fails outright, so the widgets never go blank during a Kia outage or restart.
- **Backoff.** After a failure, retries slow down exponentially
  (`retryInterval`, ×2, ×4, … capped at `retryInterval × backoffMax`) and reset
  on the next success.
- **Request cap.** `maxRequestsPerHour` (default off) pauses fetching once the cap
  is hit — Kia soft-locks accounts that poll too hard.
- **Auth-failure cooldown.** 3 consecutive re-login failures in a row (bad
  credentials, or `hyundai_kia_connect_api` itself choking on an unexpected
  response — both look the same from here) stop contacting Kia's login
  endpoint entirely for a cooldown (30 min, doubling on repeat, capped at
  4h) instead of retrying on the normal schedule. Repeatedly retrying a
  broken login is exactly the pattern that gets an account rate-limited or
  locked out — this is deliberate, not a bug if fetches pause for a while
  after several auth errors in a row.
- **One shared login per account (Home Assistant).** Every config entry for
  the same Kia account — however many vehicles it has — shares a single
  login and a single account-wide fetch, instead of each vehicle's entry
  logging in and polling independently. An N-vehicle account therefore
  generates roughly the same account-level Kia API traffic a single-vehicle
  account does, not N times as much, which matters directly for the
  auth-failure cooldown above: less traffic is less exposure to the kind of
  repeated-failure pattern that trips it.
- **Charging analytics correctness.** Three related fixes: (1) a charge
  session whose location genuinely couldn't be determined (no home zone
  configured, or no GPS fix that poll) now reports `location: "unknown"`
  and its own `unknown` bucket in charge summaries/`chargingPerformance`,
  instead of silently being counted as "home"; (2) the EV9's 99.8kWh usable
  pack size is no longer used as a generic capacity guess for a vehicle
  whose own capacity isn't configured or reported — it only applies when
  the vehicle's own model actually looks like an EV9 (a string match on
  Kia's own API-reported model name — a best-effort heuristic, not a
  certainty, since that string isn't guaranteed to format identically
  across regions/brands), so another model's kWh/cost figures are never
  silently computed off the wrong battery size. If your EV9's own model
  string ever ISN'T recognised (charge sessions stop showing a kWh figure),
  **Configure → Usable battery capacity kWh** set to `99.8` is the reliable
  fallback for any vehicle, EV9 or not — it's always checked first, before
  any model guessing;
  (3) `core/analytics.js`'s monthly efficiency trend now buckets by UTC,
  matching `analytics.py`, which already did — previously a trip near a
  month boundary could land in a different month in the MagicMirror
  module's own trend than in Home Assistant's, depending on which
  timezone each process happened to be running in.
- **VIN fallback for Kia USA.** `hyundai_kia_connect_api`'s Kia-brand/USA
  implementation never reports a vehicle's real VIN (every other
  region/brand does) — vehicle selection (the "choose a vehicle" step, the
  Configure VIN picker, and every internal VIN match) falls back to the
  vehicle's own account-issued id in that case, so a Kia USA multi-vehicle
  account still works. The "VIN" shown in these pickers for a Kia USA
  account is therefore this id, not the car's literal VIN — cosmetic only,
  it still uniquely and stably identifies the vehicle.

## OTP expiry

Kia's OTP can't be refreshed unattended (it needs the SMS/email code). The module
records when `enroll.py` ran and shows **"OTP expires in ~N days — re-run
enroll.py"** once you're within `otpWarnDays` of `otpLifetimeDays` (both
configurable; the 30-day default is an estimate — tune it to what you observe).
The `otpExpiring` notification check fires the same warning to other modules.

`hyundai_kia_connect_api` ≥ 4.25.3 auto-recovers a Kia USA session that the
server expires (error 1003 / 1005) without a fresh OTP, so re-enrollment is
needed much less often than it used to be — `npm install` keeps the library
current.

## Notes

- The MagicMirror module is **read-only**. Car control is in the Home Assistant
  integration (mode A).
- Home Assistant and the mirror share one engine (`core/`), so the sensors,
  commands, alert rules and the car diagram are identical on every surface. New
  attributes from `hyundai_kia_connect_api` show up automatically after an
  `npm install` (mode B) or a HACS redownload (mode A / C).
- Trigger an immediate mirror refresh from another module with
  `this.sendNotification("MMM_KIA_ACCESS_REFRESH")`.
- **Contributing / repo layout.** `custom_components/kia_access/kia_client.py`,
  `conditions.py`, `vehicle_state.py`, `sessions.py`, `range.py`, `routing.py`,
  `trips.py` and `core/entities.json` / `core/commands.json` look like
  duplicates of the same-named files at the repo root — they are: HACS
  requires the integration folder to be self-contained (no reaching outside
  it for shared code), so `scripts/sync-core.js` copies those root files in
  verbatim. **Always edit the root copy**, never the one under
  `custom_components/`; then run `npm run sync` (CI's `sync-core.js --check`
  fails the build if you forget). The card bundle
  (`custom_components/kia_access/frontend/kia-access-card.js`) is generated
  the same way, from `card/*.src.js` + `core/*.js` — edit those, not the
  bundle. Running the tests: `npm test` runs the JS suite only — a JS-only
  edit to `core/sessions.js` etc. that silently drifts from its Python
  mirror would pass `npm test` cleanly and only get caught by CI's separate
  Python job. `npm run test:python` runs every `test/*_test.py` parity
  check locally in one command (mirrors `.github/workflows/ci.yml`'s
  "python"/"hass" jobs; the "hass" group needs `pip install homeassistant`
  and is skipped with a warning if that's not installed), or `npm run
  test:all` for both JS and Python together.

## Send to car

`kia_access.send_to_car` pushes a destination to the car's built-in navigation
(the "Send-To-Car" feature in the Kia app — on the next start the car offers it
as your route). Pass a `name` plus either an `address` (geocoded via
OpenStreetMap) or explicit `latitude` / `longitude`:

```yaml
service: kia_access.send_to_car
data:
  name: "White House"
  address: "1600 Pennsylvania Ave NW, Washington, DC"
```

**Send your calendar destinations before you leave:**

```yaml
alias: Route to the car before a calendar event
trigger:
  - platform: calendar
    event: start
    offset: "-00:20:00"          # 20 minutes before it starts
    entity_id: calendar.family_calendar
condition:
  - "{{ trigger.calendar_event.location not in ('', None) }}"
action:
  - service: kia_access.send_to_car
    data:
      name: "{{ trigger.calendar_event.summary }}"
      address: "{{ trigger.calendar_event.location }}"
```

> **Dormant for now.** `hyundai_kia_connect_api` only implements `set_navigation`
> for EU / AU / IN / CN so far — **not USA**. On a US car the service call
> returns *"send_to_car isn't available for this region yet"*. The wiring is all
> in place: when USA support lands upstream, a library update (`npm install` /
> HACS redownload) lights it up with no config change. Progress is tracked by
> the monthly upstream check. (If you can capture one Send-To-Car request from
> the Kia app, a US `set_navigation` implementation could be contributed —
> [open an issue](https://github.com/Legal-Copy7045/MMM-KiaAccess/issues).)

## Home Assistant — reference

Install and setup are **mode A** above. Some details:

- **How the card gets its data.** The integration adds one diagnostic sensor,
  `sensor.<vehicle>_status`, whose attributes carry the whole flat vehicle
  payload (`kia_access_raw: true`). The card — and the module in mode C — read
  only that one entity, so neither costs any extra polling of Kia. Those
  attributes include the VIN and the parked coordinates, so the sensor declares
  `_unrecorded_attributes` — the blob is available live but is **not** written to
  the recorder / history / logbook.
- **Control — native entities.** `lock.<vehicle>_doors`,
  `climate.<vehicle>_climate` (HVAC wrapper over start/stop climate),
  `number.<vehicle>_ac_charge_limit` / `_dc_charge_limit` /
  `_climate_run_time`, `switch.<vehicle>_charging` /
  `_front_defrost_with_climate` / `_rear_defrost_with_climate`, and
  `select.<vehicle>_*_seat_with_climate` / `_steering_wheel_heat_with_climate`.
  The duration / defrost / seat / wheel entities are **stored preferences** —
  there's no API to set them on their own, so `climate.turn_on` and the
  `start_climate` button/service fold whatever they're set to into one call.
  Seat levels use `KiaUvoApiUSA` codes (Off / low·med·high heat / low·med·high
  cool); other regions differ — use the raw `start_climate` service there.
  Buttons still cover the no-argument commands; `set_charge_limits`,
  `send_to_car` and the full `start_climate` (with seats) remain services too.
  All commands refresh the coordinator afterwards. Multiple accounts: pass
  `entry_id` in the service call.
- **Climate temperature unit.** For the **USA** region the library sends
  `set_temp` in **Fahrenheit** (62–82; outside that it becomes "LOW" / "HIGH"),
  and `climate: true` is what actually turns the A/C on. `commands.json`
  reflects that; EU/other regions use °C 16–30 and would need the option bounds
  adjusted.
- **Alerts in automations.** Trigger on `event_type: kia_access_alert`; the
  `event_data` has `reason`, `level`, `active`, `message`, `vin`, `entry_id`.
- **Token / re-auth.** The refresh token lives in the config entry and is
  re-saved when Kia rotates it (nothing is written into the HACS-managed
  folder). If Kia ever forces a new one-time code, HA shows a **"Reconfigure"
  / re-authenticate** prompt on the integration — enter the password and the
  new code there; no need to delete and re-add.

## Credits

- [`hyundai_kia_connect_api`](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api)
- Formatter/flatten design informed by [`bluelinky`](https://github.com/Hacksore/bluelinky)

## License

MIT
