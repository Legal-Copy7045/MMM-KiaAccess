/* MagicMirror² node_helper for MMM-KiaAccess
 *
 * Fetches vehicle data by shelling out to `kia_bridge.py`, which uses the
 * actively-maintained `hyundai_kia_connect_api` Python library. That library
 * handles Kia USA's Cloudflare bot protection, which blocks the Node
 * `bluelinky` library (HTTP 403).
 *
 * Credentials are passed to the child process on stdin (never argv), so they
 * do not show up in the process list.
 */
const NodeHelper = require("node_helper");
const Log = require("logger");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { flatten } = require("./flatten.js");

/** Prefer the bundled venv (built by setup_python.js) unless the user set pythonBin. */
function resolvePython(configured) {
  if (configured && configured !== "python3") return configured;
  const venv =
    process.platform === "win32"
      ? path.join(__dirname, "venv", "Scripts", "python.exe")
      : path.join(__dirname, "venv", "bin", "python3");
  if (fs.existsSync(venv)) return venv;
  return configured || process.env.PYTHON || "python3";
}

module.exports = NodeHelper.create({
  start() {
    this.inFlight = {};
    this.mqttClients = {};
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

  handleFetch(config) {
    const id = this.identifierFor(config);
    if (this.inFlight[id]) {
      Log.info("[MMM-KiaAccess] fetch already in progress, skipping");
      return;
    }
    this.inFlight[id] = true;

    const pythonBin = resolvePython(config.pythonBin);
    const script = path.join(__dirname, "kia_bridge.py");
    const job = {
      username: config.username,
      password: config.password,
      pin: config.pin,
      brand: config.brand || "KIA",
      region: config.region || "USA",
      vin: config.vin || "",
      refresh: config.refresh !== false,
      geocode: config.geocode === true
    };

    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(pythonBin, [script], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      this.inFlight[id] = false;
      return this.fail(id, config, `could not start ${pythonBin}: ${err.message}`);
    }

    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, (config.fetchTimeout || 90) * 1000);

    child.on("error", (err) => {
      clearTimeout(killTimer);
      this.inFlight[id] = false;
      this.fail(id, config, `failed to run ${pythonBin}: ${err.message}`);
    });

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      clearTimeout(killTimer);
      this.inFlight[id] = false;

      let result;
      try {
        result = JSON.parse(lastJsonLine(stdout));
      } catch (e) {
        return this.fail(
          id,
          config,
          `bridge produced no JSON (exit ${code}). ${truncate(stderr || stdout)}`
        );
      }

      if (!result.ok) {
        return this.fail(id, config, result.error || "unknown bridge error");
      }

      // one module instance == one vehicle (first match)
      const vehicle = result.vehicles[0];
      const payload = {
        vehicle,
        _meta: Object.assign(
          {
            fetchedAt: new Date().toISOString(),
            vehicleCount: result.vehicles.length
          },
          result.meta || {}
        )
      };
      if (payload._meta.warning) {
        Log.warn("[MMM-KiaAccess] " + payload._meta.warning);
      }
      this.sendSocketNotification("KIA_DATA", { identifier: id, config, payload });
      this.publishMqtt(config, payload);
    });

    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  },

  fail(id, config, message) {
    Log.error("[MMM-KiaAccess] fetch failed: " + message);
    this.sendSocketNotification("KIA_ERROR", { identifier: id, config, error: message });
  },

  // ---- optional MQTT state publisher ----
  mqttClient(m) {
    const key = m.url + "|" + (m.username || "") + "|" + (m.topicPrefix || "");
    if (this.mqttClients[key]) return this.mqttClients[key];

    let mqtt;
    try {
      mqtt = require("mqtt");
    } catch (e) {
      Log.warn(
        "[MMM-KiaAccess] mqtt config set but the 'mqtt' package isn't installed " +
          "(cd into the module folder and run: npm install mqtt)"
      );
      this.mqttClients[key] = null; // don't retry the require every fetch
      return null;
    }

    const prefix = String(m.topicPrefix || "kia").replace(/\/+$/, "");
    const client = mqtt.connect(m.url, {
      username: m.username || undefined,
      password: m.password || undefined,
      reconnectPeriod: 30000,
      will: { topic: prefix + "/status", payload: "offline", retain: true, qos: 0 }
    });
    client.on("connect", () => {
      Log.info("[MMM-KiaAccess] mqtt connected to " + m.url);
      client.publish(prefix + "/status", "online", { retain: true });
    });
    client.on("error", (err) => Log.error("[MMM-KiaAccess] mqtt: " + err.message));
    this.mqttClients[key] = client;
    return client;
  },

  publishMqtt(config, payload) {
    const m = config && config.mqtt;
    if (!m || m.enabled === false || !m.url) return;
    const client = this.mqttClient(m);
    if (!client) return;

    const prefix = String(m.topicPrefix || "kia").replace(/\/+$/, "");
    const retain = m.retain !== false;
    const flat = flatten(payload.vehicle || {});

    Object.keys(flat).forEach((k) => {
      const v = flat[k];
      if (v === undefined) return;
      const topic = prefix + "/" + k.replace(/\./g, "/");
      client.publish(topic, v === null ? "" : String(v), { retain });
    });
    client.publish(prefix + "/_meta/fetched_at", String(payload._meta.fetchedAt || ""), { retain });
    if (m.publishJson !== false) {
      client.publish(prefix + "/state", JSON.stringify(payload.vehicle || {}), { retain });
    }
  }
});

function lastJsonLine(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("{")) return lines[i];
  }
  return text;
}

function truncate(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  n = n || 300;
  return s.length > n ? s.slice(0, n) + "…" : s;
}
