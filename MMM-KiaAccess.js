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

    // ---- display ----
    header: "Kia",
    units: "imperial", // "imperial" | "metric"
    decimals: 1,
    nullText: "—",
    include: [], // e.g. ["vehicle.ev_battery_percentage", "vehicle.*_door_is_open", "vehicle.odometer"]
    exclude: ["vehicle.data.*", "vehicle.VIN"], // raw API dump + VIN hidden by default
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
    debug: false
  },

  getStyles() {
    return ["MMM-KiaAccess.css"];
  },

  getScripts() {
    return [this.file("flatten.js")];
  },

  start() {
    this.viewData = null;
    this.errorMessage = null;
    this.loading = true;
    this.lastUpdated = null;
    this.utils = typeof KiaAccessUtils !== "undefined" ? KiaAccessUtils : null;

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
    this.viewData = this.utils.selectEntries(flat, this.config);
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

    if (this.viewData.length === 0) {
      const n = document.createElement("div");
      n.className = "small dimmed";
      n.innerHTML = "No attributes matched your include/exclude config.";
      wrapper.appendChild(n);
      return wrapper;
    }

    const table = document.createElement("table");
    table.className = "kiaaccess-table small";

    this.viewData.forEach((entry) => {
      const row = document.createElement("tr");

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
