/* Optional time-series exporters for MMM-KiaAccess (node_helper only).
 *
 * Node built-ins only (http/https) — deliberately NOT in core/, which is the
 * shared JS+Python engine. Fed the flattened vehicle state after every fetch:
 *
 *   - InfluxDB (v2 / v1.8 `/api/v2/write`): one line-protocol POST per update
 *   - Prometheus: a tiny always-on `/metrics` endpoint scrapers can hit
 *
 * Numeric + boolean `vehicle.*` values are exported; strings are skipped
 * (except as tags). `_meta.stale` and `_meta.fetched_at` ride along.
 */
"use strict";

const http = require("http");
const https = require("https");

/** flat "ev_battery_percentage" map (node_helper.js's runExporters() builds
 *  this via flatten(payload.vehicle) -- BARE keys, no "vehicle." prefix; the
 *  same convention publishMqtt()'s own flatten(payload.vehicle) call and
 *  topic-path building already use, and the one real caller this function
 *  has ever had) -> [{ key, value }] of exportable numbers (bools become
 *  1/0). Keys are sanitised to snake_case metric names.
 *
 *  This used to require a "vehicle." prefix that the real caller never
 *  actually produced -- confirmed by tracing the real runExporters() ->
 *  flatten() -> numericFields() path end to end, not just this function's
 *  own unit test, which happened to hand it pre-prefixed fixture data and
 *  never caught the mismatch. The practical effect: EVERY numeric field
 *  check below silently matched nothing, so InfluxDB/Prometheus export
 *  never actually pushed any real vehicle telemetry -- only the separate
 *  `stale` field (appended by pushInflux()/PromServer.setSnapshot()'s own
 *  callers, not through this function) ever showed up. */
function numericFields(flat) {
  const out = [];
  Object.keys(flat || {}).forEach((k) => {
    if (k.indexOf("data.") === 0) return; // skip the raw API dump
    let v = flat[k];
    if (v === true || v === "true") v = 1;
    else if (v === false || v === "false") v = 0;
    else {
      const n = Number(v);
      if (v === null || v === "" || !isFinite(n)) return;
      v = n;
    }
    out.push({
      key: k.replace(/[^a-zA-Z0-9_]/g, "_"),
      value: v
    });
  });
  return out;
}

function escTag(s) {
  // Influx line-protocol escaping for measurement / tag keys / tag values.
  // Backslash first so an existing "\" in the input isn't left ambiguous.
  return String(s).replace(/\\/g, "\\\\").replace(/[ ,=]/g, "\\$&");
}

/** InfluxDB line protocol for one sample. `ts` in ns (optional). */
function lineProtocol(measurement, tags, fields, ts) {
  const t = Object.keys(tags || {})
    .filter((k) => tags[k] != null && tags[k] !== "")
    .map((k) => "," + escTag(k) + "=" + escTag(tags[k]))
    .join("");
  const f = fields.map((x) => x.key + "=" + x.value).join(",");
  if (!f) return null;
  return escTag(measurement) + t + " " + f + (ts ? " " + ts : "");
}

function request(urlStr, opts, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error("bad exporter url")); }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, opts, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on("error", reject);
    req.setTimeout(Number(opts.timeoutMs) || 8000, () =>
      req.destroy(new Error("exporter timeout")));
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Push one update to InfluxDB.
 * @param {object} cfg { url, org, bucket, token, measurement, tags }
 *   url e.g. "http://influx:8086" (the "/api/v2/write" path is added)
 * @returns Promise<number> HTTP status
 */
function pushInflux(cfg, flat, meta) {
  cfg = cfg || {};
  if (!cfg.url || !cfg.bucket) return Promise.reject(new Error("influx needs url + bucket"));
  const base = String(cfg.url).replace(/\/+$/, "");
  const q =
    "?bucket=" + encodeURIComponent(cfg.bucket) +
    (cfg.org ? "&org=" + encodeURIComponent(cfg.org) : "") +
    "&precision=s";
  const fields = numericFields(flat).concat(
    meta && meta.stale != null ? [{ key: "stale", value: meta.stale ? 1 : 0 }] : []
  );
  const line = lineProtocol(
    cfg.measurement || "kia_vehicle",
    cfg.tags || {},
    fields,
    Math.floor(Date.now() / 1000)
  );
  if (!line) return Promise.resolve(0);
  return request(base + "/api/v2/write" + q, {
    method: "POST",
    headers: Object.assign(
      { "content-type": "text/plain; charset=utf-8" },
      cfg.token ? { Authorization: "Token " + cfg.token } : {}
    ),
    timeoutMs: cfg.timeoutMs
  }, line);
}

// Prometheus label names must match [a-zA-Z_][a-zA-Z0-9_]* -- unlike metric
// names (already sanitized the same way, see numericFields()'s caller
// below), a raw JS object key from a user's `exporter.tags` config (e.g.
// "vehicle-name") is never validated anywhere else before landing here. An
// invalid label name doesn't just get dropped -- it makes the ENTIRE
// /metrics response invalid to a scraper, taking every other metric down
// with it. Silently sanitizing (matching the existing metric-name
// precedent) rather than refusing to start: this module has no config-time
// validation step to hook into, and a working-but-renamed tag beats an
// entirely broken scrape.
function sanitizeLabelName(k) {
  let s = String(k).replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = "_" + s;
  return s || "_";
}

function renderLabels(labels) {
  const merged = {}; // sanitized name -> value; a later raw key that
  // sanitizes to the same name as an earlier one wins (avoids emitting the
  // same label name twice in one series, itself also invalid exposition)
  Object.keys(labels || {}).forEach((k) => {
    if (labels[k] == null || labels[k] === "") return;
    merged[sanitizeLabelName(k)] = labels[k];
  });
  return Object.keys(merged)
    .map((k) => k + '="' + String(merged[k]).replace(/["\\\n]/g, "") + '"')
    .join(",");
}

/** Render the Prometheus exposition text for one snapshot. */
function promText(flat, meta, prefix, labels) {
  prefix = prefix || "kia";
  const lbl = renderLabels(labels);
  const suffix = lbl ? "{" + lbl + "}" : "";
  const lines = [];
  numericFields(flat).forEach((x) => {
    const name = prefix + "_" + x.key;
    lines.push("# TYPE " + name + " gauge");
    lines.push(name + suffix + " " + x.value);
  });
  if (meta && meta.stale != null) {
    lines.push("# TYPE " + prefix + "_stale gauge");
    lines.push(prefix + "_stale" + suffix + " " + (meta.stale ? 1 : 0));
  }
  return lines.join("\n") + "\n";
}

/** Combine multiple labeled snapshots into one exposition, emitting each
 *  metric's `# TYPE` line once (not once per snapshot) with every
 *  snapshot's sample for that metric grouped underneath it -- the format
 *  a rotate-mode MM instance's multiple vehicles need to appear as
 *  distinct label-series of the SAME metric, not overwrite one another. */
function promTextMulti(snapshots, prefix) {
  prefix = prefix || "kia";
  const order = [];
  const linesByName = {};
  const ensure = (name) => {
    if (!linesByName[name]) { linesByName[name] = []; order.push(name); }
    return linesByName[name];
  };
  Object.keys(snapshots).forEach((key) => {
    const snap = snapshots[key];
    if (!snap) return;
    const lbl = renderLabels(snap.labels);
    const suffix = lbl ? "{" + lbl + "}" : "";
    numericFields(snap.flat).forEach((x) => {
      const name = prefix + "_" + x.key;
      ensure(name).push(name + suffix + " " + x.value);
    });
    if (snap.meta && snap.meta.stale != null) {
      const name = prefix + "_stale";
      ensure(name).push(name + suffix + " " + (snap.meta.stale ? 1 : 0));
    }
  });
  const out = [];
  order.forEach((name) => {
    out.push("# TYPE " + name + " gauge");
    linesByName[name].forEach((l) => out.push(l));
  });
  return out.length ? out.join("\n") + "\n" : "# no data yet\n";
}

/** A minimal always-on /metrics server. Call setSnapshot() after each fetch.
 *
 *  `vin` (optional) is what lets one server/port serve several vehicles at
 *  once, as MM's rotate-within-one-module feature does -- one bridge call
 *  fetches every vehicle, and each calls setSnapshot() with its own VIN, so
 *  /metrics ends up with one label-series per car instead of the LAST
 *  vehicle processed silently overwriting every other one's numbers (while
 *  labeled, misleadingly, as whichever vehicle happened to create the
 *  server first). A caller that only ever has one vehicle (the common
 *  case, and every pre-rotate-mode setup) simply never passes `vin`, and
 *  behaves exactly as before -- `labels` from the constructor is used as-is. */
class PromServer {
  constructor(opts) {
    opts = opts || {};
    this.port = Number(opts.port) || 9110;
    // loopback-only unless explicitly widened -- /metrics has no auth of
    // its own (see start()'s handler: any request to `this.path` gets the
    // full snapshot, no check at all), so binding every interface by
    // default would hand live battery %, location and (in rotate mode) the
    // VIN to anything on the LAN. An explicit opts.host (e.g. "0.0.0.0")
    // is honoured as-is for a user who actually wants LAN-wide scraping.
    this.host = opts.host || "127.0.0.1";
    this.path = opts.path || "/metrics";
    this.prefix = opts.prefix || "kia";
    this.labels = opts.labels || {};
    this._snapshots = {}; // key ("" for a single, unkeyed vehicle) -> {flat, meta, labels}
    this._text = "# no data yet\n";
    this._server = null;
    // Node-builtins-only module (see the file header) -- no logger here by
    // design, so a bind failure (EADDRINUSE, permission denied on a
    // privileged port, etc.) is handed to the CALLER's own logger instead
    // of being silently discarded. Without this, node_helper.js would go on
    // calling setSnapshot() and believing /metrics was being served, while
    // externally every scrape just fails with no explanation anywhere.
    this._onError = typeof opts.onError === "function" ? opts.onError : null;
  }

  setSnapshot(flat, meta, vin) {
    const key = vin || "";
    this._snapshots[key] = {
      flat: flat,
      meta: meta,
      labels: vin ? Object.assign({}, this.labels, { vin: vin }) : this.labels
    };
    this._text = promTextMulti(this._snapshots, this.prefix);
  }

  /** Drop a vehicle's series entirely (retired from config, or removed
   *  from the account) -- without this, /metrics would go on reporting its
   *  last-known numbers forever, indistinguishable from a car that's still
   *  actually being polled. A no-op if this vin was never snapshotted. */
  removeSnapshot(vin) {
    const key = vin || "";
    if (!(key in this._snapshots)) return;
    delete this._snapshots[key];
    this._text = promTextMulti(this._snapshots, this.prefix);
  }

  start() {
    if (this._server) return;
    this._server = http.createServer((req, res) => {
      if (req.url && req.url.split("?")[0] === this.path) {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(this._text);
      } else {
        res.writeHead(404);
        res.end("not found\n");
      }
    });
    this._server.on("error", (err) => { if (this._onError) this._onError(err); });
    this._server.listen(this.port, this.host);
  }

  stop() {
    if (this._server) { try { this._server.close(); } catch (e) { /* */ } }
    this._server = null;
  }
}

module.exports = { numericFields, lineProtocol, pushInflux, promText, promTextMulti, PromServer };
