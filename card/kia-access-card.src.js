/* Kia Access - Lovelace card.
 *
 * Renders the same top-down car diagram, battery gauge and widgets as the
 * MagicMirror module (shared core/visuals.js + core/state.js), plus a details
 * table and action buttons wired to the kia_access.* services.
 *
 * scripts/sync-core.js prepends core/state.js, core/visuals.js, core/conditions.js,
 * the entity + command catalogues, then this file. Globals available here:
 *   KiaAccessState.buildState, KiaAccessVisuals.*, KiaConditions.evaluate,
 *   KiaAccessEntities.entities, KiaAccessCommands.commands
 */
(function () {
  "use strict";

  var V = self.KiaAccessVisuals;
  var S = self.KiaAccessState;
  var C = self.KiaConditions;
  var RNG = self.KiaAccessRange;
  var ISO = self.KiaAccessIsoline;
  var CATALOGUE = (self.KiaAccessEntities && self.KiaAccessEntities.entities) || [];
  var COMMANDS = (self.KiaAccessCommands && self.KiaAccessCommands.commands) || [];
  // one-tap buttons: the no-argument commands. start_climate / stop_climate have
  // their own panel (temperature + duration + toggles); set_charge_limits and
  // send_to_car stay services only.
  var CLIMATE_KEYS = { start_climate: 1, stop_climate: 1 };
  var BUTTON_COMMANDS = COMMANDS.filter(function (c) {
    return !c.options && !CLIMATE_KEYS[c.key];
  });
  var CMD_BY_KEY = {};
  COMMANDS.forEach(function (c) { CMD_BY_KEY[c.key] = c; });

  // button groups, in display order
  var CAT_ORDER = ["security", "climate", "charge", "find"];
  var CAT_LABEL = {
    security: "Doors", climate: "Climate", charge: "Charging", find: "Find the car"
  };

  var STYLE =
    ".ka-wrap{padding:12px 16px 14px}" +
    ".ka-top{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}" +
    ".ka-diagram svg{max-width:264px;height:auto}" +  /* room for the warning badge's wider viewBox */
    ".ka-side{flex:1 1 160px;min-width:150px}" +
    ".ka-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}" +
    ".ka-title{min-width:0}" +
    ".ka-name{font-size:1.1em;font-weight:500}" +
    ".ka-sub{color:var(--secondary-text-color);font-size:.85em}" +
    ".ka-refresh{flex:none;background:none;border:0;cursor:pointer;padding:4px;" +
    "border-radius:50%;color:var(--secondary-text-color);display:flex}" +
    ".ka-refresh:hover{background:var(--secondary-background-color);color:var(--primary-text-color)}" +
    ".ka-refresh ha-icon{--mdc-icon-size:20px;width:20px;height:20px}" +
    ".ka-refresh.spinning ha-icon{animation:ka-spin 1s linear infinite}" +
    "@keyframes ka-spin{to{transform:rotate(360deg)}}" +
    ".ka-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}" +
    ".ka-chip{font-size:.75em;padding:2px 8px;border-radius:10px;background:var(--secondary-background-color);color:var(--secondary-text-color)}" +
    // status bar for active warnings/criticals -- same idea as the MM
    // module's persistent banner (every active issue, colour by severity)
    ".ka-alertbar{display:flex;align-items:baseline;gap:6px;margin-top:6px;" +
    "font-size:.85em;font-weight:600;line-height:1.3}" +
    ".ka-alert-icon{--mdc-icon-size:16px;width:16px;height:16px;flex:none;" +
    "animation:ka-alertflash 1.3s ease-in-out infinite}" +
    ".ka-alertbar.is-critical .ka-alert-icon{color:var(--error-color,#e53935);animation-duration:.85s}" +
    ".ka-alertbar.is-warning .ka-alert-icon{color:var(--warning-color,#ffb300)}" +
    ".ka-alert-crit{color:var(--error-color,#e53935)}" +
    ".ka-alert-warn{color:var(--warning-color,#ffb300)}" +
    ".ka-alert-sep{color:var(--secondary-text-color);font-weight:400}" +
    "@keyframes ka-alertflash{0%,100%{opacity:1}50%{opacity:.25}}" +
    "@media (prefers-reduced-motion:reduce){.ka-alert-icon{animation:none}}" +
    ".ka-actions{margin-top:14px}" +
    ".ka-group{margin-top:9px}" +
    ".ka-group-label{font-size:.68em;text-transform:uppercase;letter-spacing:.08em;" +
    "color:var(--secondary-text-color);margin-bottom:5px}" +
    ".ka-btns{display:flex;flex-wrap:wrap;gap:6px}" +
    ".ka-btns button{display:inline-flex;align-items:center;gap:5px;" +
    "background:var(--card-background-color);color:var(--primary-text-color);" +
    "border:1px solid var(--divider-color);border-radius:16px;padding:5px 12px;" +
    "font-size:.85em;font-family:inherit;cursor:pointer}" +
    ".ka-btns button:hover{background:var(--secondary-background-color)}" +
    ".ka-btns ha-icon{--mdc-icon-size:16px;width:16px;height:16px}" +
    ".ka-clim{display:flex;flex-direction:column;gap:7px;margin-top:2px}" +
    ".ka-clim-row{display:flex;align-items:center;justify-content:space-between;gap:10px}" +
    ".ka-clim-row>span{font-size:.85em;color:var(--primary-text-color)}" +
    ".ka-step{display:inline-flex;align-items:center;border:1px solid var(--divider-color);" +
    "border-radius:16px;overflow:hidden}" +
    ".ka-step button{border:0;background:var(--card-background-color);color:var(--primary-text-color);" +
    "font:inherit;font-size:1.05em;line-height:1;width:30px;height:28px;cursor:pointer}" +
    ".ka-step button:hover{background:var(--secondary-background-color)}" +
    ".ka-step button:disabled{opacity:.35;cursor:default}" +
    ".ka-step .ka-step-val{min-width:52px;text-align:center;font-size:.9em;" +
    "color:var(--primary-text-color);font-variant-numeric:tabular-nums}" +
    ".ka-toggles{display:flex;flex-wrap:wrap;gap:6px}" +
    ".ka-toggles label{display:inline-flex;align-items:center;gap:5px;font-size:.8em;" +
    "color:var(--primary-text-color);" +
    "border:1px solid var(--divider-color);border-radius:14px;padding:3px 10px;cursor:pointer}" +
    ".ka-toggles input{accent-color:var(--primary-color)}" +
    ".ka-clim-go{display:flex;gap:6px;margin-top:2px}" +
    ".ka-clim-go button{flex:1;border-radius:16px;border:1px solid var(--divider-color);" +
    "font:inherit;font-size:.85em;padding:6px 10px;cursor:pointer;" +
    "background:var(--card-background-color);color:var(--primary-text-color)}" +
    ".ka-clim-go button.primary{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:transparent}" +
    ".ka-clim-note{font-size:.78em;color:var(--secondary-text-color);min-height:1em}" +
    ".ka-rangemap{margin-top:14px}" +
    ".ka-rangemap-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}" +
    ".ka-rangemap-h .t{font-size:.9em}" +
    ".ka-rmseg{display:inline-flex;border:1px solid var(--divider-color);border-radius:14px;overflow:hidden}" +
    ".ka-rmseg button{border:0;background:var(--card-background-color);color:var(--secondary-text-color);" +
    "font:inherit;font-size:.78em;padding:4px 10px;cursor:pointer}" +
    ".ka-rmseg button[aria-pressed=true]{background:var(--primary-color);color:var(--text-primary-color,#fff)}" +
    ".ka-rangemap img{display:block;width:100%;border-radius:10px;background:var(--secondary-background-color)}" +
    ".ka-rangemap .cap{font-size:.8em;color:var(--secondary-text-color);margin-top:5px}" +
    ".ka-rangemap .cap b.no{color:var(--error-color)} .ka-rangemap .cap b.ok{color:var(--primary-color)}" +
    ".ka-table{width:100%;border-collapse:collapse;margin-top:14px;font-size:.9em}" +
    ".ka-table td{padding:2px 0;border-bottom:1px solid var(--divider-color)}" +
    ".ka-table td:last-child{text-align:right;color:var(--secondary-text-color)}" +
    ".ka-warn{color:var(--error-color);margin-top:8px;font-size:.9em}";

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var UNIT = {};
  CATALOGUE.forEach(function (e) { if (e.unit) UNIT[e.key] = e.unit; });

  var DIST_KEYS = {
    ev_driving_range: 1, total_driving_range: 1, fuel_driving_range: 1,
    odometer: 1, next_service_distance: 1
  };
  var TEMP_KEYS = { outside_temperature: 1, air_temperature: 1 };

  function fmt(key, value, imperial) {
    if (value === true || value === "true") return "Yes";
    if (value === false || value === "false") return "No";
    if (value == null || value === "" || value === "null") return "—";
    var u = UNIT[key];
    var numeric = typeof value === "number" || /^-?\d+(\.\d+)?$/.test(value);
    if (u && numeric) {
      var n = Number(value);
      if (imperial && DIST_KEYS[key]) { n = n * 0.621371; u = "mi"; }
      else if (imperial && TEMP_KEYS[key]) { n = n * 9 / 5 + 32; u = "°F"; }
      return (Math.round(n * 10) / 10) + " " + u;
    }
    return String(value);
  }

  function relTime(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 90) return s + "s ago";
    var m = Math.round(s / 60);
    if (m < 90) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 36) return h + "h ago";
    return Math.round(h / 24) + "d ago";
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

  function buttonHtml(c) {
    var ic = c.icon ? "<ha-icon icon='" + esc(c.icon) + "'></ha-icon>" : "";
    return "<button type='button' data-cmd='" + esc(c.key) + "'" +
      (c.confirm ? " data-confirm='1'" : "") + ">" + ic + esc(c.name) + "</button>";
  }

  // button groups only (no wrapper) — the climate panel is rendered alongside
  function actionsGroupsHtml() {
    var seen = {};
    var html = CAT_ORDER.map(function (cat) {
      var items = BUTTON_COMMANDS.filter(function (c) { return (c.category || "other") === cat; });
      items.forEach(function (c) { seen[c.key] = 1; });
      if (!items.length) return "";
      return "<div class='ka-group'><div class='ka-group-label'>" +
        esc(CAT_LABEL[cat] || cat) + "</div><div class='ka-btns'>" +
        items.map(buttonHtml).join("") + "</div></div>";
    }).join("");
    var rest = BUTTON_COMMANDS.filter(function (c) { return !seen[c.key]; });
    if (rest.length) {
      html += "<div class='ka-group'><div class='ka-btns'>" +
        rest.map(buttonHtml).join("") + "</div></div>";
    }
    return html;
  }

  // ---- climate control panel -------------------------------------------------
  // The Kia USA API takes the set-point in °F (62–82). We keep the canonical
  // value in °F and only convert for display when the dashboard is metric.
  var CLIM_OPTS = (CMD_BY_KEY.start_climate && CMD_BY_KEY.start_climate.options) || {};
  var TEMP_F_MIN = (CLIM_OPTS.set_temp && CLIM_OPTS.set_temp.min) || 62;
  var TEMP_F_MAX = (CLIM_OPTS.set_temp && CLIM_OPTS.set_temp.max) || 82;
  var TEMP_F_DEF = (CLIM_OPTS.set_temp && CLIM_OPTS.set_temp.default) || 70;
  var DUR_MIN = (CLIM_OPTS.duration && CLIM_OPTS.duration.min) || 1;
  var DUR_MAX = (CLIM_OPTS.duration && CLIM_OPTS.duration.max) || 30;
  var DUR_DEF = (CLIM_OPTS.duration && CLIM_OPTS.duration.default) || 10;
  var CLIM_STORE = "kia-access-card:climate";

  var fToC = function (f) { return (f - 32) * 5 / 9; };
  var cToF = function (c) { return c * 9 / 5 + 32; };
  var clamp = function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); };

  function loadClim() {
    var d = { tempF: TEMP_F_DEF, duration: DUR_DEF, defrost: false, rearDefrost: false, wheel: false };
    try {
      var s = JSON.parse(window.localStorage.getItem(CLIM_STORE) || "{}");
      if (typeof s.tempF === "number") d.tempF = clamp(Math.round(s.tempF), TEMP_F_MIN, TEMP_F_MAX);
      if (typeof s.duration === "number") d.duration = clamp(Math.round(s.duration), DUR_MIN, DUR_MAX);
      d.defrost = !!s.defrost; d.rearDefrost = !!s.rearDefrost; d.wheel = !!s.wheel;
    } catch (e) { /* first run / private mode */ }
    return d;
  }
  function saveClim(c) {
    try { window.localStorage.setItem(CLIM_STORE, JSON.stringify(c)); } catch (e) { /* ignore */ }
  }

  function stepRow(label, id, valTxt, atMin, atMax) {
    return "<div class='ka-clim-row'><span>" + esc(label) + "</span>" +
      "<span class='ka-step'>" +
      "<button type='button' data-step='" + id + ":-1'" + (atMin ? " disabled" : "") + ">−</button>" +
      "<span class='ka-step-val'>" + esc(valTxt) + "</span>" +
      "<button type='button' data-step='" + id + ":1'" + (atMax ? " disabled" : "") + ">+</button>" +
      "</span></div>";
  }

  // `unit` is "C" or "F"
  function climateHtml(clim, unit) {
    var tempTxt, atTMin, atTMax;
    if (unit === "C") {
      var tC = Math.round(fToC(clim.tempF));
      tempTxt = tC + " °C";
      atTMin = tC <= Math.ceil(fToC(TEMP_F_MIN));
      atTMax = tC >= Math.floor(fToC(TEMP_F_MAX));
    } else {
      tempTxt = Math.round(clim.tempF) + " °F";
      atTMin = clim.tempF <= TEMP_F_MIN;
      atTMax = clim.tempF >= TEMP_F_MAX;
    }
    var cb = function (id, lbl, on) {
      return "<label><input type='checkbox' data-clim='" + id + "'" +
        (on ? " checked" : "") + ">" + esc(lbl) + "</label>";
    };
    return "<div class='ka-group'><div class='ka-group-label'>Climate</div>" +
      "<div class='ka-clim'>" +
      stepRow("Temperature", "temp", tempTxt, atTMin, atTMax) +
      stepRow("Run for", "dur", clim.duration + " min",
        clim.duration <= DUR_MIN, clim.duration >= DUR_MAX) +
      "<div class='ka-toggles'>" +
      cb("defrost", "Defrost", clim.defrost) +
      cb("rearDefrost", "Rear + mirrors", clim.rearDefrost) +
      cb("wheel", "Heated wheel", clim.wheel) +
      "</div>" +
      "<div class='ka-clim-go'>" +
      "<button type='button' class='primary' data-clim-go='start'>Start climate</button>" +
      "<button type='button' data-clim-go='stop'>Stop</button>" +
      "</div>" +
      "<div class='ka-clim-note' data-clim-note></div>" +
      "</div></div>";
  }

  // ---- range-map (Geoapify isoline -> static image) ----
  var RM_STORE = "kia-access-rangemap-v2"; // bump to bust stale cached image URLs
  function loadRm() {
    try { return JSON.parse(window.localStorage.getItem(RM_STORE) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function saveRm(o) {
    try { window.localStorage.setItem(RM_STORE, JSON.stringify(o)); } catch (e) { /* */ }
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

  class KiaAccessCard extends HTMLElement {
    setConfig(config) {
      this._config = config || {};
      this._sig = null;
      if (!this._root) this._root = this.attachShadow({ mode: "open" });
      if (this._hass) { this.hass = this._hass; }
    }

    getCardSize() { return 8; }

    static getStubConfig() { return { entity: "" }; }

    disconnectedCallback() {
      clearTimeout(this._flashT);
    }

    set hass(hass) {
      this._hass = hass;
      // HA sets `hass` on every state change anywhere — only re-render when the
      // vehicle entity we care about actually changed
      var entId = findRawEntity(hass, this._config && this._config.entity);
      var st = entId && hass.states[entId];
      var sig = st ? entId + "|" + st.state + "|" + st.last_updated : "none";
      if (sig === this._sig) return;
      this._sig = sig;
      this._render();
    }

    // guard against a double-tap firing the same command twice
    _tooSoon(key) {
      var now = Date.now();
      this._lastCmd = this._lastCmd || {};
      if (now - (this._lastCmd[key] || 0) < 1500) return true;
      this._lastCmd[key] = now;
      return false;
    }

    _callCommand(key, needsConfirm) {
      if (!this._hass || this._tooSoon(key)) return;
      var spec = CMD_BY_KEY[key] || {};
      if (needsConfirm &&
          !window.confirm((spec.name || key) + " — send this to the car?")) {
        return;
      }
      var data = {};
      if (this._entryId) data.entry_id = this._entryId;
      this._hass.callService("kia_access", key, data);

      // acknowledge a hazards/find-the-car command by flashing the diagram lamps
      // (~3s covers the 5 SMIL flashes); the API has no live state to follow
      if (key === "flash_lights" || key === "find_car") {
        this._flashing = true;
        this._render();
        clearTimeout(this._flashT);
        this._flashT = setTimeout(function () {
          this._flashing = false;
          this._sig = null;
          this._render();
        }.bind(this), 3200);
      }
    }

    // ---- range map ----
    _rmMode() {
      if (!this._rmModeCache) {
        var m = (this._config.range_map && this._config.range_map.mode) || loadRm().mode || "one";
        this._rmModeCache = m === "round" ? "round" : "one";
      }
      return this._rmModeCache;
    }
    _setRmMode(m) {
      this._rmModeCache = m === "round" ? "round" : "one";
      var s = loadRm(); s.mode = this._rmModeCache; saveRm(s);
      this._render();
    }
    _rangeInputs(flat) {
      if (!RNG || !(this._config.range_map || {}).api_key) return null;
      var lat = Number(flat["vehicle.location_latitude"]);
      var lon = Number(flat["vehicle.location_longitude"]);
      var rk = Number(flat["vehicle.ev_driving_range"]);
      if (!isFinite(rk) || rk <= 0) rk = Number(flat["vehicle.total_driving_range"]);
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(rk) || rk <= 0) return null;
      var cfg = this._config.range_map;
      var o = { factor: cfg.factor, reservePct: cfg.reserve_pct };
      return {
        lat: lat, lon: lon,
        oneWay: RNG.reach(rk, Object.assign({}, o, { roundTrip: false })),
        round: RNG.reach(rk, Object.assign({}, o, { roundTrip: true }))
      };
    }
    _fetchRangeMap(inp, hass) {
      var self0 = this;
      var cfg = this._config.range_map || {};
      if (!cfg.api_key || !ISO || !RNG || !inp || typeof fetch !== "function") return;
      var key = ISO.cacheKey(inp.lat, inp.lon, [inp.oneWay, inp.round]);
      if (this._rm && this._rm.key === key) return;
      var cache = loadRm();
      if (cache.key === key && cache.at && Date.now() - cache.at < 6 * 3600e3 && cache.oneWayUrl) {
        this._rm = cache; this._render(); return;
      }
      if (this._rmFetching === key) return;
      if (this._rmFailAt && Date.now() - this._rmFailAt < 60000) return; // back off after an error
      this._rmFetching = key;
      var mode = cfg.mode || "drive";

      // one ring per distance: TomTom (any) -> Geoapify (<=100km) -> circle
      function ringFor(km) {
        if (!km) return Promise.resolve(null);
        var circle = function () { return { ring: RNG.circleRing(inp.lat, inp.lon, km), approx: true }; };
        var geo = function () {
          if (!ISO.pastMax(km)) {
            return fetch(ISO.isoUrl({ apiKey: cfg.api_key, lat: inp.lat, lon: inp.lon, rangesKm: [km], mode: mode }))
              .then(function (r) { if (!r.ok) throw 0; return r.json(); })
              .then(function (j) {
                var p = ISO.parseIso(j);
                var ring = p.length ? p[p.length - 1].ring : null;
                if (!ring) throw 0;
                return { ring: ring, approx: false };
              }).catch(circle);
          }
          return Promise.resolve(circle());
        };
        if (cfg.tomtom_key) {
          return fetch(ISO.tomtomUrl({ apiKey: cfg.tomtom_key, lat: inp.lat, lon: inp.lon, distanceKm: km, mode: mode }))
            .then(function (r) { if (!r.ok) throw 0; return r.json(); })
            .then(function (j) {
              var ring = ISO.parseTomtom(j);
              if (!ring) throw 0;
              return { ring: ring, approx: false };
            }).catch(geo);
        }
        return geo();
      }

      Promise.all([ringFor(inp.oneWay), ringFor(inp.round)]).then(function (res) {
        var oneR = res[0], roundR = res[1];
        // only pin zones that are roughly reachable — a zone on another
        // continent shouldn't drag the map out
        var far = Math.max(inp.oneWay, inp.round || 0) * 1.6;
        var near = zonePois(hass)
          .map(function (p) {
            return { p: p, km: RNG.haversineKm(inp.lat, inp.lon, p.lat, p.lon) };
          })
          .filter(function (z) { return z.km <= far; })
          .sort(function (a, b) { return a.km - b.km; })
          .slice(0, 6);
        var markers = [{ lat: inp.lat, lon: inp.lon, color: "#4ea1ff", always: true }].concat(
          near.map(function (z) {
            return { lat: z.p.lat, lon: z.p.lon, color: "#e53935", text: z.p.name };
          })
        );
        function smap(ring) {
          return ring && ISO.staticMapUrl({
            apiKey: cfg.api_key,
            width: Number(cfg.width) || 600,
            height: Number(cfg.height) || 340,
            style: cfg.style || "osm-bright-grey",
            simplifyDeg: cfg.simplify_deg != null ? Number(cfg.simplify_deg) : 0.01,
            rings: [{ ring: ring, color: "#4caf50" }], markers: markers
          });
        }
        var rm = {
          key: key, at: Date.now(),
          oneWayKm: Math.round(inp.oneWay),
          roundKm: inp.round ? Math.round(inp.round) : null,
          oneWayApprox: !!(oneR && oneR.approx),
          roundApprox: roundR ? !!roundR.approx : null,
          oneWayUrl: smap(oneR && oneR.ring),
          roundUrl: smap(roundR && roundR.ring)
        };
        self0._rm = rm;
        self0._rmFailAt = 0;
        saveRm(Object.assign({ mode: self0._rmMode() }, rm));
        self0._render();
      }).catch(function () { self0._rmFailAt = Date.now(); })
        .then(function () { self0._rmFetching = null; });
    }
    _rangeMapSection(inp, hass) {
      if (!inp || !RNG) return "";
      var metric = !this._imperial();
      var mode = this._rmMode();
      var dist = mode === "round" ? inp.round : inp.oneWay;
      var rm = this._rm;
      var url = rm && (mode === "round" ? rm.roundUrl : rm.oneWayUrl);
      var approx = rm && (mode === "round" ? rm.roundApprox : rm.oneWayApprox);
      var poi = RNG.poiStatus(inp.lat, inp.lon, zonePois(hass), dist)
        .filter(function (p) { return p.km <= dist * 2.5; });
      var caps = poi.slice(0, 3).map(function (p) {
        return "<b class='" + (p.reachable ? "ok" : "no") + "'>" +
          (p.reachable ? "✓ " : "✗ ") + esc(p.name) + "</b> " + kmToDisp(p.km, metric);
      }).join(" · ");
      return "<div class='ka-rangemap'>" +
        "<div class='ka-rangemap-h'><span class='t'>Reach <b>" + kmToDisp(dist, metric) + "</b>" +
        (mode === "round" ? " there &amp; back" : "") + "</span>" +
        "<span class='ka-rmseg'>" +
        "<button type='button' data-rm='one' aria-pressed='" + (mode !== "round") + "'>How far</button>" +
        "<button type='button' data-rm='round' aria-pressed='" + (mode === "round") + "'>&amp; back</button>" +
        "</span></div>" +
        (url ? "<img loading='lazy' src='" + esc(url) + "' alt='reachable driving area'>"
             : "<div class='cap'>Building the map…</div>") +
        (approx ? "<div class='cap'>straight-line radius · road isochrone under ~60 mi range</div>" : "") +
        (caps ? "<div class='cap'>" + caps + "</div>" : "") +
        "</div>";
    }

    // miles + °F, or km + °C? card `units:` config wins, else the HA unit system
    _imperial() {
      var c = this._config && this._config.units;
      if (c === "imperial") return true;
      if (c === "metric") return false;
      var us = this._hass && this._hass.config && this._hass.config.unit_system;
      return !!(us && (us.length === "mi" || us.temperature === "°F"));
    }

    // "C" / "F" for the climate panel + diagram — `temperature_unit` / `units`
    // config wins, else the HA unit system
    _tempUnit() {
      var c = this._config && this._config.temperature_unit;
      if (c === "C" || c === "F") return c;
      if (this._config && this._config.units === "imperial") return "F";
      if (this._config && this._config.units === "metric") return "C";
      var us = this._hass && this._hass.config && this._hass.config.unit_system;
      return us && us.temperature === "°F" ? "F" : "C";
    }

    _clim() {
      if (!this._climState) this._climState = loadClim();
      return this._climState;
    }

    // re-render only the climate panel, keeping its scroll / focus context light
    _climRefresh() {
      var panel = this._root && this._root.querySelector(".ka-clim");
      if (!panel) { this._sig = null; this._render(); return; }
      var host = panel.closest(".ka-group");
      host.outerHTML = climateHtml(this._clim(), this._tempUnit());
      this._wireClimate();
    }

    _climStep(id, dir) {
      var c = this._clim();
      if (id === "temp") {
        if (this._tempUnit() === "C") {
          // step a whole °C: round the current point to °C, move, convert back
          var next = clamp(Math.round(fToC(c.tempF)) + dir,
            Math.ceil(fToC(TEMP_F_MIN)), Math.floor(fToC(TEMP_F_MAX)));
          c.tempF = clamp(Math.round(cToF(next)), TEMP_F_MIN, TEMP_F_MAX);
        } else {
          c.tempF = clamp(c.tempF + dir, TEMP_F_MIN, TEMP_F_MAX);
        }
      } else if (id === "dur") {
        c.duration = clamp(c.duration + dir, DUR_MIN, DUR_MAX);
      }
      saveClim(c);
      this._climRefresh();
    }

    _climToggle(id, on) {
      var c = this._clim();
      c[id] = on;
      saveClim(c);
    }

    _climNote(msg) {
      var n = this._root && this._root.querySelector("[data-clim-note]");
      if (n) n.textContent = msg || "";
    }

    _startClimate() {
      if (!this._hass || this._tooSoon("start_climate")) return;
      var c = this._clim();
      var data = {
        set_temp: c.tempF,
        duration: c.duration,
        climate: true,
        defrost: !!c.defrost,
        heating: c.rearDefrost ? 1 : 0,
        steering_wheel: c.wheel ? 2 : 0
      };
      if (this._entryId) data.entry_id = this._entryId;
      var shown = this._tempUnit() === "C"
        ? Math.round(fToC(c.tempF)) + " °C" : c.tempF + " °F";
      this._hass.callService("kia_access", "start_climate", data);
      this._climNote("Starting climate at " + shown + " for " + c.duration + " min…");
    }

    _stopClimate() {
      if (!this._hass || this._tooSoon("stop_climate")) return;
      var data = {};
      if (this._entryId) data.entry_id = this._entryId;
      this._hass.callService("kia_access", "stop_climate", data);
      this._climNote("Stopping climate…");
    }

    // pull fresh data from Kia's servers now (button.<vehicle>_refresh_now,
    // added alongside the integration's coordinator.async_force_refresh() —
    // wakes the car even when "poll car directly" is off). Spins the icon
    // for a few seconds as immediate feedback; the entity has no state of
    // its own to watch (it's a momentary button, not a sensor).
    _refreshNow() {
      if (!this._hass || this._tooSoon("refresh_now") || !this._refreshEntity) return;
      this._hass.callService("button", "press", { entity_id: this._refreshEntity });
      this._refreshing = true;
      this._render();
      clearTimeout(this._refreshT);
      this._refreshT = setTimeout(function () {
        this._refreshing = false;
        this._sig = null;
        this._render();
      }.bind(this), 3200);
    }

    _wireClimate() {
      var root = this._root;
      var card = this;
      root.querySelectorAll("[data-step]").forEach(function (b) {
        b.addEventListener("click", function () {
          var p = b.getAttribute("data-step").split(":");
          card._climStep(p[0], parseInt(p[1], 10));
        });
      });
      root.querySelectorAll("[data-clim]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          card._climToggle(cb.getAttribute("data-clim"), cb.checked);
        });
      });
      root.querySelectorAll("[data-clim-go]").forEach(function (b) {
        b.addEventListener("click", function () {
          if (b.getAttribute("data-clim-go") === "start") card._startClimate();
          else card._stopClimate();
        });
      });
    }

    // unexpected_move / not_plugged_home / cant_get_home need a caller-tracked
    // parked-GPS anchor + home-unplugged timer -- conditions.js can't compute
    // these itself (see core/conditions.js comments). The MM module and the
    // HA coordinator (coordinator.py _emit_alerts) each keep this state
    // locally and it was never surfaced back onto the summary sensor's
    // attributes, so the card's own client-side C.evaluate() call could never
    // see it and silently never detected these three conditions -- MM (or
    // the coordinator's own kia_access_alert events) could show "Moved while
    // parked" while this card stayed clean for the exact same car. Mirrors
    // MMM-KiaAccess.js processConditions()/coordinator.py _emit_alerts()
    // exactly, but reads the home point from zone.home instead of a config
    // option -- the card already has hass, no extra setup needed.
    _updateHomeAndMoveTracking(state) {
      var hass = this._hass;
      var zone = hass && hass.states["zone.home"];
      if (zone && state.locationLat != null && state.locationLon != null
          && RNG && RNG.haversineKm) {
        var km = RNG.haversineKm(
          state.locationLat, state.locationLon,
          zone.attributes.latitude, zone.attributes.longitude
        );
        var radiusKm = (Number(zone.attributes.radius) || 100) / 1000;
        state.atHome = km != null ? km <= radiusKm : undefined;
        state.homeDistanceKm = km;
      } else {
        state.atHome = undefined;
        state.homeDistanceKm = null;
      }

      var homeUnplugged = state.atHome === true && state.plugged !== true;
      if (homeUnplugged && !this._homeUnpluggedSince) this._homeUnpluggedSince = Date.now();
      if (!homeUnplugged) this._homeUnpluggedSince = null;
      state.homeUnpluggedMin = this._homeUnpluggedSince
        ? (Date.now() - this._homeUnpluggedSince) / 60000 : null;

      // moved-while-parked (tow / theft): GPS shifted while the odometer
      // stayed put and the car was off
      var now = Date.now();
      var p = this._lastParked;
      var odoStable = p && state.odometerKm != null && Math.abs(state.odometerKm - p.odo) < 0.1;
      if (odoStable && state.carOn !== true && state.locationLat != null
          && p.lat != null && RNG && RNG.haversineKm) {
        var movedKm = RNG.haversineKm(p.lat, p.lon, state.locationLat, state.locationLon);
        if (movedKm != null && movedKm >= 0.3048) { // 1000 ft -- real move, not GPS jitter
          if (!this._movedSince) this._movedSince = now;
          state.movedWhileParkedKm = movedKm;
          state.movedWhileParkedMin = (now - this._movedSince) / 60000;
        } else {
          this._movedSince = null;
          state.movedWhileParkedKm = 0;
          state.movedWhileParkedMin = 0;
        }
      } else {
        this._movedSince = null;
        if (state.locationLat != null && state.odometerKm != null) {
          this._lastParked = {
            lat: state.locationLat, lon: state.locationLon, odo: state.odometerKm
          };
        }
        state.movedWhileParkedKm = this._lastParked ? 0 : null;
        state.movedWhileParkedMin = 0;
      }
    }

    _render() {
      var hass = this._hass;
      var root = this._root;
      if (!hass || !root) return;

      var entId = findRawEntity(hass, this._config && this._config.entity);
      if (!entId || !hass.states[entId]) {
        root.innerHTML =
          "<ha-card><div class='ka-wrap'>Kia Access: no vehicle entity found. " +
          "Add the integration, or set <code>entity:</code> to its summary sensor." +
          "</div></ha-card><style>" + STYLE + "</style>";
        return;
      }

      var st = hass.states[entId];
      this._entryId = st.attributes.entry_id || null;
      var flat = flatFromAttributes(st.attributes);
      var state = S.buildState(flat, {});
      this._updateHomeAndMoveTracking(state);
      if (C) {
        try {
          var cres = C.evaluate(state, {}, {});
          state.critical = cres.conditions.some(function (c) {
            return c.level === "critical" && c.active === true;
          });
          state.alerts = V.alertLabels ? V.alertLabels(cres.conditions) : [];
        } catch (e) { /* ignore */ }
      }
      state.flashing = this._flashing === true;
      // the API reports temperatures in °C; the diagram and the climate panel
      // share one unit choice (card config, else the HA unit system)
      var diagram = V.carDiagram(state,
        { width: 230, battery: true, tempUnit: this._tempUnit() });

      var name = st.attributes.vehicle_name || st.attributes.friendly_name || "Kia";
      var updated = st.state && st.state !== "unknown" && st.state !== "unavailable"
        ? "Updated " + relTime(st.state) : "";

      // "Refresh now" icon next to the name/updated line -- only shown when
      // the integration is new enough to have registered the button entity
      this._refreshEntity = entId.replace(/^sensor\./, "button.").replace(/_status$/, "_refresh_now");
      var refreshBtnHtml = hass.states[this._refreshEntity]
        ? "<button type='button' class='ka-refresh" + (this._refreshing ? " spinning" : "") +
          "' data-refresh title='Refresh now' aria-label='Refresh now'>" +
          "<ha-icon icon='mdi:refresh'></ha-icon></button>"
        : "";

      // status chips for the at-a-glance stuff
      var chips = [];
      if (flat["vehicle.valet_mode_active"] === true) chips.push("<span class='ka-chip'>Valet</span>");
      if (flat["vehicle.ev_battery_precondition_enabled"] === true) chips.push("<span class='ka-chip'>Preconditioning</span>");
      var chipHtml = chips.length ? "<div class='ka-chips'>" + chips.join("") + "</div>" : "";

      // same status bar as MM's persistent banner -- every active warning
      // and critical, not just a generic "something's wrong" chip
      var alertHtml = "";
      if (state.alerts && state.alerts.length) {
        var anyCrit = state.alerts.some(function (a) { return a.level === "critical"; });
        var parts = state.alerts.map(function (a) {
          return "<span class='ka-alert-" + (a.level === "critical" ? "crit" : "warn") + "'>" +
            esc(a.label) + "</span>";
        });
        alertHtml = "<div class='ka-alertbar" + (anyCrit ? " is-critical" : " is-warning") + "'>" +
          "<ha-icon icon='mdi:alert' class='ka-alert-icon'></ha-icon>" +
          "<span class='ka-alert-list'>" +
          parts.join("<span class='ka-alert-sep'> &middot; </span>") +
          "</span></div>";
      }

      var imperial = this._imperial();
      var rows = CATALOGUE.map(function (e) {
        var raw = flat["vehicle." + e.key];
        if (raw === undefined) return "";
        return "<tr><td>" + esc(e.name) + "</td><td>" + esc(fmt(e.key, raw, imperial)) + "</td></tr>";
      }).join("");

      var note = st.attributes.note
        ? "<div class='ka-warn'>" + esc(st.attributes.note) + "</div>" : "";

      var rmInp = this._rangeInputs(flat);
      if (rmInp) this._fetchRangeMap(rmInp, hass);

      root.innerHTML =
        "<ha-card><div class='ka-wrap'><div class='ka-top'>" +
        "<div class='ka-diagram'>" + diagram + "</div>" +
        "<div class='ka-side'>" +
        "<div class='ka-head'>" +
        "<div class='ka-title'>" +
        "<div class='ka-name'>" + esc(name) + "</div>" +
        "<div class='ka-sub'>" + esc(updated) + "</div>" +
        "</div>" + refreshBtnHtml +
        "</div>" +
        alertHtml + chipHtml + note +
        "</div></div>" +
        this._rangeMapSection(rmInp, hass) +
        "<div class='ka-actions'>" +
        climateHtml(this._clim(), this._tempUnit()) +
        actionsGroupsHtml() +
        "</div>" +
        "<table class='ka-table'>" + rows + "</table>" +
        "</div></ha-card><style>" + STYLE + "</style>";

      var card = this;
      root.querySelectorAll(".ka-btns button").forEach(function (b) {
        b.addEventListener("click", function () {
          card._callCommand(b.getAttribute("data-cmd"), b.getAttribute("data-confirm") === "1");
        });
      });
      root.querySelectorAll(".ka-rmseg button").forEach(function (b) {
        b.addEventListener("click", function () { card._setRmMode(b.getAttribute("data-rm")); });
      });
      var refreshBtn = root.querySelector(".ka-refresh");
      if (refreshBtn) refreshBtn.addEventListener("click", function () { card._refreshNow(); });
      this._wireClimate();
    }
  }

  if (!customElements.get("kia-access-card")) {
    customElements.define("kia-access-card", KiaAccessCard);
  }
  self.customCards = self.customCards || [];
  self.customCards.push({
    type: "kia-access-card",
    name: "Kia Access Card",
    description: "Top-down vehicle diagram, status and controls for Kia Access.",
    preview: true
  });
})();
