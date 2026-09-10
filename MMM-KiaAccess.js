/* global Module, Log */

/* MMM-KiaAccess
 * A MagicMirror² module that shows configurable Kia Connect / Bluelink data.
 * Built for the Kia EV9 (Kia USA) but works with any Hyundai/Kia supported by
 * the `hyundai_kia_connect_api` Python library.
 *
 * By design the node_helper returns the *entire* vehicle attribute set and the
 * frontend flattens it into `path -> value` rows (all keys are under `vehicle.`,
 * plus a `_meta.` block). You choose what to show with
 * `include` / `exclude` / `order` / `labels` / `formatters`.
 */
Module.register("MMM-KiaAccess", {
  defaults: {
    // ---- credentials (Kia Connect / Bluelink account) ----
    username: "",
    password: "",
    pin: "",
    brand: "KIA", // "KIA" | "HYUNDAI" | "GENESIS"
    region: "USA", // "USA" | "CA" | "EU" | "AU" | "CN" | "IN" | "NZ" | "BR"
    vin: "", // optional; first vehicle on the account is used when blank

    // ---- data source ----
    source: "kia", // "kia" = poll Kia directly (default)
                   // "homeassistant" = read from the Kia Access HA integration instead
    homeassistant: {
      url: "", // e.g. "http://homeassistant.local:8123"
      token: "", // a HA long-lived access token
      entity: "", // optional; the "…_status" summary sensor, auto-detected when blank
      mode: "push" // "push" = live WebSocket, instant updates (needs Node >= 22)
                   // "poll" = REST every updateInterval (default 30s in this mode)
    },

    // ---- runtime ----
    pythonBin: "python3", // command used to run kia_bridge.py
    fetchTimeout: 90, // seconds before the bridge process is killed
    forceRefreshTimeout: 45, // seconds to wait for the car's live wake-up (`refresh: true`)
                             // before falling back to Kia's cached copy for this poll

    // ---- polling / reliability ----
    updateInterval: 30 * 60 * 1000, // 30 min. Be gentle: frequent polls drain the 12V battery.
    retryInterval: 5 * 60 * 1000, // base delay between retries after a failure
    backoffMax: 8, // cap the exponential backoff at retryInterval * this
    maxRequestsPerHour: 0, // 0 = no cap. Protects the Kia account from lock-outs.
    refresh: true, // true = ask the car for live data, false = Kia's cached copy
    geocode: false, // true = resolve vehicle.geocode to a street address (OpenStreetMap)
    historyDays: 60, // rolling SoC / 12V history kept on disk (sparkline + drain alert)
    historyMinIntervalMinutes: 30, // don't record history samples closer than this
    otpLifetimeDays: 30, // assumed Kia refresh-token lifetime (used for the expiry warning)
    otpWarnDays: 7, // start showing "OTP expires in N days" this many days out

    // ---- display ----
    header: "Kia",
    units: "imperial", // "imperial" | "metric"
    decimals: 1,
    nullText: "—",
    include: [], // e.g. ["vehicle.ev_battery_percentage", "vehicle.*_door_is_open", "vehicle.odometer"]
    exclude: ["vehicle.data.*", "vehicle.VIN"], // raw API dump + VIN hidden by default
    hideWhenFalsy: [], // paths/globs whose row is dropped when the value is
                       //   false / 0 / null / "" / "—"; use "*" (or [ "*" ]) to
                       //   drop EVERY empty row (tidy while the car hasn't synced)
    order: [], // paths / globs listed here are shown first, in this order
    combine: {}, // { "vehicle.geocode": ["vehicle.location_last_updated_at"] } — fold
                 //   the listed keys onto the primary row ("address · 5 min ago")
    labels: {
      // "vehicle.ev_battery_percentage": "Battery",
    },
    formatters: {
      // key path -> one of:
      // raw | boolean | percent | distanceKm | distanceMi |
      // temperatureC | speedKph | datetime | relativeTime
      "vehicle.ev_battery_percentage": "percent",
      "vehicle.ev_battery_soh_percentage": "percent",
      "vehicle.car_battery_percentage": "percent",
      "vehicle.ev_driving_range": "distanceKm",
      "vehicle.total_driving_range": "distanceKm",
      "vehicle.odometer": "distanceKm",
      "vehicle.next_service_distance": "distanceKm",
      "vehicle.ev_battery_precondition_enabled": "boolean",
      "vehicle.valet_mode_active": "boolean",
      "vehicle.ev_battery_is_charging": "boolean",
      "vehicle.ev_battery_is_plugged_in": "boolean",
      "vehicle.is_locked": "boolean",
      "vehicle.air_control_is_on": "boolean",
      "vehicle.last_updated_at": "relativeTime",
      "vehicle.last_scanned_at": "relativeTime",
      "_meta.fetchedAt": "relativeTime"
    },

    showHeaderCount: true,
    showUpdatedFooter: true,
    showReportedInHeader: false, // append " - as of: <time>" (vehicle.last_updated_at)
                                //   to the header and drop that row from the table
    showTable: true, // false = drop the details table entirely (the diagram +
                     //   widgets carry the state); Range etc. still show via
                     //   visuals.batteryDetail
    maxWidth: "420px",
    animationSpeed: 500,
    debug: false,

    // ---- graphical widgets (all off by default) ----
    visuals: {
      enabled: false,
      car: true, // top-down SUV diagram (doors / frunk / tailgate / charge port / tyres).
                 //   owns lock, 12V %, climate set-point, outside temp — those
                 //   rows are dropped from the table
      battery: true, // vertical battery in the centre of the car (charge % + charging bolt).
                     //   drops the SoC row + the batteryDetail rows from the table
      rowIcons: true, // Font Awesome icon before each table row
      width: 210, // px width for the car SVG (base size)
      scale: 1, // multiplies the whole visuals block — diagram, its fonts, the
                //   sparklines/ring and the readout text. e.g. 1.3 = 130%. 0.5–3.
      compact: false, // one-line summary instead of the diagram + table
      chargeProgress: true, // when plugged in: a progress bar + "full at HH:MM"
      rangeRing: false, // a radial SoC / range gauge under the car
      socHistory: false, // an EV-battery-% sparkline over the last `socHistoryDays`
      socHistoryDays: 14,
      v12History: false, // a 12V-battery-% sparkline (spot vampire drain / a dying 12V)
      v12HistoryDays: 14,
      tripStats: false, // distance / consumption / regen from month_trip_info
      location: {
        enabled: false,
        homeLat: null, // set both to show "N mi from home" AND drive the
        homeLon: null, //   notPluggedInHome alert (no `enabled` needed for that)
        homeRadiusKm: 0.2, // within this of home = "at home"
        map: false, // show a static map image
        mapZoom: 14,
        mapWidth: 210,
        mapHeight: 120,
        // {lat} {lon} {zoom} {w} {h} are substituted. Default is keyless OSM;
        // for reliability use your own provider (Geoapify / Mapbox / …).
        mapUrlTemplate:
          "https://staticmap.openstreetmap.de/staticmap.php?center={lat},{lon}&zoom={zoom}&size={w}x{h}&markers={lat},{lon},red-pushpin",
        // "how far can I drive" readout (needs GPS + ev_driving_range)
        reach: false,
        reachFactor: 0.92, //   haircut on the car's range estimate
        reachReservePct: 10, // arrive with this much charge left
        reachRoundTrip: false, // true = show the "…and get back" distance instead
        reachPois: 4, // how many nearby saved places to list
        pois: [], // [{ name, lat, lon }] — homeLat/homeLon adds an implicit "Home"
        // road-network reachable-area image. `apiKey` (Geoapify) renders the map;
        // `tomtomKey` (TomTom, optional) gives a real isochrone at any distance —
        // without it, anything over ~100 km is a straight-line circle.
        rangeMap: {
          enabled: false,
          apiKey: "",
          tomtomKey: "",
          provider: "geoapify",
          mode: "drive", // drive | bicycle | walk
          style: "osm-bright-grey",
          width: 340,
          height: 220,
          simplifyDeg: 0.01
        }
      },
      chargeCost: {
        enabled: false, // the "est. cost to the target" line while charging
        pricePerKwh: 0, // your all-in marginal home rate, e.g. 0.185
        awayPricePerKwh: 0, // rate for sessions started away from home (public
                            //   chargers). 0 = use the home rate. Needs
                            //   visuals.location.homeLat/homeLon set.
        zoneRates: [], // per-charger rates, checked before home/away:
                       //   [{ name: "Work", lat, lon, radiusKm: 0.1, pricePerKwh: 0.19 }]
                       //   first match wins; a name of "home" keeps that
                       //   session in the home bucket.
        currency: "$",
        capacityKwh: null, // usable pack kWh; falls back to ev_battery_capacity then 99.8 (EV9)
        log: false, // a charge-session history widget (kWh + cost per session + monthly total)
        logMonths: 3, // how far back the widget looks
        logRows: 4, // most recent sessions to list
        logRetentionDays: 180 // sessions kept on disk
      },
      // "Driving times" panel — a standalone list of destinations with live
      // drive time, the route ("via …"), an ETA coloured by traffic delay, and
      // the battery you'd arrive with. Needs source: "homeassistant" and the
      // Kia Access integration's Calendar / Drive-time provider set up (the MM
      // just renders sensor.<v>_range_reach). Falls back to a straight-line
      // estimate over `location.pois` when HA hasn't sent routed data.
      drivingTimes: {
        enabled: false,
        header: "Driving times",
        max: 8, // rows to show
        order: "grouped", // "grouped" (calendar by time -> static -> zones by distance) | "nearest"
        showVia: true, // the "via <roads>" subline
        showConsumption: true, // "· arrive 78% · ~14 kWh"
        packKwh: null, // usable kWh for the kWh estimate (falls back to chargeCost.capacityKwh, then 99.8)
        // ETA colour by traffic delay — % slower than the free-flow time.
        // The highest stop whose `pctOver` the delay reaches wins; null = the
        // normal text colour. Matches MMM-Traffic's typicalGradientStops.
        delayStops: [
          { pctOver: 10, color: "#ffff00" }, // 10%+ slower -> yellow
          { pctOver: 20, color: "#ff9900" }, // 20%+        -> orange
          { pctOver: 35, color: "#ff5555" } //  35%+        -> red
        ],
        hideUnreachable: false, // drop destinations beyond the car's range
        // which HA zones to show here (calendar + static are always shown).
        // [] = every zone HA sent. Names (or "zone.x"), case-insensitive;
        // a "-Name" entry excludes that zone instead.
        zones: []
      },
      // trip log — auto-detected drives (odometer delta + SoC drop): distance,
      // mi/kWh, and cost per trip, plus a rolling total. Uses
      // chargeCost.pricePerKwh / capacityKwh for the £ and kWh maths.
      tripLog: {
        enabled: false,
        days: 30, // window for the rolling total
        rows: 4, // most recent trips to list
        minKm: 0.5, // ignore drives shorter than this
        parkGapMin: 8, // odometer stable this long = parked (ends the trip)
        retentionDays: 365 // trips kept on disk
      },
      // readouts shown under the battery gauge (and removed from the table).
      // Uses your labels / formatters / hideWhenFalsy just like table rows.
      // charge power (kW) + current (A) show on the diagram under the charger
      // while charging, so they're not repeated here by default
      batteryDetail: [
        "vehicle.ev_driving_range",
        "vehicle.ev_estimated_current_charge_duration",
        "vehicle.ev_estimated_fast_charge_duration",
        "vehicle.ev_estimated_station_charge_duration",
        "vehicle.ev_estimated_portable_charge_duration"
      ]
    },
    icons: {}, // key path -> Font Awesome class, overrides the built-in map

    // ---- outgoing notifications when a vehicle state changes ----
    // Edge-triggered: fires only when a condition flips, not every refresh.
    notifications: {
      enabled: false,
      alertModule: true, // also emit SHOW_ALERT for the built-in `alert` module (warning + critical)
      alertSeconds: 15, // warning-level SHOW_ALERT auto-dismiss timer (seconds)
      criticalAlertSeconds: 0, // critical-level alerts: 0 = stay on screen until the condition clears
      // How active issues are kept visible:
      //   persistentBanner: the status bar under the header listing every active
      //                     issue (amber = warning, red = do-not-drive) — default.
      //                     Non-blocking; stays until each condition clears.
      //   criticalPopup:    also throw the centre-screen `alert` modal that dims
      //                     the whole mirror until a critical clears (off by
      //                     default — it's the big blocking box). Either way a
      //                     new issue still gets one brief corner growl as it fires.
      persistentBanner: true,
      criticalPopup: false,
      notifyOnStartup: "critical", // false | "critical" | true — which levels fire on the first data after (re)start
      quietWhileDriving: true, // suppress open-part / unlocked alerts while the car is on
      title: "Kia EV9",
      // Per-condition config. Set any key to `false` to disable it, or pass an
      // object to override its `level` / thresholds. Anything omitted keeps the
      // built-in default (see conditions.js CHECK_DEFAULTS).
      checks: {
        // evBatteryLow:   { belowPct: 20, clearPct: 25, level: "warning" },
        // battery12vLow:  { belowPct: 55, clearPct: 60 },
        // battery12vDrain:{ dropPct: 8, overHours: 12 }, // 12V falling while parked
        // otpExpiring:    { warnDays: 7 },
        // windowOpen: false,
        // chargeInterrupted: { minGapPct: 3 },
        // chargingStarted: false,       // "Charging started — 7.4 kW" (info)
        // serviceDue:      { belowKm: 800 },   // ~500 mi to the next service
        // notPluggedInHome:{ graceMin: 20, afterHour: 16 }, // needs visuals.location.homeLat/Lon
      },

      // ---- optional outbound webhook (node_helper) ----
      // One HTTP POST per edge-triggered event — reaches services an MQTT broker
      // can't (Discord/Slack/IFTTT, a cloud logger, a serverless function). The
      // body is the same shape as the KIA_ACCESS_STATE_CHANGED notification.
      // Needs notifications.enabled: true (set alertModule: false for webhook-only).
      webhook: {
        enabled: false,
        url: "", // https endpoint; one POST per event
        method: "POST",
        headers: {}, // e.g. { Authorization: "Bearer …" }
        events: "all", // "all", or an array of reason slugs to include
        levels: "all", // "all", or an array of ["info","warning","critical"]
        includeState: false, // add the full flattened vehicle state to the body
        timeoutMs: 8000
      }
    },

    // ---- optional MQTT state publisher (node_helper) ----
    // Publishes the full flattened vehicle state to retained topics after every
    // fetch. Needs the `mqtt` npm package (optionalDependency).
    mqtt: {
      enabled: false,
      url: "", // e.g. "mqtt://192.168.1.8:1883"
      username: "",
      password: "",
      topicPrefix: "kia/ev9",
      retain: true,
      publishJson: true, // also publish <prefix>/state as one JSON blob
      homeAssistant: {
        enabled: false, // publish HA MQTT discovery so entities appear automatically
        discoveryPrefix: "homeassistant",
        device: {} // extra fields merged into the HA `device` block
      }
    },

    // ---- optional time-series exporters (node_helper) ----
    // Every numeric / boolean vehicle.* value after each fetch.
    exporter: {
      tags: {}, // extra labels/tags on every point (vin is added automatically)
      influx: {
        url: "", // e.g. "http://192.168.1.8:8086" (InfluxDB v2 or v1.8)
        org: "",
        bucket: "", // required to enable
        token: "",
        measurement: "kia_vehicle",
        timeoutMs: 8000
      },
      prometheus: {
        enabled: false, // true = serve /metrics
        port: 9110,
        path: "/metrics",
        prefix: "kia"
      }
    }
  },

  getStyles() {
    return ["MMM-KiaAccess.css", "font-awesome.css"];
  },

  getScripts() {
    return [
      this.file("core/flatten.js"),
      this.file("core/visuals.js"),
      this.file("core/conditions.js"),
      this.file("core/state.js"),
      this.file("core/sessions.js"),
      this.file("core/trips.js"),
      this.file("core/range.js")
    ];
  },

  start() {
    this.viewData = null;
    this.errorMessage = null;
    this.loading = true;
    this.lastUpdated = null;
    this.utils = typeof KiaAccessUtils !== "undefined" ? KiaAccessUtils : null;
    this.visuals = typeof KiaAccessVisuals !== "undefined" ? KiaAccessVisuals : null;
    this.conditions = typeof KiaConditions !== "undefined" ? KiaConditions : null;
    this.stateBuilder = typeof KiaAccessState !== "undefined" ? KiaAccessState : null;
    this.sessionLib = typeof KiaAccessSessions !== "undefined" ? KiaAccessSessions : null;
    this.tripLib = typeof KiaAccessTrips !== "undefined" ? KiaAccessTrips : null;
    this.flatMap = null;
    this.history = [];
    this.sessions = [];
    this.openSession = null;
    this.trips = [];
    this.openTrip = null;
    this.stale = false;
    this.staleNote = null;
    this.prevCond = {}; // { <reason>: bool, _charging: bool|null }
    this.firstConditionRun = true;
    this.diagramAlerts = []; // [{level,label}] under the diagram's warning triangle
    this.rangeMap = null; // { oneWayUrl, roundTripUrl, … } from node_helper
    this.rangeReach = null; // { pois, oneWayKm, driveTimeSource } from HA (mode C)

    // MagicMirror merges `config` shallowly, so a user-supplied nested block
    // replaces the default wholesale — re-apply the defaults for any missing keys
    const merge = (base, over) => Object.assign({}, base, over || {});
    this.config.visuals = merge(this.defaults.visuals, this.config.visuals);
    this.config.visuals.location = merge(this.defaults.visuals.location, this.config.visuals.location);
    this.config.visuals.location.rangeMap = merge(
      this.defaults.visuals.location.rangeMap,
      this.config.visuals.location.rangeMap
    );
    this.config.visuals.chargeCost = merge(this.defaults.visuals.chargeCost, this.config.visuals.chargeCost);
    this.config.visuals.tripLog = merge(this.defaults.visuals.tripLog, this.config.visuals.tripLog);
    this.config.visuals.drivingTimes = merge(this.defaults.visuals.drivingTimes, this.config.visuals.drivingTimes);
    this.config.icons = merge(this.defaults.icons, this.config.icons);
    this.config.homeassistant = merge(this.defaults.homeassistant, this.config.homeassistant);
    this.config.notifications = merge(this.defaults.notifications, this.config.notifications);
    this.config.notifications.webhook = merge(
      this.defaults.notifications.webhook,
      this.config.notifications.webhook
    );
    this.config.mqtt = merge(this.defaults.mqtt, this.config.mqtt);
    this.config.exporter = merge(this.defaults.exporter, this.config.exporter);
    this.config.exporter.influx = merge(
      this.defaults.exporter.influx, this.config.exporter.influx);
    this.config.exporter.prometheus = merge(
      this.defaults.exporter.prometheus, this.config.exporter.prometheus);
    this.config.mqtt.homeAssistant = merge(
      this.defaults.mqtt.homeAssistant,
      this.config.mqtt.homeAssistant
    );
    this.config.visuals.scale = Math.max(
      0.5, Math.min(3, Number(this.config.visuals.scale) || 1)
    );

    const src = String(this.config.source || "kia").toLowerCase();
    let configErr = null;
    if (src === "homeassistant") {
      const ha = this.config.homeassistant || {};
      if (!ha.url || !ha.token) {
        configErr = "Set homeassistant.url and homeassistant.token in config.js";
      }
      // in push mode the WebSocket is real-time and updateInterval is only a
      // slow liveness/fallback poll; in poll mode it's the actual refresh rate
      const haMode = String((ha.mode || "push")).toLowerCase();
      if (this.config.updateInterval === this.defaults.updateInterval) {
        this.config.updateInterval = haMode === "poll" ? 30 * 1000 : 5 * 60 * 1000;
      }
      if (this.config.retryInterval === this.defaults.retryInterval) {
        this.config.retryInterval = 30 * 1000;
      }
    } else if (!this.config.username || !this.config.password) {
      configErr = "Set username / password / pin in config.js";
    }
    if (configErr) {
      this.errorMessage = configErr;
      this.loading = false;
    } else {
      this.scheduleFetch(0);
    }
  },

  scheduleFetch(delay) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.doFetch(), delay);
  },

  doFetch() {
    if (this.config.debug) Log.info("[MMM-KiaAccess] requesting data");
    this.sendSocketNotification("KIA_FETCH", this.serialisableConfig());
    // watchdog: never leave "Loading …" up forever if the helper goes quiet
    clearTimeout(this._watchdog);
    this._watchdog = setTimeout(() => {
      if (this.loading && !this.rawPayload) {
        this.errorMessage = "no response from the vehicle bridge yet — retrying";
        this.updateDom(this.config.animationSpeed);
      }
      this.scheduleFetch(this.config.retryInterval);
    }, ((this.config.fetchTimeout || 90) + 25) * 1000);
  },

  serialisableConfig() {
    // only what the helper needs
    const c = this.config;
    return {
      username: c.username,
      password: c.password,
      pin: c.pin,
      brand: c.brand,
      region: c.region,
      vin: c.vin,
      source: c.source,
      homeassistant: c.homeassistant,
      refresh: c.refresh,
      geocode: c.geocode || (c.visuals && c.visuals.location && c.visuals.location.enabled),
      pythonBin: c.pythonBin,
      fetchTimeout: c.fetchTimeout,
      forceRefreshTimeout: c.forceRefreshTimeout,
      maxRequestsPerHour: c.maxRequestsPerHour,
      historyDays: c.historyDays,
      historyMinIntervalMinutes: c.historyMinIntervalMinutes,
      chargeLog: {
        pricePerKwh: ((c.visuals || {}).chargeCost || {}).pricePerKwh || 0,
        awayPricePerKwh: ((c.visuals || {}).chargeCost || {}).awayPricePerKwh || 0,
        zoneRates: ((c.visuals || {}).chargeCost || {}).zoneRates || [],
        capacityKwh: ((c.visuals || {}).chargeCost || {}).capacityKwh || null,
        retentionDays: ((c.visuals || {}).chargeCost || {}).logRetentionDays || 180,
        homeLat: ((c.visuals || {}).location || {}).homeLat,
        homeLon: ((c.visuals || {}).location || {}).homeLon,
        homeRadiusKm: ((c.visuals || {}).location || {}).homeRadiusKm || 0.2
      },
      tripLog: {
        minKm: ((c.visuals || {}).tripLog || {}).minKm,
        parkGapMin: ((c.visuals || {}).tripLog || {}).parkGapMin,
        retentionDays: ((c.visuals || {}).tripLog || {}).retentionDays || 365
      },
      mqtt: c.mqtt && c.mqtt.enabled && c.mqtt.url ? c.mqtt : null,
      exporter: this.exporterConfig(),
      rangeMap: this.rangeMapConfig()
    };
  },

  // config the node_helper needs to fetch + build the range-map image
  exporterConfig() {
    const ex = this.config.exporter || {};
    const influxOn = ex.influx && ex.influx.url && ex.influx.bucket;
    const promOn = ex.prometheus && ex.prometheus.enabled;
    if (!influxOn && !promOn) return null;
    return {
      tags: ex.tags || {},
      influx: influxOn ? ex.influx : null,
      prometheus: promOn ? ex.prometheus : null
    };
  },

  rangeMapConfig() {
    const loc = ((this.config.visuals || {}).location) || {};
    const rm = loc.rangeMap || {};
    if (!rm.enabled || !rm.apiKey) return null;
    const pois = Array.isArray(loc.pois) ? loc.pois.slice() : [];
    if (loc.homeLat != null && loc.homeLon != null &&
        !pois.some((p) => /^home$/i.test((p && p.name) || "")))
      pois.unshift({ name: "Home", lat: Number(loc.homeLat), lon: Number(loc.homeLon) });
    return {
      apiKey: rm.apiKey,
      tomtomKey: rm.tomtomKey || "",
      provider: rm.provider || "geoapify",
      mode: rm.mode || "drive",
      style: rm.style || "osm-bright-grey",
      width: Number(rm.width) || 340,
      height: Number(rm.height) || 220,
      simplifyDeg: rm.simplifyDeg != null ? Number(rm.simplifyDeg) : 0.01,
      units: this.config.units,
      factor: loc.reachFactor,
      reservePct: loc.reachReservePct,
      pois: pois
    };
  },

  socketNotificationReceived(notification, data) {
    if (!data || !this.isForMe(data.identifier)) return;
    clearTimeout(this._watchdog);

    if (notification === "KIA_DATA") {
      this.loading = false;
      this.rawPayload = data.payload;
      const m = data.payload._meta || {};
      this.history = data.payload.history || [];
      this.sessions = data.payload.sessions || [];
      this.openSession = data.payload.openSession || null;
      this.trips = data.payload.trips || [];
      this.openTrip = data.payload.openTrip || null;
      if (data.payload.rangeMap) this.rangeMap = data.payload.rangeMap;
      if (data.payload.rangeReach) this.rangeReach = data.payload.rangeReach;
      this.liveChargeTimer(); // start/stop the "cost this charge" refresh
      this.stale = !!m.stale;
      this.staleNote = m.note || null;
      this.errorMessage = m.error || null; // shown as a strip; data still renders
      this.lastUpdated = new Date(m.stale ? m.cachedAt || m.fetchedAt : m.fetchedAt || Date.now());

      // with a short poll interval (mode C) most fetches return identical data —
      // only rebuild / re-render / re-check conditions when something changed
      const sig = JSON.stringify(data.payload.vehicle || {}) +
        "|" + this.stale + "|" + (this.errorMessage || "") + "|" + (this.staleNote || "") +
        "|" + (((this.config.visuals || {}).drivingTimes || {}).enabled
          ? JSON.stringify((data.payload.rangeReach || {}).pois || []) +
            "|" + ((data.payload.rangeReach || {}).mmZones || "") : "");
      if (sig !== this._lastSig) {
        this._lastSig = sig;
        this.rebuildView();
        this.processConditions();
        this.updateDom(this.config.animationSpeed);
      }
      this.scheduleFetch(this.nextDelay(m.failStreak || 0, m.retryAfterMs));
    } else if (notification === "KIA_ERROR") {
      this.loading = false;
      this.errorMessage = data.error || "Unknown error";
      Log.error("[MMM-KiaAccess] " + this.errorMessage);
      this.updateDom(this.config.animationSpeed);
      this.scheduleFetch(this.nextDelay(data.failStreak || 1, data.retryAfterMs));
    } else if (notification === "KIA_RANGE_MAP") {
      this.rangeMap = data.rangeMap || this.rangeMap;
      this.updateDom(0);
    }
  },

  nextDelay(failStreak, retryAfterMs) {
    if (retryAfterMs) return retryAfterMs;
    if (!failStreak) return this.config.updateInterval;
    const cap = this.config.retryInterval * (this.config.backoffMax || 8);
    return Math.min(this.config.retryInterval * Math.pow(2, failStreak - 1), cap);
  },

  isForMe(identifier) {
    // node_helper builds the identifier the same way from our serialisable config
    const c = this.serialisableConfig();
    const mine = [c.region, c.brand, c.username, c.vin || "auto"].join("|");
    return identifier === mine;
  },

  rebuildView() {
    if (!this.utils || !this.rawPayload) {
      this.viewData = [];
      return;
    }
    const flat = this.utils.flatten(this.rawPayload);
    this.flatMap = flat;
    let entries = this.utils.selectEntries(flat, this.config);

    // anything a widget already shows is dropped from the table so it isn't
    // said twice. battery widget → SoC + the batteryDetail readouts; car
    // diagram → lock (body colour), 12V %, climate set-point, outside temp.
    const vis = this.config.visuals || {};
    if (this.visuals && vis.enabled && !vis.compact) {
      const moved = new Set();
      if (vis.battery) {
        moved.add("vehicle.ev_battery_percentage");
        (vis.batteryDetail || []).forEach((k) => moved.add(k));
      }
      if (vis.car) {
        [
          "vehicle.is_locked",
          "vehicle.car_battery_percentage",
          "vehicle.air_temperature",
          "vehicle.outside_temperature"
        ].forEach((k) => moved.add(k));
      }
      entries = entries.filter((e) => !moved.has(e.key));
    }
    // "car last reported" can live in the header instead of the table
    if (this.config.showReportedInHeader) {
      entries = entries.filter((e) => e.key !== "vehicle.last_updated_at");
    }
    this.viewData = this.applyCombine(entries);
  },

  // vehicle.last_updated_at as a short "as of" string for the header:
  // "14:32" today, "Sep 7 14:32" otherwise, null if missing / unparseable
  reportedAt() {
    const raw = (this.flatMap || {})["vehicle.last_updated_at"];
    if (raw == null || raw === "") return null;
    let d;
    const m = String(raw).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    else d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    // follow the mirror's global 12/24h setting when it's reachable
    const h12 =
      typeof config !== "undefined" && config && config.timeFormat === 12;
    const time = d.toLocaleTimeString([], {
      hour: h12 ? "numeric" : "2-digit",
      minute: "2-digit",
      hour12: h12
    });
    return d.toDateString() === new Date().toDateString()
      ? time
      : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
  },

  // `combine: { "vehicle.geocode": ["vehicle.location_last_updated_at"] }` folds
  // the listed keys onto the primary row ("address · 5 min ago"). The folded
  // keys never render as their own rows — with or without a value — so the
  // layout doesn't shuffle as data comes and goes. If the primary itself has
  // no value and nothing folded in, the whole row is dropped.
  applyCombine(entries) {
    const combine = this.config.combine || {};
    const keys = Object.keys(combine);
    if (!keys.length) return entries;
    const nul = this.config.nullText;
    const byKey = {};
    entries.forEach((e) => { byKey[e.key] = e; });
    const drop = new Set();
    keys.forEach((primary) => {
      const secondary = combine[primary] || [];
      secondary.forEach((k) => drop.add(k)); // always fold away, value or not
      const host = byKey[primary];
      if (!host) return;
      const parts = secondary
        .map((k) => byKey[k])
        .filter(Boolean)
        .map((e) => this.utils.formatValue(e, this.config))
        .filter((v) => v && v !== nul);
      if (parts.length) host.combinedSuffix = parts.join(" · ");
      const hostVal = this.utils.formatValue(host, this.config);
      if (!host.combinedSuffix && (!hostVal || hostVal === nul)) drop.add(primary);
    });
    return entries.filter((e) => !drop.has(e.key));
  },

  batteryDetailEntries() {
    const vis = this.config.visuals || {};
    const keys = vis.batteryDetail || [];
    const f = this.flatMap || {};
    const labels = this.config.labels || {};
    const hideCfg = this.config.hideWhenFalsy || [];
    const hideAllEmpty = hideCfg === true || hideCfg === "*" ||
      (Array.isArray(hideCfg) && hideCfg.indexOf("*") !== -1);
    const hide = Array.isArray(hideCfg) ? hideCfg : [];
    return keys
      .filter((k) => Object.prototype.hasOwnProperty.call(f, k))
      .map((k) => ({
        key: k,
        label: labels[k] || this.utils.prettifyKey(k),
        rawValue: f[k]
      }))
      .filter(
        (e) =>
          !this.utils.isEmptyValue(e.rawValue) ||
          (!hideAllEmpty && !this.utils.matchesAny(e.key, hide))
      );
  },

  // canonical vehicle state for the diagram + conditions — delegated to the
  // shared core/state.js (loaded via getScripts) so MM, the HA card and the
  // contract tests all run the identical logic. Cached per flatMap: getDom()
  // and processConditions() ask for it many times per cycle.
  visualState() {
    if (!this.stateBuilder) return {}; // core/state.js failed to load
    if (this._stateCache && this._stateCacheKey === this.flatMap) {
      return this._stateCache;
    }
    this._stateCache = this.stateBuilder.buildState(this.flatMap || {}, {
      history: this.history || [],
      units: this.config.units,
      otpLifetimeDays: this.config.otpLifetimeDays,
      otpWarnDays: this.config.otpWarnDays
    });
    this._stateCacheKey = this.flatMap;
    return this._stateCache;
  },

  // is the car within homeRadiusKm of the configured home point?
  atHome(st) {
    const loc = (this.config.visuals && this.config.visuals.location) || {};
    if (loc.homeLat == null || loc.homeLon == null ||
        st.locationLat == null || st.locationLon == null) {
      return undefined; // no home configured / no fix — check stays inert
    }
    const km = this.haversineKm(
      st.locationLat, st.locationLon, Number(loc.homeLat), Number(loc.homeLon)
    );
    return km <= (Number(loc.homeRadiusKm) || 0.2);
  },

  // edge-triggered vehicle-state notifications
  processConditions() {
    if (!this.conditions || !this.flatMap) return;
    const cfg = this.config.notifications || {};

    // clone the (memoised) state so the home context doesn't pollute the cache
    const st = Object.assign({}, this.visualState());
    st.atHome = this.atHome(st);
    const homeUnplugged = st.atHome === true && st.plugged !== true;
    if (homeUnplugged && !this._homeUnpluggedSince) this._homeUnpluggedSince = Date.now();
    if (!homeUnplugged) this._homeUnpluggedSince = null;
    st.homeUnpluggedMin = this._homeUnpluggedSince
      ? (Date.now() - this._homeUnpluggedSince) / 60000 : null;

    // distance car -> configured home (km) for the "can't get home" check
    const _loc = (this.config.visuals && this.config.visuals.location) || {};
    st.homeDistanceKm = (_loc.homeLat != null && st.locationLat != null)
      ? this.haversineKm(st.locationLat, st.locationLon,
          Number(_loc.homeLat), Number(_loc.homeLon))
      : null;

    // moved-while-parked (tow / theft): GPS shifted while the odometer stayed
    // put and the car was off. Track how far and for how long.
    const now = Date.now();
    const p = this._lastParked;
    const odoStable = p && st.odometerKm != null && Math.abs(st.odometerKm - p.odo) < 0.1;
    if (odoStable && st.carOn !== true && st.locationLat != null && p.lat != null) {
      const movedKm = this.haversineKm(p.lat, p.lon, st.locationLat, st.locationLon);
      if (movedKm != null && movedKm >= 0.15) {
        if (!this._movedSince) this._movedSince = now;
        st.movedWhileParkedKm = movedKm;
        st.movedWhileParkedMin = (now - this._movedSince) / 60000;
      } else {
        this._movedSince = null;
        st.movedWhileParkedKm = 0;
        st.movedWhileParkedMin = 0;
      }
    } else {
      // driven, or first sample, or no GPS — (re)anchor the parked position
      this._movedSince = null;
      if (st.locationLat != null && st.odometerKm != null) {
        this._lastParked = { lat: st.locationLat, lon: st.locationLon, odo: st.odometerKm };
      }
      st.movedWhileParkedKm = this._lastParked ? 0 : null;
      st.movedWhileParkedMin = 0;
    }

    if (this.config.debug) {
      const loc = (this.config.visuals && this.config.visuals.location) || {};
      Log.info("[MMM-KiaAccess] home check: " + JSON.stringify({
        carLat: st.locationLat, carLon: st.locationLon,
        homeLat: loc.homeLat, homeLon: loc.homeLon, radiusKm: loc.homeRadiusKm,
        distKm: (st.locationLat != null && loc.homeLat != null)
          ? +this.haversineKm(st.locationLat, st.locationLon,
              Number(loc.homeLat), Number(loc.homeLon)).toFixed(3) : null,
        atHome: st.atHome, plugged: st.plugged,
        homeUnpluggedMin: st.homeUnpluggedMin == null
          ? null : +st.homeUnpluggedMin.toFixed(1)
      }));
    }

    const res = this.conditions.evaluate(st, cfg, this.prevCond);

    if (this.config.debug) {
      const hp = res.conditions.find((c) => c.reason === "not_plugged_home");
      Log.info("[MMM-KiaAccess] not_plugged_home -> " +
        (hp ? JSON.stringify({ level: hp.level, active: hp.active, message: hp.message })
            : "check not evaluated (disabled or driving)"));
    }

    // any active critical condition -> the diagram shows a warning triangle
    // (independent of whether the `alert` notifications are enabled)
    this.hasCritical = res.conditions.some(
      (c) => c.level === "critical" && c.active === true
    );
    // reasons the diagram's warning triangle lists underneath itself
    this.diagramAlerts =
      this.visuals && this.visuals.alertLabels
        ? this.visuals.alertLabels(res.conditions)
        : [];

    if (cfg.enabled) this.fireNotifications(res, cfg);

    // keep prevCond fresh for the hysteresis dead-bands regardless of alerts
    res.conditions.forEach((c) => {
      if (c.active !== null) this.prevCond[c.reason] = c.active;
    });
    this.prevCond._charging = res.meta.charging;
    this.firstConditionRun = false;
  },

  fireNotifications(res, cfg) {
    const vin = (this.rawPayload && this.rawPayload.vehicle && this.rawPayload.vehicle.VIN) || null;
    const startup = this.firstConditionRun;
    const startupAllows = (level) =>
      cfg.notifyOnStartup === true ||
      (cfg.notifyOnStartup === "critical" && level === "critical");

    this.announcedActive = this.announcedActive || {};
    const fired = [];
    res.conditions.forEach((c) => {
      const was = this.prevCond[c.reason];
      const becameActive = c.active === true && was !== true;
      // only announce a "cleared" if we actually announced it becoming active
      const cleared =
        !c.oneShot && c.active === false && was === true && this.announcedActive[c.reason];

      const fire = startup ? becameActive && startupAllows(c.level) : becameActive || cleared;
      if (becameActive && fire) this.announcedActive[c.reason] = true;
      if (cleared) this.announcedActive[c.reason] = false;
      if (fire) {
        const event = {
          reason: c.reason,
          level: c.level,
          active: c.active,
          title: c.title,
          message: c.message,
          value: c.value,
          vin: vin,
          at: new Date().toISOString()
        };
        fired.push(event);
        this.sendNotification("KIA_ACCESS_STATE_CHANGED", event);
        if (cfg.alertModule !== false && (c.level === "warning" || c.level === "critical")) {
          const critical = c.level === "critical";
          const secs = critical
            ? (cfg.criticalAlertSeconds != null ? cfg.criticalAlertSeconds : 0)
            : (cfg.alertSeconds != null ? cfg.alertSeconds : 15);
          // A `notification`-type alert ALWAYS gets a ttl from the alert module
          // (its display_time when no timer is given) — it can't truly persist.
          // Only a `type: "alert"` with no `timer` stays until HIDE_ALERT — and
          // that one dims the whole mirror, so it's opt-in (cfg.criticalPopup).
          // Otherwise a still-active critical lives in the in-module banner
          // (see getDom) and only throws a brief corner growl as it fires.
          const wantsModal = critical && !(secs > 0) && cfg.criticalPopup === true;
          if (becameActive) {
            const alert = { title: c.title, message: c.message };
            if (wantsModal) {
              alert.type = "alert"; // centre popup, stays until HIDE_ALERT
            } else {
              alert.type = "notification"; // corner growl
              alert.timer = (secs > 0 ? secs : 15) * 1000;
            }
            this.sendNotification("SHOW_ALERT", alert);
            this._alertShown = this._alertShown || {};
            if (wantsModal) this._alertShown[c.reason] = true;
          } else if (cleared && this._alertShown && this._alertShown[c.reason]) {
            // a persistent modal's condition cleared — dismiss it
            this.sendNotification("HIDE_ALERT");
            this._alertShown[c.reason] = false;
          }
        }
      }
    });

    // hand any fired events to node_helper for the outbound webhook (it applies
    // the events/levels filter and does the HTTP POST off the main process)
    const hook = cfg.webhook || {};
    if (hook.enabled && hook.url && fired.length) {
      this.sendSocketNotification("KIA_WEBHOOK", {
        events: fired,
        webhook: hook,
        state: hook.includeState ? this.flatMap : null
      });
    }
  },

  // let another module (or a button) force an immediate refresh
  notificationReceived(notification) {
    if (notification === "MMM_KIA_ACCESS_REFRESH") {
      this.scheduleFetch(0);
    }
  },

  // ---------- small helpers for the optional widgets ----------

  // user scale for the whole visuals block (clamped in start())
  visScale() {
    return (this.config.visuals && this.config.visuals.scale) || 1;
  },

  // scaled px width for the car SVG + the sparklines / charge bar
  visWidth() {
    const base = (this.config.visuals && this.config.visuals.width) || 210;
    return Math.round(base * this.visScale());
  },

  agoText(date) {
    if (!date) return "";
    const mins = Math.round((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return hrs + " h ago";
    return Math.round(hrs / 24) + " d ago";
  },

  fmtDist(km) {
    if (km == null || isNaN(km)) return null;
    return this.config.units === "metric"
      ? Math.round(km) + " km"
      : Math.round(km * 0.621371) + " mi";
  },

  // distance in km between two lat/lon (haversine)
  haversineKm(a, b, c, d) {
    const R = 6371;
    const p = Math.PI / 180;
    const h =
      0.5 -
      Math.cos((c - a) * p) / 2 +
      (Math.cos(a * p) * Math.cos(c * p) * (1 - Math.cos((d - b) * p))) / 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  },

  compactLine() {
    const s = this.visualState();
    const bits = [];
    if (s.batteryPct != null) bits.push(Math.round(s.batteryPct) + "%");
    const range = this.fmtDist(s.rangeKm);
    if (range) bits.push(range);
    if (s.locked === true) bits.push("🔒");
    else if (s.locked === false) bits.push("🔓");
    if (s.charging === true) bits.push("⚡" + (s.chargeKw ? " " + s.chargeKw + " kW" : ""));
    else if (s.plugged === true) bits.push("🔌");
    return bits.join(" · ");
  },

  // while a charge session is open, re-render every 30s so the running cost
  // keeps climbing between polls
  liveChargeTimer() {
    const want = !!this.openSession;
    if (want && !this._liveTimer) {
      this._liveTimer = setInterval(() => this.updateDom(0), 30000);
    } else if (!want && this._liveTimer) {
      clearInterval(this._liveTimer);
      this._liveTimer = null;
    }
  },

  // "£1.23 this charge · 6.7 kWh" for the session in progress, or null
  sessionCostLine() {
    const cc = (this.config.visuals || {}).chargeCost || {};
    if (!this.sessionLib || !this.openSession) return null;
    const s = this.visualState();
    if (s.charging !== true) return null;
    const p = this.sessionLib.progress(this.openSession, {
      t: Date.now(), charging: true,
      batteryPct: s.batteryPct, chargeKw: s.chargeKw
    }, {
      pricePerKwh: cc.pricePerKwh,
      capacityKwh: cc.capacityKwh || s.capacityKwh
    });
    if (!p || p.kwh == null) return null;
    const kwh = (Math.round(p.kwh * 10) / 10) + " kWh";
    return p.cost != null
      ? (cc.currency || "$") + p.cost.toFixed(2) + " this charge · " + kwh
      : kwh + " this charge";
  },

  // charge progress bar + "full at HH:MM" when plugged in
  chargeProgressEl() {
    const s = this.visualState();
    if (!(this.config.visuals || {}).chargeProgress) return null;
    if (s.charging !== true && s.plugged !== true) return null;
    const el = document.createElement("div");
    el.className = "kiaaccess-visuals";
    const target = s.chargeLimitPct;
    el.innerHTML = this.visuals.chargeBar(s.batteryPct, target, {
      width: this.visWidth()
    });
    const mins = Number(
      (this.flatMap || {})["vehicle.ev_estimated_current_charge_duration"]
    );
    const cap = document.createElement("div");
    cap.className = "kiaaccess-batt-detail";
    let msg = s.charging === true ? "Charging" : "Plugged in, not charging";
    if (s.charging === true && isFinite(mins) && mins >= 1) {
      const t = Math.round(mins);
      const h = Math.floor(t / 60);
      const hm = h ? (t % 60 ? h + "h " + (t % 60) + "m" : h + "h") : t % 60 + "m";
      const done = new Date(Date.now() + mins * 60000);
      const to = target && target < 100 ? target + "%" : "full";
      msg = hm + " → " + to + " at " +
        done.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    let html = '<div><span class="kiaaccess-bd-value">' + this.escape(msg) + "</span></div>";
    const costLine = this.sessionCostLine();
    if (costLine) {
      html += '<div><span class="kiaaccess-bd-value">' + this.escape(costLine) + "</span></div>";
    }
    cap.innerHTML = html;
    el.appendChild(cap);
    return el;
  },

  rangeRingEl() {
    const s = this.visualState();
    if (!(this.config.visuals || {}).rangeRing || s.batteryPct == null) return null;
    const el = document.createElement("div");
    el.className = "kiaaccess-visuals";
    el.innerHTML = this.visuals.rangeRing(s.batteryPct, {
      charging: s.charging,
      centreText: this.fmtDist(s.rangeKm) || "",
      size: Math.round(132 * this.visScale())
    });
    return el;
  },

  historySparkEl(series, days, color, caption) {
    const cutoff = Date.now() - days * 864e5;
    const pts = (this.history || [])
      .filter((h) => h && h.t >= cutoff && h[series] != null)
      .map((h) => ({ t: h.t, v: h[series] }));
    if (pts.length < 2) return null;
    const last = pts[pts.length - 1].v;
    const el = document.createElement("div");
    el.className = "kiaaccess-visuals";
    el.innerHTML = this.visuals.sparkline(pts, {
      width: this.visWidth(),
      height: Math.round(40 * this.visScale()),
      color: color
    });
    const cap = document.createElement("div");
    cap.className = "kiaaccess-batt-detail";
    cap.innerHTML =
      '<div><span class="kiaaccess-bd-label">' +
      this.escape(caption) +
      '</span><span class="kiaaccess-bd-value">' +
      Math.round(last) +
      "%</span></div>";
    el.appendChild(cap);
    return el;
  },

  socHistoryEl() {
    const vis = this.config.visuals || {};
    if (!vis.socHistory) return null;
    const days = vis.socHistoryDays || 14;
    return this.historySparkEl("ev", days, this.visuals.COL.ok, "EV battery, last " + days + " d");
  },

  v12HistoryEl() {
    const vis = this.config.visuals || {};
    if (!vis.v12History) return null;
    const days = vis.v12HistoryDays || 14;
    return this.historySparkEl("v12", days, this.visuals.COL.warn, "12V battery, last " + days + " d");
  },

  locationEl() {
    const cfg = (this.config.visuals || {}).location || {};
    if (!cfg.enabled) return null;
    const f = this.flatMap || {};
    const lat = Number(f["vehicle.location_latitude"]);
    const lon = Number(f["vehicle.location_longitude"]);
    if (!isFinite(lat) || !isFinite(lon)) return null;

    const el = document.createElement("div");
    el.className = "kiaaccess-visuals kiaaccess-location";
    const lines = [];
    if (cfg.homeLat != null && cfg.homeLon != null) {
      const km = this.haversineKm(lat, lon, Number(cfg.homeLat), Number(cfg.homeLon));
      lines.push(km < 0.15 ? "At home" : (this.fmtDist(km) || "") + " from home");
    }
    const addr = f["vehicle.geocode"] || f["vehicle.location_name"];
    if (addr && addr !== "—") lines.push(String(addr));
    // "where did I park" — a maps link (opens on a phone) when the car is off
    if (cfg.parkedLink !== false && f["vehicle.engine_is_running"] !== true &&
        f["vehicle.engine_is_running"] !== "true") {
      lines.push("maps.google.com/?q=" + lat.toFixed(5) + "," + lon.toFixed(5));
    }
    if (lines.length) {
      const t = document.createElement("div");
      t.className = "kiaaccess-batt-detail";
      t.innerHTML = lines
        .map((l) => '<div><span class="kiaaccess-bd-value">' + this.escape(l) + "</span></div>")
        .join("");
      el.appendChild(t);
    }

    // "how far can I drive" + which saved places are in reach
    if (cfg.reach && typeof KiaAccessRange !== "undefined") {
      const st = this.visualState();
      const pois = (cfg.pois || []).slice();
      if (cfg.homeLat != null && cfg.homeLon != null &&
          !pois.some((p) => /^home$/i.test((p && p.name) || "")))
        pois.unshift({ name: "Home", lat: Number(cfg.homeLat), lon: Number(cfg.homeLon) });
      const sum = KiaAccessRange.summary(lat, lon, st.rangeKm, pois, {
        factor: cfg.reachFactor,
        reservePct: cfg.reachReservePct,
        roundTrip: cfg.reachRoundTrip === true,
        batteryPct: st.batteryPct,
        roadFactor: cfg.reachRoadFactor || 1.3
      });
      if (sum.reachKm != null) {
        const rb = document.createElement("div");
        rb.className = "kiaaccess-batt-detail kiaaccess-reach";
        const alt = sum.roundTrip ? sum.oneWayKm : sum.roundTripKm;
        const head =
          (sum.roundTrip ? "There & back: " : "One-way reach: ") +
          (this.fmtDist(sum.reachKm) || "?") +
          (alt != null ? "  (" + (sum.roundTrip ? "one-way " : "round trip ") +
            (this.fmtDist(alt) || "?") + ")" : "");
        let html =
          '<div><span class="kiaaccess-bd-value">' + this.escape(head) + "</span></div>";
        const hm = (t) => {
          if (t == null || !isFinite(t)) return "";
          const h = Math.floor(t / 60);
          return h ? (t % 60 ? h + "h " + (t % 60) + "m" : h + "h") : (t % 60) + "m";
        };
        sum.pois.slice(0, Number(cfg.reachPois) || 4).forEach((p) => {
          const d = this.fmtDist(p.km) || "";
          const dur = p.durationMin != null ? " · " + hm(p.durationMin) : "";
          const arr = p.arrivalPct != null ? " · arrive " + p.arrivalPct + "%" : "";
          const tail = p.reachable
            ? d + dur + arr
            : d + dur + " · " + (this.fmtDist(-p.marginKm) || "") + " short";
          html +=
            '<div class="kiaaccess-reach-poi ' + (p.reachable ? "ok" : "no") +
            '"><span class="kiaaccess-bd-label">' +
            (p.reachable ? "✓ " : "✗ ") + this.escape(p.name || "?") +
            '</span><span class="kiaaccess-bd-value">' + this.escape(tail) + "</span></div>";
        });
        rb.innerHTML = html;
        el.appendChild(rb);
      }
    }

    // road-network reachable-area image (built by node_helper via Geoapify)
    if ((cfg.rangeMap || {}).enabled && this.rangeMap) {
      const rt = cfg.reachRoundTrip === true;
      const url = rt ? this.rangeMap.roundTripUrl : this.rangeMap.oneWayUrl;
      const approx = rt ? this.rangeMap.roundTripApprox : this.rangeMap.oneWayApprox;
      if (url) {
        const img = document.createElement("img");
        img.className = "kiaaccess-map kiaaccess-rangemap";
        img.src = url;
        img.alt = "reachable driving area";
        img.loading = "lazy";
        img.style.width = (cfg.rangeMap.width || 340) + "px";
        img.onerror = () => img.remove();
        el.appendChild(img);
        if (approx) {
          const c = document.createElement("div");
          c.className = "kiaaccess-bd-label xsmall";
          c.style.textAlign = "center";
          c.textContent = "straight-line radius (road isochrone under 60 mi range)";
          el.appendChild(c);
        }
      }
    }

    if (cfg.map) {
      const url = String(cfg.mapUrlTemplate || "")
        .replace(/{lat}/g, lat)
        .replace(/{lon}/g, lon)
        .replace(/{zoom}/g, cfg.mapZoom || 14)
        .replace(/{w}/g, cfg.mapWidth || 210)
        .replace(/{h}/g, cfg.mapHeight || 120);
      const img = document.createElement("img");
      img.className = "kiaaccess-map";
      img.src = url;
      img.alt = "vehicle location";
      img.loading = "lazy";
      img.style.width = (cfg.mapWidth || 210) + "px";
      img.onerror = () => img.remove();
      el.appendChild(img);
    }
    return el.childNodes.length ? el : null;
  },

  tripStatsEl() {
    if (!(this.config.visuals || {}).tripStats) return null;
    const f = this.flatMap || {};
    const g = (k) => {
      const v = f["vehicle.month_trip_info." + k];
      return v == null || v === "" ? null : v;
    };
    const rows = [
      ["This month", this.fmtDist(Number(g("distance"))), Number(g("distance")) != null],
      ["Avg consumption", g("average_consumption") != null ? g("average_consumption") + " Wh/km" : null],
      ["Regen", g("regenerated_energy") != null ? g("regenerated_energy") + " Wh" : null]
    ].filter((r) => r[1] != null);
    if (!rows.length) return null;
    const el = document.createElement("div");
    el.className = "kiaaccess-batt-detail";
    el.innerHTML =
      '<div class="kiaaccess-bd-label" style="text-align:center;margin-bottom:2px">Trip stats</div>' +
      rows
        .map(
          (r) =>
            '<div><span class="kiaaccess-bd-label">' +
            this.escape(r[0]) +
            '</span><span class="kiaaccess-bd-value">' +
            this.escape(r[1]) +
            "</span></div>"
        )
        .join("");
    return el;
  },

  // charge-session log — recent sessions + a rolling total
  chargeLogEl() {
    const cc = (this.config.visuals || {}).chargeCost || {};
    if (!cc.log) return null;
    const list = (this.sessions || []).slice()
      .filter((x) => x && x.endedAt)
      .sort((a, b) => b.endedAt - a.endedAt);
    if (!list.length) return null;

    const cur = (n) => (cc.currency || "$") + Number(n).toFixed(2);
    const kwh = (n) => (Math.round(Number(n) * 10) / 10) + " kWh";
    const val = (x) =>
      (x.kwh != null ? kwh(x.kwh) : "") +
      (x.cost != null ? " · " + cur(x.cost) : "") || "—";

    const months = cc.logMonths || 3;
    const sum = this.sessionLib
      ? this.sessionLib.summary(list, months * 30)
      : { kwh: null, cost: null };

    const anyAway = list.some((x) => x.location != null && x.location !== "home") ||
      (cc.awayPricePerKwh || 0) > 0 ||
      (Array.isArray(cc.zoneRates) && cc.zoneRates.length > 0);

    const el = document.createElement("div");
    el.className = "kiaaccess-batt-detail";
    const rows = list.slice(0, cc.logRows || 4).map((x) => {
      const away = x.location != null && x.location !== "home";
      const mark = anyAway ? (away ? "📍 " : "🏠 ") : "";
      return '<div><span class="kiaaccess-bd-label">' + mark +
        this.escape(this.agoText(new Date(x.endedAt))) +
        '</span><span class="kiaaccess-bd-value">' + this.escape(val(x)) + "</span></div>";
    }).join("");
    const totLine = (label, o) =>
      '<span class="kiaaccess-bd-label">' + label + '</span>' +
      '<span class="kiaaccess-bd-value">' + this.escape(
        (o && o.kwh != null ? kwh(o.kwh) : "—") +
        (o && o.cost != null ? " · " + cur(o.cost) : "")
      ) + "</span>";
    let total =
      '<div style="opacity:.85;border-top:1px solid rgba(255,255,255,.15);margin-top:3px;padding-top:3px">' +
      totLine("Last " + months + " mo", sum) + "</div>";
    if (anyAway && sum.home && sum.away && sum.away.count) {
      total +=
        '<div style="opacity:.7">' + totLine("· home", sum.home) + "</div>" +
        '<div style="opacity:.7">' + totLine("· away", sum.away) + "</div>";
    }
    el.innerHTML =
      '<div class="kiaaccess-bd-label" style="text-align:center;margin-bottom:2px">Charging log</div>' +
      rows + total;
    return el;
  },

  // trip log — recent drives + a rolling distance / efficiency / cost total
  tripLogEl() {
    const tl = (this.config.visuals || {}).tripLog || {};
    if (!tl.enabled) return null;
    const list = (this.trips || []).slice()
      .filter((x) => x && x.endedAt)
      .sort((a, b) => b.endedAt - a.endedAt);
    if (!list.length) return null;

    const cc = (this.config.visuals || {}).chargeCost || {};
    const cur = (n) => (cc.currency || "$") + Number(n).toFixed(2);
    const imperial = this.config.units !== "metric";
    const dist = (x) => imperial
      ? (x.distanceMi != null ? x.distanceMi + " mi" : "—")
      : (x.distanceKm != null ? x.distanceKm + " km" : "—");
    const eff = (x) => x.miPerKwh != null ? x.miPerKwh + " mi/kWh" : null;
    const val = (x) => [dist(x), eff(x), x.cost != null ? cur(x.cost) : null]
      .filter(Boolean).join(" · ");

    const days = tl.days || 30;
    const sum = this.tripLib ? this.tripLib.summary(list, days) : null;

    const el = document.createElement("div");
    el.className = "kiaaccess-batt-detail";
    const rows = list.slice(0, tl.rows || 4).map((x) =>
      '<div><span class="kiaaccess-bd-label">' +
      this.escape(this.agoText(new Date(x.endedAt))) +
      '</span><span class="kiaaccess-bd-value">' + this.escape(val(x)) + "</span></div>"
    ).join("");
    let total = "";
    if (sum && sum.count) {
      const td = imperial ? sum.distanceMi + " mi" : sum.distanceKm + " km";
      const tbits = [
        td,
        sum.miPerKwh != null ? sum.miPerKwh + " mi/kWh" : null,
        sum.costPerMi != null ? cur(sum.costPerMi) + "/mi" : null
      ].filter(Boolean).join(" · ");
      total =
        '<div style="opacity:.85;border-top:1px solid rgba(255,255,255,.15);margin-top:3px;padding-top:3px">' +
        '<span class="kiaaccess-bd-label">Last ' + days + ' d</span>' +
        '<span class="kiaaccess-bd-value">' + this.escape(tbits) + "</span></div>";
    }
    el.innerHTML =
      '<div class="kiaaccess-bd-label" style="text-align:center;margin-bottom:2px">Trips</div>' +
      rows + total;
    return el;
  },

  // "Driving times" — a standalone destinations panel (drive time + route +
  // traffic-delay colour + arrival battery). Prefers HA's routed data
  // (this.rangeReach from sensor.<v>_range_reach); falls back to a local
  // straight-line estimate over location.pois.
  drivingTimesEl() {
    const dt = (this.config.visuals || {}).drivingTimes || {};
    if (!dt.enabled) return null;

    const hm = (t) => {
      if (t == null || !isFinite(t)) return "";
      t = Math.round(t);
      const h = Math.floor(t / 60);
      return h ? (t % 60 ? h + "h " + (t % 60) + "m" : h + "h") : t + "m";
    };

    let rows = [];
    const rr = this.rangeReach && Array.isArray(this.rangeReach.pois)
      ? this.rangeReach.pois : null;
    if (rr && rr.length) {
      rows = rr.map((p) => ({
        name: p.name,
        entityId: p.entity_id || null,
        source: p.source || "zone",
        km: Number(p.km),
        durationMin: p.duration_min != null ? Number(p.duration_min) : null,
        delayMin: p.delay_min != null ? Number(p.delay_min) : null,
        delayPct: p.delay_pct != null ? Number(p.delay_pct) : null,
        via: p.via || null,
        whenLocal: p.when_local || null,
        when: p.when || null,
        arrivalPct: p.arrival_pct != null ? Number(p.arrival_pct) : null,
        reachable: p.reachable !== false,
        routed: !!p.routed
      }));
    } else if (typeof KiaAccessRange !== "undefined") {
      // local fallback: no calendar, no traffic, estimated times
      const st = this.visualState();
      const loc = (this.config.visuals || {}).location || {};
      const pois = (loc.pois || []).slice();
      if (loc.homeLat != null && loc.homeLon != null &&
          !pois.some((p) => /^home$/i.test((p && p.name) || "")))
        pois.unshift({ name: "Home", lat: Number(loc.homeLat), lon: Number(loc.homeLon) });
      if (st.locationLat == null || st.locationLon == null || st.rangeKm == null) return null;
      const sum = KiaAccessRange.summary(st.locationLat, st.locationLon, st.rangeKm, pois, {
        factor: loc.reachFactor, reservePct: loc.reachReservePct,
        batteryPct: st.batteryPct, roadFactor: loc.reachRoadFactor || 1.3
      });
      rows = (sum.pois || []).map((p) => ({
        name: p.name, source: "zone", km: Number(p.km),
        durationMin: p.durationMin != null ? Number(p.durationMin) : null,
        delayMin: null, delayPct: null, via: null, whenLocal: null, when: null,
        arrivalPct: p.arrivalPct != null ? Number(p.arrivalPct) : null,
        reachable: p.reachable !== false, routed: false
      }));
    }
    if (!rows.length) return null;

    // zone filter (calendar + static always pass). "-Name" excludes; a plain
    // list is a whitelist. HA's zone option wins over config. Matches on the
    // zone entity id OR its name, with punctuation stripped so "zone.nana_s"
    // and "Nana's" are the same key.
    const znorm = (s) => String(s || "").toLowerCase()
      .replace(/^zone\./, "").replace(/[^a-z0-9]+/g, "");
    const haZones = (this.rangeReach && this.rangeReach.mmZones) || "";
    const zfRaw = haZones.trim()
      ? haZones.split(/[\n,]/)
      : (Array.isArray(dt.zones) ? dt.zones : []);
    const inc = [], exc = [];
    zfRaw.map((z) => String(z).trim()).filter(Boolean).forEach((z) => {
      (z[0] === "-" || z[0] === "!" ? exc : inc).push(znorm(z.replace(/^[-!]/, "")));
    });
    if (inc.length || exc.length) {
      rows = rows.filter((r) => {
        if (r.source !== "zone") return true;
        const keys = [znorm(r.name), znorm(r.entityId)].filter(Boolean);
        if (exc.some((e) => keys.includes(e))) return false;
        return inc.length === 0 || inc.some((k) => keys.includes(k));
      });
    }

    if (dt.hideUnreachable) rows = rows.filter((r) => r.reachable);
    if ((dt.order || "grouped") === "nearest") {
      rows.sort((a, b) => a.km - b.km);
    } else {
      // grouped: calendar (by event time) -> static -> other US zones (by distance)
      const rank = { calendar: 0, static: 1, zone: 2 };
      rows.sort((a, b) => {
        const g = (rank[a.source] != null ? rank[a.source] : 3) -
          (rank[b.source] != null ? rank[b.source] : 3);
        if (g) return g;
        if (a.source === "calendar")
          return String(a.when || "").localeCompare(String(b.when || ""));
        return a.km - b.km;
      });
    }
    rows = rows.slice(0, Number(dt.max) || 8);

    const stops = (Array.isArray(dt.delayStops) ? dt.delayStops : [])
      .filter((s) => s && isFinite(s.pctOver))
      .sort((a, b) => a.pctOver - b.pctOver);
    const delayColor = (r) => {
      if (r.delayPct == null) return null;
      let col = null;
      stops.forEach((s) => { if (r.delayPct >= s.pctOver) col = s.color || null; });
      return col;
    };

    const pack = Number(dt.packKwh) ||
      Number(((this.config.visuals || {}).chargeCost || {}).capacityKwh) ||
      Number((this.rawPayload && this.rawPayload.vehicle || {}).ev_battery_capacity) || 99.8;
    const battPct = this.visualState().batteryPct;

    const el = document.createElement("div");
    el.className = "kiaaccess-batt-detail kiaaccess-drivetimes";
    let html =
      '<div class="kiaaccess-dt-header">' + this.escape(dt.header || "Driving times") + "</div>";
    let anyRouted = false;
    rows.forEach((r) => {
      if (r.routed) anyRouted = true;
      const icon = r.source === "calendar" ? "📅" : r.source === "static" ? "⭐" : "📍";
      const col = delayColor(r);
      const timeTxt = r.durationMin != null ? hm(r.durationMin) : "—";
      const delayTxt = r.delayMin ? " +" + hm(r.delayMin) : "";
      // compact sub-line: [when] · [via] · [→SoC ~kWh]
      const subBits = [];
      if (r.whenLocal) subBits.push(this.escape(r.whenLocal));
      if (dt.showVia !== false && r.via) subBits.push(this.escape(r.via));
      if (dt.showConsumption !== false && r.arrivalPct != null) {
        let c = "→" + r.arrivalPct + "%";
        if (battPct != null && pack) {
          const kwh = Math.max(0, (battPct - r.arrivalPct) / 100 * pack);
          if (kwh >= 0.5) c += " ~" + kwh.toFixed(0) + "kWh";
        }
        subBits.push(c);
      } else if (dt.showConsumption !== false && !r.reachable) {
        subBits.push("out of range");
      }
      html +=
        '<div class="kiaaccess-dt-row">' +
          '<div class="kiaaccess-dt-line">' +
            '<span class="kiaaccess-dt-name">' + icon + " " + this.escape(r.name || "?") + "</span>" +
            '<span class="kiaaccess-dt-time"' + (col ? ' style="color:' + col + '"' : "") + ">" +
              this.escape(timeTxt + delayTxt) + "</span>" +
          "</div>" +
          (subBits.length
            ? '<div class="kiaaccess-dt-sub">' + subBits.join(" · ") + "</div>"
            : "") +
        "</div>";
    });
    if (rr && rr.length && !anyRouted && dt.showVia !== false) {
      const dbg = this.rangeReach && this.rangeReach.debug;
      const src = (this.rangeReach && this.rangeReach.driveTimeSource) || "estimate";
      let hint;
      if (src === "estimate") {
        hint = "Estimated times — set a Drive-time provider (TomTom) in Home Assistant for routes + traffic";
      } else if (dbg && dbg.errors && dbg.errors.length) {
        hint = "Routing (" + src + ") error: " + this.escape(String(dbg.errors[0]).slice(0, 90));
      } else if (dbg && dbg.routes_enabled === false) {
        hint = "Turn on 'Per-destination routes' in Home Assistant for the route + delay";
      } else {
        hint = "Routing configured (" + src + ") but no route data yet — see drive_time_status in HA";
      }
      html += '<div class="kiaaccess-dt-hint">' + hint + "</div>";
    }
    if (rr && this.rangeReach && this.rangeReach.debug &&
        this.rangeReach.debug.static_configured &&
        !this.rangeReach.debug.static_geocoded &&
        !rows.some((r) => r.source === "static")) {
      html +=
        '<div class="kiaaccess-dt-hint">Static destinations set but none geocoded — ' +
        'add a Geoapify geocoding key in Home Assistant</div>';
    }
    el.innerHTML = html;
    return el;
  },

  preconditionEl() {
    const f = this.flatMap || {};
    const on = f["vehicle.ev_first_departure_enabled"];
    if (on !== true && on !== "true") return null;
    const time = f["vehicle.ev_first_departure_time"];
    const days = f["vehicle.ev_first_departure_days"];
    const temp = f["vehicle.ev_first_departure_climate_temperature"];
    const climateOn = f["vehicle.ev_first_departure_climate_enabled"];
    if (!time) return null;
    let s = "Departure " + String(time).slice(0, 5);
    if (days) s += " · " + String(days);
    if ((climateOn === true || climateOn === "true") && temp) s += " · preheat " + temp + "°";
    const el = document.createElement("div");
    el.className = "kiaaccess-batt-detail";
    el.innerHTML =
      '<div><span class="kiaaccess-bd-value"><i class="fa-solid fa-clock"></i> ' +
      this.escape(s) +
      "</span></div>";
    return el;
  },

  chargeCostEl() {
    const cc = (this.config.visuals || {}).chargeCost || {};
    if (!cc.enabled || !(cc.pricePerKwh > 0)) return null;
    const s = this.visualState();
    if (s.batteryPct == null || s.capacityKwh == null) return null;
    const target = s.chargeLimitPct != null ? s.chargeLimitPct : 100;
    const kwh = Math.max(0, ((target - s.batteryPct) / 100) * s.capacityKwh);
    if (kwh <= 0.1) return null;
    const cost = kwh * cc.pricePerKwh;
    const el = document.createElement("div");
    el.className = "kiaaccess-batt-detail";
    el.innerHTML =
      '<div><span class="kiaaccess-bd-label">Est. cost to ' +
      target +
      '%</span><span class="kiaaccess-bd-value">' +
      this.escape((cc.currency || "$") + cost.toFixed(2)) +
      "</span></div>";
    return el;
  },

  getHeader() {
    let h = this.data.header || this.config.header || "";
    if (this.config.showReportedInHeader) {
      const at = this.reportedAt();
      if (at) h += " - as of: " + at;
    }
    if (this.config.showTable !== false && this.config.showHeaderCount &&
        this.viewData && this.viewData.length) {
      h += ` (${this.viewData.length})`;
    }
    return h;
  },

  otpNoticeText() {
    const s = this.visualState();
    if (s.tokenAgeDays == null) return null;
    const life = this.config.otpLifetimeDays || 30;
    const warn = this.config.otpWarnDays || 7;
    const remaining = Math.ceil(life - s.tokenAgeDays);
    if (life - s.tokenAgeDays > warn) return null;
    return remaining > 0
      ? "OTP expires in ~" + remaining + " day" + (remaining === 1 ? "" : "s") + " — re-run enroll.py"
      : "OTP has likely expired — re-run enroll.py";
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "kiaaccess";
    if (this.config.maxWidth) wrapper.style.maxWidth = this.config.maxWidth;
    // scales the HTML readout text (the SVGs scale via their px width);
    // CSS reads --kia-scale in calc()
    if (this.visScale() !== 1) {
      wrapper.style.setProperty("--kia-scale", String(this.visScale()));
    }

    const haveData = !!(this.rawPayload && this.flatMap);

    // no data at all -> loading / hard error only
    if (!haveData) {
      const l = document.createElement("div");
      l.className = "small dimmed";
      l.innerHTML = this.errorMessage
        ? "⚠ " + this.escape(this.errorMessage)
        : "Loading Kia data …";
      l.classList.toggle("kiaaccess-error", !!this.errorMessage);
      wrapper.appendChild(l);
      return wrapper;
    }

    // a warning strip while still showing the (possibly stale) data
    if (this.errorMessage || this.staleNote) {
      const strip = document.createElement("div");
      strip.className = "kiaaccess-error xsmall";
      strip.innerHTML =
        "⚠ " + this.escape(this.errorMessage || this.staleNote) + " — showing cached data";
      wrapper.appendChild(strip);
    }
    const otp = this.otpNoticeText();
    if (otp) {
      const n = document.createElement("div");
      n.className = "kiaaccess-error xsmall";
      n.innerHTML = "⚠ " + this.escape(otp);
      wrapper.appendChild(n);
    }

    // persistent, non-blocking status bar under the header — lists every
    // currently-active issue and stays until each one clears. Amber font for
    // warnings ("door open", "not plugged in"), red for the do-not-drive set
    // ("flat tyre", "12V critical", faults). Transparent background.
    const ncfg = this.config.notifications || {};
    const issues = this.diagramAlerts || [];
    if (ncfg.persistentBanner !== false && issues.length) {
      const anyCrit = issues.some((a) => a.level === "critical");
      const bar = document.createElement("div");
      bar.className =
        "kiaaccess-alertbanner " + (anyCrit ? "is-critical" : "is-warning");
      const parts = issues.map(
        (a) =>
          '<span class="' +
          (a.level === "critical" ? "kiaaccess-alert-crit" : "kiaaccess-alert-warn") +
          '">' +
          this.escape(a.label) +
          "</span>"
      );
      bar.innerHTML =
        '<i class="fa-solid fa-triangle-exclamation"></i>' +
        '<span class="kiaaccess-alert-list">' +
        parts.join('<span class="kiaaccess-alert-sep"> &middot; </span>') +
        "</span>";
      wrapper.appendChild(bar);
    }

    const V = this.visuals;
    const vis = this.config.visuals || {};

    // ---- compact one-liner ----
    if (V && vis.enabled && vis.compact) {
      const line = document.createElement("div");
      line.className = "kiaaccess-compact";
      line.innerHTML = this.escape(this.compactLine());
      wrapper.appendChild(line);
      this.appendFooter(wrapper);
      return wrapper;
    }

    if (V && vis.enabled) {
      const s = this.visualState();
      s.critical = !!this.hasCritical; // set by processConditions()
      s.alerts = this.diagramAlerts || []; // reasons under the warning triangle
      const panel = document.createElement("div");
      panel.className = "kiaaccess-visuals";

      if (vis.car) {
        const c = document.createElement("div");
        c.className = "kiaaccess-carwrap";
        c.innerHTML = V.carDiagram(s, {
          width: this.visWidth(),
          battery: vis.battery !== false,
          tempUnit: this.config.units === "metric" ? "C" : "F"
        });
        panel.appendChild(c);
      }

      const detail = vis.battery !== false ? this.batteryDetailEntries() : [];
      if (detail.length) {
        const dl = document.createElement("div");
        dl.className = "kiaaccess-batt-detail";
        detail.forEach((e) => {
          const r = document.createElement("div");
          r.innerHTML =
            '<span class="kiaaccess-bd-label">' +
            this.escape(e.label) +
            '</span><span class="kiaaccess-bd-value bright">' +
            this.escape(this.utils.formatValue(e, this.config)) +
            "</span>";
          dl.appendChild(r);
        });
        panel.appendChild(dl);
      }
      if (panel.childNodes.length) wrapper.appendChild(panel);

      // extra optional widgets, each returns an element or null
      [
        this.chargeProgressEl(),
        this.rangeRingEl(),
        this.socHistoryEl(),
        this.v12HistoryEl(),
        this.preconditionEl(),
        this.chargeCostEl(),
        this.chargeLogEl(),
        this.tripLogEl(),
        this.tripStatsEl(),
        this.drivingTimesEl(),
        this.locationEl()
      ].forEach((el) => el && wrapper.appendChild(el));
    }

    // the details table — `showTable: false` drops it entirely (the diagram +
    // widgets carry the state); keep the "nothing matched" hint only when there
    // are no visuals to fall back on
    if (this.config.showTable !== false && this.viewData.length) {
      const rowIcons = !!(V && vis.enabled && vis.rowIcons);
      const table = document.createElement("table");
      table.className = "kiaaccess-table";

      this.viewData.forEach((entry) => {
        const row = document.createElement("tr");

        if (rowIcons) {
          const ic = document.createElement("td");
          ic.className = "kiaaccess-icon";
          const cls = V.iconFor(entry.key, this.config.icons);
          if (cls) ic.innerHTML = '<i class="' + this.escape(cls) + '"></i>';
          row.appendChild(ic);
        }

        const label = document.createElement("td");
        label.className = "kiaaccess-label";
        label.innerHTML = this.escape(entry.label);
        label.title = entry.key;

        const value = document.createElement("td");
        value.className = "kiaaccess-value bright";
        let valTxt = this.utils.formatValue(entry, this.config);
        if (entry.combinedSuffix) valTxt += " · " + entry.combinedSuffix;
        value.innerHTML = this.escape(valTxt);

        row.appendChild(label);
        row.appendChild(value);
        table.appendChild(row);
      });
      wrapper.appendChild(table);
    } else if (
      this.config.showTable !== false &&
      this.viewData.length === 0 &&
      !(V && vis.enabled)
    ) {
      const n = document.createElement("div");
      n.className = "small dimmed";
      n.innerHTML = "No attributes matched your include/exclude config.";
      wrapper.appendChild(n);
    }

    this.appendFooter(wrapper);
    return wrapper;
  },

  appendFooter(wrapper) {
    if (!this.config.showUpdatedFooter || !this.lastUpdated) return;
    const foot = document.createElement("div");
    foot.className = "kiaaccess-footer xsmall dimmed";
    foot.innerHTML =
      "updated " + this.agoText(this.lastUpdated) + (this.stale ? " · cached" : "");
    wrapper.appendChild(foot);
  },

  escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[c];
    });
  }
});
