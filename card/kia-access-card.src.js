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
  var CATALOGUE = (self.KiaAccessEntities && self.KiaAccessEntities.entities) || [];
  var COMMANDS = (self.KiaAccessCommands && self.KiaAccessCommands.commands) || [];
  // one-tap buttons: the no-argument commands, plus start_climate (fires with
  // the catalogue defaults — a "warm the car up" tap). set_charge_limits and a
  // custom start_climate stay services only, since a stray tap would change
  // settings.
  var BUTTON_COMMANDS = COMMANDS.filter(function (c) {
    return !c.options || c.key === "start_climate";
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
    ".ka-diagram svg{max-width:230px;height:auto}" +
    ".ka-side{flex:1 1 160px;min-width:150px}" +
    ".ka-name{font-size:1.1em;font-weight:500}" +
    ".ka-sub{color:var(--secondary-text-color);font-size:.85em}" +
    ".ka-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}" +
    ".ka-chip{font-size:.75em;padding:2px 8px;border-radius:10px;background:var(--secondary-background-color);color:var(--secondary-text-color)}" +
    ".ka-chip.alert{background:var(--error-color);color:#fff}" +
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

  function fmt(key, value) {
    if (value === true || value === "true") return "Yes";
    if (value === false || value === "false") return "No";
    if (value == null || value === "" || value === "null") return "—";
    var u = UNIT[key];
    if (u && (typeof value === "number" || /^-?\d+(\.\d+)?$/.test(value))) {
      return (Math.round(Number(value) * 10) / 10) + " " + u;
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

  function actionsHtml() {
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
    return html ? "<div class='ka-actions'>" + html + "</div>" : "";
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

    _callCommand(key, needsConfirm) {
      if (!this._hass) return;
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
      if (C) {
        try {
          var cres = C.evaluate(state, {}, {});
          state.critical = cres.conditions.some(function (c) {
            return c.level === "critical" && c.active === true;
          });
        } catch (e) { /* ignore */ }
      }
      state.flashing = this._flashing === true;
      var diagram = V.carDiagram(state, { width: 230, battery: true });

      var name = st.attributes.vehicle_name || st.attributes.friendly_name || "Kia";
      var updated = st.state && st.state !== "unknown" && st.state !== "unavailable"
        ? "Updated " + relTime(st.state) : "";

      // status chips for the at-a-glance stuff
      var chips = [];
      if (state.critical) chips.push("<span class='ka-chip alert'>Check vehicle</span>");
      if (flat["vehicle.valet_mode_active"] === true) chips.push("<span class='ka-chip'>Valet</span>");
      if (flat["vehicle.ev_battery_precondition_enabled"] === true) chips.push("<span class='ka-chip'>Preconditioning</span>");
      var chipHtml = chips.length ? "<div class='ka-chips'>" + chips.join("") + "</div>" : "";

      var rows = CATALOGUE.map(function (e) {
        var raw = flat["vehicle." + e.key];
        if (raw === undefined) return "";
        return "<tr><td>" + esc(e.name) + "</td><td>" + esc(fmt(e.key, raw)) + "</td></tr>";
      }).join("");

      var note = st.attributes.note
        ? "<div class='ka-warn'>" + esc(st.attributes.note) + "</div>" : "";

      root.innerHTML =
        "<ha-card><div class='ka-wrap'><div class='ka-top'>" +
        "<div class='ka-diagram'>" + diagram + "</div>" +
        "<div class='ka-side'>" +
        "<div class='ka-name'>" + esc(name) + "</div>" +
        "<div class='ka-sub'>" + esc(updated) + "</div>" +
        chipHtml + note +
        "</div></div>" +
        actionsHtml() +
        "<table class='ka-table'>" + rows + "</table>" +
        "</div></ha-card><style>" + STYLE + "</style>";

      var card = this;
      root.querySelectorAll(".ka-btns button").forEach(function (b) {
        b.addEventListener("click", function () {
          card._callCommand(b.getAttribute("data-cmd"), b.getAttribute("data-confirm") === "1");
        });
      });
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
