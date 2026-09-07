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
      battery: true, // battery gauge (charge % only) + a caption block under it
      car: true, // top-down car status diagram (doors / hood / trunk / lock / charge port / tyres)
      carLabel: "EV9", // text under the lock glyph ("" to hide)
      rowIcons: true, // Font Awesome icon before each table row
      width: 210, // px width for the battery gauge; car scales with it
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
    icons: {} // key path -> Font Awesome class, overrides the built-in map
  },

  getStyles() {
    return ["MMM-KiaAccess.css", "font-awesome.css"];
  },

  getScripts() {
    return [this.file("flatten.js"), this.file("visuals.js")];
  },

  start() {
    this.viewData = null;
    this.errorMessage = null;
    this.loading = true;
    this.lastUpdated = null;
    this.utils = typeof KiaAccessUtils !== "undefined" ? KiaAccessUtils : null;
    this.visuals = typeof KiaAccessVisuals !== "undefined" ? KiaAccessVisuals : null;
    this.flatMap = null;

    // MagicMirror merges `config` shallowly, so a user-supplied `visuals` block
    // replaces the default wholesale — re-apply the defaults for any missing keys
    this.config.visuals = Object.assign({}, this.defaults.visuals, this.config.visuals || {});
    this.config.icons = Object.assign({}, this.defaults.icons, this.config.icons || {});

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
      fetchTimeout: c.fetchTimeout
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
      const v = Number(f["vehicle." + k]);
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
      headlights: headlights,
      doorFL: bool("front_left_door_is_open"),
      doorFR: bool("front_right_door_is_open"),
      doorRL: bool("back_left_door_is_open"),
      doorRR: bool("back_right_door_is_open"),
      hood: bool("hood_is_open"),
      trunk: bool("trunk_is_open"),
      tyreAny: bool("tire_pressure_all_warning_is_on"),
      tyreFL: bool("tire_pressure_front_left_warning_is_on"),
      tyreFR: bool("tire_pressure_front_right_warning_is_on"),
      tyreRL: bool("tire_pressure_rear_left_warning_is_on"),
      tyreRR: bool("tire_pressure_rear_right_warning_is_on")
    };
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

      // car first, then battery gauge, then the battery readouts — one column
      if (vis.car) {
        const c = document.createElement("div");
        c.className = "kiaaccess-carwrap";
        c.innerHTML = V.carDiagram(s, {
          // the car SVG is centred on the car body, so matching the gauge
          // width lines the car up with the battery gauge below it
          width: vis.width || 210,
          label: vis.carLabel != null ? vis.carLabel : "EV9"
        });
        panel.appendChild(c);
      }

      if (vis.battery && s.batteryPct != null) {
        const bwrap = document.createElement("div");
        bwrap.className = "kiaaccess-batt";
        bwrap.innerHTML = V.batteryGauge(s.batteryPct, {
          charging: s.charging,
          width: vis.width || 210
        });
        const detail = this.batteryDetailEntries();
        if (detail.length) {
          const dl = document.createElement("div");
          dl.className = "kiaaccess-batt-detail";
          detail.forEach((e) => {
            const r = document.createElement("div");
            r.innerHTML =
              '<span class="kiaaccess-label">' +
              this.escape(e.label) +
              '</span><span class="kiaaccess-value bright">' +
              this.escape(this.utils.formatValue(e, this.config)) +
              "</span>";
            dl.appendChild(r);
          });
          bwrap.appendChild(dl);
        }
        panel.appendChild(bwrap);
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
