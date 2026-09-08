/* Kia Access - Lovelace card.
 *
 * Renders the same top-down car diagram, battery gauge and widgets as the
 * MagicMirror module (shared core/visuals.js + core/state.js), plus a details
 * table and action buttons wired to the kia_access.* services.
 *
 * scripts/sync-core.js prepends core/state.js, core/visuals.js, the entity and
 * command catalogues, then this file. Globals available here:
 *   KiaAccessState.buildState, KiaAccessVisuals.*,
 *   KiaAccessEntities.entities, KiaAccessCommands.commands
 */
(function () {
  "use strict";

  var V = self.KiaAccessVisuals;
  var S = self.KiaAccessState;
  var C = self.KiaConditions;
  var CATALOGUE = (self.KiaAccessEntities && self.KiaAccessEntities.entities) || [];
  var COMMANDS = (self.KiaAccessCommands && self.KiaAccessCommands.commands) || [];
  var BUTTON_COMMANDS = COMMANDS.filter(function (c) { return !c.options; });

  var STYLE =
    ".ka-wrap{padding:12px 16px}" +
    ".ka-top{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}" +
    ".ka-diagram svg{max-width:230px;height:auto}" +
    ".ka-side{flex:1 1 160px;min-width:150px}" +
    ".ka-name{font-size:1.1em;font-weight:500}" +
    ".ka-sub{color:var(--secondary-text-color);font-size:.85em;margin-bottom:10px}" +
    ".ka-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}" +
    ".ka-btns button{background:var(--card-background-color);color:var(--primary-text-color);" +
    "border:1px solid var(--divider-color);border-radius:16px;padding:5px 12px;font-size:.85em;cursor:pointer}" +
    ".ka-btns button:hover{background:var(--secondary-background-color)}" +
    ".ka-table{width:100%;border-collapse:collapse;margin-top:12px;font-size:.9em}" +
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

  class KiaAccessCard extends HTMLElement {
    setConfig(config) {
      this._config = config || {};
      this._sig = null;
      if (!this._root) this._root = this.attachShadow({ mode: "open" });
      if (this._hass) { this.hass = this._hass; }
    }

    getCardSize() { return 7; }

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

    _callCommand(key) {
      if (!this._hass) return;
      var data = {};
      if (this._entryId) data.entry_id = this._entryId;
      this._hass.callService("kia_access", key, data);
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
      var diagram = V.carDiagram(state, { width: 230, battery: true });

      var name = st.attributes.vehicle_name || st.attributes.friendly_name || "Kia";
      var updated = st.state && st.state !== "unknown" && st.state !== "unavailable"
        ? "Updated " + relTime(st.state) : "";

      var rows = CATALOGUE.map(function (e) {
        var raw = flat["vehicle." + e.key];
        if (raw === undefined) return "";
        return "<tr><td>" + esc(e.name) + "</td><td>" + esc(fmt(e.key, raw)) + "</td></tr>";
      }).join("");

      var buttons = BUTTON_COMMANDS.map(function (c) {
        return "<button data-cmd='" + esc(c.key) + "'>" + esc(c.name) + "</button>";
      }).join("");

      var note = st.attributes.note
        ? "<div class='ka-warn'>" + esc(st.attributes.note) + "</div>" : "";

      root.innerHTML =
        "<ha-card><div class='ka-wrap'><div class='ka-top'>" +
        "<div class='ka-diagram'>" + diagram + "</div>" +
        "<div class='ka-side'>" +
        "<div class='ka-name'>" + esc(name) + "</div>" +
        "<div class='ka-sub'>" + esc(updated) + "</div>" +
        "<div class='ka-btns'>" + buttons + "</div>" + note +
        "</div></div>" +
        "<table class='ka-table'>" + rows + "</table>" +
        "</div></ha-card><style>" + STYLE + "</style>";

      var card = this;
      root.querySelectorAll(".ka-btns button").forEach(function (b) {
        b.addEventListener("click", function () {
          card._callCommand(b.getAttribute("data-cmd"));
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
