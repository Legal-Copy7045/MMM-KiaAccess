/* Optional outbound webhook for MMM-KiaAccess.
 *
 * Node-only helper (uses the built-in http/https modules) — deliberately NOT in
 * core/, which is the shared JS+Python engine. node_helper.js POSTs one JSON
 * body per edge-triggered event; a consumer (Discord/Slack/IFTTT, a cloud
 * logger, a serverless function) gets the same shape as the
 * KIA_ACCESS_STATE_CHANGED MagicMirror notification.
 */
"use strict";

const http = require("http");
const https = require("https");

/**
 * POST `obj` as JSON to `url`.
 * Resolves with the numeric HTTP status code; rejects on a bad URL, a network
 * error, or a timeout.
 */
function post(url, obj, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error("invalid webhook url"));
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return reject(new Error("webhook url must be http(s)"));
    }
    const lib = u.protocol === "https:" ? https : http;
    const body = Buffer.from(JSON.stringify(obj));
    const req = lib.request(
      u,
      {
        method: (opts.method || "POST").toUpperCase(),
        headers: Object.assign(
          {
            "content-type": "application/json",
            "content-length": body.length,
            "user-agent": "MMM-KiaAccess"
          },
          opts.headers || {}
        )
      },
      (res) => {
        res.resume(); // drain so the socket can be reused / freed
        resolve(res.statusCode || 0);
      }
    );
    req.on("error", reject);
    req.setTimeout(Number(opts.timeoutMs) || 8000, () =>
      req.destroy(new Error("webhook timeout"))
    );
    req.end(body);
  });
}

/** Does this event pass the webhook's `events` / `levels` filters?
 *  A filter that isn't an array (e.g. "all", or unset) matches everything. */
function wants(hook, event) {
  hook = hook || {};
  const okReason =
    !Array.isArray(hook.events) || hook.events.indexOf(event.reason) !== -1;
  const okLevel =
    !Array.isArray(hook.levels) || hook.levels.indexOf(event.level) !== -1;
  return okReason && okLevel;
}

module.exports = { post, wants };
