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

    // ---- runtime ----
    pythonBin: "python3", // command used to run kia_bridge.py
    fetchTimeout: 90, // seconds before the bridge process is killed

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
    hideWhenFalsy: [], // paths/globs: drop the row when its value is false / 0 / null / "" / "—"
    order: [], // paths / globs listed here are shown first, in this order
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
    maxWidth: "420px",
    animationSpeed: 500,
    debug: false,

    // ---- graphical widgets (all off by default) ----
    visuals: {
      enabled: false,
      car: true, // top-down SUV diagram (doors / frunk / tailgate / charge port / tyres)
      battery: true, // vertical battery in the centre of the car (charge % + charging bolt)
      rowIcons: true, // Font Awesome icon before each table row
      width: 210, // px width for the car SVG
      compact: false, // one-line summary instead of the diagram + table
      chargeProgress: true, // when plugged in: a progress bar + "full at HH:MM"
      rangeRing: false, // a radial SoC / range gauge under the car
      socHistory: false, // a battery-% sparkline over the last `socHistoryDays`
      socHistoryDays: 14,
      tripStats: false, // distance / consumption / regen from month_trip_info
      location: {
        enabled: false,
        homeLat: null, // set both to show "N mi from home"
        homeLon: null,
        map: false, // show a static map image
        mapZoom: 14,
        mapWidth: 210,
        mapHeight: 120,
        // {lat} {lon} {zoom} {w} {h} are substituted. Default is keyless OSM;
        // for reliability use your own provider (Geoapify / Mapbox / …).
        mapUrlTemplate:
          "https://staticmap.openstreetmap.de/staticmap.php?center={lat},{lon}&zoom={zoom}&size={w}x{h}&markers={lat},{lon},red-pushpin"
      },
      chargeCost: {
        enabled: false,
        pricePerKwh: 0, // e.g. 0.14
        currency: "$"
      },
      // readouts shown under the battery gauge (and removed from the table).
      // Uses your labels / formatters / hideWhenFalsy just like table rows.
      batteryDetail: [
        "vehicle.ev_driving_range",
        "vehicle.ev_charging_power",
        "vehicle.ev_charging_current",
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
      alertSeconds: 15, // SHOW_ALERT auto-dismiss timer
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
    }
  },

  getStyles() {
    return ["MMM-KiaAccess.css", "font-awesome.css"];
  },

  getScripts() {
    return [this.file("flatten.js"), this.file("visuals.js"), this.file("conditions.js")];
  },

  start() {
    this.viewData = null;
    this.errorMessage = null;
    this.loading = true;
    this.lastUpdated = null;
    this.utils = typeof KiaAccessUtils !== "undefined" ? KiaAccessUtils : null;
    this.visuals = typeof KiaAccessVisuals !== "undefined" ? KiaAccessVisuals : null;
    this.conditions = typeof KiaConditions !== "undefined" ? KiaConditions : null;
    this.flatMap = null;
    this.history = [];
    this.stale = false;
    this.staleNote = null;
    this.prevCond = {}; // { <reason>: bool, _charging: bool|null }
    this.firstConditionRun = true;

    // MagicMirror merges `config` shallowly, so a user-supplied nested block
    // replaces the default wholesale — re-apply the defaults for any missing keys
    const merge = (base, over) => Object.assign({}, base, over || {});
    this.config.visuals = merge(this.defaults.visuals, this.config.visuals);
    this.config.visuals.location = merge(this.defaults.visuals.location, this.config.visuals.location);
    this.config.visuals.chargeCost = merge(this.defaults.visuals.chargeCost, this.config.visuals.chargeCost);
    this.config.icons = merge(this.defaults.icons, this.config.icons);
    this.config.notifications = merge(this.defaults.notifications, this.config.notifications);
    this.config.mqtt = merge(this.defaults.mqtt, this.config.mqtt);
    this.config.mqtt.homeAssistant = merge(
      this.defaults.mqtt.homeAssistant,
      this.config.mqtt.homeAssistant
    );

    if (!this.config.username || !this.config.password) {
      this.errorMessage = "Set username / password / pin in config.js";
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
      refresh: c.refresh,
      geocode: c.geocode || (c.visuals && c.visuals.location && c.visuals.location.enabled),
      pythonBin: c.pythonBin,
      fetchTimeout: c.fetchTimeout,
      maxRequestsPerHour: c.maxRequestsPerHour,
      historyDays: c.historyDays,
      historyMinIntervalMinutes: c.historyMinIntervalMinutes,
      mqtt: c.mqtt && c.mqtt.enabled && c.mqtt.url ? c.mqtt : null
    };
  },

  socketNotificationReceived(notification, data) {
    if (!data || !this.isForMe(data.identifier)) return;

    if (notification === "KIA_DATA") {
      this.loading = false;
      this.rawPayload = data.payload;
      const m = data.payload._meta || {};
      this.history = data.payload.history || [];
      this.stale = !!m.stale;
      this.staleNote = m.note || null;
      this.errorMessage = m.error || null; // shown as a strip; data still renders
      this.lastUpdated = new Date(m.stale ? m.cachedAt || m.fetchedAt : m.fetchedAt || Date.now());
      this.rebuildView();
      this.processConditions();
      this.updateDom(this.config.animationSpeed);
      this.scheduleFetch(this.nextDelay(m.failStreak || 0, m.retryAfterMs));
    } else if (notification === "KIA_ERROR") {
      this.loading = false;
      this.errorMessage = data.error || "Unknown error";
      Log.error("[MMM-KiaAccess] " + this.errorMessage);
      this.updateDom(this.config.animationSpeed);
      this.scheduleFetch(this.nextDelay(data.failStreak || 1, data.retryAfterMs));
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

    // when the battery widget is on, its readouts (and the % itself) are shown
    // in the widget, not the table — drop any duplicates
    const vis = this.config.visuals || {};
    if (this.visuals && vis.enabled && vis.battery) {
      const moved = new Set(
        ["vehicle.ev_battery_percentage"].concat(vis.batteryDetail || [])
      );
      entries = entries.filter((e) => !moved.has(e.key));
    }
    this.viewData = entries;
  },

  batteryDetailEntries() {
    const vis = this.config.visuals || {};
    const keys = vis.batteryDetail || [];
    const f = this.flatMap || {};
    const labels = this.config.labels || {};
    const hide = this.config.hideWhenFalsy || [];
    return keys
      .filter((k) => Object.prototype.hasOwnProperty.call(f, k))
      .map((k) => ({
        key: k,
        label: labels[k] || this.utils.prettifyKey(k),
        rawValue: f[k]
      }))
      .filter(
        (e) =>
          !this.utils.matchesAny(e.key, hide) || !this.utils.isEmptyValue(e.rawValue)
      );
  },

  // read canonical vehicle.* values straight from the flat map, independent of
  // the include/exclude list, so the diagram is always complete
  visualState() {
    const f = this.flatMap || {};
    const bool = (k) => {
      const v = f["vehicle." + k];
      if (v === true || v === "true" || v === 1 || v === "1") return true;
      if (v === false || v === "false" || v === 0 || v === "0") return false;
      return null;
    };
    const num = (k) => {
      const raw = f["vehicle." + k];
      if (raw == null || raw === "") return null; // Number(null) is 0 — guard it
      const v = Number(raw);
      return isFinite(v) ? v : null;
    };
    const anyTrue = (...ks) => {
      const vals = ks.map(bool);
      if (vals.some((v) => v === true)) return true;
      if (vals.every((v) => v === false)) return false;
      return null;
    };
    const hs = f["vehicle.headlamp_status"];
    let headlights = anyTrue(
      "headlamp_left_low",
      "headlamp_right_low",
      "headlamp_left_high",
      "headlamp_right_high"
    );
    if (headlights == null && typeof hs === "string") {
      const t = hs.trim().toLowerCase();
      headlights = t && t !== "off" && t !== "none" && t !== "0" ? true : false;
    }

    return {
      batteryPct: num("ev_battery_percentage"),
      rangeKm: num("ev_driving_range"),
      chargeKw: num("ev_charging_power"),
      charging: bool("ev_battery_is_charging"),
      plugged: bool("ev_battery_is_plugged_in"),
      v2l: bool("ev_v2l_status"),
      v2x: bool("ev_v2x_status"),
      locked: bool("is_locked"),
      carOn: anyTrue(
        "engine_is_running",
        "accessory_on",
        "ign3",
        "remote_ignition"
      ),
      headlights: headlights,
      doorFL: bool("front_left_door_is_open"),
      doorFR: bool("front_right_door_is_open"),
      doorRL: bool("back_left_door_is_open"),
      doorRR: bool("back_right_door_is_open"),
      winFL: bool("front_left_window_is_open"),
      winFR: bool("front_right_window_is_open"),
      winRL: bool("back_left_window_is_open"),
      winRR: bool("back_right_window_is_open"),
      hood: bool("hood_is_open"),
      trunk: bool("trunk_is_open"),
      sunroof: bool("sunroof_is_open"),
      defrost: bool("defrost_is_on"),
      rearHeat: bool("back_window_heater_is_on"),
      mirrorHeat: bool("side_mirror_heater_is_on"),
      steerHeat: bool("steering_wheel_heater_is_on"),
      climate: (() => {
        if (bool("air_control_is_on") !== true) return null;
        const set = num("air_temperature");
        const out = num("outside_temperature");
        if (set != null && out != null) {
          if (set - out >= 1) return "heat";
          if (out - set >= 1) return "cool";
        }
        return "on";
      })(),
      tyreAny: bool("tire_pressure_all_warning_is_on"),
      tyreFL: bool("tire_pressure_front_left_warning_is_on"),
      tyreFR: bool("tire_pressure_front_right_warning_is_on"),
      tyreRL: bool("tire_pressure_rear_left_warning_is_on"),
      tyreRR: bool("tire_pressure_rear_right_warning_is_on"),
      // extra fields used by conditions.js (not drawn)
      car12vPct: num("car_battery_percentage"),
      chargeLimitPct: (() => {
        const ac = num("ev_charge_limits_ac");
        const dc = num("ev_charge_limits_dc");
        const vals = [ac, dc].filter((v) => v != null && v > 0);
        return vals.length ? Math.max(...vals) : null;
      })(),
      capacityKwh: num("ev_battery_capacity"),
      history: this.history || [],
      tokenAgeDays: (() => {
        const t = f["_meta.tokenEnrolledAt"];
        if (!t) return null;
        const ms = Date.now() - new Date(t).getTime();
        return isFinite(ms) && ms >= 0 ? ms / 864e5 : null;
      })(),
      otpLifetimeDays: this.config.otpLifetimeDays,
      otpWarnDays: this.config.otpWarnDays
    };
  },

  // edge-triggered vehicle-state notifications
  processConditions() {
    const cfg = this.config.notifications || {};
    if (!cfg.enabled || !this.conditions || !this.flatMap) return;

    const res = this.conditions.evaluate(this.visualState(), cfg, this.prevCond);
    const vin = (this.rawPayload && this.rawPayload.vehicle && this.rawPayload.vehicle.VIN) || null;
    const startup = this.firstConditionRun;
    const startupAllows = (level) =>
      cfg.notifyOnStartup === true ||
      (cfg.notifyOnStartup === "critical" && level === "critical");

    this.announcedActive = this.announcedActive || {};
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
        this.sendNotification("KIA_ACCESS_STATE_CHANGED", {
          reason: c.reason,
          level: c.level,
          active: c.active,
          title: c.title,
          message: c.message,
          value: c.value,
          vin: vin,
          at: new Date().toISOString()
        });
        if (
          cfg.alertModule !== false &&
          becameActive &&
          (c.level === "warning" || c.level === "critical")
        ) {
          this.sendNotification("SHOW_ALERT", {
            type: "notification",
            title: c.title,
            message: c.message,
            timer: (cfg.alertSeconds || 15) * 1000
          });
        }
      }
      if (c.active !== null) this.prevCond[c.reason] = c.active;
    });

    this.prevCond._charging = res.meta.charging;
    this.firstConditionRun = false;
  },

  // allow live config edits via MM's module dev tooling / notifications
  notificationReceived(notification, payload) {
    if (notification === "MMM_KIA_ACCESS_REFRESH") {
      this.scheduleFetch(0);
    }
  },

  // ---------- small helpers for the optional widgets ----------

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

  // charge progress bar + "full at HH:MM" when plugged in
  chargeProgressEl() {
    const s = this.visualState();
    if (!(this.config.visuals || {}).chargeProgress) return null;
    if (s.charging !== true && s.plugged !== true) return null;
    const el = document.createElement("div");
    el.className = "kiaaccess-visuals";
    const target = s.chargeLimitPct;
    el.innerHTML = this.visuals.chargeBar(s.batteryPct, target, {
      width: (this.config.visuals || {}).width || 210
    });
    const mins = this.utils
      ? Number(this.flatMap["vehicle.ev_estimated_current_charge_duration"])
      : NaN;
    const cap = document.createElement("div");
    cap.className = "kiaaccess-batt-detail";
    let msg = s.charging === true ? "Charging" : "Plugged in, not charging";
    if (s.charging === true && isFinite(mins) && mins > 0) {
      const done = new Date(Date.now() + mins * 60000);
      msg = "Full" + (target ? " (" + target + "%)" : "") + " at " +
        done.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    cap.innerHTML = '<div><span class="kiaaccess-bd-value">' + this.escape(msg) + "</span></div>";
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
      centreText: this.fmtDist(s.rangeKm) || ""
    });
    return el;
  },

  socHistoryEl() {
    const vis = this.config.visuals || {};
    if (!vis.socHistory) return null;
    const days = vis.socHistoryDays || 14;
    const cutoff = Date.now() - days * 864e5;
    const pts = (this.history || [])
      .filter((h) => h && h.t >= cutoff && h.ev != null)
      .map((h) => ({ t: h.t, v: h.ev }));
    if (pts.length < 2) return null;
    const el = document.createElement("div");
    el.className = "kiaaccess-visuals";
    el.innerHTML = this.visuals.sparkline(pts, {
      width: vis.width || 210,
      height: 40,
      color: this.visuals.COL.ok
    });
    const cap = document.createElement("div");
    cap.className = "kiaaccess-batt-detail";
    cap.innerHTML =
      '<div><span class="kiaaccess-bd-label">Battery, last ' + days + " days</span></div>";
    el.appendChild(cap);
    return el;
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
    const addr = f["vehicle.geocode"];
    if (addr && addr !== "—") lines.push(String(addr));
    if (lines.length) {
      const t = document.createElement("div");
      t.className = "kiaaccess-batt-detail";
      t.innerHTML = lines
        .map((l) => '<div><span class="kiaaccess-bd-value">' + this.escape(l) + "</span></div>")
        .join("");
      el.appendChild(t);
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
    if (this.config.showHeaderCount && this.viewData && this.viewData.length) {
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
      const panel = document.createElement("div");
      panel.className = "kiaaccess-visuals";

      if (vis.car) {
        const c = document.createElement("div");
        c.className = "kiaaccess-carwrap";
        c.innerHTML = V.carDiagram(s, {
          width: vis.width || 210,
          battery: vis.battery !== false
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
        this.preconditionEl(),
        this.chargeCostEl(),
        this.tripStatsEl(),
        this.locationEl()
      ].forEach((el) => el && wrapper.appendChild(el));
    }

    if (this.viewData.length === 0) {
      if (!(V && vis.enabled)) {
        const n = document.createElement("div");
        n.className = "small dimmed";
        n.innerHTML = "No attributes matched your include/exclude config.";
        wrapper.appendChild(n);
      }
      this.appendFooter(wrapper);
      return wrapper;
    }

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
      value.innerHTML = this.escape(this.utils.formatValue(entry, this.config));

      row.appendChild(label);
      row.appendChild(value);
      table.appendChild(row);
    });

    wrapper.appendChild(table);
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
