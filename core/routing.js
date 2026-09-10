/* Drive-time matrix helpers — turn "car here, N saved places there" into real
 * road distance + drive time from a routing provider, so the reachable-
 * destinations list shows an actual ETA instead of a straight-line estimate.
 *
 * Pure: builds the request and parses the response. The caller does the HTTP
 * and the caching. Works in Node and the browser (no `fetch`, no DOM).
 *
 * Providers (both free-tier friendly, both one POST for the whole matrix):
 *   geoapify — https://apidocs.geoapify.com/docs/route-matrix/
 *   tomtom   — https://developer.tomtom.com/matrix-routing-v2/documentation
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KiaAccessRouting = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PROVIDERS = ["geoapify", "tomtom"];

  function _pt(p) {
    return { lat: Number(p && (p.lat != null ? p.lat : p[0])),
             lon: Number(p && (p.lon != null ? p.lon : p[1])) };
  }
  function _ok(p) { return isFinite(p.lat) && isFinite(p.lon); }

  /**
   * Build the matrix request for one origin -> many targets.
   * @param {string} provider  "geoapify" | "tomtom"
   * @param {{lat,lon}} origin
   * @param {Array<{lat,lon}>} targets
   * @param {string} apiKey
   * @param {object} [o] { mode: "drive", traffic: true }
   * @returns {{url, method:"POST", headers, body:string}|null}
   */
  function matrixRequest(provider, origin, targets, apiKey, o) {
    o = o || {};
    var src = _pt(origin);
    var tgts = (targets || []).map(_pt).filter(_ok);
    if (!apiKey || !_ok(src) || !tgts.length) return null;
    var traffic = o.traffic !== false;

    if (provider === "geoapify") {
      var mode = o.mode || "drive";
      return {
        url: "https://api.geoapify.com/v1/routematrix?apiKey=" + encodeURIComponent(apiKey),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: mode,
          sources: [{ location: [src.lon, src.lat] }],
          targets: tgts.map(function (t) { return { location: [t.lon, t.lat] }; })
        })
      };
    }
    if (provider === "tomtom") {
      return {
        url: "https://api.tomtom.com/routing/matrix/2?key=" + encodeURIComponent(apiKey),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origins: [{ point: { latitude: src.lat, longitude: src.lon } }],
          destinations: tgts.map(function (t) {
            return { point: { latitude: t.lat, longitude: t.lon } };
          }),
          options: {
            travelMode: o.mode === "truck" ? "truck" : "car",
            traffic: traffic ? "live" : "historical"
          }
        })
      };
    }
    return null;
  }

  /**
   * Parse a matrix response into per-target results, aligned to the request's
   * target order. Unroutable targets come back as null.
   * @returns Array<{ durationMin:number, distanceKm:number }|null>
   */
  function parseMatrix(provider, json, targetCount) {
    var out = [];
    var i;
    for (i = 0; i < targetCount; i++) out.push(null);
    if (!json) return out;

    if (provider === "geoapify") {
      var rows = json.sources_to_targets || [];
      var row = rows[0] || [];
      row.forEach(function (cell) {
        if (!cell) return;
        var idx = cell.target_index;
        if (idx == null || idx < 0 || idx >= targetCount) return;
        if (cell.time == null || cell.distance == null) return; // no route found
        out[idx] = {
          durationMin: Math.round(Number(cell.time) / 60),
          distanceKm: Number(cell.distance) / 1000
        };
      });
      return out;
    }
    if (provider === "tomtom") {
      var data = json.data || [];
      data.forEach(function (cell) {
        if (!cell) return;
        var idx = cell.destinationIndex;
        if (idx == null || idx < 0 || idx >= targetCount) return;
        var sum = cell.routeSummary || {};
        if (sum.travelTimeInSeconds == null || sum.lengthInMeters == null) return;
        out[idx] = {
          durationMin: Math.round(Number(sum.travelTimeInSeconds) / 60),
          distanceKm: Number(sum.lengthInMeters) / 1000
        };
      });
      return out;
    }
    return out;
  }

  /**
   * Build a forward-geocode request (address string -> lat/lon), US-biased.
   * @returns {{url, method:"GET"}|null}
   */
  function geocodeRequest(provider, text, apiKey) {
    if (!apiKey || !text) return null;
    var q = encodeURIComponent(String(text));
    if (provider === "geoapify") {
      return {
        url: "https://api.geoapify.com/v1/geocode/search?text=" + q +
          "&limit=1&filter=countrycode:us&apiKey=" + encodeURIComponent(apiKey),
        method: "GET"
      };
    }
    if (provider === "tomtom") {
      return {
        url: "https://api.tomtom.com/search/2/geocode/" + q +
          ".json?limit=1&countrySet=US&key=" + encodeURIComponent(apiKey),
        method: "GET"
      };
    }
    return null;
  }

  /** Parse a forward-geocode response. @returns {{lat,lon,name}|null} */
  function parseGeocode(provider, json) {
    if (!json) return null;
    if (provider === "geoapify") {
      var f = (json.features || [])[0];
      var p = f && f.properties;
      if (!p || p.lat == null || p.lon == null) return null;
      return { lat: Number(p.lat), lon: Number(p.lon),
               name: p.formatted || p.address_line1 || "" };
    }
    if (provider === "tomtom") {
      var r = (json.results || [])[0];
      var pos = r && r.position;
      if (!pos || pos.lat == null || pos.lon == null) return null;
      return { lat: Number(pos.lat), lon: Number(pos.lon),
               name: (r.address && r.address.freeformAddress) || "" };
    }
    return null;
  }

  /**
   * Build a single origin -> destination route request. Richer than the
   * matrix: the response carries the road-name breakdown and (TomTom) the
   * free-flow time so the caller can show "via <roads>" and a traffic delay.
   * @returns {{url, method:"GET"}|null}
   */
  function routeRequest(provider, origin, dest, apiKey, o) {
    o = o || {};
    var s = _pt(origin), d = _pt(dest);
    if (!apiKey || !_ok(s) || !_ok(d)) return null;
    var traffic = o.traffic !== false;

    if (provider === "tomtom") {
      var mode = o.mode === "truck" ? "truck" : "car";
      return {
        url: "https://api.tomtom.com/routing/1/calculateRoute/" +
          s.lat + "," + s.lon + ":" + d.lat + "," + d.lon + "/json" +
          "?key=" + encodeURIComponent(apiKey) +
          "&travelMode=" + mode +
          "&traffic=" + (traffic ? "true" : "false") +
          "&computeTravelTimeFor=all" +
          "&instructionsType=text&sectionType=street&routeRepresentation=summaryOnly",
        method: "GET"
      };
    }
    if (provider === "geoapify") {
      return {
        url: "https://api.geoapify.com/v1/routing?waypoints=" +
          s.lat + "," + s.lon + "|" + d.lat + "," + d.lon +
          "&mode=" + (o.mode || "drive") +
          "&details=instruction_details&apiKey=" + encodeURIComponent(apiKey),
        method: "GET"
      };
    }
    return null;
  }

  /** top `n` distinct road labels by distance covered, in route order */
  function _topRoads(pairs, n) {
    var order = [], meters = {};
    pairs.forEach(function (p) {
      var road = (p.road || "").trim();
      if (!road) return;
      if (meters[road] == null) { meters[road] = 0; order.push(road); }
      meters[road] += Math.max(0, Number(p.m) || 0);
    });
    return order
      .filter(function (r) { return meters[r] > 300; })
      .sort(function (a, b) { return meters[b] - meters[a]; })
      .slice(0, n || 3)
      .sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
  }

  /**
   * Parse a single-route response.
   * @returns {{ durationMin, distanceKm, typicalMin, delayMin, via }|null}
   *   typicalMin / delayMin are null when the provider has no traffic model.
   *   via is a short "Rte 28 · Greensburg Rd" string, or null.
   */
  function parseRoute(provider, json) {
    if (!json) return null;

    if (provider === "tomtom") {
      var route = (json.routes || [])[0];
      if (!route) return null;
      var sum = route.summary || {};
      if (sum.travelTimeInSeconds == null || sum.lengthInMeters == null) return null;
      var live = Number(sum.travelTimeInSeconds);
      var free = sum.noTrafficTravelTimeInSeconds != null
        ? Number(sum.noTrafficTravelTimeInSeconds)
        : (sum.trafficDelayInSeconds != null ? live - Number(sum.trafficDelayInSeconds) : null);
      var instr = ((route.guidance || {}).instructions) || [];
      var pairs = instr.map(function (ins, i) {
        var next = instr[i + 1];
        var m = next && next.routeOffsetInMeters != null && ins.routeOffsetInMeters != null
          ? next.routeOffsetInMeters - ins.routeOffsetInMeters : 0;
        var road = (ins.roadNumbers && ins.roadNumbers[0]) || ins.street || "";
        return { road: road, m: m };
      });
      return {
        durationMin: Math.round(live / 60),
        distanceKm: Number(sum.lengthInMeters) / 1000,
        typicalMin: free != null ? Math.round(free / 60) : null,
        delayMin: free != null ? Math.max(0, Math.round((live - free) / 60)) : null,
        via: _topRoads(pairs, 3).join(" · ") || null
      };
    }
    if (provider === "geoapify") {
      var f = (json.features || [])[0];
      var pr = f && f.properties;
      if (!pr || pr.time == null || pr.distance == null) return null;
      var gp = [];
      (pr.legs || []).forEach(function (leg) {
        (leg.steps || []).forEach(function (st) {
          gp.push({ road: st.name || "", m: Number(st.distance) || 0 });
        });
      });
      return {
        durationMin: Math.round(Number(pr.time) / 60),
        distanceKm: Number(pr.distance) / 1000,
        typicalMin: null,
        delayMin: null,
        via: _topRoads(gp, 3).join(" · ") || null
      };
    }
    return null;
  }

  return {
    PROVIDERS: PROVIDERS,
    matrixRequest: matrixRequest,
    parseMatrix: parseMatrix,
    geocodeRequest: geocodeRequest,
    parseGeocode: parseGeocode,
    routeRequest: routeRequest,
    parseRoute: parseRoute
  };
});
