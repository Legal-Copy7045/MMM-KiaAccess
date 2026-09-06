/* MagicMirror² node_helper for MMM-KiaAccess
 *
 * Talks to Kia Connect / Bluelink through the `bluelinky` library and returns
 * the merged vehicle payload to the frontend. All display logic lives in the
 * frontend so the same payload can be re-filtered without another API call.
 */
const NodeHelper = require("node_helper");
const Log = require("logger");

let BlueLinky;
try {
  BlueLinky = require("bluelinky");
} catch (err) {
  BlueLinky = null;
}

module.exports = NodeHelper.create({
  start() {
    this.clients = {}; // keyed by identifier -> { client, vehicle, ready }
    Log.info("[MMM-KiaAccess] node_helper started");
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "KIA_FETCH") {
      this.handleFetch(payload);
    }
  },

  identifierFor(config) {
    return [config.region, config.brand, config.username, config.vin || "auto"].join("|");
  },

  async getVehicle(config) {
    if (!BlueLinky) {
      throw new Error(
        "The 'bluelinky' package is not installed. Run `npm install` inside the MMM-KiaAccess folder."
      );
    }

    const id = this.identifierFor(config);
    if (this.clients[id] && this.clients[id].vehicle) {
      return this.clients[id].vehicle;
    }

    const vehicle = await new Promise((resolve, reject) => {
      const client = new BlueLinky({
        username: config.username,
        password: config.password,
        pin: config.pin,
        brand: config.brand || "kia",
        region: config.region || "US",
        vin: config.vin || undefined
      });

      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for Kia Connect login (check credentials / region)."));
      }, (config.loginTimeout || 30) * 1000);

      client.on("ready", (vehicles) => {
        clearTimeout(timer);
        if (!vehicles || vehicles.length === 0) {
          return reject(new Error("Kia Connect returned no vehicles for this account."));
        }
        let chosen = vehicles[0];
        if (config.vin) {
          chosen =
            vehicles.find((v) => (v.vin() || "").toUpperCase() === config.vin.toUpperCase()) ||
            chosen;
        }
        this.clients[id] = { client, vehicle: chosen };
        resolve(chosen);
      });

      client.on("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    return vehicle;
  },

  async handleFetch(config) {
    const id = this.identifierFor(config);
    try {
      const vehicle = await this.getVehicle(config);
      const wantRefresh = config.refresh !== false; // pull fresh data from the car, not cache

      const payload = { _meta: {} };

      // status() is the primary source (battery, climate, doors, tyres ...)
      try {
        payload.status = await vehicle.status({
          parsed: true,
          refresh: wantRefresh
        });
      } catch (e) {
        payload._meta.statusError = String(e && e.message ? e.message : e);
      }

      // raw / unparsed status for anything the parser drops
      try {
        payload.rawStatus = await vehicle.status({ parsed: false, refresh: false });
      } catch (e) {
        /* optional */
      }

      try {
        payload.odometer = await vehicle.odometer();
      } catch (e) {
        payload._meta.odometerError = String(e && e.message ? e.message : e);
      }

      try {
        payload.location = await vehicle.location();
      } catch (e) {
        payload._meta.locationError = String(e && e.message ? e.message : e);
      }

      if (config.includeFullStatus) {
        try {
          payload.fullStatus = await vehicle.fullStatus({ parsed: true, refresh: false });
        } catch (e) {
          /* not implemented in every region */
        }
      }

      payload._meta.fetchedAt = new Date().toISOString();
      payload._meta.vin = safeCall(vehicle, "vin");
      payload._meta.nickname = safeCall(vehicle, "nickname");
      payload._meta.name = safeCall(vehicle, "name");

      this.sendSocketNotification("KIA_DATA", { identifier: id, config, payload });
    } catch (err) {
      // force a fresh login next time on hard failures
      delete this.clients[id];
      Log.error("[MMM-KiaAccess] fetch failed: " + (err && err.message ? err.message : err));
      this.sendSocketNotification("KIA_ERROR", {
        identifier: id,
        config,
        error: err && err.message ? err.message : String(err)
      });
    }
  }
});

function safeCall(obj, method) {
  try {
    return typeof obj[method] === "function" ? obj[method]() : undefined;
  } catch (e) {
    return undefined;
  }
}
