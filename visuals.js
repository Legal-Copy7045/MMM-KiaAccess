/* Optional graphical widgets for MMM-KiaAccess.
 *
 * Pure functions that return SVG / markup strings — no DOM, no MagicMirror
 * deps — so they can be unit-tested and the frontend just drops the string
 * into an element's innerHTML.
 *
 * Everything is theme-agnostic: colours are explicit, backgrounds transparent.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.KiaAccessVisuals = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var COL = {
    outline: "#9aa0a6",
    dim: "#5f6368",
    ok: "#4caf50",
    warn: "#ffb300",
    bad: "#e53935",
    text: "#e8eaed",
    accent: "#4fc3f7"
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function batteryColor(pct) {
    if (pct == null || isNaN(pct)) return COL.dim;
    if (pct <= 15) return COL.bad;
    if (pct <= 40) return COL.warn;
    return COL.ok;
  }

  /**
   * Horizontal battery gauge — shows the charge % only. Any extra readouts
   * (range, charge rate, times to full) are rendered by the frontend as a
   * caption block underneath.
   * @param {number} pct 0..100 (null -> empty/unknown)
   * @param {object} o { charging, width }
   */
  function batteryGauge(pct, o) {
    o = o || {};
    var w = o.width || 210;
    var h = 50;
    var bx = 8,
      by = 8,
      bw = w - 34,
      bh = 34;
    var innerW = Math.max(0, Math.min(1, (Number(pct) || 0) / 100)) * (bw - 6);
    var col = batteryColor(pct);
    var label = pct == null || isNaN(pct) ? "—" : Math.round(pct) + "%";

    var bolt =
      o.charging === true
        ? '<path d="M ' +
          (bx + bw - 20) +
          " " +
          (by + 6) +
          " l -11 14 h 7 l -4 11 l 13 -16 h -8 z" +
          '" fill="' +
          COL.text +
          '" stroke="#000" stroke-width="0.5" opacity="0.95">' +
          '<animate attributeName="opacity" values="0.35;1;0.35" dur="1.6s" repeatCount="indefinite"/>' +
          "</path>"
        : "";

    return (
      '<svg class="kiaaccess-battery" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" width="' +
      w +
      '" role="img" aria-label="Battery ' +
      esc(label) +
      '">' +
      '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh +
      '" rx="6" fill="none" stroke="' + COL.outline + '" stroke-width="2"/>' +
      '<rect x="' + (bx + bw + 3) + '" y="' + (by + bh / 2 - 7) +
      '" width="7" height="14" rx="2" fill="' + COL.outline + '"/>' +
      '<rect x="' + (bx + 3) + '" y="' + (by + 3) + '" width="' + innerW + '" height="' + (bh - 6) +
      '" rx="3" fill="' + col + '"/>' +
      '<text x="' + (bx + bw / 2) + '" y="' + (by + bh / 2 + 6) +
      '" text-anchor="middle" font-size="18" font-weight="700" fill="' + COL.text +
      '" style="paint-order:stroke;stroke:#000;stroke-width:3px">' + esc(label) + "</text>" +
      bolt +
      "</svg>"
    );
  }

  function panel(open, x, y, w, h, dxdy) {
    var fill = open === true ? COL.bad : "none";
    var stroke = open === true ? COL.bad : COL.outline;
    var t =
      open === true && dxdy
        ? ' transform="translate(' + dxdy[0] + "," + dxdy[1] + ')"'
        : "";
    return (
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
      '" rx="3" fill="' + fill + '" fill-opacity="0.55" stroke="' + stroke +
      '" stroke-width="1.6"' + t + "/>"
    );
  }

  function wheel(x, y, warn) {
    var c = warn === true ? COL.bad : COL.dim;
    return (
      '<rect x="' + x + '" y="' + y + '" width="10" height="22" rx="4" fill="' + c +
      '" stroke="#000" stroke-width="0.5"/>'
    );
  }

  function lockGlyph(cx, cy, locked) {
    var col = locked === true ? COL.ok : locked === false ? COL.bad : COL.dim;
    var shackle =
      locked === true
        ? '<path d="M ' + (cx - 6) + " " + (cy - 3) + " v -5 a 6 6 0 0 1 12 0 v 5" +
          '" fill="none" stroke="' + col + '" stroke-width="2.4"/>'
        : '<path d="M ' + (cx - 6) + " " + (cy - 3) + " v -5 a 6 6 0 0 1 12 0" +
          '" fill="none" stroke="' + col + '" stroke-width="2.4"/>';
    return (
      shackle +
      '<rect x="' + (cx - 9) + '" y="' + (cy - 3) + '" width="18" height="14" rx="2.5" fill="' +
      col + '"/>'
    );
  }

  /**
   * Top-down car status diagram.
   * @param {object} s state flags (all bool|null): locked, doorFL, doorFR,
   *   doorRL, doorRR, hood, trunk, charging, plugged, tyreFL, tyreFR, tyreRL,
   *   tyreRR, tyreAny
   * @param {object} o { width, label }
   */
  function carDiagram(s, o) {
    s = s || {};
    o = o || {};
    var w = o.width || 190;
    var vb = 190;
    var vbh = 300;

    var tyre = function (which) {
      return s["tyre" + which] === true || s.tyreAny === true;
    };

    var port =
      s.charging === true
        ? COL.ok
        : s.plugged === true
        ? COL.warn
        : COL.dim;
    var portPulse =
      s.charging === true
        ? '<animate attributeName="r" values="5;8;5" dur="1.6s" repeatCount="indefinite"/>'
        : "";

    var bodyStroke =
      s.locked === true ? COL.ok : s.locked === false ? COL.bad : COL.outline;

    return (
      '<svg class="kiaaccess-car" viewBox="0 0 ' + vb + " " + vbh + '" width="' + w +
      '" role="img" aria-label="Vehicle status">' +
      // body
      '<rect x="30" y="18" width="130" height="264" rx="34" fill="#1b1c1e" stroke="' +
      bodyStroke + '" stroke-width="3"/>' +
      // windshield / rear glass
      '<path d="M 46 78 q 49 -26 98 0 v 4 q -49 -20 -98 0 z" fill="' + COL.dim + '" opacity="0.5"/>' +
      '<path d="M 48 226 q 47 22 94 0 v -4 q -47 18 -94 0 z" fill="' + COL.dim + '" opacity="0.5"/>' +
      // roof panel
      '<rect x="52" y="92" width="86" height="120" rx="18" fill="#242628"/>' +
      // hood + tailgate
      panel(s.hood, 60, 22, 70, 22, [0, -6]) +
      panel(s.trunk, 60, 256, 70, 22, [0, 6]) +
      // doors
      panel(s.doorFL, 24, 108, 16, 46, [-7, 0]) +
      panel(s.doorRL, 24, 160, 16, 46, [-7, 0]) +
      panel(s.doorFR, 150, 108, 16, 46, [7, 0]) +
      panel(s.doorRR, 150, 160, 16, 46, [7, 0]) +
      // wheels
      wheel(18, 70, tyre("FL")) +
      wheel(162, 70, tyre("FR")) +
      wheel(18, 210, tyre("RL")) +
      wheel(162, 210, tyre("RR")) +
      // charge port (front-left corner)
      '<circle cx="34" cy="60" r="5" fill="' + port + '">' + portPulse + "</circle>" +
      // centre lock
      lockGlyph(95, 150, s.locked) +
      // label
      (o.label
        ? '<text x="95" y="176" text-anchor="middle" font-size="12" fill="' + COL.dim + '">' +
          esc(o.label) + "</text>"
        : "") +
      "</svg>"
    );
  }

  // ---- row icons (Font Awesome 6, bundled with MagicMirror) ----

  var DEFAULT_ICONS = {
    "vehicle.ev_battery_percentage": "fa-solid fa-battery-half",
    "vehicle.ev_battery_soh_percentage": "fa-solid fa-heart-pulse",
    "vehicle.ev_battery_capacity": "fa-solid fa-car-battery",
    "vehicle.ev_battery_pack_voltage": "fa-solid fa-bolt-lightning",
    "vehicle.car_battery_percentage": "fa-solid fa-car-battery",
    "vehicle.ev_battery_is_plugged_in": "fa-solid fa-plug",
    "vehicle.ev_charge_port_door_is_open": "fa-solid fa-plug-circle-plus",
    "vehicle.ev_charging_power": "fa-solid fa-bolt",
    "vehicle.ev_charging_current": "fa-solid fa-bolt",
    "vehicle.ev_estimated_current_charge_duration": "fa-solid fa-hourglass-half",
    "vehicle.ev_estimated_fast_charge_duration": "fa-solid fa-gauge-high",
    "vehicle.ev_estimated_station_charge_duration": "fa-solid fa-charging-station",
    "vehicle.ev_estimated_portable_charge_duration": "fa-solid fa-suitcase-rolling",
    "vehicle.ev_v2l_status": "fa-solid fa-house-signal",
    "vehicle.ev_v2x_status": "fa-solid fa-plug-circle-bolt",
    "vehicle.ev_driving_range": "fa-solid fa-road",
    "vehicle.total_driving_range": "fa-solid fa-route",
    "vehicle.odometer": "fa-solid fa-gauge",
    "vehicle.is_locked": "fa-solid fa-lock",
    "vehicle.air_control_is_on": "fa-solid fa-fan",
    "vehicle.air_temperature": "fa-solid fa-temperature-half",
    "vehicle.outside_temperature": "fa-solid fa-cloud-sun",
    "vehicle.defrost_is_on": "fa-solid fa-snowflake",
    "vehicle.back_window_heater_is_on": "fa-solid fa-grip-lines",
    "vehicle.steering_wheel_heater_is_on": "fa-solid fa-circle-notch",
    "vehicle.tire_pressure_all_warning_is_on": "fa-solid fa-circle-exclamation",
    "vehicle.battery_auxiliary_fail_warning_is_on": "fa-solid fa-triangle-exclamation",
    "vehicle.smart_key_battery_warning_is_on": "fa-solid fa-key",
    "vehicle.engine_is_running": "fa-solid fa-power-off",
    "vehicle.accessory_on": "fa-solid fa-toggle-on",
    "vehicle.trunk_is_open": "fa-solid fa-car-rear",
    "vehicle.hood_is_open": "fa-solid fa-car",
    "vehicle.last_updated_at": "fa-solid fa-car-on",
    "vehicle.location_last_updated_at": "fa-solid fa-location-dot",
    "vehicle.geocode": "fa-solid fa-map-location-dot",
    "_meta.fetchedAt": "fa-solid fa-arrows-rotate"
  };

  var KEYWORD_ICONS = [
    [/door/, "fa-solid fa-car-side"],
    [/window/, "fa-solid fa-window-maximize"],
    [/tire|tyre/, "fa-solid fa-gauge-simple-high"],
    [/temp/, "fa-solid fa-temperature-half"],
    [/charg/, "fa-solid fa-bolt"],
    [/batter/, "fa-solid fa-battery-half"],
    [/lock/, "fa-solid fa-lock"],
    [/range/, "fa-solid fa-road"],
    [/seat/, "fa-solid fa-chair"],
    [/location|geocode|latitude|longitude/, "fa-solid fa-location-dot"],
    [/warning|fail/, "fa-solid fa-triangle-exclamation"],
    [/time|updated|duration/, "fa-solid fa-clock"]
  ];

  function iconFor(key, overrides) {
    if (overrides && overrides[key]) return overrides[key];
    if (DEFAULT_ICONS[key]) return DEFAULT_ICONS[key];
    var lk = String(key).toLowerCase();
    for (var i = 0; i < KEYWORD_ICONS.length; i++) {
      if (KEYWORD_ICONS[i][0].test(lk)) return KEYWORD_ICONS[i][1];
    }
    return null;
  }

  return {
    COL: COL,
    batteryGauge: batteryGauge,
    carDiagram: carDiagram,
    iconFor: iconFor,
    DEFAULT_ICONS: DEFAULT_ICONS
  };
});
