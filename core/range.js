/* Drive-range reachability — shared by the MagicMirror module and the HA
 * integration. Turns the car's own range estimate into "how far can I get"
 * (one-way or there-and-back), tells you which saved places are in reach, and
 * builds a plain circle for when a road-network isochrone isn't available.
 *
 * Pure: no DOM, no `this`, no network. The isochrone fetch lives in the
 * callers (node_helper / coordinator); this module just does the maths.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KiaAccessRange = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = {
    factor: 0.92,      // haircut on the car's guess-o-meter (cold air, a long pull)
    reservePct: 10,    // arrive with this much charge left…
    reserveKm: null,   // …or an absolute distance, if set (wins over reservePct)
    roundTrip: false,  // halve the distance for "there AND back"
    circleFactor: 0.85 // extra haircut for the straight-line circle fallback
  };

  function opt(o, k) {
    o = o || {};
    return o[k] === undefined || o[k] === null ? DEFAULTS[k] : o[k];
  }

  /** usable one-way (or half, round trip) drive distance in km, or null. */
  function reach(rangeKm, o) {
    var r = Number(rangeKm);
    if (!isFinite(r) || r <= 0) return null;
    var reserveKm = opt(o, "reserveKm");
    var usable =
      reserveKm != null
        ? r - Number(reserveKm)
        : r * (1 - Number(opt(o, "reservePct")) / 100);
    if (!(usable > 0)) return 0;
    var d = usable * Number(opt(o, "factor"));
    return opt(o, "roundTrip") ? d / 2 : d;
  }

  var R_EARTH_KM = 6371.0088;
  var D2R = Math.PI / 180;

  /** great-circle distance in km */
  function haversineKm(lat1, lon1, lat2, lon2) {
    var dLat = (lat2 - lat1) * D2R;
    var dLon = (lon2 - lon1) * D2R;
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R_EARTH_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** initial bearing (degrees, 0 = N) from point 1 to point 2 */
  function bearingDeg(lat1, lon1, lat2, lon2) {
    var y = Math.sin((lon2 - lon1) * D2R) * Math.cos(lat2 * D2R);
    var x =
      Math.cos(lat1 * D2R) * Math.sin(lat2 * D2R) -
      Math.sin(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.cos((lon2 - lon1) * D2R);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }

  /**
   * Which saved places are in reach.
   * @param {number} lat @param {number} lon  the car
   * @param {Array<{name,lat,lon}>} pois
   * @param {number} reachKm  from reach()
   * @param {object} [trip] { batteryPct, rangeKm, roadFactor } to also estimate
   *        the state-of-charge you'd arrive with
   * @returns sorted nearest-first:
   *   [{ name, km, reachable, marginKm, bearing, arrivalPct }]
   *   marginKm > 0 = spare, < 0 = short by that much; arrivalPct null if no trip
   */
  function poiStatus(lat, lon, pois, reachKm, trip) {
    if (!isFinite(lat) || !isFinite(lon) || !Array.isArray(pois)) return [];
    trip = trip || {};
    var pct = Number(trip.batteryPct);
    var rng = Number(trip.rangeKm);
    var road = Number(trip.roadFactor) || 1.3;
    var canArrive = isFinite(pct) && isFinite(rng) && rng > 0;
    var out = [];
    pois.forEach(function (p) {
      if (!p || p.lat == null || p.lon == null) return;
      var pla = Number(p.lat), plo = Number(p.lon);
      if (!isFinite(pla) || !isFinite(plo)) return;
      var km = haversineKm(lat, lon, pla, plo);
      var arrivalPct = null;
      if (canArrive) {
        arrivalPct = Math.round(Math.max(0, pct * (1 - (km * road) / rng)));
      }
      out.push({
        name: p.name || "",
        km: km,
        reachable: reachKm != null && km <= reachKm,
        marginKm: reachKm != null ? reachKm - km : null,
        bearing: bearingDeg(lat, lon, pla, plo),
        arrivalPct: arrivalPct
      });
    });
    out.sort(function (a, b) { return a.km - b.km; });
    return out;
  }

  /** GeoJSON polygon ring (lon/lat pairs) approximating a `km`-radius circle —
   *  the fallback when a road-network isochrone can't be had. */
  function circleRing(lat, lon, km, n) {
    n = n || 64;
    var ring = [];
    var latR = km / 111.32;
    var lonR = km / (111.32 * Math.cos(lat * D2R) || 1e-6);
    for (var i = 0; i <= n; i++) {
      var t = (i / n) * 2 * Math.PI;
      ring.push([lon + lonR * Math.sin(t), lat + latR * Math.cos(t)]);
    }
    return ring;
  }

  /** Everything a surface needs for one render. */
  function summary(carLat, carLon, rangeKm, pois, o) {
    o = o || {};
    var one = reach(rangeKm, Object.assign({}, o, { roundTrip: false }));
    var round = reach(rangeKm, Object.assign({}, o, { roundTrip: true }));
    var rt = opt(o, "roundTrip");
    var active = rt ? round : one;
    var trip = {
      batteryPct: o.batteryPct,
      rangeKm: rangeKm,
      roadFactor: o.roadFactor
    };
    return {
      roundTrip: !!rt,
      oneWayKm: one,
      roundTripKm: round,
      reachKm: active,
      pois: poiStatus(carLat, carLon, pois || [], active, trip),
      circle: (isFinite(carLat) && active) ? circleRing(carLat, carLon, active) : null
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    reach: reach,
    haversineKm: haversineKm,
    bearingDeg: bearingDeg,
    poiStatus: poiStatus,
    circleRing: circleRing,
    summary: summary
  };
});
