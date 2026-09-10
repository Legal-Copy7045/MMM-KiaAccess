/* Charge-session tracking — shared by the MagicMirror node_helper and the HA
 * coordinator, both of which drive it with their own streaming state + storage.
 *
 * A "session" runs from the first `charging` sample until the car is unplugged
 * (or has sat plugged-but-not-charging for GAP_MIN). Scheduled-charging pauses
 * inside that window stay part of the one session — kWh is derived from the
 * start→end state-of-charge, so gaps don't matter.
 *
 * Pure: no DOM, no `this`, no clock of its own (the caller passes `t`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KiaAccessSessions = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_CAPACITY_KWH = 99.8; // Kia EV9 usable
  var GAP_MIN = 45; // plugged + not charging this long → the session is over
  var MIN_KWH = 0.3; // ignore trickle / noise sessions below this

  function num(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function round(n, dp) {
    var f = Math.pow(10, dp == null ? 2 : dp);
    return Math.round(n * f) / f;
  }

  /** which per-kWh rate applies to a session, given where it charged */
  function rateFor(atHome, opts) {
    var home = num(opts.pricePerKwh) || 0;
    var away = num(opts.awayPricePerKwh);
    return atHome === false && away != null ? away : home;
  }
  function tri(v) { return v === true || v === false ? v : null; }

  /**
   * Fold one state sample into session tracking.
   * @param {object|null} open  session in progress, or null
   * @param {object} cur   { t, charging, plugged, batteryPct, chargeKw,
   *                          atHome, rate, rateLabel }
   *        atHome: true / false / null — home vs away bucket + the fallback rate.
   *        rate:   an explicit $/kWh for this session (from a per-zone rate) —
   *                overrides pricePerKwh/awayPricePerKwh when set.
   *        rateLabel: the `location` string for the session ("home" keeps it in
   *                the home bucket; anything else is treated as public/away).
   * @param {object} opts  { pricePerKwh, awayPricePerKwh, capacityKwh, minKwh, gapMin }
   * @returns {{ open: (object|null), closed: (object|null) }}
   */
  function update(open, cur, opts) {
    opts = opts || {};
    var cap = num(opts.capacityKwh) || DEFAULT_CAPACITY_KWH;
    var minKwh = num(opts.minKwh);
    if (minKwh == null) minKwh = MIN_KWH;
    var gapMs = (num(opts.gapMin) || GAP_MIN) * 60000;

    var t = num(cur.t) || Date.now();
    var pct = num(cur.batteryPct);
    var kw = num(cur.chargeKw);
    var charging = cur.charging === true;
    var plugged = cur.plugged !== false; // treat unknown as still plugged

    // start
    if (charging && !open) {
      return {
        open: {
          startedAt: t, lastChargingAt: t,
          startPct: pct, lastPct: pct, peakKw: kw || 0,
          atHome: tri(cur.atHome),
          rate: num(cur.rate),
          rateLabel: cur.rateLabel || null
        },
        closed: null
      };
    }
    if (!open) return { open: null, closed: null };

    // running
    if (charging) {
      open.lastChargingAt = t;
      if (open.atHome == null && tri(cur.atHome) != null) open.atHome = cur.atHome;
      if (open.rate == null && num(cur.rate) != null) {
        open.rate = num(cur.rate);
        open.rateLabel = cur.rateLabel || open.rateLabel;
      }
      if (pct != null) {
        open.lastPct = pct;
        if (open.startPct == null) open.startPct = pct;
      }
      if (kw != null && kw > open.peakKw) open.peakKw = kw;
      return { open: open, closed: null };
    }

    // not charging this sample — keep open through a short pause
    if (plugged && cur.plugged !== false &&
        t - (open.lastChargingAt || open.startedAt) < gapMs) {
      if (pct != null) open.lastPct = pct;
      return { open: open, closed: null };
    }

    // close it
    var endPct = pct != null ? pct : open.lastPct;
    var gained = (open.startPct != null && endPct != null)
      ? Math.max(0, endPct - open.startPct) : null;
    var kwh = gained != null ? (gained / 100) * cap : null;
    var mins = Math.max(0, Math.round((open.lastChargingAt - open.startedAt) / 60000));
    var rate = open.rate != null ? open.rate : rateFor(open.atHome, opts);
    var where = open.rateLabel || (open.atHome === false ? "away" : "home");
    var s = {
      startedAt: open.startedAt,
      endedAt: open.lastChargingAt || t,
      minutes: mins,
      startPct: open.startPct,
      endPct: endPct,
      gainedPct: gained != null ? round(gained, 1) : null,
      kwh: kwh != null ? round(kwh, 2) : null,
      cost: (kwh != null && rate > 0) ? round(kwh * rate, 2) : null,
      peakKw: round(open.peakKw, 1),
      avgKw: (kwh != null && mins > 0) ? round(kwh / (mins / 60), 1) : null,
      pricePerKwh: rate || null,
      location: where,
      costSource: (kwh != null && rate > 0) ? "rate" : null
    };
    return { open: null, closed: (s.kwh != null && s.kwh >= minKwh) ? s : null };
  }

  /**
   * Replace a session's cost with a known figure (from a public-charging
   * integration, or entered by hand). Keeps the rate estimate as
   * `estimatedCost`. Returns a new object.
   * @param {object} session
   * @param {number} cost
   * @param {string} source  "external" | "manual"
   */
  function applyCost(session, cost, source) {
    if (!session) return session;
    var c = num(cost);
    var out = {};
    for (var k in session) if (Object.prototype.hasOwnProperty.call(session, k)) out[k] = session[k];
    if (c == null || c < 0) return out;
    if (out.estimatedCost == null) out.estimatedCost = out.cost;
    out.cost = round(c, 2);
    out.costSource = source || "external";
    return out;
  }

  /**
   * Live figures for the session in progress — kWh from the state-of-charge
   * delta so far, plus a short kW×time extrapolation so the number keeps
   * climbing between polls (capped at 15 min of drift). null if no session.
   * @param {object} cur { t, charging, batteryPct, chargeKw }
   */
  function progress(open, cur, opts) {
    if (!open) return null;
    opts = opts || {};
    var cap = num(opts.capacityKwh) || DEFAULT_CAPACITY_KWH;
    var price = open.rate != null ? open.rate : rateFor(open.atHome, opts);
    var t = num(cur.t) || Date.now();
    var pct = num(cur.batteryPct);
    var lastPct = pct != null ? pct : open.lastPct;
    var kwhSoc = (open.startPct != null && lastPct != null)
      ? Math.max(0, ((lastPct - open.startPct) / 100) * cap) : 0;
    var kw = num(cur.chargeKw);
    if (kw == null) kw = open.peakKw || 0;
    var driftMs = Math.max(0, Math.min(15 * 60000, t - (open.lastChargingAt || open.startedAt)));
    var kwh = kwhSoc + (cur.charging === true ? kw * (driftMs / 3600000) : 0);
    return {
      kwh: round(kwh, 2),
      cost: price > 0 ? round(kwh * price, 2) : null,
      gainedPct: (open.startPct != null && lastPct != null)
        ? round(lastPct - open.startPct, 1) : null,
      minutes: Math.max(0, Math.round((t - open.startedAt) / 60000))
    };
  }

  /** totals over the last `days` (default 30) of a session list, split
   *  home / away */
  function summary(sessions, days) {
    var cutoff = Date.now() - (days || 30) * 864e5;
    var acc = {
      all: { count: 0, kwh: 0, cost: 0, haveCost: false },
      home: { count: 0, kwh: 0, cost: 0, haveCost: false },
      away: { count: 0, kwh: 0, cost: 0, haveCost: false }
    };
    (sessions || []).forEach(function (s) {
      if (!s || num(s.endedAt) == null || s.endedAt < cutoff) return;
      // "home" (or no location) is the home bucket; any other label — "away"
      // or a specific public-charger zone name — is the away bucket
      var where = (s.location == null || s.location === "home") ? "home" : "away";
      [acc.all, acc[where]].forEach(function (a) {
        a.count += 1;
        if (s.kwh != null) a.kwh += s.kwh;
        if (s.cost != null) { a.cost += s.cost; a.haveCost = true; }
      });
    });
    function out(a) {
      return {
        count: a.count,
        kwh: round(a.kwh, 1),
        cost: a.haveCost ? round(a.cost, 2) : null
      };
    }
    var r = out(acc.all);
    r.home = out(acc.home);
    r.away = out(acc.away);
    return r;
  }

  return {
    update: update,
    progress: progress,
    summary: summary,
    applyCost: applyCost,
    DEFAULT_CAPACITY_KWH: DEFAULT_CAPACITY_KWH
  };
});
