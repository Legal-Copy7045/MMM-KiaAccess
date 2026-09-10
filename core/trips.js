/* Trip / drive-segment tracking — shared by the MagicMirror node_helper and the
 * HA coordinator, both of which drive it with their own streaming state + storage.
 *
 * A "trip" runs from a parked anchor until the car is parked again. Distance is
 * the odometer delta (works even in cached-poll mode, where per-drive engine
 * state is never seen); energy is the state-of-charge drop across the trip,
 * converted with the usable pack size. If the car charged during the window the
 * energy / efficiency / cost fields are left null — the distance still counts.
 *
 * Pure: no DOM, no `this`, no clock of its own (the caller passes `t`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KiaAccessTrips = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_CAPACITY_KWH = 99.8; // Kia EV9 usable
  var MIN_KM = 0.5;                // ignore driveway shuffles below this
  var PARK_GAP_MIN = 8;            // odo stable / engine off this long -> parked
  var MI_PER_KM = 0.621371;

  function num(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function round(n, dp) {
    if (n == null) return null;
    var f = Math.pow(10, dp == null ? 2 : dp);
    return Math.round(n * f) / f;
  }
  function haversineKm(aLat, aLon, bLat, bLon) {
    if (aLat == null || aLon == null || bLat == null || bLon == null) return null;
    var R = 6371, p = Math.PI / 180;
    var dLat = (bLat - aLat) * p, dLon = (bLon - aLon) * p;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.asin(Math.sqrt(s));
  }

  function close(open, opts, endAt) {
    var cap = num(opts.capacityKwh) || DEFAULT_CAPACITY_KWH;
    var price = num(opts.pricePerKwh) || 0;
    var dist = (open.lastOdo != null && open.anchorOdo != null)
      ? Math.max(0, open.lastOdo - open.anchorOdo) : null;
    if (dist == null || dist < (num(opts.minKm) != null ? num(opts.minKm) : MIN_KM)) {
      return null;
    }
    var usedPct = (!open.chargedSince && open.anchorPct != null && open.lastPct != null)
      ? open.anchorPct - open.lastPct : null;
    var kwh = (usedPct != null && usedPct > 0) ? (usedPct / 100) * cap : null;
    var mins = Math.max(1, Math.round((endAt - open.anchorAt) / 60000));
    return {
      startedAt: open.anchorAt,
      endedAt: endAt,
      minutes: mins,
      distanceKm: round(dist, 1),
      distanceMi: round(dist * MI_PER_KM, 1),
      usedPct: usedPct != null ? round(usedPct, 1) : null,
      kwh: round(kwh, 2),
      // efficiency both ways round — mi/kWh reads high-is-good, kWh/100mi low-is-good
      miPerKwh: (kwh != null && kwh > 0) ? round(dist * MI_PER_KM / kwh, 2) : null,
      kwhPer100mi: (kwh != null && dist > 0)
        ? round(kwh / (dist * MI_PER_KM) * 100, 1) : null,
      cost: (kwh != null && price > 0) ? round(kwh * price, 2) : null,
      pricePerKwh: price || null,
      fromLat: open.anchorLat, fromLon: open.anchorLon,
      toLat: open.lastLat, toLon: open.lastLon,
      straightLineKm: round(
        haversineKm(open.anchorLat, open.anchorLon, open.lastLat, open.lastLon), 1),
      chargedDuring: !!open.chargedSince
    };
  }

  /**
   * Fold one state sample into trip tracking.
   * @param {object|null} open  trip in progress, or null
   * @param {object} cur  { t, odometerKm, batteryPct, charging, carOn,
   *                         locationLat, locationLon }
   * @param {object} opts { pricePerKwh, capacityKwh, minKm, parkGapMin }
   * @returns {{ open: (object|null), closed: (object|null) }}
   */
  function update(open, cur, opts) {
    opts = opts || {};
    var t = num(cur.t) || Date.now();
    var odo = num(cur.odometerKm);
    var pct = num(cur.batteryPct);
    var lat = num(cur.locationLat);
    var lon = num(cur.locationLon);
    var charging = cur.charging === true;
    var carOn = cur.carOn === true;
    var gapMs = (num(opts.parkGapMin) || PARK_GAP_MIN) * 60000;

    if (odo == null) return { open: open, closed: null };

    // no trip yet: set / refresh the parked anchor
    if (!open) {
      return {
        open: {
          anchorOdo: odo, anchorPct: pct, anchorAt: t,
          anchorLat: lat, anchorLon: lon,
          lastOdo: odo, lastPct: pct, lastAt: t,
          lastLat: lat, lastLon: lon,
          movedAt: t, chargedSince: false
        },
        closed: null
      };
    }

    var moved = odo > open.lastOdo + 0.05;
    if (charging || (pct != null && open.lastPct != null && pct > open.lastPct + 1)) {
      open.chargedSince = true;
    }

    if (moved) {
      open.lastOdo = odo;
      open.movedAt = t;
      if (pct != null) open.lastPct = pct;
      if (lat != null) { open.lastLat = lat; open.lastLon = lon; }
      open.lastAt = t;
      return { open: open, closed: null };
    }

    // not moving this sample
    if (pct != null) open.lastPct = pct;
    if (lat != null && open.lastOdo === open.anchorOdo) {
      // still parked at the anchor — keep the anchor fresh so a later charge
      // there is attributed correctly
      open.anchorLat = lat; open.anchorLon = lon;
      if (pct != null) open.anchorPct = pct;
    }
    open.lastAt = t;

    var parked = (!carOn && t - open.movedAt >= gapMs);
    if (parked && open.lastOdo > open.anchorOdo) {
      var trip = close(open, opts, open.movedAt);
      return {
        open: {
          anchorOdo: open.lastOdo, anchorPct: open.lastPct, anchorAt: t,
          anchorLat: open.lastLat, anchorLon: open.lastLon,
          lastOdo: open.lastOdo, lastPct: open.lastPct, lastAt: t,
          lastLat: open.lastLat, lastLon: open.lastLon,
          movedAt: t, chargedSince: false
        },
        closed: trip
      };
    }
    if (parked) {
      // parked but no distance (or below MIN_KM) — reset the anchor here
      open.anchorOdo = open.lastOdo;
      open.anchorPct = open.lastPct;
      open.anchorAt = t;
      open.anchorLat = open.lastLat;
      open.anchorLon = open.lastLon;
      open.chargedSince = false;
    }
    return { open: open, closed: null };
  }

  /** totals over the last `days` (default 30) of a trip list */
  function summary(trips, days) {
    var cutoff = Date.now() - (days || 30) * 864e5;
    var km = 0, kwh = 0, cost = 0, n = 0, haveCost = false, haveKwh = false;
    (trips || []).forEach(function (tr) {
      if (!tr || num(tr.endedAt) == null || tr.endedAt < cutoff) return;
      n += 1;
      if (tr.distanceKm != null) km += tr.distanceKm;
      if (tr.kwh != null) { kwh += tr.kwh; haveKwh = true; }
      if (tr.cost != null) { cost += tr.cost; haveCost = true; }
    });
    var mi = km * MI_PER_KM;
    return {
      count: n,
      distanceKm: round(km, 1),
      distanceMi: round(mi, 1),
      kwh: haveKwh ? round(kwh, 1) : null,
      cost: haveCost ? round(cost, 2) : null,
      miPerKwh: (haveKwh && kwh > 0) ? round(mi / kwh, 2) : null,
      costPerMi: (haveCost && mi > 0) ? round(cost / mi, 3) : null
    };
  }

  return {
    update: update,
    summary: summary,
    haversineKm: haversineKm,
    DEFAULT_CAPACITY_KWH: DEFAULT_CAPACITY_KWH,
    MI_PER_KM: MI_PER_KM
  };
});
