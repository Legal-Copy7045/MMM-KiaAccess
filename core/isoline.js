/* Geoapify isoline + static-map URL helpers — shared by the MagicMirror
 * node_helper (server-side fetch) and the bundled Lovelace card (browser fetch).
 *
 * Pure: only builds URLs and parses responses. The caller does the HTTP and the
 * caching. Works in Node and the browser (no `fetch`, no DOM).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KiaAccessIsoline = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var ISO = "https://api.geoapify.com/v1/isoline";
  var SMAP = "https://maps.geoapify.com/v1/staticmap";
  // Geoapify's free-tier distance-isoline ceiling. Above this we draw a plain
  // straight-line reachable-radius circle instead (still on the same map).
  // In practice a full EV charge is well over this, so the map is usually a
  // circle and "upgrades" to the road-network shape as the battery runs down.
  var MAX_DRIVE_KM = 100;

  var enc = encodeURIComponent;

  /** request URL for one or more distance isolines (km in, metres on the wire) */
  function isoUrl(o) {
    var ranges = (o.rangesKm || [])
      .filter(function (k) { return k > 0; })
      .map(function (k) { return Math.round(Math.min(k, MAX_DRIVE_KM) * 1000); });
    return (
      ISO +
      "?lat=" + enc(o.lat) +
      "&lon=" + enc(o.lon) +
      "&type=distance&mode=" + enc(o.mode || "drive") +
      "&range=" + ranges.join(",") +
      "&apiKey=" + enc(o.apiKey)
    );
  }

  /** true when the reach is past what the provider will isoline — caller should
   *  fall back to a plain circle (core/range.js circleRing). */
  function pastMax(km) {
    return km > MAX_DRIVE_KM;
  }

  /** FeatureCollection -> [{ rangeKm, ring:[[lon,lat],…] }] smallest first */
  function parseIso(json) {
    var feats = (json && json.features) || [];
    var out = [];
    feats.forEach(function (f) {
      if (!f || !f.geometry) return;
      var g = f.geometry, ring;
      if (g.type === "Polygon") {
        ring = g.coordinates[0];
      } else if (g.type === "MultiPolygon") {
        var bestN = -1;
        g.coordinates.forEach(function (poly) {
          if (poly[0] && poly[0].length > bestN) { bestN = poly[0].length; ring = poly[0]; }
        });
      } else {
        return;
      }
      var rng = f.properties && f.properties.range;
      out.push({ rangeKm: rng != null ? rng / 1000 : null, ring: ring });
    });
    out.sort(function (a, b) { return (a.rangeKm || 0) - (b.rangeKm || 0); });
    return out;
  }

  /** Douglas–Peucker on a lon/lat ring; `tol` in degrees. Keeps static-map URLs
   *  short (a raw isoline can be hundreds of points). */
  function simplify(ring, tol) {
    if (!ring || ring.length < 4 || !tol) return ring || [];
    function d2(p, a, b) {
      var x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
      var t = dx || dy ? ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy) : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var ex = x + t * dx - p[0], ey = y + t * dy - p[1];
      return ex * ex + ey * ey;
    }
    function dp(s, e, out) {
      var idx = -1, max = tol * tol;
      for (var i = s + 1; i < e; i++) {
        var dd = d2(ring[i], ring[s], ring[e]);
        if (dd > max) { max = dd; idx = i; }
      }
      if (idx > -1) { dp(s, idx, out); out.push(ring[idx]); dp(idx, e, out); }
    }
    var res = [ring[0]];
    dp(0, ring.length - 1, res);
    res.push(ring[ring.length - 1]);
    return res;
  }

  function bbox(ringsAndPts, padFrac) {
    var minx = 180, miny = 90, maxx = -180, maxy = -90;
    ringsAndPts.forEach(function (p) {
      if (p[0] < minx) minx = p[0];
      if (p[0] > maxx) maxx = p[0];
      if (p[1] < miny) miny = p[1];
      if (p[1] > maxy) maxy = p[1];
    });
    var px = (maxx - minx) * (padFrac || 0.12) || 0.02;
    var py = (maxy - miny) * (padFrac || 0.12) || 0.02;
    return [minx - px, miny - py, maxx + px, maxy + py];
  }

  /** keep a ring under `max` points (Geoapify static-map URLs cap at ~2048 ch) */
  function cap(ring, max) {
    if (!ring || ring.length <= max) return ring || [];
    var step = Math.ceil(ring.length / max);
    var out = [];
    for (var i = 0; i < ring.length; i += step) out.push(ring[i]);
    if (out[out.length - 1] !== ring[ring.length - 1]) out.push(ring[ring.length - 1]);
    return out;
  }

  /**
   * Geoapify static map with the isoline polygon(s) + markers baked in.
   * o: { apiKey, width, height, style, rings:[{ring,color}], markers:[{lat,lon,color,text}],
   *      simplifyDeg, padFrac }
   */
  function staticMapUrl(o) {
    var rings = (o.rings || []).map(function (r) {
      // simplify only a dense raw isochrone; leave a tidy circle / small ring alone
      var ring = (r.ring && r.ring.length > 100)
        ? simplify(r.ring, o.simplifyDeg || 0.02)
        : (r.ring || []);
      return { ring: cap(ring, 90), color: r.color };
    }).filter(function (r) { return r.ring && r.ring.length > 3; });
    if (!rings.length && !(o.markers || []).length) return null;

    // The map extent is set by the reachable-area ring(s) — NOT by the markers,
    // so a far-away zone can't zoom the whole map out. Markers outside that
    // extent (padded a little) are simply dropped from the image.
    var ringPts = [];
    rings.forEach(function (r) { r.ring.forEach(function (p) { ringPts.push(p); }); });
    var b = ringPts.length
      ? bbox(ringPts, o.padFrac)
      : bbox((o.markers || []).map(function (m) { return [m.lon, m.lat]; }), o.padFrac);
    var mx = (b[2] - b[0]) * 0.15;
    var my = (b[3] - b[1]) * 0.15;
    var inView = function (lon, lat) {
      return lon >= b[0] - mx && lon <= b[2] + mx && lat >= b[1] - my && lat <= b[3] + my;
    };

    // one geometry= param, polygons joined by "|"; one marker= param likewise
    var geom = rings.map(function (r) {
      var flat = r.ring.map(function (p) {
        return p[0].toFixed(5) + "," + p[1].toFixed(5);
      }).join(",");
      return "polygon:" + flat +
        ";linewidth:2;linecolor:" + enc(r.color || "#4caf50") +
        ";fillcolor:" + enc(r.color || "#4caf50") + ";fillopacity:0.2";
    }).join("|");

    var marks = (o.markers || [])
      .filter(function (m) { return m.always || inView(m.lon, m.lat); })
      .map(function (m) {
        return "lonlat:" + m.lon.toFixed(5) + "," + m.lat.toFixed(5) +
          ";type:material;size:34;color:" + enc(m.color || "#e53935") +
          ";contentcolor:%23ffffff" +
          (m.text ? ";text:" + enc(String(m.text).slice(0, 1).toUpperCase()) : "");
      }).join("|");

    return (
      SMAP +
      "?apiKey=" + enc(o.apiKey) +
      "&width=" + (o.width || 600) +
      "&height=" + (o.height || 360) +
      "&style=" + enc(o.style || "osm-bright-grey") +
      "&area=rect:" + b.map(function (n) { return n.toFixed(5); }).join(",") +
      (geom ? "&geometry=" + geom : "") +
      (marks ? "&marker=" + marks : "")
    );
  }

  /** cache key — coarse enough that a parked car / tiny range wiggle is a hit */
  function cacheKey(lat, lon, rangesKm) {
    return (
      Number(lat).toFixed(2) + "," + Number(lon).toFixed(2) + ":" +
      (rangesKm || []).map(function (k) { return Math.round(k / 10) * 10; }).join("_")
    );
  }

  return {
    MAX_DRIVE_KM: MAX_DRIVE_KM,
    isoUrl: isoUrl,
    pastMax: pastMax,
    parseIso: parseIso,
    simplify: simplify,
    bbox: bbox,
    staticMapUrl: staticMapUrl,
    cacheKey: cacheKey
  };
});
