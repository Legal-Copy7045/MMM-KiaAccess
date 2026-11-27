# Changelog

All notable changes to Kia Access (the Home Assistant integration and the MagicMirror module), newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Each section is also the GitHub Release's notes.

To update: HACS → Kia Access → Update, then restart Home Assistant. MagicMirror:
`cd ~/MagicMirror/modules/MMM-KiaAccess && git pull && npm install`, then restart MagicMirror.

## [2.125.0] - 2026-11-27

Nothing changes in how Kia Access works for you: this release changes how it's built, tested and released.

### Changed

- **Releases now come with this changelog.** Each GitHub Release (what HACS shows when you update) takes its notes
  from the matching section here, and every version is listed in this file, newest first.
- **The project follows the owner's shared project standard (1.1.0).** Pull requests run only the checks a change can
  affect, the full set runs weekly, and a merged version bump is what publishes a release.
- **Dependency updates arrive automatically.** GitHub's Dependabot checks the build tools and dependencies weekly.
  The Kia/Hyundai library stays with the weekly upstream review, so its version always matches in both places it's
  pinned.

### Security

- Code scanning (CodeQL) now runs weekly and on demand instead of on every push, and every pull request is checked
  for leaked secrets (gitleaks) and personal details. The privacy check now also looks at image location data.
- A full regression suite checks the cards in a real browser on desktop and phone, every test file, the security
  scanners, and the published release.

## [2.124.1] - 2026-11-23

_Kia/Hyundai library 5.4.2_

### Changed

- **Kia/Hyundai library 5.3.1 → 5.4.2**, the same version kia_uvo 4.2.0 uses. Fixes that matter for you, from hyundai_kia_connect_api:
  - Europe: when the car sends an invalid range reading (a 4095/1023 placeholder) or a distance unit the library doesn't recognise, the range now shows as unknown instead of a wrong number (#1609). Hyundai cars on the older status format now report "unplugged" correctly when there's no connector-lock data (#1619).
  - Canada: the login connection is more reliable on newer systems (#1618), seat heater states are read from the right place (#1626), climate on some newer EVs falls back to the right request (#1625), and a command the server rejects now shows as failed instead of looking like it worked (#1608).
  - US Hyundai: setup no longer fails when an account has no enrolment date (#1632), and a trip with no distance no longer stops the update (#1627).
- No changes to your entities or settings.

## [2.124.0] - 2026-11-22

_Tyre pressures keep their last reading while parked_

### Changed

- **Tyre pressure sensors no longer drop to "unknown" while the car is parked.** Some cars (notably on the Australian and New Zealand service) only send tyre pressures while the car is on. The four tyre pressure sensors now keep showing the last real reading and update as soon as a new one arrives. After a Home Assistant restart they show the last saved reading.
  - Each tyre pressure sensor has two new attributes: `last_reported` (when that reading was taken) and `retained` (true while it's showing an older reading). Use them if you want an automation to ignore old pressures.
  - The tyre pressure **warning** sensors aren't affected and still show what the car reports now.
  - These sensors are off by default. Thanks to the kia_uvo team for the idea (kia_uvo 4.1.0, #1930).

## [2.123.0] - 2026-11-22

_Kia/Hyundai library 5.3.1, Python 3.13 for the MagicMirror bridge_

### Changed

- **Kia/Hyundai library 5.2.1 → 5.3.1**, the same version kia_uvo 4.1.0 uses. Fixes that matter for you, from hyundai_kia_connect_api:
  - Canada: remote climate on EVs sends the right request for more models, including the IONIQ 9 (#1593, #1601).
  - Europe: the parked location is read from the newer response shape too (#1594), and more server errors (expired token, timeout, rate limit, no data) give a clear message (#1596).
  - The address lookup for the car's location handles special characters and retries after a failed lookup (#1597, #1599).
- **The MagicMirror bridge now needs Python 3.13 or newer** (library 5.3.0 dropped 3.12, #1590). This only matters if your mirror talks to Kia itself (mode B). If your mirror gets its data from Home Assistant (mode C), or you only use the HA integration, nothing changes for you.
  - `npm install` handles it: it uses a system Python 3.13+ if you have one, otherwise on Linux it downloads a checksum-verified standalone CPython 3.13 (as it did for 3.12), and rebuilds the module's Python environment.
  - If you update with `git pull` but skip `npm install`, the mirror keeps working on the previous library and logs a warning telling you to run `npm install`.
  - On macOS or Windows without Python 3.13, install it first, then run `npm install`.

## [2.122.0] - 2026-11-22

_Kia/Hyundai library 5.2.1, fuel economy units_

### Changed

- **Fuel economy sensors now show their unit.** The three "Fuel economy" sensors (this drive, since refuel, overall) had no unit. They now show the unit your car reports, such as L/100km, km/L, MPG or kWh/100km. These sensors are off by default; if you turned them on, Home Assistant may ask once about the unit change in its statistics. Thanks to the kia_uvo team (kia_uvo 4.1.0, #2091) and hyundai_kia_connect_api 5.2.0 (#1576).
- **Kia/Hyundai library 5.1.2 → 5.2.1.** Fixes that matter for you, from hyundai_kia_connect_api:
  - Changing only part of the charging schedule (for example the off-peak window) on cars using the newer European (GSPA) connection no longer resets the other settings to midnight or off (#1588).
  - European EVs: "charging" and "plugged in" are reported correctly in more cases (#1581, #1584), and the "last updated" time comes from the car rather than the server clock (#1587).
  - European cars on the older climate endpoint now honour the heated seat and steering wheel options (#1585).
  - European accounts renew their sign-in token before the server starts refusing it, so fewer failed polls (#1579).
  - US Hyundai: a vented window now counts as open (#1582).
  - Off-peak mode "undefined" on newer European cars reads as off (#1577).

## [2.121.1] - 2026-11-17

_Map library served locally, stronger login-pause fingerprint_

### Changed

- **The range map no longer loads code from the internet.** The map library it uses (Leaflet 1.9.4) now ships with Kia Access, and Home Assistant serves it itself. Before, the dashboard downloaded it from a public CDN. That copy was already locked to an exact checksum, so a changed file would have been refused, but now nothing runs in your dashboard that didn't come with the integration. The included files are the unmodified Leaflet release, and the card still checks them against Leaflet's published checksums. Map tiles (the background images) still come from OpenStreetMap or Geoapify, as before.
- **The failed-login pause stores a safer fingerprint.** After repeated failed sign-ins, Kia Access remembers a fingerprint of the password and PIN that failed, so a corrected one isn't held back by the pause. That fingerprint was a quick, unsalted hash. It's now a slow, salted password hash (PBKDF2), so the file can't be used to test password guesses quickly, and the file is readable only by its owner. A pause saved by an older version is cleared once on update. This fixes two GitHub code-scanning alerts.

## [2.121.0] - 2026-11-10

_Faster dashboard card, current climate API, quieter calendar geocoding_

### Changed

- **The dashboard card is now cached properly.** Home Assistant serves the card with long-lived cache headers, so browsers and the app stop re-checking it on every page load. The card's dashboard resource and the frontend URL both carry the version (`?v=2.121.0`), so an update still shows up straight away.
- **The climate entity uses Home Assistant's current temperature API.** It sets the native temperature unit instead of overriding the deprecated `temperature_unit` (removal is scheduled for HA 2027.11), and current and target temperatures moved to the native API as well. °F and °C behave exactly as before: whole degrees from 62–82 °F, half degrees from 16–30 °C. Older Home Assistant versions still work.
- **The car's location tracker no longer reports a battery level.** Home Assistant has deprecated that on trackers. The EV battery is reported by its own sensor (`sensor.<car>_ev_battery`), so use that in automations or cards that read the tracker's `battery_level` attribute.
- **Calendar destinations skip online meetings.** Locations such as Microsoft Teams, Zoom, Google Meet, Webex or Skype, and anything that's a link (`http…`, `www.…`), are no longer looked up. They show as "online meeting – skipped" in the calendar diagnostics and don't count as places.
- **Failed address lookups aren't retried on every refresh.** An address that couldn't be found (or resolved too far from home) is remembered for 24 hours instead of being looked up again on each calendar refresh, with a warning in the log every time. Adding or changing a geocoding or routing key retries it straight away.

## [2.120.0] - 2026-11-09

_Kia/Hyundai library 5.1.2, charging-connector lock sensor_

### Added

- **Kia/Hyundai library 4.48.0 → 5.1.2.** Notable for you:
  - **Europe (newer platform):** "Plugged in" works again. Since an earlier library version it read *unknown*.
  - **Europe:** cached status is read correctly for every car, and live refresh asks the car to upload fresh status.
  - **Canada:** token refresh failures and PIN check errors are fixed.
  - **Europe (newer platform):** more status fields, including petrol range on hybrids, are mapped.
- **Charging connector lock** — a new sensor (off by default) showing whether the charging cable is locked, unlocked or released, on European cars that report it.

### Fixed

- The ownership-costs example (`examples/ha-ownership-package.yaml`) used an icon name that doesn't exist (`mdi:cash-alert`), so that sensor showed no icon. It now uses `mdi:cash-clock`.

## [2.119.1] - 2026-11-05

_Fix stale dashboard card, European login recovery, tidier padlock_

### Fixed

- **The dashboard card now updates straight after a HACS update.** The card was registered as a dashboard resource without a version number, so browsers and the Home Assistant app kept serving their cached copy, and the old card stayed on screen even after a restart. The resource now carries the version, and an existing entry is upgraded automatically on the next Home Assistant start. If you still see the old diagram once, refresh the page; after that it updates by itself.
- **MagicMirror installs the right Kia/Hyundai library by itself.** Updating with `git pull` alone left the old library in place. When Hyundai and Kia's European sign-in started requiring a newer app signature (October 2026), that old library failed every login with "code 9035 – unusual activity". The module now checks the library at startup and installs the version this release needs. Running `git pull && npm install` remains the recommended way to update; the README now says so.
- **The failed-login pause clears when something changes.** After three failed sign-ins, Kia Access waits 30 minutes or more before trying again, to avoid an account lockout. A corrected password or PIN, or an updated library, now counts as a fresh attempt and goes through straight away. A 9035–9037 error now also says to update the library.
- **The padlock on the EV9 diagram** is centred in its ring in both states, and the unlocked shackle is drawn properly lifted open.

## [2.119.0] - 2026-11-04

_A new EV9-style car diagram, now the default_

### Added

- **A new car diagram that looks like the EV9.** It has flared wheel arches with treaded tyres, the Star Map pixel lamps front and rear, a raked windscreen, a panoramic glass roof with rails and side glass, and a glowing body edge in the lock colour.
  - **The drive battery glows up through the roof glass**, green, then amber, then red as it runs down, with the % on top and a pulse while charging.
  - **A padlock on the hood:** closed when locked, its shackle lifted open when unlocked.
  - **Doors** swing open on their front hinges, and an open window glows along the side glass.
  - **Every state the original diagram shows is still there, in the same place:**
    - frunk, liftgate and sunroof;
    - headlights and taillights;
    - tyres;
    - heaters, airflow and set-point;
    - outside temperature;
    - 12V battery;
    - charger, cable flow, kW and amps;
    - V2L/V2X;
    - the warning triangle;
    - find-the-car flashing;
    - gas and hybrid cells.
- **It's the default on the Home Assistant card and the MagicMirror module.** To keep the original drawing:
  - **card:** `car_style: classic`;
  - **MagicMirror:** `visuals: { carStyle: "classic" }`.
- **`docs/car-states.png`** now shows every state in both styles side by side.

## [2.118.0] - 2026-11-04

_One car can't take down the account; library 4.48_

### Fixed

- **One problem car no longer knocks out every other car on the same account.** Before, a car Kia couldn't refresh (for example, one you've sold that's still on the account) failed the whole update, so every other car on that account went unavailable too. Now only that car is affected and the rest keep updating. It recovers on its own once Kia serves it again. This applies to Home Assistant and to MagicMirror's rotate mode.
- **A temperature change with the mode set to "off" no longer starts climate.** `climate.set_temperature` with `hvac_mode: "off"` used to start climate at that temperature. It now stops climate and remembers the temperature for next time.
- **Single-car fetches are leaner:** a request for one car now refreshes only that car, not every car on the account.

### Added

- **Genesis on `EU-CCI`.** The newer European platform now supports Genesis too.
- **Long European passwords:** if sign-in fails for a European account with a password over 20 characters, the error now says to try the first 20. Some Kia / Hyundai / Genesis apps cut longer passwords when saving them.
- **More status sensors for `EU-CCI` cars**, all off by default and in the diagnostics section:
  - *Charge-complete alarm*
  - *V2L time remaining*, plus raw V2L range and mode
  - gear position and steering-wheel heat level (raw values)
  - three fuel-economy readings
- **Kia/Hyundai library 4.41.4 → 4.48.0**, which brings these fixes:
  - **Canada:** sign-in errors are clearer and token refresh works better.
  - **Europe:** live refresh now works on Kia `EU-CCI` cars, and scheduled climate works there too.
  - **Australia:** remote start and stop for newer petrol cars.
  - **Python 3.14:** support has started.

  One library change to note: Europe no longer accepts a refresh token pasted in as the password, so sign in with your real password.

## [2.117.0] - 2026-10-27

_Newer European cars (EU-CCI), library update_

### Added

- **New region: `EU-CCI`.** This is Europe's newer platform, the one behind the current Kia and Hyundai app sign-in. kia_uvo calls it "Europe (Beta)". If your European car isn't found under `EU`, set the integration up again and pick `EU-CCI`. Valet mode, windows, charging current, V2L and the charging schedule services are available there too, as far as the library supports each car. Genesis isn't supported on this platform yet; the setup screen says so.
- **Four new status sensors for these cars**, off by default: *Hazard lights*, *Windscreen heater*, *Air cleaning* and *12V auto-cut pre-warning*.
- **Kia/Hyundai library 4.41.1 → 4.41.4**, which brings these fixes:
  - **Battery health:** an out-of-range reading (Europe) now shows as unknown instead of a bogus number.
  - **Sunroof:** unusual status codes on newer cars now show as unknown instead of open or closed.
  - **Climate unit:** newer cars keep their climate temperature unit while climate is off.
  - **Off-peak charging:** the off-peak-only setting is now sent correctly on `EU-CCI` cars.

## [2.116.0] - 2026-10-25

_Car-measured energy and efficiency (Europe, Canada, US Hyundai)_

### Added

Many cars report their own **energy log**: how much energy they used each day (Europe and the other EU-style regions) or each trip (Canada, US Hyundai), split into driving, climate, onboard electronics and battery care, plus energy regenerated and distance. Kia Access now uses it:

- **Car-measured efficiency**: mi/kWh or km/kWh, and Wh per mile/km, over the last 30 days. This is energy the car measured, not an estimate from the battery percentage, so it's accurate even on short trips.
- **Where the energy goes**: the share used by driving, climate, electronics and battery care, so you can see what heating or cooling costs you.
- **Regen**: energy recovered, and as a share of what you used.
- **Monthly trend.** The car only returns about a month at a time, so Kia Access keeps the log itself, and the trend grows with every month you run it.

**Where to find it**
- **Home Assistant:** new `car_*` attributes on `sensor.<vehicle>_observed_range`. The dashboard example in `docs/observed-range-dashboard-snippet.yaml` has a *Car-measured energy* card.
- **MagicMirror:** a *Car-measured efficiency* row in the *Observed range & efficiency* panel (`visuals.analytics`), in direct and Home Assistant modes.

**Kia USA cars don't report an energy log,** so nothing changes for them. The trip-based efficiency figures stay the source, as before.

### Fixed

For cars that report this log, it used to show up as one long unreadable line of text in the vehicle data, the MagicMirror table and MQTT. It's now stored as clean records, kept out of the table and MQTT, and summarised by the analytics instead.

## [2.115.0] - 2026-10-25

_Library update and fixes from kia_uvo 3.20.0_

### Added

- **Kia/Hyundai library 4.35.2 → 4.41.1.** Notable for you:
  - **Canada:** fixes logins blocked by Cloudflare (HTTP 403).
  - **India:** keeps the real refresh token and retries expired ones, so logins last as they should.
  - **US Hyundai:** now reports per-tyre pressures. Turn on the *Tyre pressure* entities to see them.
  - **Europe:** charging current and window control now work on more Kia models.
- **Valet mode and window buttons** are hidden when the car itself reports it doesn't support them, even in a region that normally does.

### Fixed

- **A failed Kia login during setup, re-authentication or reconfigure** now shows the usual sign-in error. Before, a login that neither succeeded nor asked for a code could carry on as if it had worked, with no saved token.
- **Energy sensor names** now say what they measure: *Energy used (90 days)*, *Energy regenerated (90 days)* and *Consumption (30-day average)*. These are rolling figures from the car, not lifetime totals. Existing entity IDs don't change.

## [2.114.1] - 2026-10-12

_Internal cleanup_

### Changed

No new features. This tidies up code that was copied in several places, so fixes land everywhere at once:

- **One distance calculation** instead of four separate copies, shared by MagicMirror, the card, trips and the range map.
- **One "home and unplugged" / "moved while parked" tracker** shared by MagicMirror, the card and Home Assistant (the Home Assistant one is a direct Python port).
- **One EV9 battery-size rule** for both trips and charge sessions.
- **Range map:** the one-way and round-trip outlines are now fetched at the same time, so the map refreshes faster.
- Commands no longer re-read the command list from disk every time.

Everything should behave exactly as in v2.114.0.

## [2.114.0] - 2026-10-12

_Second round of code-review fixes_

### Fixed

**Alerts**
- The **"12V battery draining while parked"** alert can now fire in Home Assistant. It never got the battery history it needs before.
- **"Not plugged in at home"** with an overnight window (e.g. `afterHour: 20, beforeHour: 7`) now works. A window across midnight never matched before.
- **"Can't get home"** now uses miles for imperial users.
- **Block automated climate** also covers venting / opening windows and a schedule that sets departure climate.

**Numbers**
- **Miles per kWh and cost per mile** were skewed when some trips had no energy or cost figure (e.g. you charged during the trip). They now compare like with like.
- **Free charging** (a zone priced at 0) shows a cost of 0 instead of "unknown".
- **Battery temperatures** reported in °F are converted to °C like the other temperatures.
- Home Assistant and MagicMirror now **round the same way**, so costs agree to the cent.
- A **bad home or zone location** no longer counts as "right here". Before, an invalid home point made the car always "at home".

**Multi-car and MagicMirror**
- With **two cars on one account**, one car's live wake-up no longer wakes the other, so each car's quiet hours hold.
- The **"Kia returned an empty state"** warning now names the car it's about instead of always looking at the first.
- **Rotate mode** no longer shows the previous car's data, stale banner or "updated" time on a car that has no data yet, and no longer runs alerts on the wrong car.
- The **card's vehicle selector** keeps each car's alert state separate.
- **Drive times** no longer shift onto the wrong destination when one destination has invalid coordinates.

**Docs**
- The `start_climate` service description no longer says Canada uses °F (it uses °C).
- The README's alert defaults now match the code (window / sunroof alerts are warnings, the tow threshold is 1000 ft, the centre popup is opt-in).

## [2.113.1] - 2026-10-12

_Fixes from a full code review (India / NZ / Brazil, plugged-in, privacy)_

### Fixed

- **India, New Zealand and Brazil accounts talked to the wrong Kia server.** The region numbers were one off from the library's, so an India account used the New Zealand API, New Zealand used Brazil's and Brazil used Europe's. Logging in, polling and commands all went to the wrong place. US, Canada, Europe and Australia were not affected.
- **"Plugged in" showed unknown while charging** on cars that report a connector code instead of yes/no (the EV9 reports `4` while charging). Fixed for the Home Assistant entity and for MagicMirror's MQTT entities.
- **Charge sessions in Home Assistant** didn't close when such a car was unplugged (they waited for a 45-minute timeout) and didn't open when charging was reported as `1`.
- **One missed charging reading no longer loses the charging alerts.** A poll that didn't report charging status used to wipe the last known state, so "charge complete" / "charge interrupted" could be missed and a second "charging started" could fire mid-session.
- **Privacy (MagicMirror reading from Home Assistant):** your Kia login email, in the summary sensor's `account` attribute, was copied into the car data and, with MQTT on, published to a retained topic. It's now left out.
- **Minimum time between wake-ups** now also counts from the last wake *attempt*. Before, a wake the car never answered (no signal, weak 12V battery) let every poll try again.
- **The 60-second retry** after a failed poll now reads the cached data instead of waking the car a second time.
- **A command run while "Refresh now" was waiting** no longer cancels that refresh's wake-up.
- **Download diagnostics** no longer fails in timezones east of UTC when the saved login has no expiry recorded.
- **Charge port door** is now off by default (only European-style regions report it).
- **Schedule services** reject a badly formatted time straight away, accept departure days as `[mon, tue]`, `"mon,tue"` or numbers, and the V2L limit only accepts 10 % steps.

## [2.113.0] - 2026-10-12

_Valet mode, windows and charging schedules (European-API regions)_

### Added

For cars in the regions the Kia/Hyundai library supports these commands for (**EU, Australia, New Zealand, India, China, Brazil**):

- **Valet mode**: Start / Stop buttons and services.
- **Windows**: one-tap **Close windows** and **Vent windows** buttons, plus `kia_access.set_windows` to set each window to closed, open or vent.
- **Charging current**: `kia_access.set_charging_current` sets the AC current to 100, 90 or 60 %.
- **V2L**: `kia_access.set_v2l_limit` sets the discharge limit, 20–80 %.
- **Schedules**: `kia_access.schedule_charging_and_climate` sets departure times, days and climate, scheduled charging and the off-peak window. Any field you leave out keeps the car's current setting.
- **Off-peak charging**: `kia_access.set_off_peak_charging` with mode `off`, `time` (charge only off-peak) or `target` (prefer off-peak, but finish the charge).

The buttons appear on the device and on the Lovelace card only for these regions. USA and Canada cars don't get them, because the library doesn't support these commands there yet, and calling the services returns a clear error instead.

Examples are in the README under *Windows, valet mode, schedules*.

## [2.112.0] - 2026-10-12

_Windows, charge-port door, charge times and more entities_

### Added

New entities, switched on by default because most cars report them:

- **Windows** — open / closed for each of the four windows.
- **Charge port door** — open / closed.
- **Engine running** — on while the car is on (for an EV, while it's "ready").
- **Time to full** on a **DC rapid**, **AC** and **portable** charger, alongside the existing estimate for the charger you're plugged into.
- **Fault codes** — how many active fault codes the car is reporting (in the device's diagnostics section).

New entities that are **off by default**, because only some regions or models report them (mostly European cars for now). Turn on the ones your car supplies under the device's entity list:

- Tyre pressures for each wheel (shown in your preferred pressure unit)
- EV battery temperature (min / max)
- Range at the AC / DC charge limit
- Departure 1 / 2 times and off-peak start / end
- V2L active and V2L discharge limit
- Energy used, energy regenerated, 30-day consumption
- Oil level low

On the Lovelace card, the details table shows the new readings and skips the off-by-default ones your car doesn't report. With imperial units, battery temperatures, tyre pressures and the charge-limit ranges show as °F, psi and miles.

**MagicMirror MQTT discovery** gets the same entities, and diagnostic entities now land in the device's diagnostics section.

## [2.111.0] - 2026-10-12

_Better diagnostics, library update_

### Added

**Download diagnostics** (Settings → Devices & Services → Kia Access → ⋮ → Download diagnostics) now includes what's needed to answer most bug reports at a glance:

- **Versions** — this integration, the Kia/Hyundai library and Home Assistant.
- **Login** — when the Kia login was set up, roughly when it will need renewing (about 30 days later) and how many days are left. The saved login itself stays out of the file.
- **Polling** — when Home Assistant last heard from Kia, when the car itself last reported, and whether the data counts as stale.

### Changed

The `hyundai_kia_connect_api` library goes from 4.35.0 to 4.35.2. This brings bug fixes for European climate temperature limits and clearer errors from Canadian accounts.

## [2.110.0] - 2026-10-12

_Quiet hours and a wake-up limit for live polling_

### Added

If you have **Poll the car directly** turned on, two new settings decide when a scheduled poll may actually wake the car. Polls that don't wake it read the manufacturer's cached data instead, so the 12V battery gets a rest.

- **Minimum time between wake-ups (minutes)** — skips the wake-up while the car's own last report is newer than this. For example, 1440 wakes it at most once a day. A car that has just reported on its own (driving, charging, the app) isn't woken again.
- **Quiet hours start / end** — scheduled polls never wake the car between these hours (local time). For example, 22 → 7 covers overnight. Set both to the same hour to turn this off.

**Refresh now** still always wakes the car. Both settings are off by default, so nothing changes unless you set them. You'll find them under **Settings → Devices & Services → Kia Access → Configure → Advanced polling**.

### Changed

When a poll fails right after a good one (a timeout, a server hiccup), it's now retried after 60 seconds instead of waiting for the next scheduled poll, so your entities aren't left unavailable for up to 30 minutes. If Kia's servers are actually down, the integration goes back to the normal polling pace rather than retrying every minute.

## [2.109.0] - 2026-10-12

_Fix USA range sometimes reading ~38% low_

### Fixed

On US accounts, Kia occasionally sends a range reading without saying whether it's in miles or km. The integration only converted miles to km when the unit was present, so on those polls a range in **miles was taken as km** — EV range, total range and fuel range read about 38% too low for that update.

Because everything downstream builds on those numbers, a bad poll could also skew the history graphs, trip distances, cost per mile, the "in reach" destinations and range alerts.

A reading with no unit is now treated as the region's own unit (miles for USA). A reading that does say its unit is still converted exactly as before, and nothing changes for other regions.
