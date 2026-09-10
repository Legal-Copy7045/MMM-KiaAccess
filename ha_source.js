/* Read vehicle state from a Home Assistant instance instead of polling Kia.
 *
 * Used when the module is configured with `source: "homeassistant"`. It reads
 * the Kia Access integration's diagnostic summary sensor (the entity whose
 * attributes carry the whole flat payload, `kia_access_raw: true`) and returns
 * the same payload shape the Python bridge produces:
 *
 *   { vehicle: { <flat vehicle attrs> }, _meta: { fetchedAt, source, ... } }
 *
 * Two mechanisms:
 *   - fetchFromHA(ha)      one-shot REST read           (homeassistant.mode: "poll")
 *   - new HaLiveClient(..) persistent WebSocket, pushes  (homeassistant.mode: "push", default)
 *
 * Node >= 18 for fetch; the WebSocket client needs Node >= 22 (global WebSocket)
 * and degrades gracefully (node_helper falls back to REST polling). No deps.
 */
"use strict";

const SKIP_ATTRS = new Set([
  "kia_access_raw",
  "entry_id",
  "vehicle_name",
  "note",
  "friendly_name",
  "icon",
  "device_class",
  "state_class",
  "unit_of_measurement",
  "entity_picture",
  "supported_features"
]);

const HTTP_TIMEOUT_MS = 20000;

async function haGet(base, token, urlPath) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(base + urlPath, {
      headers: { Authorization: "Bearer " + token },
      signal: ctl.signal
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("HA " + urlPath + " timed out after " + HTTP_TIMEOUT_MS / 1000 + "s");
    }
    throw new Error("HA " + urlPath + " -> " + (err && err.message ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error("HA " + urlPath + " -> HTTP " + res.status + " " + res.statusText);
  }
  return res.json();
}

async function findSummaryEntity(base, token, configured) {
  if (configured) return configured;
  const states = await haGet(base, token, "/api/states");
  const hit = states.find(
    (s) => s.attributes && s.attributes.kia_access_raw === true
  );
  if (!hit) {
    throw new Error(
      "no Kia Access summary entity found in Home Assistant — set homeassistant.entity"
    );
  }
  return hit.entity_id;
}

/** turn an HA state object ({state, attributes, last_changed}) into our payload */
function payloadFromState(state, entity, via) {
  const attrs = (state && state.attributes) || {};
  const vehicle = {};
  Object.keys(attrs).forEach((k) => {
    if (SKIP_ATTRS.has(k)) return;
    vehicle[k] = attrs[k];
  });
  const meta = {
    fetchedAt: new Date().toISOString(),
    source: "homeassistant",
    via: via || "rest",
    haEntity: entity,
    haLastChanged: (state && state.last_changed) || null
  };
  if (attrs.note) meta.note = attrs.note;
  if (!Object.keys(vehicle).length) {
    meta.warning = "Home Assistant returned no vehicle attributes yet";
  }
  return { vehicle, _meta: meta };
}

/** the reachable-destinations sensor id, from config or derived from the
 *  summary entity (`sensor.<v>_status` -> `sensor.<v>_range_reach`) */
function rangeReachEntity(ha, summaryEntity) {
  if (ha && ha.rangeReachEntity) return ha.rangeReachEntity;
  if (!summaryEntity) return null;
  return /_status$/.test(summaryEntity)
    ? summaryEntity.replace(/_status$/, "_range_reach")
    : null;
}

/** best-effort: fetch the range_reach sensor and hang its driving-times data
 *  off the payload as `payload.rangeReach` (never throws) */
async function attachRangeReach(base, token, payload, summaryEntity, ha) {
  const id = rangeReachEntity(ha, summaryEntity);
  if (!id) return payload;
  try {
    const st = await haGet(base, token, "/api/states/" + encodeURIComponent(id));
    const a = (st && st.attributes) || {};
    payload.rangeReach = {
      entity: id,
      oneWayKm: a.one_way_km != null ? a.one_way_km : null,
      driveTimeSource: a.drive_time_source || "estimate",
      debug: a.driving_times_debug || null,
      mmZones: a.mm_zone_filter || "",
      pois: Array.isArray(a.pois) ? a.pois : []
    };
  } catch (e) {
    /* leave payload.rangeReach undefined — the module falls back to local calc */
  }
  return payload;
}

/**
 * @param {object} ha  { url, token, entity?, rangeReachEntity? }
 * @returns {Promise<{vehicle: object, _meta: object, rangeReach?: object}>}
 */
async function fetchFromHA(ha) {
  if (!ha || !ha.url || !ha.token) {
    throw new Error("source 'homeassistant' needs homeassistant.url and homeassistant.token");
  }
  const base = String(ha.url).replace(/\/+$/, "");
  const entity = await findSummaryEntity(base, ha.token, ha.entity);
  const state = await haGet(base, ha.token, "/api/states/" + encodeURIComponent(entity));
  const payload = payloadFromState(state, entity, "rest");
  return attachRangeReach(base, ha.token, payload, entity, ha);
}

/* ---------------------------------------------------------------------------
 * HaLiveClient — persistent WebSocket, pushes changes as they happen
 * ------------------------------------------------------------------------- */
const PING_MS = 25000;
const PONG_GRACE_MS = 70000;
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 120000;

class HaLiveClient {
  /**
   * @param {object} ha  { url, token, entity? }
   * @param {object} cb  { onPayload(payload), onStatus(message, {fatal}) }
   */
  constructor(ha, cb) {
    this.ha = ha || {};
    this.cb = cb || {};
    this.base = String(this.ha.url || "").replace(/\/+$/, "");
    this._stopped = false;
    this._ws = null;
    this._msgId = 1;
    this._subId = null;
    this._entity = null;
    this._lastPong = 0;
    this._retry = RECONNECT_MIN_MS;
    this._pingTimer = null;
    this._reconnectTimer = null;
  }

  static get supported() {
    return typeof WebSocket === "function";
  }

  get healthy() {
    return !!(
      this._ws &&
      this._ws.readyState === 1 /* OPEN */ &&
      this._subId !== null &&
      Date.now() - this._lastPong < PONG_GRACE_MS
    );
  }

  start() {
    if (!HaLiveClient.supported) {
      this._status("global WebSocket not available (need Node >= 22) — using REST polling", { fatal: false });
      return;
    }
    if (!this.base || !this.ha.token) {
      this._status("push needs homeassistant.url and homeassistant.token", { fatal: true });
      return;
    }
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._pingTimer);
    try { if (this._ws) this._ws.close(); } catch (e) { /* ignore */ }
    this._ws = null;
  }

  _status(msg, opts) {
    if (typeof this.cb.onStatus === "function") this.cb.onStatus(msg, opts || {});
  }

  _wsUrl() {
    return this.base.replace(/^http/i, "ws") + "/api/websocket";
  }

  async _connect() {
    if (this._stopped) return;
    this._subId = null;
    let ws;
    try {
      ws = new WebSocket(this._wsUrl());
    } catch (err) {
      return this._scheduleReconnect("connect failed: " + (err && err.message));
    }
    this._ws = ws;

    this._openedAt = Date.now();
    ws.addEventListener("message", (ev) => this._onMessage(String(ev.data)));
    ws.addEventListener("close", (ev) => {
      const held = this._openedAt ? Math.round((Date.now() - this._openedAt) / 1000) : "?";
      const code = ev && ev.code != null ? ev.code : "?";
      const reason = ev && ev.reason ? " " + ev.reason : "";
      this._scheduleReconnect(
        "connection closed — code " + code + reason + ", held " + held + "s"
      );
    });
    ws.addEventListener("error", () => {
      // 'close' fires straight after; let that drive the reconnect
    });
  }

  _send(obj) {
    try { this._ws.send(JSON.stringify(obj)); } catch (e) { /* reconnect will handle */ }
  }

  async _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === "auth_required") {
      this._send({ type: "auth", access_token: this.ha.token });
      return;
    }
    if (msg.type === "auth_invalid") {
      this._status("Home Assistant rejected the access token", { fatal: true });
      this.stop();
      return;
    }
    if (msg.type === "auth_ok") {
      try {
        this._entity = await findSummaryEntity(this.base, this.ha.token, this.ha.entity);
      } catch (err) {
        return this._scheduleReconnect(err && err.message);
      }
      this._subId = this._msgId++;
      this._send({
        id: this._subId,
        type: "subscribe_trigger",
        trigger: { platform: "state", entity_id: this._entity }
      });
      // prime with the current state (triggers only fire on change)
      this._primeInitial();
      this._retry = RECONNECT_MIN_MS;
      this._lastPong = Date.now();
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => this._ping(), PING_MS);
      this._status("push connected (" + this._entity + ")", { fatal: false });
      return;
    }
    if (msg.type === "pong") {
      this._lastPong = Date.now();
      return;
    }
    // the reply to our subscribe_trigger — if HA rejected it we are NOT
    // subscribed, so drop the "healthy" claim and reconnect (otherwise
    // node_helper would keep skipping the REST fallback forever)
    if (msg.type === "result" && msg.id === this._subId) {
      if (msg.success === false) {
        this._subId = null;
        return this._scheduleReconnect(
          "subscribe rejected: " +
            ((msg.error && msg.error.message) || "unknown")
        );
      }
      return;
    }
    if (msg.type === "event" && msg.id === this._subId) {
      const to =
        msg.event &&
        msg.event.variables &&
        msg.event.variables.trigger &&
        msg.event.variables.trigger.to_state;
      if (to) this._emit(to);
    }
  }

  async _emit(state) {
    if (typeof this.cb.onPayload !== "function") return;
    const payload = payloadFromState(state, this._entity, "push");
    await attachRangeReach(this.base, this.ha.token, payload, this._entity, this.ha);
    this.cb.onPayload(payload);
  }

  async _primeInitial() {
    try {
      const state = await haGet(
        this.base,
        this.ha.token,
        "/api/states/" + encodeURIComponent(this._entity)
      );
      await this._emit(state);
    } catch (e) {
      /* the periodic fallback poll in node_helper will cover this */
    }
  }

  _ping() {
    if (!this._ws || this._ws.readyState !== 1) return;
    if (Date.now() - this._lastPong > PONG_GRACE_MS) {
      this._scheduleReconnect("no pong — connection stale");
      return;
    }
    this._send({ id: this._msgId++, type: "ping" });
  }

  _scheduleReconnect(why) {
    if (this._stopped) return;
    clearInterval(this._pingTimer);
    this._subId = null;
    try { if (this._ws) this._ws.close(); } catch (e) { /* ignore */ }
    this._ws = null;
    if (this._reconnectTimer) return; // already scheduled
    this._status("push dropped (" + (why || "unknown") + ") — retrying in " +
      Math.round(this._retry / 1000) + "s", { fatal: false });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, this._retry);
    this._retry = Math.min(this._retry * 2, RECONNECT_MAX_MS);
  }
}

module.exports = { fetchFromHA, HaLiveClient };
