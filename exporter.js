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

/** flat "vehicle.ev_battery_percentage" map -> [{ key, value }] of exportable
 *  numbers (bools become 1/0). Keys are sanitised to snake_case metric names. */
function numericFields(flat) {
  const out = [];
  Object.keys(flat || {}).forEach((k) => {
    if (k.indexOf("vehicle.") !== 0) return;
    if (k.indexOf("vehicle.data.") === 0) return; // skip the raw API dump
    let v = flat[k];
    if (v === true || v === "true") v = 1;
    else if (v === false || v === "false") v = 0;
    else {
      const n = Number(v);
      if (v === null || v === "" || !isFinite(n)) return;
      v = n;
    }
    out.push({
      key: k.slice("vehicle.".length).replace(/[^a-zA-Z0-9_]/g, "_"),
      value: v
    });
  });
  return out;
}

function escTag(s) {
  return String(s).replace(/[ ,=]/g, "\\$&");
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

/** Render the Prometheus exposition text for one snapshot. */
function promText(flat, meta, prefix, labels) {
  prefix = prefix || "kia";
  const lbl = Object.keys(labels || {})
    .filter((k) => labels[k] != null && labels[k] !== "")
    .map((k) => k + '="' + String(labels[k]).replace(/["\\\n]/g, "") + '"')
    .join(",");
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

/** A minimal always-on /metrics server. Call setSnapshot() after each fetch. */
class PromServer {
  constructor(opts) {
    opts = opts || {};
    this.port = Number(opts.port) || 9110;
    this.path = opts.path || "/metrics";
    this.prefix = opts.prefix || "kia";
    this.labels = opts.labels || {};
    this._text = "# no data yet\n";
    this._server = null;
  }

  setSnapshot(flat, meta) {
    this._text = promText(flat, meta, this.prefix, this.labels);
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
    this._server.on("error", () => { /* port in use etc — logged by caller */ });
    this._server.listen(this.port);
  }

  stop() {
    if (this._server) { try { this._server.close(); } catch (e) { /* */ } }
    this._server = null;
  }
}

module.exports = { numericFields, lineProtocol, pushInflux, promText, PromServer };
