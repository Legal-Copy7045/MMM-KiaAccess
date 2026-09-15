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
const S = require("./core/state.js");
const haDiscovery = require("./core/ha-discovery.js");
const haSource = require("./ha_source.js");
const sessions = require("./core/sessions.js");
const trips = require("./core/trips.js");
const analytics = require("./core/analytics.js");
const drange = require("./core/range.js");
const isoline = require("./core/isoline.js");
const webhook = require("./webhook.js");
const exporter = require("./exporter.js");

const CACHE_DIR = path.join(__dirname, "cache");

// How many consecutive SUCCESSFUL account-wide fetches a still-configured
// rotate-mode vehicle may be missing from the account's own response before
// it's treated as gone (sold, removed from the Kia app, …) and retired --
// see handleFetch()'s accountMissStreak tracking. Low enough to actually
// retire a genuinely-removed vehicle in reasonable time, high enough that
// one incomplete/flaky account response doesn't retire a car that's still
// really there.
const ACCOUNT_MISS_RETIRE_AFTER = 3;

/** Kia USA (KiaUvoApiUSA) never populates a vehicle's real VIN at all --
 * confirmed against the installed hyundai_kia_connect_api source, and
 * against its latest upstream too; every other region/brand implementation
 * does set it. kia_client.py's own _vehicle_key()/_vehicle_key_dict()
 * already fall back to the vehicle's own account-issued `id` for exactly
 * this reason (used by HA's config flow / AccountPoller.select_own_vehicle)
 * -- this is the Node-side mirror of that SAME fallback, used everywhere a
 * vehicle object needs to be turned into a stable per-vehicle identity:
 * rotate-mode filtering/dispatch, MQTT topic scoping, and the Influx/
 * Prometheus vin tag. Before this, every one of those sites read only
 * vehicle.VIN/vehicle.vin -- for a Kia USA multi-vehicle rotate config,
 * EVERY vehicle silently failed this check (both blank -> "" -> filtered
 * out), and the module processed zero vehicles from an otherwise-
 * successful account fetch, with no error surfaced anywhere. The config
 * schema still calls the field "vin" for backwards compatibility, but for
 * a Kia USA account it must be set to the vehicle's own `id` instead of a
 * literal VIN -- see README's rotate-mode section. */
function vehicleIdentity(vehicle) {
  if (!vehicle) return "";
  return String(vehicle.VIN || vehicle.vin || vehicle.id || "").trim().toUpperCase();
}

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
    this.mqttPrefixOwners = {}; // topicPrefix -> the connection key that first claimed it
    this.promServers = {}; // key -> exporter.PromServer
    this.haLive = {}; // id -> HaLiveClient (source: "homeassistant", mode: "push")
    this.state = {}; // id -> { failStreak, lastGood, history[] }
    this.rotateVins = {}; // account-level id -> Set of VINs configured as of the last fetch
    this.accountMissStreak = {}; // account-level id -> { vin: consecutive successful fetches missing it }
    // acctKeyFor(config) (region|brand|username, no vin) -> { reqTimes[] } --
    // the request/hour cap's own bucket, deliberately separate from `state`
    // (which is keyed by the vin-inclusive `id`) so two module configs
    // covering the SAME real Kia account under different vehicle scopes
    // share one request budget instead of each getting their own -- see
    // the request/hour guard in handleFetch().
    this.acctState = {};
    // An instance field (defaulting to the real module-level CACHE_DIR)
    // rather than reading the module constant directly everywhere below --
    // lets a test point a helper instance at a throwaway temp directory
    // instead of writing into this repo's real cache/ folder.
    this.cacheDir = CACHE_DIR;
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
      // mkdirSync's `mode` only applies to a directory it actually creates --
      // an existing cache/ from before this was added (or created under a
      // permissive umask) needs its own chmod to actually get locked down.
      fs.chmodSync(this.cacheDir, 0o700);
    } catch (e) {
      /* ignore */
    }
    Log.info("[MMM-KiaAccess] node_helper started");
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "KIA_FETCH") this.handleFetch(payload);
    else if (notification === "KIA_WEBHOOK") this.handleWebhook(payload);
    else if (notification === "KIA_LAST_PARKED") this.handleLastParked(payload);
  },

  // The frontend's moved-while-parked (tow/theft) anchor changed -- persist
  // it into that vehicle's own cache file so a MagicMirror restart doesn't
  // lose it (see st()'s and emitData()'s comments). `identifier` is the
  // same region|brand|username|VIN this vehicle's KIA_DATA/KIA_ERROR
  // already use, so this naturally stays isolated per vehicle in rotate
  // mode -- no new id scheme needed.
  handleLastParked(msg) {
    const identifier = msg && msg.identifier;
    if (!identifier) return;
    const s = this.st(identifier);
    s.lastParked = (msg.lastParked && typeof msg.lastParked === "object") ? msg.lastParked : null;
    this.persist(identifier);
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

  // The real Kia account this config talks to -- deliberately WITHOUT the
  // vin-or-"auto" suffix identifierFor() adds, so two module configs that
  // cover the same login under different vehicle scopes (a single-vehicle
  // block plus a separate rotate block for the same account, say) share one
  // request-rate budget instead of each getting their own -- see the
  // request/hour guard in handleFetch().
  acctKeyFor(config) {
    return [config.region, config.brand, config.username].join("|");
  },

  // sha256 purely to get a fixed-length, filesystem-safe, non-cleartext name
  // for a local (git-ignored) cache file / identity tag — not a security
  // boundary.
  _idHash(id) {
    return crypto.createHash("sha256").update(id).digest("hex").slice(0, 16);
  },

  cacheFile(id) {
    const file = path.join(this.cacheDir, this._idHash(id) + ".json");
    // one-time migration off the older (pre-v2.43.1) filename so
    // charge-session / trip history carries over on upgrade
    if (!fs.existsSync(file)) {
      try {
        this.migrateLegacyCache(file);
      } catch (e) {
        /* fall through to a fresh cache */
      }
    }
    return file;
  },

  // The old cache filename was also a hash of the vehicle id, so there's no
  // way to recompute it without hashing sensitive data again -- but every
  // file persist() writes (v2.56+) tags itself with _kiaAccessIdHash, so a
  // NEW-format leftover always identifies itself and is never ambiguous.
  // Only an OLD, untagged file (genuinely pre-v2.43.1) is a migration
  // candidate; a single leftover with a tag belongs to some OTHER already-
  // configured vehicle (routine now that one MM instance can rotate through
  // several cars, see the vehicles: config) and must never be adopted --
  // silently attaching vehicle A's history/sessions/trips to vehicle B
  // under a plausible-looking filename is far worse than just starting B
  // fresh. Ambiguous (0 or 2+ untagged leftovers) also falls through to a
  // fresh cache, as before.
  migrateLegacyCache(file) {
    const leftovers = fs.readdirSync(this.cacheDir)
      .filter((f) => f.endsWith(".json") && path.join(this.cacheDir, f) !== file)
      .filter((f) => {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(this.cacheDir, f), "utf8"));
          return !(parsed && typeof parsed === "object" && parsed._kiaAccessIdHash);
        } catch (e) {
          return false; // unreadable/corrupt -- not a safe migration candidate
        }
      });
    if (leftovers.length === 1) {
      fs.renameSync(path.join(this.cacheDir, leftovers[0]), file);
    }
  },

  st(id) {
    if (this.state[id]) return this.state[id];
    var s = {
      failStreak: 0, lastGood: null, history: [],
      sessions: [], openSession: null, rangeMap: null,
      // HA's driving-times data (mode C only) -- emitData() keeps the last
      // known value when a poll doesn't carry a fresh one, but that only
      // helps within one process lifetime unless it's also round-tripped
      // through the cache file like rangeMap/lastParked/etc: without this, a
      // MagicMirror restart would silently drop it back to null and the
      // "Driving times" widget would sit empty until HA supplied it again.
      rangeReach: null,
      trips: [], openTrip: null,
      // moved-while-parked (tow/theft) anchor -- lives on the FRONTEND
      // (MMM-KiaAccess.js's processConditions()), not computed here, but
      // persisted through this per-vehicle cache like everything else so a
      // MagicMirror restart doesn't lose it (see handleLastParked() below
      // and emitData()'s round-trip). Without this, a vehicle towed/moved
      // while MM was down would silently become its own new "parked here"
      // baseline on the first post-restart poll instead of being detected
      // as having moved at all.
      lastParked: null
    };
    try {
      var disk = JSON.parse(fs.readFileSync(this.cacheFile(id), "utf8"));
      if (disk && typeof disk === "object") {
        s.lastGood = disk.lastGood || null;
        s.history = Array.isArray(disk.history) ? disk.history : [];
        s.sessions = Array.isArray(disk.sessions) ? disk.sessions : [];
        s.openSession = disk.openSession || null;
        s.rangeMap = disk.rangeMap || null;
        s.rangeReach = disk.rangeReach || null;
        s.trips = Array.isArray(disk.trips) ? disk.trips : [];
        s.openTrip = disk.openTrip || null;
        s.lastParked = disk.lastParked || null;
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
          // identity tag (a hash, not the raw id -- which embeds the
          // account email) -- see migrateLegacyCache()'s comment for why
          // this exists: it's what stops a brand-new vehicle's first cache
          // file from ever being able to adopt an already-tagged file that
          // belongs to a DIFFERENT vehicle.
          _kiaAccessIdHash: this._idHash(id),
          lastGood: s.lastGood, history: s.history,
          sessions: s.sessions, openSession: s.openSession,
          rangeMap: s.rangeMap, rangeReach: s.rangeReach,
          trips: s.trips, openTrip: s.openTrip,
          lastParked: s.lastParked
        }),
        // owner-only -- this file carries the vehicle's raw API dump
        // (GPS/location history, VIN, odometer), the same class of
        // personal data token.json's credentials get chmod'd for; on a
        // shared/multi-user host the default umask would otherwise leave
        // it group/world-readable.
        { mode: 0o600 }
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

    // "rotate within one module": config.vehicles is a list of {vin, header}
    // to cycle through on-screen. Computed up front (not just before the
    // bridge spawn below) because request-cap/error paths ahead of that
    // point need it too -- see _reportFailure()'s comment for why an
    // account-level failure can't just use `id` here in rotate mode.
    const rotating = Array.isArray(config.vehicles) && config.vehicles.length > 0;

    // A vehicle removed from config.vehicles must be retired (MQTT
    // "offline", Prometheus snapshot dropped) unconditionally, on the very
    // next call, NOT only once a fetch happens to succeed -- this diff only
    // needs config.vehicles (current) vs this.rotateVins[id] (the set as of
    // the last time this ran), no account data at all. Retirement used to
    // live only inside _handleBridgeClose's success branch: a vehicle
    // removed from config while the account kept failing to fetch (bad
    // credentials, a cooldown, an outage) stayed "online"/reporting stale
    // numbers for as long as the fetch kept failing -- backwards, since the
    // user's own config change is known immediately regardless of whether
    // Kia's API is reachable at all. Safe to also still run (as a no-op)
    // inside a later successful fetch's own diff -- see _retireVehicle()'s
    // idempotency.
    this._retireRemovedFromConfig(id, config);

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
    // Keyed by ACCOUNT (region|brand|username), not `id` -- `id` includes the
    // vin-or-"auto" suffix, so two module configs covering the same real Kia
    // account under different vin-scopes (e.g. one single-vehicle block plus
    // one rotate block for the same login) used to each get their OWN
    // request budget, silently doubling (or more) the real request rate
    // against Kia's servers despite maxRequestsPerHour being set identically
    // on both -- defeating the one thing this cap exists to guarantee.
    const acctKey = this.acctKeyFor(config);
    const acct = this.acctState[acctKey] || (this.acctState[acctKey] = { reqTimes: [] });
    const now = Date.now();
    acct.reqTimes = acct.reqTimes.filter((t) => now - t < 3600e3);
    const cap = Number(config.maxRequestsPerHour) || 0;
    if (cap > 0 && acct.reqTimes.length >= cap) {
      const retryAfterMs = 3600e3 - (now - acct.reqTimes[0]) + 1000;
      Log.warn(`[MMM-KiaAccess] request cap reached (${cap}/hr) — serving cache`);
      return this._reportServe(id, config, rotating, {
        stale: true,
        note: `paused — ${cap} requests/hour cap`,
        retryAfterMs
      });
    }
    acct.reqTimes.push(now);
    this.inFlight[id] = true;

    // One bridge call fetches every configured vehicle at once
    // (allVehicles:true, see kia_client.fetch()) instead of running one
    // bridge process per car -- cheaper on Kia's servers, and each vehicle
    // still gets its own isolated history/session/trip/cache/mqtt identity
    // below (see child.on("close") and onPayload()'s `id` param), exactly
    // like a dedicated single-vehicle module instance would.
    const pythonBin = resolvePython(config.pythonBin);
    const script = path.join(__dirname, "kia_bridge.py");
    const job = {
      username: config.username,
      password: config.password,
      pin: config.pin,
      brand: config.brand || "KIA",
      region: config.region || "USA",
      vin: rotating ? "" : config.vin || "",
      allVehicles: rotating,
      refresh: config.refresh !== false,
      geocode: config.geocode === true,
      // honour an explicit 0 (cache-only) — don't let `|| 45` clobber it
      forceRefreshTimeout:
        config.forceRefreshTimeout == null || config.forceRefreshTimeout === ""
          ? 45
          : Number(config.forceRefreshTimeout) || 0
    };

    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(pythonBin, [script], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      this.inFlight[id] = false;
      return this._reportFailure(id, config, rotating, `could not start ${pythonBin}: ${err.message}`);
    }

    const killTimer = setTimeout(() => child.kill("SIGKILL"), (config.fetchTimeout || 90) * 1000);

    // A spawn-level failure (bad executable, no exec permission, OS-level
    // error) fires BOTH "error" and a subsequent "close" -- two separate
    // Node child_process lifecycle events for the one real failure, not a
    // caller mistake. Without this guard, both handlers report a failure:
    // failStreak double-increments (skewing the exponential backoff) and
    // the frontend gets the same error twice.
    let settled = false;
    const reportOnce = (message) => {
      if (settled) return;
      settled = true;
      this._reportFailure(id, config, rotating, message);
    };

    child.on("error", (err) => {
      clearTimeout(killTimer);
      this.inFlight[id] = false;
      reportOnce(`failed to run ${pythonBin}: ${err.message}`);
    });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      clearTimeout(killTimer);
      this.inFlight[id] = false;
      if (settled) return; // "error" already reported this exact failure
      this._handleBridgeClose(id, config, rotating, code, stdout, stderr, reportOnce);
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

  // Extracted from handleFetch()'s child.on("close", ...) purely so it's
  // directly unit-testable without spawning a real kia_bridge.py process --
  // pass a fake stdout/JSON result and a spy in place of reportOnce, and
  // this can be exercised exactly like a real bridge response. No behaviour
  // change from when this lived inline; same parameters the closure over
  // handleFetch's local scope used to provide.
  _handleBridgeClose(id, config, rotating, code, stdout, stderr, reportOnce) {
    let result;
    try {
      result = JSON.parse(lastJsonLine(stdout));
    } catch (e) {
      return reportOnce(`bridge produced no JSON (exit ${code}). ${truncate(stderr || stdout)}`);
    }
    // kia_client.fetch() itself now refuses (result.ok === false) a
    // multi-vehicle account with no VIN configured, UNLESS this is a
    // rotate instance (job.allVehicles:true above) -- rather than warning
    // here and silently picking [0], which physical car that was could
    // change between polls. So outside rotate mode, result.vehicles is
    // guaranteed to have exactly one entry by the time we reach this line.
    if (!result.ok) {
      return reportOnce(result.error || "unknown bridge error");
    }
    if (!Array.isArray(result.vehicles) || !result.vehicles.length) {
      return reportOnce("bridge returned no vehicles");
    }

    if (rotating) {
      // job.allVehicles:true (above) tells kia_client.fetch() to return
      // EVERY vehicle on the account, not just the ones this module
      // config lists -- config.vehicles is what actually scopes "the
      // cars this module rotates through" (it's also the exact list the
      // frontend indexes into for its own rotation), so an account with
      // more cars than are configured here must not let the extra ones
      // through: they'd get cache/history/session/trip files created,
      // publish to MQTT/Influx/Prometheus, and trigger range-map fetches
      // for a vehicle nothing asked this module to track.
      const configuredVins = new Set(
        config.vehicles.map((v) => String(v.vin || "").toUpperCase())
      );
      const seenVins = new Set();
      // Route each vehicle through the exact same per-id pipeline a
      // dedicated single-vehicle module instance uses (onPayload() reads
      // everything -- history, sessions, trips, cache, mqtt, exporter --
      // off `this.st(id)`, so giving each vehicle its own subId here is
      // what keeps two cars' trip/charge logs from ever mixing).
      result.vehicles.forEach((vehicle) => {
        const vin = vehicleIdentity(vehicle);
        if (!vin || !configuredVins.has(vin)) return;
        seenVins.add(vin);
        const subId = this.identifierFor(Object.assign({}, config, { vin }));
        this.onPayload(subId, config, {
          vehicle: vehicle,
          _meta: Object.assign(
            { fetchedAt: new Date().toISOString(), vehicleCount: result.vehicles.length, failStreak: 0 },
            result.meta || {}
          )
        });
      });

      // The account genuinely returned vehicles this poll, but NONE of them
      // matched anything in config.vehicles -- this is a fetch that
      // "succeeded" (result.ok, non-empty result.vehicles) while silently
      // processing zero cars, which is easy to mistake for "everything's
      // fine, just nothing changed" rather than a config problem. Almost
      // always means config.vehicles' vin: values don't match what
      // vehicleIdentity() actually computes for this account (e.g. a Kia
      // USA account, where it's the vehicle's own `id`, not its VIN --
      // logging what the account actually returned turns this from a
      // silent no-op into something fixable.
      if (result.vehicles.length && !seenVins.size) {
        Log.warn("[MMM-KiaAccess] rotate mode: account returned " +
          result.vehicles.length + " vehicle(s) but none matched config.vehicles' vin: " +
          "values -- account has: " +
          result.vehicles.map((v) => vehicleIdentity(v) || "(no VIN or id)").join(", ") +
          ". For a Kia USA account, set vin: to the vehicle's own id shown here, not its literal VIN.");
      }

      // Retire any vehicle that WAS configured on a previous fetch but no
      // longer is (removed from vehicles: since then) -- otherwise its
      // MQTT status stays retained "online" and its Prometheus series
      // keeps reporting its last-known numbers forever, indistinguishable
      // from a car that's still actually being polled.
      const prevVins = this.rotateVins[id];
      if (prevVins) {
        prevVins.forEach((vin) => {
          if (!configuredVins.has(vin)) this._retireVehicle(config, vin);
        });
      }
      this.rotateVins[id] = configuredVins;

      // Separately: a vehicle can stay in vehicles: but drop out of the
      // ACCOUNT's own response (sold, removed from the Kia app, etc.) --
      // same stale-forever problem, different cause, so it needs its own
      // retirement path rather than piggybacking on the config diff
      // above. Debounced across several consecutive SUCCESSFUL fetches
      // (not just polls -- a failed fetch never reaches this line at
      // all) specifically because a single incomplete/flaky account
      // response missing one car is a known, ordinary occurrence; only a
      // sustained absence should be treated as "this vehicle is gone."
      const miss = this.accountMissStreak[id] || {};
      configuredVins.forEach((vin) => {
        if (seenVins.has(vin)) {
          delete miss[vin];
        } else {
          miss[vin] = (miss[vin] || 0) + 1;
          if (miss[vin] >= ACCOUNT_MISS_RETIRE_AFTER) {
            this._retireVehicle(config, vin);
            delete miss[vin];
          }
        }
      });
      this.accountMissStreak[id] = miss;
      return;
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
    // home vs away: is the car within homeRadiusKm of homeLat/homeLon? null
    // (= home rate) when no home point is set or there's no GPS fix
    let atHome = null;
    const cLat = numOrNull(vehicle.location_latitude);
    const cLon = numOrNull(vehicle.location_longitude);
    if (cl.homeLat != null && cl.homeLon != null && cLat != null && cLon != null) {
      const homeRadiusKm = Number(cl.homeRadiusKm);
      atHome = drange.haversineKm(cLat, cLon, Number(cl.homeLat), Number(cl.homeLon))
        <= (isFinite(homeRadiusKm) ? homeRadiusKm : 0.2);
    }
    // per-zone rates: first matching zone wins; its rate + label override the
    // home/away rate for this session
    let zoneRate = null;
    let zoneLabel = null;
    if (cLat != null && cLon != null && Array.isArray(cl.zoneRates)) {
      for (const z of cl.zoneRates) {
        if (!z || z.lat == null || z.lon == null || z.pricePerKwh == null) continue;
        const km = drange.haversineKm(cLat, cLon, Number(z.lat), Number(z.lon));
        if (km <= (Number(z.radiusKm) || 0.2)) {
          zoneRate = Number(z.pricePerKwh);
          zoneLabel = z.name || null;
          break;
        }
      }
    }
    const sess = sessions.update(s.openSession, {
      t: sample.t,
      charging: truthy(vehicle.ev_battery_is_charging),
      plugged: truthy(vehicle.ev_battery_is_plugged_in),
      batteryPct: numOrNull(vehicle.ev_battery_percentage),
      chargeKw: numOrNull(vehicle.ev_charging_power),
      atHome: atHome,
      rate: zoneRate,
      rateLabel: zoneLabel
    }, {
      pricePerKwh: cl.pricePerKwh,
      awayPricePerKwh: cl.awayPricePerKwh || null,
      capacityKwh: cl.capacityKwh || numOrNull(vehicle.ev_battery_capacity),
      // sessions.js's DEFAULT_CAPACITY_KWH fallback is the EV9's own pack
      // size -- it only applies when this vehicle's own model actually
      // looks like an EV9, so it never silently borrows the EV9's battery
      // size for some other model with no configured/reported capacity.
      model: vehicle.model
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
    // carOn (and charging) must use the SAME canonical definition the rest
    // of the app uses (buildState()'s anyTrue(engine_is_running,
    // accessory_on, ign3, remote_ignition)) -- a hand-picked
    // truthy(vehicle.engine_is_running) here would let trip tracking
    // disagree with the alert engine about whether the car is actually
    // driving.
    const tripState = S.buildState(flatten({ vehicle: vehicle }), {});
    const tcfg = config.tripLog || {};
    const tr = trips.update(s.openTrip, {
      t: sample.t,
      odometerKm: tripState.odometerKm,
      batteryPct: tripState.batteryPct,
      charging: tripState.charging,
      carOn: tripState.carOn,
      locationLat: tripState.locationLat,
      locationLon: tripState.locationLon,
      // fed to core/analytics.js via the closed trip record -- both were
      // already computed by buildState() above, no new data needed
      rangeKm: tripState.rangeKm,
      outsideTempC: tripState.outsideTempC
    }, {
      pricePerKwh: cl.pricePerKwh,
      capacityKwh: cl.capacityKwh || numOrNull(vehicle.ev_battery_capacity),
      // see the session-tracking block above for why
      model: vehicle.model,
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

    // ---- observed-performance analytics (core/analytics.js) ----
    // Recomputed only when a trip or session actually closed/changed --
    // cheap either way (pure aggregation over the already-in-memory
    // s.trips/s.sessions arrays), but no reason to redo it every poll when
    // neither history actually moved. Stored on `s` (not built fresh in
    // emitData()) so every emitData() caller -- a live poll, serve()'s
    // stale-cache replay, handleFetch()'s healthy-socket replay -- sees
    // the same figures without recomputing, matching how s.rangeMap works.
    if (tripChanged || sessChanged) {
      const unitsOpt = { units: config.units };
      s.analytics = {
        observedEfficiency: analytics.observedEfficiency(s.trips, unitsOpt),
        rangeAccuracy: analytics.rangeAccuracy(s.trips, unitsOpt),
        chargingPerformance: analytics.chargingPerformance(s.sessions),
        drivingPatterns: analytics.drivingPatterns(s.trips, unitsOpt)
      };
    }

    s.failStreak = 0;
    s.lastGood = payload;
    // rangeReach (HA's driving-times data, mode C) must be folded into s
    // BEFORE the persist decision below, not inside emitData() (which used
    // to do this) -- emitData() runs AFTER persist(), so a cycle where
    // rangeReach changed but nothing else did (a plausible common case:
    // traffic/route data changes without the vehicle's own telemetry
    // moving, since rangeReach is a sibling of payload.vehicle, not part of
    // it) would see dataChanged/histChanged/sessChanged all false, skip
    // persist() entirely, and leave the disk cache holding a stale
    // rangeReach indefinitely -- until some unrelated later change happened
    // to also trigger a persist.
    const rangeReachChanged = !!payload.rangeReach &&
      JSON.stringify(payload.rangeReach) !== JSON.stringify(s.rangeReach);
    if (payload.rangeReach) s.rangeReach = payload.rangeReach;
    // only touch the disk cache when something changed — avoids an SD-card
    // write every poll when nothing moved
    if (dataChanged || histChanged || sessChanged || rangeReachChanged) this.persist(id);

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
    const vin = vehicleIdentity(payload.vehicle) || null;
    const tags = Object.assign(vin ? { vin } : {}, ex.tags || {});

    if (ex.influx && ex.influx.url && ex.influx.bucket) {
      // `tags` (vin + ex.tags) was computed above but never actually reached
      // pushInflux() -- every write used ex.influx's own (usually absent)
      // tags only, so multi-vehicle Influx samples weren't separated by VIN
      // as the config's own comment promises. Merge it in; an explicit
      // ex.influx.tags entry still wins on a key collision.
      const influxCfg = Object.assign({}, ex.influx, {
        tags: Object.assign({}, tags, ex.influx.tags || {})
      });
      exporter
        .pushInflux(influxCfg, flat, meta)
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
          // base tags only -- a rotating module's several vehicles can share
          // one port/server, so the per-vehicle vin tag is applied per
          // setSnapshot() call below (its 3rd arg), not baked in here
          labels: ex.tags || {},
          // Without this, a bind failure (port already in use, no
          // permission on a privileged port, …) was silently swallowed --
          // setSnapshot() kept being called as if /metrics were being
          // served while every actual scrape just failed with nothing
          // logged anywhere to explain why.
          onError: (err) => {
            Log.error(`[MMM-KiaAccess] Prometheus server on :${port} failed: ${err.message}`);
            // `this.promServers[port] = srv` (below) already ran by the time
            // this fires (listen() is sync, the bind failure/success is
            // reported asynchronously) -- without clearing it, every future
            // poll would see a truthy-but-dead server here and never retry
            // binding even once the port becomes free.
            if (this.promServers[port] === srv) delete this.promServers[port];
            srv.stop();
          }
        });
        srv.start();
        this.promServers[port] = srv;
        Log.info("[MMM-KiaAccess] Prometheus /metrics on :" + port);
      } else if (
        !srv._mismatchWarned &&
        (srv.path !== (ex.prometheus.path || "/metrics") ||
          srv.prefix !== (ex.prometheus.prefix || "kia"))
      ) {
        srv._mismatchWarned = true; // once per server, not once per poll
        // Two DIFFERENT module configs sharing one port is a real OS-level
        // constraint, not just a bookkeeping choice: only one process can
        // ever bind a given TCP port, so there is no such thing as two
        // independent PromServers on it -- whichever config's module
        // instance got here first silently wins the path/prefix for every
        // vehicle on this port from then on. Different vehicles' own
        // numbers still show up correctly (they're separate label-series,
        // see setSnapshot()'s vin argument), so this only warns rather than
        // failing -- but a mismatched path/prefix means the LOSING config's
        // own setting is being ignored, worth knowing about.
        Log.warn(
          `[MMM-KiaAccess] Prometheus port ${port} is already serving ` +
          `path "${srv.path}" / prefix "${srv.prefix}" (from another ` +
          `module config) -- this config's path/prefix is being ignored. ` +
          `Give each module instance its own prometheus.port if you want ` +
          `them independent.`
        );
      }
      // Passing vin keys this snapshot separately from any other vehicle
      // sharing the same server/port -- without it, a rotating module's N
      // vehicles calling setSnapshot() on the same PromServer would each
      // overwrite the last one's numbers, while /metrics kept reporting
      // them under whichever vehicle's vin created the server first.
      srv.setSnapshot(flat, meta, vin);
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
    // Keyed by `id` (per vehicle), not a single module-wide slot -- a
    // rotate-mode module calls maybeRangeMap() for every vehicle from one
    // fetch cycle, near-simultaneously; a shared slot meant vehicle B's
    // request could clear/overwrite vehicle A's in-flight marker (or vice
    // versa) before A's fetch actually finished, defeating the guard for
    // both instead of coalescing each vehicle's own repeat requests.
    this._rmInFlight = this._rmInFlight || {};
    if (this._rmInFlight[id] === key) return;
    this._rmInFlight[id] = key;

    // Same out-of-order-resolution problem ha_source.js's HaLiveClient._emit()
    // already guards against with its own _emitSeq counter: two overlapping
    // calls for this SAME id (a slow one for an OLD position/key, a fast one
    // for a NEWER one -- e.g. HA poll mode's 30s default interval is often
    // shorter than this function's own up-to-~30s worst-case external-API
    // time, so a moving car can genuinely trigger two overlapping calls with
    // different keys) must not let the slower, now-stale call's result win
    // just because it happened to finish last. Bumped here, checked again
    // right before the write below -- only the call that's still the LATEST
    // one started for this id is allowed to actually write s.rangeMap.
    this._rmGen = this._rmGen || {};
    const gen = (this._rmGen[id] = (this._rmGen[id] || 0) + 1);

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

      // A newer call for this same id (different, more current key) may have
      // started -- and even already finished and written its own result --
      // while these awaits were pending. Writing this now-stale result over
      // it would silently regress the map to an out-of-date location/range
      // until the NEXT poll happens to re-diverge from this stale key.
      if (this._rmGen[id] !== gen) return;

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
      // Only clear the in-flight marker if it's still ours -- a newer call
      // may have already overwritten it with ITS OWN key, and this (older,
      // now-finishing) call clearing that unconditionally would let a THIRD,
      // redundant call for that same still-in-flight newer key slip through.
      if (this._rmInFlight[id] === key) this._rmInFlight[id] = null;
    }
  },

  fail(id, config, message) {
    const s = this.st(id);
    s.failStreak = (s.failStreak || 0) + 1;
    Log.error(`[MMM-KiaAccess] fetch failed (streak ${s.failStreak}): ${message}`);
    this.serve(id, config, { stale: true, error: message });
  },

  // A whole-account fetch that fails before any vehicle-specific data comes
  // back (bridge wouldn't start, no JSON, kia_client.fetch() itself errored,
  // the request-cap was hit) has nowhere vehicle-specific to report through
  // -- there IS no per-vehicle payload yet. Reporting it under the account-
  // level `id` (region|brand|username|auto) is what a single-vehicle module
  // expects, but the frontend's isForMe() in rotate mode only ever accepts
  // region|brand|username|<configured VIN> (see MMM-KiaAccess.js) and
  // silently drops anything else -- so a rotate-mode account failure would
  // vanish into the void: no error surfaced, no stale-cache fallback shown,
  // the UI just keeps displaying whatever it already had with no indication
  // anything is wrong. Fan it out to each configured vehicle's own identity
  // instead, so every one gets its own (correctly failStreak-tracked, cache-
  // backed) failure report, same as if each had its own dedicated module
  // instance that individually failed to fetch.
  _reportFailure(id, config, rotating, message) {
    if (!rotating) return this.fail(id, config, message);
    // Dedup defensively even though MMM-KiaAccess.js's own config
    // normalisation already does -- a duplicated vin entry here would
    // otherwise call fail() twice for the one vehicle, double-counting its
    // failStreak for a single real failure.
    const seen = new Set();
    (config.vehicles || []).forEach((v) => {
      const vin = String((v && v.vin) || "").toUpperCase();
      if (!vin || seen.has(vin)) return;
      seen.add(vin);
      this.fail(this.identifierFor(Object.assign({}, config, { vin })), config, message);
    });
  },

  // Same idea as _reportFailure(), for a non-error "serve what we have"
  // case (currently just the request/hour cap) -- opts (stale/note/
  // retryAfterMs) apply identically to every configured vehicle since the
  // cap is account-wide, not per-car.
  _reportServe(id, config, rotating, opts) {
    if (!rotating) return this.serve(id, config, opts);
    const seen = new Set();
    (config.vehicles || []).forEach((v) => {
      const vin = String((v && v.vin) || "").toUpperCase();
      if (!vin || seen.has(vin)) return;
      seen.add(vin);
      this.serve(this.identifierFor(Object.assign({}, config, { vin })), config, opts);
    });
  },

  // A vehicle removed from a rotate-mode vehicles: config (see handleFetch's
  // rotateVins diff) stops being fetched, but its telemetry would otherwise
  // linger forever: MQTT's retained "online" status and Prometheus's last
  // snapshot are both durable by design and nothing else naturally expires
  // them. This doesn't touch the vehicle's individual cache/history/session/
  // trip file -- those stay on disk exactly like a module instance that's
  // simply stopped polling would leave them, in case the vehicle comes back.
  // See handleFetch()'s call site for why this runs unconditionally, before
  // any fetch is even attempted -- not gated behind fetch success.
  _retireRemovedFromConfig(id, config) {
    if (!(Array.isArray(config.vehicles) && config.vehicles.length > 0)) return;
    const configuredVins = new Set(
      config.vehicles.map((v) => String(v.vin || "").toUpperCase())
    );
    const prevVins = this.rotateVins[id];
    if (prevVins) {
      prevVins.forEach((vin) => {
        if (!configuredVins.has(vin)) this._retireVehicle(config, vin);
      });
    }
    this.rotateVins[id] = configuredVins;
  },

  _retireVehicle(config, vin) {
    const m = config && config.mqtt;
    if (m && m.enabled !== false && m.url) {
      const client = this.mqttClient(m);
      if (client) {
        const basePrefix = String(m.topicPrefix || "kia").replace(/\/+$/, "");
        client.publish(basePrefix + "/" + vin + "/status", "offline", {
          retain: m.retain !== false
        });
      }
    }
    const ex = config && config.exporter;
    if (ex && ex.prometheus && ex.prometheus.enabled !== false) {
      const port = Number(ex.prometheus.port) || 9110;
      const srv = this.promServers[port];
      if (srv) srv.removeSnapshot(vin);
    }
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
    // driving times come from HA (mode C); keep the last known set if this
    // payload didn't carry one. (Folding a FRESH payload.rangeReach into
    // s.rangeReach happens earlier, in onPayload() -- before the persist
    // decision, see its comment -- not here; every other caller of
    // emitData() [serve()'s stale replay, handleFetch()'s healthy-socket
    // replay] passes an already-cloned s.lastGood whose rangeReach, if any,
    // already reflects the last real update, so re-assigning it here would
    // only ever be a same-value no-op for them.)
    if (!payload.rangeReach && s.rangeReach) payload.rangeReach = s.rangeReach;
    payload.trips = s.trips.slice(-60);
    payload.openTrip = s.openTrip || null;
    // round-tripped so the frontend can restore its moved-while-parked
    // anchor after a restart instead of starting blank (see st()'s comment)
    payload.lastParked = s.lastParked || null;
    // s.analytics is normally kept fresh incrementally in onPayload() (only
    // recomputed when a trip/session actually changed) -- but right after a
    // MagicMirror restart, s.trips/s.sessions are restored from disk while
    // s.analytics itself is NOT (it's a pure derived value, so it isn't
    // worth persisting), leaving it unset until the next trip/session
    // change, which could be a long wait for a car that's just sitting
    // parked. Compute it once here on first access instead of leaving the
    // "Observed Range & Efficiency" widget empty until then.
    if (s.analytics === undefined) {
      const unitsOpt = { units: config.units };
      s.analytics = {
        observedEfficiency: analytics.observedEfficiency(s.trips, unitsOpt),
        rangeAccuracy: analytics.rangeAccuracy(s.trips, unitsOpt),
        chargingPerformance: analytics.chargingPerformance(s.sessions),
        drivingPatterns: analytics.drivingPatterns(s.trips, unitsOpt)
      };
    }
    payload.analytics = s.analytics;
    // note: `config` (credentials / token) is deliberately NOT echoed back
    this.sendSocketNotification("KIA_DATA", { identifier: id, payload });
  },

  // ---- optional MQTT state publisher ----
  mqttClient(m) {
    // password included: two configs that differ only by credentials must
    // never share a connection -- url/username/topicPrefix alone would
    // silently connect the SECOND config with the FIRST one's password.
    const key = m.url + "|" + (m.username || "") + "|" + (m.password || "") +
      "|" + (m.topicPrefix || "");
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

    // Two DIFFERENT connections (distinct credentials -- see `key` above)
    // can still legitimately share the same topicPrefix (two accounts, one
    // broker, same prefix chosen independently). mqtt.js only supports ONE
    // static Last-Will-and-Testament per connection, so it has to point
    // somewhere deterministic and connection-specific -- a plain
    // `<prefix>/status` shared by both connections would mean one
    // connection dropping publishes offline to a topic the OTHER, healthy
    // connection also claims, flipping based on whichever last (dis)
    // connected rather than reflecting either account specifically.
    // statusTopic below is derived from the connection's own identity
    // (username, or the URL if anonymous) so it's stable across restarts
    // and never collides between two genuinely different accounts, even
    // sharing one topicPrefix.
    // Human-readable for recognisability, but that alone can collide: two
    // DIFFERENT usernames/URLs can sanitise to the identical string (e.g.
    // "foo/bar@x" and "foo_bar@x" both become "foo_bar@x" once "/" is
    // stripped). A short hash of the actual (username, url) pair -- the same
    // identity components `key` above is keyed on, password aside -- makes
    // the segment collision-proof regardless of what the readable part does.
    const acctReadable = String(m.username || m.url || "account")
      .toLowerCase().replace(/[^a-z0-9_.@-]/g, "_").slice(0, 40);
    const acctSeg = acctReadable + "-" + this._idHash((m.username || "") + "|" + (m.url || "")).slice(0, 8);
    const statusTopic = prefix + "/status/" + acctSeg;

    const owner = this.mqttPrefixOwners[prefix];
    if (owner === undefined) {
      this.mqttPrefixOwners[prefix] = key;
    } else if (owner !== key) {
      Log.warn(
        `[MMM-KiaAccess] mqtt topicPrefix "${prefix}" is used by more than one ` +
        `independently configured connection -- the plain "${prefix}/status" topic ` +
        `will flip between online/offline based on whichever connection last (dis)` +
        `connected, not either account specifically. Use "${statusTopic}" instead ` +
        `for a reliable per-account status, or give each account its own ` +
        `mqtt.topicPrefix.`
      );
    }

    const client = mqtt.connect(m.url, {
      username: m.username || undefined,
      password: m.password || undefined,
      reconnectPeriod: 30000,
      will: { topic: statusTopic, payload: "offline", retain: true, qos: 0 }
    });
    // Stashed so publishMqtt() can hand it to ha-discovery.js as the
    // real LWT-backed availability topic -- see that file's header for why
    // neither the legacy plain <prefix>/status nor a per-VIN <prefix>/VIN/status
    // topic can serve as availability_topic on its own.
    client._kiaStatusTopic = statusTopic;
    client._kiaDiscovered = false;
    client.on("connect", () => {
      Log.info("[MMM-KiaAccess] mqtt connected to " + m.url);
      client.publish(statusTopic, "online", { retain: true });
      // Legacy plain topic, best-effort: still published "online" here for
      // any dashboard/automation already watching it, but it no longer
      // carries this connection's own Last-Will -- that's on statusTopic
      // above now, the only one guaranteed to flip to "offline" on an
      // ungraceful disconnect when more than one connection shares this
      // topicPrefix (see the warning above).
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

    // Every vehicle gets its own MQTT namespace whenever it has a
    // resolvable identity (VIN or, for Kia USA, its account-issued id --
    // see vehicleIdentity()), regardless of whether THIS config is
    // "rotating" -- a previous version only scoped topics in rotate mode
    // (config.vehicles set), reasoning that a lone single-vehicle `vin:`
    // config's topics should stay exactly as they were before rotate mode
    // existed. That missed a DIFFERENT, equally-documented way to run more
    // than one vehicle: several separate module blocks, each its own
    // single-vehicle `vin:` config (README's "add this module more than
    // once" option) -- none of which is "rotating" individually, but which
    // can share the exact same mqtt url/username/password/topicPrefix
    // (mqttClient()'s own connection-sharing key), and so the exact same
    // connection object. Both silently published to the SAME unscoped
    // topics, each retained-overwriting the other's state -- genuine
    // cross-vehicle data corruption (car B's telemetry readable under
    // what a dashboard/HA-discovery device still labels car A), not just
    // a missing convenience. Scoping unconditionally on the vehicle's own
    // identity (not on config shape) closes that -- the one-time cost is
    // an existing lone-single-vehicle setup's topics gaining a `/<vin>/`
    // segment they didn't have before; see the README/CHANGELOG for the
    // migration note.
    const vin = vehicleIdentity(payload.vehicle);
    const basePrefix = String(m.topicPrefix || "kia").replace(/\/+$/, "");
    const prefix = vin ? basePrefix + "/" + vin : basePrefix;
    const retain = m.retain !== false;
    const flat = flatten(payload.vehicle || {});

    // The connection's own Last-Will-and-Testament (basePrefix + "/status",
    // set once at connect time in mqttClient()) only reflects whether the
    // bridge is reachable AT ALL -- mqtt.js supports one static LWT per
    // connection, fixed before the account's vehicle list is even known, so
    // it can't distinguish "vehicle A's data is flowing" from "vehicle B's".
    // Each vehicle also gets its own retained "online" at its own vin-scoped
    // status topic, refreshed on every successful poll -- matching the
    // per-vehicle availability_topic ha-discovery declares below.
    if (vin) client.publish(prefix + "/status", "online", { retain });

    // Home Assistant MQTT discovery (once per connection PER VEHICLE when
    // rotating -- a single client._kiaDiscovered boolean would only ever
    // register whichever vehicle happened to be processed first, and never
    // learn about the others)
    const ha = m.homeAssistant;
    if (ha && ha.enabled) {
      const discoveredVins = vin
        ? (client._kiaDiscoveredVins || (client._kiaDiscoveredVins = {}))
        : null;
      const already = vin ? discoveredVins[vin] : client._kiaDiscovered;
      if (!already) {
        try {
          haDiscovery.publish(client, {
            prefix, discoveryPrefix: ha.discoveryPrefix, device: ha.device, vehicle: payload.vehicle,
            lwtTopic: client._kiaStatusTopic,
            // rotate mode only -- matches the per-VIN topic published
            // "online" above and "offline" by _retireVehicle()
            vehicleStatusTopic: vin ? prefix + "/status" : null
          });
          if (vin) discoveredVins[vin] = true;
          else client._kiaDiscovered = true;
        } catch (e) {
          Log.warn("[MMM-KiaAccess] HA discovery failed: " + e.message);
        }
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
  // some binary_sensor-shaped fields aren't strict 0/1 -- e.g. the EV9's
  // ev_battery_is_plugged_in comes back as a connector-type code (seen: 4
  // while actively charging), not a boolean. Any other finite number: 0 is
  // false, anything else is true.
  if (typeof v === "number" && isFinite(v)) return v !== 0;
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
