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
    ".ka-vehicle-select{font:inherit;font-size:1.1em;font-weight:500;color:inherit;" +
    "background:transparent;border:0;border-radius:4px;padding:2px 4px;margin:-2px -4px;" +
    "max-width:100%;cursor:pointer}" +
    ".ka-vehicle-select:hover,.ka-vehicle-select:focus{background:var(--secondary-background-color)}" +
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

  // every raw summary sensor on the WHOLE HA instance (one per config entry
  // / vehicle -- possibly spanning more than one Kia Access ACCOUNT, see
  // distinctAccounts() below), sorted for a stable order across renders
  function findAllRawEntities(hass) {
    return Object.keys(hass.states).filter(function (id) {
      var a = hass.states[id].attributes;
      return id.indexOf("sensor.") === 0 && a && a.kia_access_raw === true;
    }).sort();
  }

  // Distinct `account` attribute values (region:brand:username, see
  // sensor.py) across a set of raw entity ids -- more than one means these
  // vehicles are NOT all the same Kia Access login, and auto-discovery must
  // not silently merge them into one dropdown (a selection in that dropdown
  // sends commands via that vehicle's own entry_id, so nothing is actually
  // sent to the wrong account -- but presenting a stranger's, or a
  // different household login's, car in what looks like "your" vehicle
  // list is confusing and unexpected).
  function distinctAccounts(hass, ids) {
    var seen = {};
    ids.forEach(function (id) {
      var a = hass.states[id] && hass.states[id].attributes;
      seen[(a && a.account) || ""] = 1;
    });
    return Object.keys(seen);
  }

  function findRawEntity(hass, configured) {
    if (configured) return configured;
    return findAllRawEntities(hass)[0] || null;
  }

  // Shared across every auto-discovering card on the dashboard (one that
  // has no explicit `entity:` pinned in its config) so picking a vehicle in
  // one card's selector is reflected by every other one on reload/re-render
  // -- a card WITH an explicit `entity:` never reads this, it always shows
  // that one vehicle (the "one card per vehicle" setup still works exactly
  // as before).
  var VEHICLE_SEL_STORE = "kia-access-selected-vehicle";
  function loadSelectedVehicle() {
    try { return window.localStorage.getItem(VEHICLE_SEL_STORE) || ""; }
    catch (e) { return ""; }
  }
  function saveSelectedVehicle(entId) {
    try { window.localStorage.setItem(VEHICLE_SEL_STORE, entId || ""); }
    catch (e) { /* ignore */ }
  }

  function buttonHtml(c) {
    var ic = c.icon ? "<ha-icon icon='" + esc(c.icon) + "'></ha-icon>" : "";
    return "<button type='button' data-cmd='" + esc(c.key) + "'" +
      (c.confirm ? " data-confirm='1'" : "") + ">" + ic + esc(c.name) + "</button>";
  }

  // button groups only (no wrapper) — the climate panel is rendered alongside.
  // canPlugIn === false hides the "charge" category entirely (open/close
  // charge port, start/stop charging) -- a vehicle with no plug (gas, or a
  // conventional non-plug hybrid -- see core/state.js's buildState()
  // canPlugIn field, the source of the value this is called with) has no
  // charge port and nothing to charge externally, so these controls would
  // otherwise sit there unconditionally, dispatching commands the car has
  // no way to honour. Any other value (including omitted) defaults to
  // showing them -- same fail-safe reasoning as buildState()'s canPlugIn.
  function actionsGroupsHtml(canPlugIn) {
    var visible = canPlugIn === false
      ? BUTTON_COMMANDS.filter(function (c) { return c.category !== "charge"; })
      : BUTTON_COMMANDS;
    var seen = {};
    var html = CAT_ORDER.map(function (cat) {
      var items = visible.filter(function (c) { return (c.category || "other") === cat; });
      items.forEach(function (c) { seen[c.key] = 1; });
      if (!items.length) return "";
      return "<div class='ka-group'><div class='ka-group-label'>" +
        esc(CAT_LABEL[cat] || cat) + "</div><div class='ka-btns'>" +
        items.map(buttonHtml).join("") + "</div></div>";
    }).join("");
    var rest = visible.filter(function (c) { return !seen[c.key]; });
    if (rest.length) {
      html += "<div class='ka-group'><div class='ka-btns'>" +
        rest.map(buttonHtml).join("") + "</div></div>";
    }
    return html;
  }

  // ---- climate control panel -------------------------------------------------
  // set_temp's native unit/bounds depend on the VEHICLE's region (USA sends
  // °F 62-82; everywhere else, INCLUDING Canada, is °C 16-30 -- see
  // core/commands.json's `metric` variant and coordinator.py's
  // climate_temp_unit()) -- NOT on the dashboard's display preference, which
  // is a separate, independent choice (_tempUnit()). climTempBounds() picks
  // the vehicle-native set, and the panel converts only for DISPLAY when
  // that differs from native.
  //
  // Canada is deliberately NOT in this set: hyundai_kia_connect_api's
  // KiaUvoApiCA.start_climate takes set_temp in Celsius (a hard lookup into
  // a 14.0-31.5°C tuple) and only KiaUvoApiUSA actually wants Fahrenheit --
  // see kia_client.py's matching comment on `fahrenheit`.
  var CLIM_OPTS = (CMD_BY_KEY.start_climate && CMD_BY_KEY.start_climate.options) || {};
  var FAHRENHEIT_REGIONS = { USA: true };
  function climTempBounds(region) {
    var o = CLIM_OPTS.set_temp || {};
    var fahrenheit = FAHRENHEIT_REGIONS[String(region || "USA").toUpperCase()] !== undefined;
    var v = (!fahrenheit && o.metric) ? o.metric : o;
    return {
      min: v.min != null ? v.min : (fahrenheit ? 62 : 16),
      max: v.max != null ? v.max : (fahrenheit ? 82 : 30),
      def: v.default != null ? v.default : (fahrenheit ? 70 : 21),
      step: v.step || (fahrenheit ? 1 : 0.5),
      fahrenheit: fahrenheit
    };
  }
  var DUR_MIN = (CLIM_OPTS.duration && CLIM_OPTS.duration.min) || 1;
  var DUR_MAX = (CLIM_OPTS.duration && CLIM_OPTS.duration.max) || 30;
  var DUR_DEF = (CLIM_OPTS.duration && CLIM_OPTS.duration.default) || 10;
  var CLIM_STORE = "kia-access-card:climate";

  var fToC = function (f) { return (f - 32) * 5 / 9; };
  var cToF = function (c) { return c * 9 / 5 + 32; };
  var clamp = function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); };
  // convert a temperature from one unit to another, both expressed as "is it Fahrenheit?"
  var convertTemp = function (v, fromF, toF) {
    if (fromF === toF) return v;
    return fromF ? fToC(v) : cToF(v);
  };

  function loadClim(bounds) {
    var d = { temp: bounds.def, duration: DUR_DEF, defrost: false, rearDefrost: false, wheel: false };
    try {
      var s = JSON.parse(window.localStorage.getItem(CLIM_STORE) || "{}");
      // a saved value from a previous, differently-unit'd render (e.g. the
      // vehicle's region changed, which shouldn't normally happen, or an
      // older card version that only ever stored °F) -- if it's wildly
      // outside this vehicle's native bounds, don't trust it, start fresh.
      if (typeof s.temp === "number" && s.temp >= bounds.min - 5 && s.temp <= bounds.max + 5) {
        d.temp = clamp(s.temp, bounds.min, bounds.max);
      }
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

  // `unit` is "C" or "F" -- the DASHBOARD's display preference, independent
  // of `bounds.fahrenheit` (the vehicle's own native unit for dispatch)
  function climateHtml(clim, unit, bounds) {
    var displayF = unit === "F";
    var displayVal = convertTemp(clim.temp, bounds.fahrenheit, displayF);
    var tempTxt = Math.round(displayVal) + (displayF ? " °F" : " °C");
    var atTMin = clim.temp <= bounds.min;
    var atTMax = clim.temp >= bounds.max;
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
      // range_map.api_key/tomtom_key sourced from the integration's own
      // Options (kia_access/map_keys, admin-only websocket command -- see
      // __init__.py's _map_keys_for_entry, and kia-range-map-card.src.js's
      // identical _maybeFetchKeys()) when this card's config didn't set
      // them explicitly -- so a real API key doesn't have to sit in
      // Lovelace YAML just to get the static range-map image.
      this._fetchedKeys = null;
      this._fetchingFor = null;
      if (!this._root) this._root = this.attachShadow({ mode: "open" });
      if (this._hass) { this.hass = this._hass; }
    }

    // Fire-and-remember: kicks off the websocket fetch at most once per
    // entry_id, and only when range_map itself is configured but didn't
    // already supply a key (an explicit api_key always wins, no fetch
    // needed). Re-renders once resolved so the map upgrades from nothing/a
    // circle without needing a page reload.
    _maybeFetchMapKeys() {
      var cfg = this._config.range_map;
      if (!cfg || cfg.api_key) return; // no range map configured, or config already has a key
      if (!this._entryId || !this._hass || !this._hass.connection) return;
      if (this._fetchedKeys !== null || this._fetchingFor === this._entryId) return;
      var self0 = this;
      var entryId = this._entryId;
      this._fetchingFor = entryId;
      this._hass.connection.sendMessagePromise({ type: "kia_access/map_keys", entry_id: entryId })
        .then(function (res) {
          if (self0._entryId !== entryId) return; // vehicle switched mid-flight
          self0._fetchedKeys = res || {};
          self0._sig = null; // force _render() to re-run _rangeInputs()/_fetchRangeMap()
          self0._render();
        })
        .catch(function (e) {
          if (self0._entryId !== entryId) return;
          console.warn("kia-access-card: could not fetch map keys from the integration", e);
          self0._fetchedKeys = {};
        });
    }

    getCardSize() { return 8; }

    static getStubConfig() { return { entity: "" }; }

    disconnectedCallback() {
      clearTimeout(this._flashT);
    }

    // Which vehicle's raw sensor this card instance shows. An explicit
    // `entity:` in the card config always wins (unchanged "one card per
    // vehicle" behaviour, and the only supported way to pin a specific
    // vehicle when more than one Kia Access ACCOUNT is configured -- see
    // the account-scoping note below). Otherwise: keep whatever's already
    // selected if it's still a real vehicle on this account; else fall back
    // to the dashboard-wide last pick (shared across every auto-discovering
    // card, see VEHICLE_SEL_STORE); else the first vehicle alphabetically.
    // Single-vehicle accounts always resolve to that one entity, so nothing
    // about this changes behaviour for the common case.
    _activeEntityId(hass) {
      if (this._config && this._config.entity) return this._config.entity;
      var all = findAllRawEntities(hass);
      if (!all.length) return null;
      // More than one Kia Access ACCOUNT on this HA instance (not just more
      // than one vehicle) -- auto-discovery can't safely guess which one is
      // "yours" for this card, so refuse to merge them into one dropdown;
      // _render() shows a message asking for an explicit `entity:` instead.
      if (distinctAccounts(hass, all).length > 1) {
        this._multiAccount = true;
        return null;
      }
      this._multiAccount = false;
      if (this._selectedEntity && all.indexOf(this._selectedEntity) !== -1) {
        return this._selectedEntity;
      }
      var stored = loadSelectedVehicle();
      this._selectedEntity = (stored && all.indexOf(stored) !== -1) ? stored : all[0];
      return this._selectedEntity;
    }

    set hass(hass) {
      this._hass = hass;
      // HA sets `hass` on every state change anywhere — only re-render when the
      // vehicle entity we care about actually changed
      var entId = this._activeEntityId(hass);
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

    // Only the climate/charge start-vs-stop pairs: a stale command in one
    // of those, if it actually landed after all, produces a confusing state
    // transition (or an unwanted double-charge-stop racing a since-issued
    // start) -- lock/unlock/flash/etc. retrying twice is comparatively
    // harmless, so this deliberately isn't a blanket check on every command.
    _confirmIfUnconfirmed(key) {
      var STATEFUL = { start_climate: 1, stop_climate: 1, start_charge: 1, stop_charge: 1 };
      if (!STATEFUL[key]) return true;
      var u = (this._unconfirmedCommands || {})[key];
      if (!u) return true;
      var spec = CMD_BY_KEY[key] || {};
      return window.confirm(
        "Your last \"" + (spec.name || key) + "\" request timed out, and we don't know " +
        "if the car received it. Send it again anyway?"
      );
    }

    _callCommand(key, needsConfirm) {
      if (!this._hass || this._tooSoon(key)) return;
      var spec = CMD_BY_KEY[key] || {};
      if (needsConfirm &&
          !window.confirm((spec.name || key) + " — send this to the car?")) {
        return;
      }
      if (!this._confirmIfUnconfirmed(key)) return;
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
    // The card config's own range_map.api_key always wins; otherwise fall
    // back to whatever the integration's Options had (see
    // _maybeFetchMapKeys() -- still null on the very first render, before
    // that websocket call resolves).
    _mapApiKey() {
      var cfg = this._config.range_map;
      if (!cfg) return null;
      return cfg.api_key || (this._fetchedKeys && this._fetchedKeys.api_key) || null;
    }
    _mapTomtomKey() {
      var cfg = this._config.range_map;
      if (!cfg) return null;
      return cfg.tomtom_key || (this._fetchedKeys && this._fetchedKeys.tomtom_key) || null;
    }
    // A pure EV has no fuel tank at all -- hyundai_kia_connect_api's own
    // Kia-USA parsing falls back to the vehicle's plain distanceToEmpty
    // reading for fuel_driving_range whenever there's no real gasModeRange
    // (true for every BEV), which is the SAME figure total_driving_range/
    // ev_driving_range already report -- not a second, genuinely distinct
    // "fuel range" at all. Symmetrically, a pure ICE vehicle has no drive
    // battery, so ev_driving_range is never real information for it either.
    // total_driving_range is already the API's own powertrain-agnostic
    // combined figure (equal to ev_driving_range for a BEV, equal to
    // fuel_driving_range for pure ICE, genuinely the SUM for a PHEV/HEV)
    // and always stays shown -- these rows are hidden only where they'd
    // just be duplicating it under a misleading label; for a PHEV/HEV they
    // stay visible since there both readings are real, distinct
    // information alongside the combined total.
    static _hidePowertrainRow(key, engineType) {
      if ((key === "fuel_driving_range" || key === "fuel_level" || key === "fuel_level_is_low") &&
          engineType === "EV") return true;
      if (key === "ev_driving_range" && engineType === "ICE") return true;
      return false;
    }

    // Whether the details table shows a given row: `rowFilter` (from the
    // card's own `rows:` config, or null when unset) is an explicit
    // allow-list checked first, then the powertrain-based hide rule above
    // -- either one can hide a row, neither one can force a row that's
    // genuinely absent from the vehicle's own data (that's handled by the
    // caller's own `raw === undefined` check before this is ever asked).
    static _rowVisible(key, rowFilter, engineType) {
      if (rowFilter && rowFilter.indexOf(key) === -1) return false;
      if (KiaAccessCard._hidePowertrainRow(key, engineType)) return false;
      return true;
    }

    _rangeInputs(flat) {
      if (!this._config.range_map) return null;
      this._maybeFetchMapKeys();
      if (!RNG || !this._mapApiKey()) return null;
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
      var apiKey = this._mapApiKey();
      var tomtomKey = this._mapTomtomKey();
      if (!apiKey || !ISO || !RNG || !inp || typeof fetch !== "function") return;
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
            return fetch(ISO.isoUrl({ apiKey: apiKey, lat: inp.lat, lon: inp.lon, rangesKm: [km], mode: mode }))
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
        if (tomtomKey) {
          return fetch(ISO.tomtomUrl({ apiKey: tomtomKey, lat: inp.lat, lon: inp.lon, distanceKm: km, mode: mode }))
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
            apiKey: apiKey,
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

    // set_temp's native unit/bounds for THIS vehicle (region-derived), not
    // the dashboard's display preference -- see climTempBounds() above
    _climBounds() {
      return climTempBounds(this._region);
    }

    _clim() {
      if (!this._climState) this._climState = loadClim(this._climBounds());
      return this._climState;
    }

    // re-render only the climate panel, keeping its scroll / focus context light
    _climRefresh() {
      var panel = this._root && this._root.querySelector(".ka-clim");
      if (!panel) { this._sig = null; this._render(); return; }
      var host = panel.closest(".ka-group");
      host.outerHTML = climateHtml(this._clim(), this._tempUnit(), this._climBounds());
      this._wireClimate();
    }

    _climStep(id, dir) {
      var c = this._clim();
      var bounds = this._climBounds();
      if (id === "temp") {
        if (this._tempUnit() !== (bounds.fahrenheit ? "F" : "C")) {
          // stepping happens in the DISPLAY unit's whole degrees, then
          // converts back to the vehicle's native storage/dispatch unit
          var displayF = this._tempUnit() === "F";
          var next = Math.round(convertTemp(c.temp, bounds.fahrenheit, displayF)) + dir;
          c.temp = clamp(
            Math.round(convertTemp(next, displayF, bounds.fahrenheit) * 2) / 2,
            bounds.min, bounds.max
          );
        } else {
          c.temp = clamp(c.temp + dir * bounds.step, bounds.min, bounds.max);
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
      if (!this._confirmIfUnconfirmed("start_climate")) return;
      var c = this._clim();
      var bounds = this._climBounds();
      var data = {
        // always the vehicle's own native unit -- matches what
        // coordinator.py's build_climate_options() sends for the native
        // climate entity, and what commands.json's `metric` variant expects
        set_temp: c.temp,
        duration: c.duration,
        climate: true,
        defrost: !!c.defrost,
        heating: c.rearDefrost ? 1 : 0,
        steering_wheel: c.wheel ? 2 : 0
      };
      if (this._entryId) data.entry_id = this._entryId;
      var displayF = this._tempUnit() === "F";
      var shown = Math.round(convertTemp(c.temp, bounds.fahrenheit, displayF)) +
        (displayF ? " °F" : " °C");
      this._hass.callService("kia_access", "start_climate", data);
      this._climNote("Starting climate at " + shown + " for " + c.duration + " min…");
    }

    _stopClimate() {
      if (!this._hass || this._tooSoon("stop_climate")) return;
      if (!this._confirmIfUnconfirmed("stop_climate")) return;
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
        var rawRadius = Number(zone.attributes.radius);
        var radiusKm = (isFinite(rawRadius) ? rawRadius : 100) / 1000;
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

      var entId = this._activeEntityId(hass);
      if (!entId || !hass.states[entId]) {
        var msg = this._multiAccount
          ? "Kia Access: more than one Kia Access account is set up on this " +
            "Home Assistant instance, so this card can't guess which one's " +
            "vehicle to show. Set <code>entity:</code> to its summary sensor."
          : "Kia Access: no vehicle entity found. Add the integration, or " +
            "set <code>entity:</code> to its summary sensor.";
        root.innerHTML =
          "<ha-card><div class='ka-wrap'>" + msg + "</div></ha-card><style>" + STYLE + "</style>";
        return;
      }

      var st = hass.states[entId];
      this._entryId = st.attributes.entry_id || null;
      this._region = st.attributes.region || "USA";
      var flat = S.flatFromAttributes(st.attributes);
      var state = S.buildState(flat, {});
      this._updateHomeAndMoveTracking(state);
      if (C) {
        try {
          // prev must persist across renders (not a fresh {} each time) --
          // otherwise every hysteresis dead-band and one-shot charge event
          // in conditions.js silently breaks on this surface only. Mirrors
          // MMM-KiaAccess.js's this.prevCond / coordinator.py's _prev_cond.
          this._prevCond = this._prevCond || {};
          var cres = C.evaluate(state, {}, this._prevCond);
          state.critical = cres.conditions.some(function (c) {
            return c.level === "critical" && c.active === true;
          });
          state.alerts = V.alertLabels ? V.alertLabels(cres.conditions) : [];
          cres.conditions.forEach(function (c) {
            if (c.active !== null) this._prevCond[c.reason] = c.active;
          }, this);
          this._prevCond._charging = cres.meta.charging;
        } catch (e) { /* ignore */ }
      }
      state.flashing = this._flashing === true;
      // state.powertrain/state.fuelPct (already set by buildState() above)
      // pick which centre cell(s) carDiagram() draws -- a plain drive
      // battery (EV, and the default for an unset/unrecognised engine_type,
      // matching this module's original EV-only behaviour), a single fuel
      // tank (ICE), or both side by side (PHEV/HEV). This used to
      // re-derive both from `flat` locally instead of reading buildState()'s
      // own already-correct fields -- same logic maintained twice, with its
      // own copy of the engine_type mapping comment, in the same file.
      // the API reports temperatures in °C; the diagram and the climate panel
      // share one unit choice (card config, else the HA unit system)
      var diagram = V.carDiagram(state, {
        width: 230, battery: true, tempUnit: this._tempUnit(),
        powertrain: state.powertrain
      });

      var name = st.attributes.vehicle_name || st.attributes.friendly_name || "Kia";
      var updated = st.state && st.state !== "unknown" && st.state !== "unavailable"
        ? "Updated " + relTime(st.state) : "";

      // Vehicle selector: only when this card auto-discovers (no explicit
      // `entity:` pinned) AND the account actually has more than one
      // vehicle -- a single-vehicle account, or a card pinned to one
      // vehicle, sees the plain name exactly as before, no dropdown.
      var allVehicles = (this._config && this._config.entity)
        ? [entId] : findAllRawEntities(hass);
      var vehicleSelectHtml = "";
      if (allVehicles.length > 1) {
        var vOpts = allVehicles.map(function (id) {
          var vst = hass.states[id];
          var vname = (vst && vst.attributes &&
            (vst.attributes.vehicle_name || vst.attributes.friendly_name)) || id;
          return "<option value='" + esc(id) + "'" +
            (id === entId ? " selected" : "") + ">" + esc(vname) + "</option>";
        }).join("");
        vehicleSelectHtml = "<select class='ka-vehicle-select' aria-label='Vehicle'>" +
          vOpts + "</select>";
      }

      // "Refresh now" icon next to the name/updated line -- only shown when
      // the integration is new enough to have registered the button entity
      this._refreshEntity = entId.replace(/^sensor\./, "button.").replace(/_status$/, "_refresh_now");
      var refreshBtnHtml = hass.states[this._refreshEntity]
        ? "<button type='button' class='ka-refresh" + (this._refreshing ? " spinning" : "") +
          "' data-refresh title='Refresh now' aria-label='Refresh now'>" +
          "<ha-icon icon='mdi:refresh'></ha-icon></button>"
        : "";

      // "Remote action" sensor's unconfirmed_commands attribute: a prior
      // start_climate/stop_climate/start_charge/stop_charge whose request
      // timed out -- Kia's protocol gives no way to know afterward whether
      // it reached the vehicle, so _callCommand()/_startClimate()/
      // _stopClimate() ask before sending a second one on top of it.
      var actionEntity = entId.replace(/_status$/, "_remote_action");
      var actionSt = hass.states[actionEntity];
      this._unconfirmedCommands =
        (actionSt && actionSt.attributes && actionSt.attributes.unconfirmed_commands) || {};

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
      var engineType = String(flat["vehicle.engine_type"] || "").toUpperCase();
      // `rows:` in the card config is an explicit allow-list of entity
      // `key` values (see core/entities.json) -- unset (the default)
      // shows every populated field, exactly as before this option
      // existed. An empty array is a deliberate "hide the whole table",
      // not the same as unset -- checked with Array.isArray, not truthiness.
      var rowFilter = Array.isArray(this._config.rows) ? this._config.rows : null;
      var rows = CATALOGUE.map(function (e) {
        var raw = flat["vehicle." + e.key];
        if (raw === undefined) return "";
        if (!KiaAccessCard._rowVisible(e.key, rowFilter, engineType)) return "";
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
        "<div class='ka-name'>" + (vehicleSelectHtml || esc(name)) + "</div>" +
        "<div class='ka-sub'>" + esc(updated) + "</div>" +
        "</div>" + refreshBtnHtml +
        "</div>" +
        alertHtml + chipHtml + note +
        "</div></div>" +
        this._rangeMapSection(rmInp, hass) +
        "<div class='ka-actions'>" +
        climateHtml(this._clim(), this._tempUnit(), this._climBounds()) +
        actionsGroupsHtml(state.canPlugIn) +
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
      var vehicleSelect = root.querySelector(".ka-vehicle-select");
      if (vehicleSelect) {
        vehicleSelect.addEventListener("change", function () {
          card._selectedEntity = vehicleSelect.value;
          saveSelectedVehicle(vehicleSelect.value);
          card._sig = null;
          card._render();
        });
      }
      this._wireClimate();
    }
  }

  // exposed for tests -- both stay plain closures (not static methods)
  // since neither has any other reason to live on the class; this is just
  // a testable seam.
  KiaAccessCard._actionsGroupsHtml = actionsGroupsHtml;
  KiaAccessCard._climTempBounds = climTempBounds;

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
