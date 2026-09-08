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

    // ---- polling ----
    updateInterval: 30 * 60 * 1000, // 30 min. Be gentle: frequent polls drain the 12V battery.
    retryInterval: 5 * 60 * 1000,
    refresh: true, // true = ask the car for live data, false = Kia's cached copy
    geocode: false, // true = resolve vehicle.geocode to a street address (OpenStreetMap)

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
        // evBatteryLow:  { belowPct: 20, clearPct: 25, level: "warning" },
        // battery12vLow: { belowPct: 55, clearPct: 60 },
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
      publishJson: true // also publish <prefix>/state as one JSON blob
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
    this.prevCond = {}; // { <reason>: bool, _charging: bool|null }
    this.firstConditionRun = true;

    // MagicMirror merges `config` shallowly, so a user-supplied nested block
    // replaces the default wholesale — re-apply the defaults for any missing keys
    this.config.visuals = Object.assign({}, this.defaults.visuals, this.config.visuals || {});
    this.config.icons = Object.assign({}, this.defaults.icons, this.config.icons || {});
    this.config.notifications = Object.assign(
      {},
      this.defaults.notifications,
      this.config.notifications || {}
    );
    this.config.mqtt = Object.assign({}, this.defaults.mqtt, this.config.mqtt || {});

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
      geocode: c.geocode,
      pythonBin: c.pythonBin,
      fetchTimeout: c.fetchTimeout,
      mqtt: c.mqtt && c.mqtt.enabled && c.mqtt.url ? c.mqtt : null
    };
  },

  socketNotificationReceived(notification, data) {
    if (!data || !this.isForMe(data.identifier)) return;

    if (notification === "KIA_DATA") {
      this.errorMessage = null;
      this.loading = false;
      this.rawPayload = data.payload;
      this.lastUpdated = new Date();
      this.rebuildView();
      this.processConditions();
      this.updateDom(this.config.animationSpeed);
      this.scheduleFetch(this.config.updateInterval);
    } else if (notification === "KIA_ERROR") {
      this.loading = false;
      this.errorMessage = data.error || "Unknown error";
      Log.error("[MMM-KiaAccess] " + this.errorMessage);
      this.updateDom(this.config.animationSpeed);
      this.scheduleFetch(this.config.retryInterval);
    }
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
      })()
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

  getHeader() {
    let h = this.data.header || this.config.header || "";
    if (this.config.showHeaderCount && this.viewData && this.viewData.length) {
      h += ` (${this.viewData.length})`;
    }
    return h;
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "kiaaccess";
    if (this.config.maxWidth) wrapper.style.maxWidth = this.config.maxWidth;

    if (this.errorMessage) {
      const err = document.createElement("div");
      err.className = "kiaaccess-error small dimmed";
      err.innerHTML = "⚠ " + this.escape(this.errorMessage);
      wrapper.appendChild(err);
      return wrapper;
    }

    if (this.loading || !this.viewData) {
      const l = document.createElement("div");
      l.className = "kiaaccess-loading small dimmed";
      l.innerHTML = "Loading Kia data …";
      wrapper.appendChild(l);
      return wrapper;
    }

    const V = this.visuals;
    const vis = this.config.visuals || {};

    if (V && vis.enabled && this.flatMap) {
      const s = this.visualState();
      const panel = document.createElement("div");
      panel.className = "kiaaccess-visuals";

      // the car carries the vertical battery in its centre; the readouts
      // (range, charge times) sit directly under it
      if (vis.car) {
        const c = document.createElement("div");
        c.className = "kiaaccess-carwrap";
        c.innerHTML = V.carDiagram(s, {
          width: vis.width || 210,
          battery: vis.battery !== false
        });
        panel.appendChild(c);
      }

      const detail =
        vis.battery !== false ? this.batteryDetailEntries() : [];
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
    }

    if (this.viewData.length === 0) {
      if (!(V && vis.enabled)) {
        const n = document.createElement("div");
        n.className = "small dimmed";
        n.innerHTML = "No attributes matched your include/exclude config.";
        wrapper.appendChild(n);
      }
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

    if (this.config.showUpdatedFooter && this.lastUpdated) {
      const foot = document.createElement("div");
      foot.className = "kiaaccess-footer xsmall dimmed";
      foot.innerHTML = "updated " + this.lastUpdated.toLocaleTimeString();
      wrapper.appendChild(foot);
    }

    return wrapper;
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
