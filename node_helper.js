/* MagicMirror² node_helper for MMM-KiaAccess
 *
 * Fetches vehicle data by shelling out to `kia_bridge.py`, which uses the
 * actively-maintained `hyundai_kia_connect_api` Python library. That library
 * handles Kia USA's Cloudflare bot protection, which blocks the Node
 * `bluelinky` library (HTTP 403).
 *
 * Credentials are passed to the child process on stdin (never argv), so they
 * do not show up in the process list.
 *
 * Reliability: the last good payload is cached to disk and re-served (flagged
 * stale) when a fetch fails; repeated failures back off; a request/hour cap
 * protects the Kia account. A rolling SoC / 12V history is persisted for the
 * sparkline and the 12V-drain alert.
 */
const NodeHelper = require("node_helper");
const Log = require("logger");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { flatten } = require("./flatten.js");
const haDiscovery = require("./ha_discovery.js");

const CACHE_DIR = path.join(__dirname, "cache");

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
    this.state = {}; // id -> { failStreak, reqTimes[], lastGood, history[] }
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch (e) {
      /* ignore */
    }
    Log.info("[MMM-KiaAccess] node_helper started");
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "KIA_FETCH") this.handleFetch(payload);
  },

  identifierFor(config) {
    return [config.region, config.brand, config.username, config.vin || "auto"].join("|");
  },

  cacheFile(id) {
    return path.join(CACHE_DIR, crypto.createHash("sha1").update(id).digest("hex").slice(0, 16) + ".json");
  },

  st(id) {
    if (this.state[id]) return this.state[id];
    var s = { failStreak: 0, reqTimes: [], lastGood: null, history: [] };
    try {
      var disk = JSON.parse(fs.readFileSync(this.cacheFile(id), "utf8"));
      if (disk && typeof disk === "object") {
        s.lastGood = disk.lastGood || null;
        s.history = Array.isArray(disk.history) ? disk.history : [];
      }
    } catch (e) {
      /* no cache yet */
    }
    this.state[id] = s;
    return s;
  },

  persist(id) {
    var s = this.state[id];
    if (!s) return;
    try {
      fs.writeFileSync(
        this.cacheFile(id),
        JSON.stringify({ lastGood: s.lastGood, history: s.history })
      );
    } catch (e) {
      Log.warn("[MMM-KiaAccess] could not write cache: " + e.message);
    }
  },

  pruneHistory(s, days) {
    var cutoff = Date.now() - (days || 60) * 864e5;
    s.history = s.history.filter(function (h) {
      return h && h.t >= cutoff;
    });
  },

  handleFetch(config) {
    const id = this.identifierFor(config);
    const s = this.st(id);
    if (this.inFlight[id]) {
      Log.info("[MMM-KiaAccess] fetch already in progress, skipping");
      return;
    }

    // ---- request/hour guard ----
    const now = Date.now();
    s.reqTimes = s.reqTimes.filter((t) => now - t < 3600e3);
    const cap = Number(config.maxRequestsPerHour) || 0;
    if (cap > 0 && s.reqTimes.length >= cap) {
      const retryAfterMs = 3600e3 - (now - s.reqTimes[0]) + 1000;
      Log.warn(`[MMM-KiaAccess] request cap reached (${cap}/hr) — serving cache`);
      return this.serve(id, config, {
        stale: true,
        note: `paused — ${cap} requests/hour cap`,
        retryAfterMs
      });
    }
    s.reqTimes.push(now);
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

    const killTimer = setTimeout(() => child.kill("SIGKILL"), (config.fetchTimeout || 90) * 1000);

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
        return this.fail(id, config, `bridge produced no JSON (exit ${code}). ${truncate(stderr || stdout)}`);
      }
      if (!result.ok) return this.fail(id, config, result.error || "unknown bridge error");

      const vehicle = result.vehicles[0];
      const payload = {
        vehicle: vehicle,
        _meta: Object.assign(
          { fetchedAt: new Date().toISOString(), vehicleCount: result.vehicles.length, failStreak: 0 },
          result.meta || {}
        )
      };
      if (payload._meta.warning) Log.warn("[MMM-KiaAccess] " + payload._meta.warning);

      // ---- record history ----
      const minGap = (Number(config.historyMinIntervalMinutes) || 30) * 60e3;
      const last = s.history[s.history.length - 1];
      const sample = {
        t: Date.now(),
        ev: numOrNull(vehicle.ev_battery_percentage),
        v12: numOrNull(vehicle.car_battery_percentage)
      };
      if (!last || sample.t - last.t >= minGap) s.history.push(sample);
      else s.history[s.history.length - 1] = sample; // refresh the latest slot
      this.pruneHistory(s, Number(config.historyDays) || 60);

      s.failStreak = 0;
      s.lastGood = payload;
      this.persist(id);

      this.emitData(id, config, payload);
      this.publishMqtt(config, payload);
    });

    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  },

  fail(id, config, message) {
    const s = this.st(id);
    s.failStreak = (s.failStreak || 0) + 1;
    Log.error(`[MMM-KiaAccess] fetch failed (streak ${s.failStreak}): ${message}`);
    this.serve(id, config, { stale: true, error: message });
  },

  /** send data — from cache when `opts` is given (stale / error / rate-limit), else assumed live */
  serve(id, config, opts) {
    const s = this.st(id);
    if (!s.lastGood) {
      this.sendSocketNotification("KIA_ERROR", {
        identifier: id,
        config,
        error: opts.error || opts.note || "no data yet",
        failStreak: s.failStreak || 0,
        retryAfterMs: opts.retryAfterMs
      });
      return;
    }
    const payload = JSON.parse(JSON.stringify(s.lastGood));
    payload._meta = Object.assign({}, payload._meta, {
      stale: true,
      cachedAt: payload._meta.fetchedAt,
      failStreak: s.failStreak || 0
    });
    if (opts.error) payload._meta.error = opts.error;
    if (opts.note) payload._meta.note = opts.note;
    if (opts.retryAfterMs) payload._meta.retryAfterMs = opts.retryAfterMs;
    this.emitData(id, config, payload);
  },

  emitData(id, config, payload) {
    const s = this.st(id);
    payload.history = s.history.slice();
    this.sendSocketNotification("KIA_DATA", { identifier: id, config, payload });
  },

  // ---- optional MQTT state publisher ----
  mqttClient(m) {
    const key = m.url + "|" + (m.username || "") + "|" + (m.topicPrefix || "");
    if (this.mqttClients[key] !== undefined) return this.mqttClients[key];

    let mqtt;
    try {
      mqtt = require("mqtt");
    } catch (e) {
      Log.warn(
        "[MMM-KiaAccess] mqtt config set but the 'mqtt' package isn't installed " +
          "(cd into the module folder and run: npm install mqtt)"
      );
      this.mqttClients[key] = null;
      return null;
    }

    const prefix = String(m.topicPrefix || "kia").replace(/\/+$/, "");
    const client = mqtt.connect(m.url, {
      username: m.username || undefined,
      password: m.password || undefined,
      reconnectPeriod: 30000,
      will: { topic: prefix + "/status", payload: "offline", retain: true, qos: 0 }
    });
    client._kiaDiscovered = false;
    client.on("connect", () => {
      Log.info("[MMM-KiaAccess] mqtt connected to " + m.url);
      client.publish(prefix + "/status", "online", { retain: true });
      client._kiaDiscovered = false; // re-send discovery after a reconnect
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

    // Home Assistant MQTT discovery (once per connection)
    const ha = m.homeAssistant;
    if (ha && ha.enabled && !client._kiaDiscovered) {
      try {
        haDiscovery.publish(client, { prefix, discoveryPrefix: ha.discoveryPrefix, device: ha.device, vehicle: payload.vehicle });
        client._kiaDiscovered = true;
      } catch (e) {
        Log.warn("[MMM-KiaAccess] HA discovery failed: " + e.message);
      }
    }

    Object.keys(flat).forEach((k) => {
      const v = flat[k];
      if (v === undefined) return;
      client.publish(prefix + "/" + k.replace(/\./g, "/"), v === null ? "" : String(v), { retain });
    });
    client.publish(prefix + "/_meta/fetched_at", String(payload._meta.fetchedAt || ""), { retain });
    client.publish(prefix + "/_meta/stale", payload._meta.stale ? "true" : "false", { retain });
    if (m.publishJson !== false) {
      client.publish(prefix + "/state", JSON.stringify(payload.vehicle || {}), { retain });
    }
  }
});

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

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
