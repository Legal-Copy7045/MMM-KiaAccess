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
const { flatten } = require("./core/flatten.js");
const haDiscovery = require("./core/ha-discovery.js");
const haSource = require("./ha_source.js");
const sessions = require("./core/sessions.js");
const trips = require("./core/trips.js");
const drange = require("./core/range.js");
const isoline = require("./core/isoline.js");
const webhook = require("./webhook.js");
const exporter = require("./exporter.js");

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
    this.promServers = {}; // key -> exporter.PromServer
    this.haLive = {}; // id -> HaLiveClient (source: "homeassistant", mode: "push")
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
    else if (notification === "KIA_WEBHOOK") this.handleWebhook(payload);
  },

  // ---- optional outbound webhook: one HTTP POST per edge-triggered event ----
  // The frontend forwards every fired event; we apply the events/levels filter
  // and POST. One retry after 3 s on a network error; a non-2xx is logged only.
  handleWebhook(msg) {
    const hook = (msg && msg.webhook) || {};
    if (!hook.enabled || !hook.url) return;
    const opts = {
      method: hook.method || "POST",
      headers: hook.headers || {},
      timeoutMs: Number(hook.timeoutMs) || 8000
    };
    (msg.events || []).forEach((ev) => {
      if (!webhook.wants(hook, ev)) return;
      const body = Object.assign({ source: "MMM-KiaAccess" }, ev);
      if (msg.state) body.state = msg.state;
      const send = () => webhook.post(hook.url, body, opts);
      send()
        .then((code) => {
          if (code < 200 || code >= 300)
            Log.warn(`[MMM-KiaAccess] webhook ${hook.url} -> HTTP ${code}`);
        })
        .catch((err) => {
          Log.warn(`[MMM-KiaAccess] webhook ${hook.url} failed (${err.message}); retrying once`);
          setTimeout(() => {
            send().catch((e) =>
              Log.error(`[MMM-KiaAccess] webhook retry failed: ${e.message}`)
            );
          }, 3000);
        });
    });
  },

  identifierFor(config) {
    return [config.region, config.brand, config.username, config.vin || "auto"].join("|");
  },

  cacheFile(id) {
    return path.join(CACHE_DIR, crypto.createHash("sha1").update(id).digest("hex").slice(0, 16) + ".json");
  },

  st(id) {
    if (this.state[id]) return this.state[id];
    var s = {
      failStreak: 0, reqTimes: [], lastGood: null, history: [],
      sessions: [], openSession: null, rangeMap: null,
      trips: [], openTrip: null
    };
    try {
      var disk = JSON.parse(fs.readFileSync(this.cacheFile(id), "utf8"));
      if (disk && typeof disk === "object") {
        s.lastGood = disk.lastGood || null;
        s.history = Array.isArray(disk.history) ? disk.history : [];
        s.sessions = Array.isArray(disk.sessions) ? disk.sessions : [];
        s.openSession = disk.openSession || null;
        s.rangeMap = disk.rangeMap || null;
        s.trips = Array.isArray(disk.trips) ? disk.trips : [];
        s.openTrip = disk.openTrip || null;
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
    var file = this.cacheFile(id);
    var tmp = file + ".tmp";
    try {
      // write-then-rename so a power cut mid-write can't corrupt the cache
      // (a truncated file would take out the history + charge log)
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          lastGood: s.lastGood, history: s.history,
          sessions: s.sessions, openSession: s.openSession,
          rangeMap: s.rangeMap,
          trips: s.trips, openTrip: s.openTrip
        })
      );
      fs.renameSync(tmp, file);
    } catch (e) {
      Log.warn("[MMM-KiaAccess] could not write cache: " + e.message);
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
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

    // ---- alternative source: pull from a Home Assistant instance ----
    // (local read — not subject to the Kia request/hour cap)
    if (String(config.source || "kia").toLowerCase() === "homeassistant") {
      const haCfg = config.homeassistant || {};
      const mode = String(haCfg.mode || "push").toLowerCase();

      // push: a persistent WebSocket pushes changes as they happen. Each periodic
      // KIA_FETCH just checks the socket is alive and does a REST read only if
      // it isn't (startup, reconnect gap, or WS unsupported on this Node).
      if (mode !== "poll" && haSource.HaLiveClient.supported) {
        if (!this.haLive[id]) {
          this.haLive[id] = new haSource.HaLiveClient(haCfg, {
            onPayload: (p) => this.onPayload(id, config, p),
            onStatus: (msg, o) => {
              if (o && o.fatal) this.fail(id, config, "Home Assistant push: " + msg);
              else Log.info("[MMM-KiaAccess] " + msg);
            }
          });
          this.haLive[id].start();
        }
        // socket is live: the WS pushes changes on its own. Re-send the current
        // state so the frontend's watchdog stays happy between real updates.
        if (this.haLive[id].healthy && s.lastGood) {
          this.emitData(id, config, JSON.parse(JSON.stringify(s.lastGood)));
          return;
        }

        this.inFlight[id] = true;
        haSource
          .fetchFromHA(haCfg)
          .then((payload) => {
            this.inFlight[id] = false;
            this.onPayload(id, config, payload);
          })
          .catch((err) => {
            this.inFlight[id] = false;
            this.fail(id, config, "Home Assistant source: " + err.message);
          });
        return;
      }

      // poll mode (or Node without global WebSocket)
      this.inFlight[id] = true;
      haSource
        .fetchFromHA(haCfg)
        .then((payload) => {
          this.inFlight[id] = false;
          this.onPayload(id, config, payload);
        })
        .catch((err) => {
          this.inFlight[id] = false;
          this.fail(id, config, "Home Assistant source: " + err.message);
        });
      return;
    }

    // ---- request/hour guard (Kia source only) ----
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
      geocode: config.geocode === true,
      forceRefreshTimeout: Number(config.forceRefreshTimeout) || 45
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
      if (!Array.isArray(result.vehicles) || !result.vehicles.length) {
        return this.fail(id, config, "bridge returned no vehicles");
      }

      const vehicle = result.vehicles[0];
      const payload = {
        vehicle: vehicle,
        _meta: Object.assign(
          { fetchedAt: new Date().toISOString(), vehicleCount: result.vehicles.length, failStreak: 0 },
          result.meta || {}
        )
      };
      this.onPayload(id, config, payload);
    });

    // a broken pipe (child died before reading stdin) must not crash the helper
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(JSON.stringify(job));
      child.stdin.end();
    } catch (e) {
      /* 'error' handler + child.on('close'/'error') take it from here */
    }
  },

  /** common success path: record history, cache, emit, publish. */
  onPayload(id, config, payload) {
    const s = this.st(id);
    const vehicle = payload.vehicle || {};
    payload._meta = Object.assign({ fetchedAt: new Date().toISOString(), failStreak: 0 }, payload._meta || {});
    if (payload._meta.warning) Log.warn("[MMM-KiaAccess] " + payload._meta.warning);

    // did the vehicle data actually move since last poll? (mode C polls often)
    const vehJson = JSON.stringify(vehicle);
    const dataChanged = vehJson !== s._lastVehJson;
    s._lastVehJson = vehJson;

    // ---- record history (append at most every minGap; between gaps keep the
    // latest slot current, but only when a value actually changed) ----
    const minGap = (Number(config.historyMinIntervalMinutes) || 30) * 60e3;
    const last = s.history[s.history.length - 1];
    const sample = {
      t: Date.now(),
      ev: numOrNull(vehicle.ev_battery_percentage),
      v12: numOrNull(vehicle.car_battery_percentage)
    };
    let histChanged = false;
    if (!last || sample.t - last.t >= minGap) {
      s.history.push(sample);
      histChanged = true;
    } else if (last.ev !== sample.ev || last.v12 !== sample.v12) {
      s.history[s.history.length - 1] = sample;
      histChanged = true;
    }
    const beforePrune = s.history.length;
    this.pruneHistory(s, Number(config.historyDays) || 60);
    if (s.history.length !== beforePrune) histChanged = true;

    // ---- charge-session log ----
    const cl = config.chargeLog || {};
    const sess = sessions.update(s.openSession, {
      t: sample.t,
      charging: truthy(vehicle.ev_battery_is_charging),
      plugged: truthy(vehicle.ev_battery_is_plugged_in),
      batteryPct: numOrNull(vehicle.ev_battery_percentage),
      chargeKw: numOrNull(vehicle.ev_charging_power)
    }, {
      pricePerKwh: cl.pricePerKwh,
      capacityKwh: cl.capacityKwh || numOrNull(vehicle.ev_battery_capacity)
    });
    let sessChanged = JSON.stringify(sess.open) !== JSON.stringify(s.openSession);
    s.openSession = sess.open;
    if (sess.closed) {
      s.sessions.push(sess.closed);
      const keepAfter = Date.now() - (Number(cl.retentionDays) || 180) * 864e5;
      s.sessions = s.sessions.filter((x) => x && x.endedAt >= keepAfter).slice(-300);
      sessChanged = true;
      Log.info("[MMM-KiaAccess] charge session logged: " +
        sess.closed.kwh + " kWh" +
        (sess.closed.cost != null ? " / " + sess.closed.cost : ""));
    }

    // ---- trip / drive-segment log ----
    const tcfg = config.tripLog || {};
    const tr = trips.update(s.openTrip, {
      t: sample.t,
      odometerKm: numOrNull(vehicle.odometer),
      batteryPct: numOrNull(vehicle.ev_battery_percentage),
      charging: truthy(vehicle.ev_battery_is_charging),
      carOn: truthy(vehicle.engine_is_running),
      locationLat: numOrNull(vehicle.location_latitude),
      locationLon: numOrNull(vehicle.location_longitude)
    }, {
      pricePerKwh: cl.pricePerKwh,
      capacityKwh: cl.capacityKwh || numOrNull(vehicle.ev_battery_capacity),
      minKm: tcfg.minKm,
      parkGapMin: tcfg.parkGapMin
    });
    let tripChanged = JSON.stringify(tr.open) !== JSON.stringify(s.openTrip);
    s.openTrip = tr.open;
    if (tr.closed) {
      s.trips.push(tr.closed);
      const keepTrips = Date.now() - (Number(tcfg.retentionDays) || 365) * 864e5;
      s.trips = s.trips.filter((x) => x && x.endedAt >= keepTrips).slice(-500);
      tripChanged = true;
      Log.info("[MMM-KiaAccess] trip logged: " + tr.closed.distanceMi + " mi" +
        (tr.closed.miPerKwh != null ? " @ " + tr.closed.miPerKwh + " mi/kWh" : "") +
        (tr.closed.cost != null ? " / " + tr.closed.cost : ""));
    }
    if (tripChanged) sessChanged = true; // reuse the "persist + re-render" flag

    s.failStreak = 0;
    s.lastGood = payload;
    // only touch the disk cache when something changed — avoids an SD-card
    // write every poll when nothing moved
    if (dataChanged || histChanged || sessChanged) this.persist(id);

    this.emitData(id, config, payload);
    this.publishMqtt(config, payload);
    this.runExporters(config, payload);
    this.maybeRangeMap(id, config, payload);
  },

  // ---- optional time-series exporters (InfluxDB push + Prometheus /metrics) ----
  runExporters(config, payload) {
    const ex = config && config.exporter;
    if (!ex) return;
    const flat = flatten(payload.vehicle || {});
    const meta = payload._meta || {};
    const vin =
      (payload.vehicle && (payload.vehicle.VIN || payload.vehicle.vin)) || null;
    const tags = Object.assign(vin ? { vin } : {}, ex.tags || {});

    if (ex.influx && ex.influx.url && ex.influx.bucket) {
      exporter
        .pushInflux(ex.influx, flat, meta)
        .then((code) => {
          if (code < 200 || code >= 300)
            Log.warn("[MMM-KiaAccess] influx write -> HTTP " + code);
        })
        .catch((e) => Log.warn("[MMM-KiaAccess] influx write failed: " + e.message));
    }

    if (ex.prometheus && ex.prometheus.enabled !== false) {
      const port = Number(ex.prometheus.port) || 9110;
      let srv = this.promServers[port];
      if (!srv) {
        srv = new exporter.PromServer({
          port,
          path: ex.prometheus.path,
          prefix: ex.prometheus.prefix || "kia",
          labels: tags
        });
        srv.start();
        this.promServers[port] = srv;
        Log.info("[MMM-KiaAccess] Prometheus /metrics on :" + port);
      }
      srv.setSnapshot(flat, meta);
    }
  },

  // ---- optional road-network reachable-area image ----
  // The polygon comes from TomTom (any distance, needs tomtomKey) or Geoapify
  // (<= 100 km) or a plain circle; it's drawn onto a Geoapify static map (which
  // needs `apiKey`). Runs in the background; result pushed via KIA_RANGE_MAP.
  async maybeRangeMap(id, config, payload) {
    const rm = config && config.rangeMap;
    if (!rm || !rm.apiKey || typeof fetch !== "function") return;
    const s = this.st(id);
    const v = payload.vehicle || {};
    const lat = numOrNull(v.location_latitude);
    const lon = numOrNull(v.location_longitude);
    const rangeKm = numOrNull(v.ev_driving_range) || numOrNull(v.total_driving_range);
    if (lat == null || lon == null || !rangeKm) return;

    const ropts = { factor: rm.factor, reservePct: rm.reservePct };
    const oneWay = drange.reach(rangeKm, Object.assign({}, ropts, { roundTrip: false }));
    const round = drange.reach(rangeKm, Object.assign({}, ropts, { roundTrip: true }));
    if (!oneWay) return;

    const key = isoline.cacheKey(lat, lon, [oneWay, round]);
    if (s.rangeMap && s.rangeMap.key === key &&
        Date.now() - (s.rangeMap.at || 0) < 6 * 3600e3) return;
    if (this._rmInFlight === key) return;
    this._rmInFlight = key;

    const timedFetch = async (url) => {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 15000);
      try {
        const res = await fetch(url, { signal: ctl.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      } finally { clearTimeout(to); }
    };

    try {
      // one ring per distance: TomTom (any) -> Geoapify (<=100km) -> circle
      const ringFor = async (km) => {
        if (!km) return null;
        if (rm.tomtomKey) {
          try {
            const j = await timedFetch(isoline.tomtomUrl(
              { apiKey: rm.tomtomKey, lat, lon, distanceKm: km, mode: rm.mode }));
            const ring = isoline.parseTomtom(j);
            if (ring) return { ring, approx: false };
          } catch (e) { /* fall through */ }
        }
        if (rm.apiKey && !isoline.pastMax(km)) {
          try {
            const j = await timedFetch(isoline.isoUrl(
              { apiKey: rm.apiKey, lat, lon, rangesKm: [km], mode: rm.mode }));
            const p = isoline.parseIso(j);
            if (p.length && p[p.length - 1].ring) return { ring: p[p.length - 1].ring, approx: false };
          } catch (e) { /* fall through */ }
        }
        return { ring: drange.circleRing(lat, lon, km), approx: true };
      };
      const oneR = await ringFor(oneWay);
      const roundR = await ringFor(round);
      const pick = (r) => r && r.ring;

      const far = Math.max(oneWay, round || 0) * 1.6;
      const markers = [{ lat, lon, color: "#4ea1ff", always: true }].concat(
        (rm.pois || [])
          .map((p) => ({ lat: Number(p.lat), lon: Number(p.lon), color: "#e53935", text: p.name }))
          .filter((p) => isFinite(p.lat) && isFinite(p.lon) &&
            drange.haversineKm(lat, lon, p.lat, p.lon) <= far)
          .slice(0, 6)
      );
      const smap = (ring) => ring && isoline.staticMapUrl({
        apiKey: rm.apiKey, width: rm.width, height: rm.height, style: rm.style,
        simplifyDeg: rm.simplifyDeg,
        rings: [{ ring: ring, color: "#4caf50" }], markers: markers
      });

      s.rangeMap = {
        key: key, at: Date.now(),
        oneWayKm: Math.round(oneWay), roundTripKm: round ? Math.round(round) : null,
        oneWayApprox: !!(oneR && oneR.approx),
        roundTripApprox: roundR ? !!roundR.approx : null,
        oneWayUrl: smap(pick(oneR)),
        roundTripUrl: smap(pick(roundR))
      };
      this.persist(id);
      this.sendSocketNotification("KIA_RANGE_MAP", { identifier: id, rangeMap: s.rangeMap });
    } catch (e) {
      Log.warn("[MMM-KiaAccess] range map: " + e.message);
    } finally {
      this._rmInFlight = null;
    }
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
    payload.sessions = s.sessions.slice(-60);
    payload.openSession = s.openSession || null;
    payload.rangeMap = s.rangeMap || null;
    payload.trips = s.trips.slice(-60);
    payload.openTrip = s.openTrip || null;
    // note: `config` (credentials / token) is deliberately NOT echoed back
    this.sendSocketNotification("KIA_DATA", { identifier: id, payload });
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

    // don't fan the full raw API dump (vehicle.data.*) out to retained topics
    const skip = m.publishRaw === true ? null : /^data\./;
    Object.keys(flat).forEach((k) => {
      const v = flat[k];
      if (v === undefined) return;
      if (skip && skip.test(k)) return;
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

// true / false / null (unknown) — matches core/state.js bool()
function truthy(v) {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return null;
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
