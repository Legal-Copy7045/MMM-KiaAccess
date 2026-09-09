/* Kia Access - interactive range map card (custom:kia-range-map-card).
 *
 * A Leaflet map (loaded from cdnjs) centred on the car, showing the reachable
 * driving area as a polygon you can pan / zoom, with a one-way / round-trip
 * toggle and markers for the zones you could reach. The shape is a real
 * road-network isochrone when the reach is <= ~100 km (Geoapify, needs an API
 * key), otherwise a straight-line radius circle - drawn client-side, no call.
 *
 * scripts/sync-core.js bundles this after core/range.js + core/isoline.js.
 */
(function () {
  "use strict";

  var RNG = self.KiaAccessRange;
  var ISO = self.KiaAccessIsoline;

  var LEAFLET_VER = "1.9.4";
  var LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/" + LEAFLET_VER + "/leaflet.js";
  var LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/" + LEAFLET_VER + "/leaflet.css";

  var _jsPromise = null;
  function loadLeafletJs() {
    if (self.L) return Promise.resolve(self.L);
    if (_jsPromise) return _jsPromise;
    _jsPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = LEAFLET_JS;
      s.crossOrigin = "";
      s.onload = function () { resolve(self.L); };
      s.onerror = function () { _jsPromise = null; reject(new Error("could not load Leaflet")); };
      document.head.appendChild(s);
    });
    return _jsPromise;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function findRawEntity(hass, configured) {
    if (configured) return configured;
    var ids = Object.keys(hass.states).filter(function (id) {
      var a = hass.states[id].attributes;
      return id.indexOf("sensor.") === 0 && a && a.kia_access_raw === true;
    });
    return ids[0] || null;
  }

  function flatFromAttributes(attrs) {
    var flat = {};
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "kia_access_raw" || k === "friendly_name" ||
          k === "icon" || k === "entry_id" || k === "vehicle_name") return;
      flat["vehicle." + k] = attrs[k];
    });
    return flat;
  }

  function isMetric(hass) {
    var u = hass && hass.config && hass.config.unit_system;
    return !!(u && (u.length === "km" || u.length === "m"));
  }
  function kmToDisp(km, metric) {
    return metric ? Math.round(km) + " km" : Math.round(km * 0.621371) + " mi";
  }
  function zonePois(hass) {
    return Object.keys(hass.states)
      .filter(function (id) { return id.indexOf("zone.") === 0; })
      .map(function (id) {
        var a = hass.states[id].attributes || {};
        return (a.latitude != null && a.longitude != null)
          ? { name: a.friendly_name || id.slice(5), lat: a.latitude, lon: a.longitude }
          : null;
      })
      .filter(Boolean);
  }

  var STYLE =
    ".krm-wrap{position:relative}" +
    "#krm-map{width:100%;border-radius:12px;overflow:hidden;background:var(--secondary-background-color)}" +
    ".krm-msg{padding:16px;color:var(--secondary-text-color)}" +
    ".krm-ctl{position:absolute;top:10px;right:10px;z-index:500;display:flex;" +
    "border:1px solid var(--divider-color);border-radius:14px;overflow:hidden;" +
    "background:var(--card-background-color);box-shadow:0 1px 4px #0003}" +
    ".krm-ctl button{border:0;background:transparent;color:var(--secondary-text-color);" +
    "font:inherit;font-size:.8em;padding:5px 11px;cursor:pointer}" +
    ".krm-ctl button[aria-pressed=true]{background:var(--primary-color);color:var(--text-primary-color,#fff)}" +
    ".krm-cap{padding:8px 12px 2px;font-size:.85em;color:var(--secondary-text-color)}" +
    ".krm-cap b.ok{color:var(--primary-color)} .krm-cap b.no{color:var(--error-color)}" +
    ".krm-car{width:16px;height:16px;border-radius:50%;background:#4ea1ff;" +
    "border:3px solid #fff;box-shadow:0 0 0 6px #4ea1ff44,0 1px 4px #0006}" +
    ".krm-pin{transform:translate(-50%,-100%);text-align:center;white-space:nowrap}" +
    ".krm-pin .d{width:12px;height:12px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);" +
    "margin:0 auto;border:2px solid #fff;box-shadow:0 1px 3px #0007}" +
    ".krm-pin .l{font-size:11px;font-weight:600;background:#000a;color:#fff;" +
    "padding:0 5px;border-radius:5px;margin-top:2px;display:inline-block}" +
    ".krm-pin.ok .d{background:var(--success-color,#4caf50)} .krm-pin.no .d{background:var(--error-color,#e53935)}" +
    ".leaflet-container{font:inherit;background:var(--secondary-background-color)}" +
    ".leaflet-bar a{background:var(--card-background-color);color:var(--primary-text-color);border-color:var(--divider-color)}";

  class KiaRangeMapCard extends HTMLElement {
    setConfig(config) {
      this._config = config || {};
      this._rm = Object.assign({}, this._config.range_map || {}, {
        api_key: (this._config.range_map || {}).api_key || this._config.api_key,
        style: (this._config.range_map || {}).style || this._config.style,
        mode: (this._config.range_map || {}).mode || this._config.mode
      });
      this._mode = config && config.default_mode === "round" ? "round" : "one";
      this._built = false;
      this._map = null;
      this._isoCache = {};
      if (!this._root) this._root = this.attachShadow({ mode: "open" });
      if (this._hass) this._render();
    }

    getCardSize() {
      return Math.max(4, Math.ceil((Number(this._config && this._config.height) || 400) / 50));
    }
    static getStubConfig() { return {}; }

    connectedCallback() {
      var m = this._map;
      if (m) setTimeout(function () { m.invalidateSize(); }, 60);
      if (this._hass && !this._built) this._render();
    }

    set hass(hass) {
      this._hass = hass;
      var entId = findRawEntity(hass, this._config && this._config.entity);
      var st = entId && hass.states[entId];
      var sig = st ? entId + "|" + st.state : "none";
      if (sig === this._sig && this._built) return;
      this._sig = sig;
      this._render();
    }

    _inputs() {
      var hass = this._hass;
      if (!hass) return null;
      var entId = findRawEntity(hass, this._config && this._config.entity);
      var st = entId && hass.states[entId];
      if (!st) return null;
      var flat = flatFromAttributes(st.attributes);
      this._entryId = st.attributes.entry_id || null;
      var lat = Number(flat["vehicle.location_latitude"]);
      var lon = Number(flat["vehicle.location_longitude"]);
      var rk = Number(flat["vehicle.ev_driving_range"]);
      if (!isFinite(rk) || rk <= 0) rk = Number(flat["vehicle.total_driving_range"]);
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(rk) || rk <= 0) return null;
      var o = { factor: this._rm.factor, reservePct: this._rm.reserve_pct };
      return {
        lat: lat, lon: lon,
        oneWay: RNG.reach(rk, Object.assign({}, o, { roundTrip: false })),
        round: RNG.reach(rk, Object.assign({}, o, { roundTrip: true })),
        apiKey: this._rm.api_key || null,
        mode: this._rm.mode || "drive"
      };
    }

    _render() {
      var root = this._root;
      if (!root) return;
      var self0 = this;
      var inp = this._inputs();
      if (!inp) {
        root.innerHTML =
          "<ha-card><div class='krm-msg'>Range map: waiting for a GPS fix and a range " +
          "figure from the car…</div></ha-card><style>" + STYLE + "</style>";
        this._built = false;
        this._map = null;
        return;
      }
      if (this._built) { this._draw(); return; }

      var h = Number(this._config.height) || 400;
      var css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = LEAFLET_CSS;
      root.innerHTML =
        "<ha-card><div class='krm-wrap'>" +
        "<div id='krm-map' style='height:" + h + "px'></div>" +
        "<div class='krm-ctl'>" +
        "<button data-m='one' aria-pressed='true'>How far</button>" +
        "<button data-m='round'>&amp; back</button>" +
        "</div>" +
        "<div class='krm-cap' data-cap></div>" +
        "</div></ha-card><style>" + STYLE + "</style>";
      root.appendChild(css);
      root.querySelectorAll(".krm-ctl button").forEach(function (b) {
        b.addEventListener("click", function () {
          self0._mode = b.getAttribute("data-m") === "round" ? "round" : "one";
          root.querySelectorAll(".krm-ctl button").forEach(function (x) {
            x.setAttribute("aria-pressed", x === b);
          });
          self0._draw(true);
        });
      });
      this._built = true;

      loadLeafletJs().then(function (L) {
        var el = root.getElementById("krm-map");
        if (!el || self0._map) return;
        self0._L = L;
        self0._map = L.map(el, { zoomSnap: 0.5 });
        var key = inp.apiKey;
        var tiles = key
          ? L.tileLayer(
              "https://maps.geoapify.com/v1/tile/" +
                encodeURIComponent(self0._rm.style || "osm-bright-grey") +
                "/{z}/{x}/{y}.png?apiKey=" + encodeURIComponent(key),
              { maxZoom: 19, attribution: "&copy; Geoapify, &copy; OpenStreetMap contributors" }
            )
          : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
              maxZoom: 19,
              attribution: "&copy; OpenStreetMap contributors"
            });
        tiles.addTo(self0._map);
        self0._layers = L.layerGroup().addTo(self0._map);
        self0._draw(true);
        setTimeout(function () { self0._map && self0._map.invalidateSize(); }, 90);
      }).catch(function (e) {
        root.innerHTML =
          "<ha-card><div class='krm-msg'>Range map: " + esc(e.message) +
          " (Leaflet is loaded from cdnjs — check the browser can reach it).</div>" +
          "</ha-card><style>" + STYLE + "</style>";
        self0._built = false;
      });
    }

    _ring(inp, dist) {
      var self0 = this;
      var circle = function () { return RNG.circleRing(inp.lat, inp.lon, dist); };
      if (!ISO || !inp.apiKey || ISO.pastMax(dist)) return Promise.resolve(circle());
      var key = ISO.cacheKey(inp.lat, inp.lon, [dist]);
      if (this._isoCache[key]) return Promise.resolve(this._isoCache[key]);
      return fetch(ISO.isoUrl({
        apiKey: inp.apiKey, lat: inp.lat, lon: inp.lon, rangesKm: [dist], mode: inp.mode
      }))
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (j) {
          var parsed = ISO.parseIso(j);
          var ring = parsed.length ? parsed[parsed.length - 1].ring : null;
          if (!ring || ring.length < 4) throw new Error("no polygon");
          self0._isoCache[key] = ring;
          return ring;
        })
        .catch(function () { return circle(); });
    }

    _draw(fit) {
      var self0 = this;
      var L = this._L, map = this._map, grp = this._layers;
      if (!L || !map || !grp) return;
      var inp = this._inputs();
      if (!inp) return;
      var hass = this._hass;
      var metric = isMetric(hass);
      var mode = this._mode;
      var dist = mode === "round" ? inp.round : inp.oneWay;
      if (!dist) return;

      this._ring(inp, dist).then(function (ring) {
        grp.clearLayers();
        var latlngs = ring.map(function (p) { return [p[1], p[0]]; });
        var col = mode === "round" ? "#ffb300" : "#4caf50";
        var poly = L.polygon(latlngs, {
          color: col, weight: 2, fillColor: col, fillOpacity: 0.15
        }).addTo(grp);

        L.marker([inp.lat, inp.lon], {
          icon: L.divIcon({ className: "", iconSize: [16, 16], iconAnchor: [8, 8],
            html: "<div class='krm-car'></div>" }),
          interactive: false, keyboard: false
        }).addTo(grp);

        var far = Math.max(inp.oneWay, inp.round || 0) * 1.6;
        var near = zonePois(hass)
          .map(function (z) {
            return { z: z, km: RNG.haversineKm(inp.lat, inp.lon, z.lat, z.lon) };
          })
          .filter(function (x) { return x.km <= far; })
          .sort(function (a, b) { return a.km - b.km; })
          .slice(0, 12);
        near.forEach(function (x) {
          var ok = x.km <= dist;
          L.marker([x.z.lat, x.z.lon], {
            icon: L.divIcon({
              className: "", iconSize: [1, 1], iconAnchor: [0, 0],
              html: "<div class='krm-pin " + (ok ? "ok" : "no") + "'><div class='d'></div>" +
                "<div class='l'>" + (ok ? "✓ " : "✗ ") + esc(x.z.name) + "</div></div>"
            })
          }).bindTooltip(esc(x.z.name) + " · " + kmToDisp(x.km, metric), { direction: "top" })
            .addTo(grp);
        });

        if (fit || !self0._fitted) {
          map.fitBounds(poly.getBounds(), { padding: [24, 24] });
          self0._fitted = true;
        }

        var cap = self0._root.querySelector("[data-cap]");
        if (cap) {
          var head = "Reach <b>" + kmToDisp(dist, metric) + "</b>" +
            (mode === "round" ? " there &amp; back" : "");
          var parts = near.slice(0, 3).map(function (x) {
            var ok = x.km <= dist;
            return "<b class='" + (ok ? "ok" : "no") + "'>" + (ok ? "✓ " : "✗ ") +
              esc(x.z.name) + "</b> " + kmToDisp(x.km, metric);
          });
          cap.innerHTML = head + (parts.length ? " &nbsp;·&nbsp; " + parts.join(" &nbsp;·&nbsp; ") : "");
        }
      });
    }
  }

  if (!customElements.get("kia-range-map-card")) {
    customElements.define("kia-range-map-card", KiaRangeMapCard);
  }
  self.customCards = self.customCards || [];
  self.customCards.push({
    type: "kia-range-map-card",
    name: "Kia Range Map",
    description: "Interactive map of how far the car can drive on the current charge.",
    preview: false
  });
})();
