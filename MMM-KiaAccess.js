/* global Module, Log */

/* MMM-KiaAccess
 * A MagicMirror² module that shows configurable Kia Connect / Bluelink data.
 * Built for the Kia EV9 but works with any bluelinky-supported Hyundai/Kia.
 *
 * By design the node_helper returns the *entire* vehicle payload and the
 * frontend flattens it into `path -> value` rows. You then choose what to show
 * with `include` / `exclude` / `order` / `labels` / `formatters`.
 */
Module.register("MMM-KiaAccess", {
  defaults: {
    // ---- credentials (Kia Connect / Bluelink account) ----
    username: "",
    password: "",
    pin: "",
    brand: "kia", // "kia" | "hyundai"
    region: "US", // "US" | "CA" | "EU" | "AU" | "KR"
    vin: "", // optional; first vehicle on the account is used when blank

    // ---- polling ----
    updateInterval: 30 * 60 * 1000, // 30 min. Be gentle: frequent polls drain the 12V battery.
    retryInterval: 5 * 60 * 1000,
    refresh: true, // true = ask the car for live data, false = Kia's cached copy
    loginTimeout: 30, // seconds

    // ---- display ----
    header: "Kia",
    units: "imperial", // "imperial" | "metric"
    decimals: 1,
    nullText: "—",
    include: [], // e.g. ["status.engine.batteryCharge", "status.chassis.*", "odometer.*"]
    exclude: ["rawStatus.*", "_meta.vin"],
    order: [], // paths / globs listed here are shown first, in this order
    labels: {
      // "status.engine.batteryCharge": "Battery",
    },
    formatters: {
      // key path -> one of:
      // raw | boolean | percent | distanceKm | distanceMi |
      // temperatureC | speedKph | datetime | relativeTime
      "status.engine.batteryCharge": "percent",
      "status.engine.range": "distanceKm",
      "status.engine.charging": "boolean",
      "status.engine.plugedTo": "raw",
      "status.chassis.locked": "boolean",
      "status.climate.temperatureSetpoint": "temperatureC",
      "status.lastupdate": "relativeTime",
      "odometer.value": "distanceKm",
      "location.latitude": "raw",
      "location.longitude": "raw",
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
      loginTimeout: c.loginTimeout,
      includeFullStatus: c.include.some((p) => String(p).indexOf("fullStatus") === 0)
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
