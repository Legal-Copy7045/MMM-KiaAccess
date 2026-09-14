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
    const lbl = Object.keys(snap.labels || {})
      .filter((k) => snap.labels[k] != null && snap.labels[k] !== "")
      .map((k) => k + '="' + String(snap.labels[k]).replace(/["\\\n]/g, "") + '"')
      .join(",");
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
    this.path = opts.path || "/metrics";
    this.prefix = opts.prefix || "kia";
    this.labels = opts.labels || {};
    this._snapshots = {}; // key ("" for a single, unkeyed vehicle) -> {flat, meta, labels}
    this._text = "# no data yet\n";
    this._server = null;
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

module.exports = { numericFields, lineProtocol, pushInflux, promText, promTextMulti, PromServer };
