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
    // null already handled; also reject NaN/Infinity (both pass a bare
    // != null check and their trig math can produce NaN/Infinity results)
    // and an out-of-range-but-finite lat/lon -- the one caller here
    // (close()) already passes a null result through round() safely, so
    // extending this is a no-op for that call site and closes the gap for
    // anything else that might reach this function.
    if (typeof aLat !== "number" || typeof aLon !== "number" ||
        typeof bLat !== "number" || typeof bLon !== "number") return null;
    if (!isFinite(aLat) || !isFinite(aLon) || !isFinite(bLat) || !isFinite(bLon)) return null;
    if (aLat < -90 || aLat > 90 || bLat < -90 || bLat > 90) return null;
    if (aLon < -180 || aLon > 180 || bLon < -180 || bLon > 180) return null;
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
      // raw start/end % (not just the usedPct delta) -- core/analytics.js's
      // rangeAccuracy() needs the actual starting % to compare against
      // what Kia displayed AT that %, not just how much was consumed.
      startPct: open.anchorPct != null ? round(open.anchorPct, 1) : null,
      endPct: open.lastPct != null ? round(open.lastPct, 1) : null,
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
      chargedDuring: !!open.chargedSince,
      // Kia's own displayed EV range at the trip's START (the anchor) --
      // core/analytics.js's rangeAccuracy() compares this against what
      // this trip's own observed efficiency implies was actually
      // achievable from that same starting %. null if the car didn't
      // report a range reading at that moment (e.g. combustion/fuel-only
      // range showing instead, or a momentary gap in the poll).
      startRangeKm: open.anchorRangeKm != null ? round(open.anchorRangeKm, 1) : null,
      // outside temperature at the trip's start -- core/analytics.js
      // buckets observed efficiency by this. Average of start+end would
      // blur a trip that started cold and warmed up; the START reading is
      // what the driver actually experienced deciding whether to trust
      // the car's range estimate that morning.
      outsideTempC: open.anchorTempC != null ? round(open.anchorTempC, 1) : null
    };
  }

  /**
   * Fold one state sample into trip tracking.
   * @param {object|null} open  trip in progress, or null
   * @param {object} cur  { t, odometerKm, batteryPct, charging, carOn,
   *                         locationLat, locationLon, rangeKm, outsideTempC }
   *   rangeKm/outsideTempC are optional -- only used by core/analytics.js's
   *   rangeAccuracy()/observedEfficiency() temperature buckets; everything
   *   else here works exactly as before when they're omitted.
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
    var rangeKm = num(cur.rangeKm);
    var tempC = num(cur.outsideTempC);
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
          anchorRangeKm: rangeKm, anchorTempC: tempC,
          lastOdo: odo, lastPct: pct, lastAt: t,
          lastLat: lat, lastLon: lon,
          lastRangeKm: rangeKm, lastTempC: tempC,
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
      if (rangeKm != null) open.lastRangeKm = rangeKm;
      if (tempC != null) open.lastTempC = tempC;
      open.lastAt = t;
      return { open: open, closed: null };
    }

    // not moving this sample
    if (pct != null) open.lastPct = pct;
    if (rangeKm != null) open.lastRangeKm = rangeKm;
    if (tempC != null) open.lastTempC = tempC;
    if (lat != null && open.lastOdo === open.anchorOdo) {
      // still parked at the anchor — keep the anchor fresh so a later charge
      // there is attributed correctly
      open.anchorLat = lat; open.anchorLon = lon;
      if (pct != null) open.anchorPct = pct;
      if (rangeKm != null) open.anchorRangeKm = rangeKm;
      if (tempC != null) open.anchorTempC = tempC;
    }
    open.lastAt = t;

    var parked = (!carOn && t - open.movedAt >= gapMs);
    if (parked && open.lastOdo > open.anchorOdo) {
      var trip = close(open, opts, open.movedAt);
      return {
        open: {
          anchorOdo: open.lastOdo, anchorPct: open.lastPct, anchorAt: t,
          anchorLat: open.lastLat, anchorLon: open.lastLon,
          anchorRangeKm: open.lastRangeKm, anchorTempC: open.lastTempC,
          lastOdo: open.lastOdo, lastPct: open.lastPct, lastAt: t,
          lastLat: open.lastLat, lastLon: open.lastLon,
          lastRangeKm: open.lastRangeKm, lastTempC: open.lastTempC,
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
      open.anchorRangeKm = open.lastRangeKm;
      open.anchorTempC = open.lastTempC;
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
