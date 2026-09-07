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
    glass: "#3a3d40",
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
    var mark =
      warn === true
        ? '<text x="' + (x + 6) + '" y="' + (y + 20) +
          '" text-anchor="middle" font-size="15" font-weight="700" fill="#fff">!</text>'
        : "";
    return (
      '<rect x="' + x + '" y="' + y + '" width="12" height="30" rx="5" fill="' + c +
      '" stroke="#000" stroke-width="0.5"/>' + mark
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
   * Top-down SUV status diagram — front at the top (direction of travel = up).
   * The canvas is a FIXED size in every state: the car body is always at the
   * same coordinates and pixel size; only the right-hand strip changes (a
   * charger + animated energy flow appear there when plugged in).
   * @param {object} s state flags (all bool|null): locked, doorFL, doorFR,
   *   doorRL, doorRR, hood, trunk, charging, plugged, v2l, v2x, headlights,
   *   tyreFL, tyreFR, tyreRL, tyreRR, tyreAny
   * @param {object} o { width, label }
   */
  function carDiagram(s, o) {
    s = s || {};
    o = o || {};
    var CARW = 200;
    var VBW = 236; // fixed canvas; car occupies x 0..200, charger strip x 176..228
    var unit = (o.width || 190) / CARW; // 1 user unit = constant px in every state
    var w = VBW * unit;

    var tyre = function (which) {
      return s["tyre" + which] === true || s.tyreAny === true;
    };

    var uid = "k" + Math.random().toString(36).slice(2, 8);
    var exporting = s.v2l === true || s.v2x === true;
    var plugged = s.charging === true || s.plugged === true || exporting;
    var flow =
      s.charging === true ? COL.ok : exporting ? COL.accent : COL.warn;

    var port =
      s.charging === true
        ? COL.ok
        : exporting
        ? COL.accent
        : s.plugged === true
        ? COL.warn
        : COL.dim;

    var bodyStroke =
      s.locked === true ? COL.ok : s.locked === false ? COL.bad : COL.outline;

    // ---- charger + cable + energy flow (right strip) ----
    var cableD = "M 162 274 C 186 274 190 250 202 252";
    var charger = "";
    if (plugged) {
      var live = s.charging === true || exporting;
      charger =
        '<path id="cbl' + uid + '" d="' + cableD + '" fill="none" stroke="' +
        (live ? flow : COL.dim) +
        '" stroke-width="3" stroke-linecap="round" opacity="0.55"/>' +
        '<rect x="200" y="228" width="28" height="48" rx="5" fill="#17181a" stroke="' +
        COL.outline + '" stroke-width="2"/>' +
        '<rect x="205" y="234" width="17" height="11" rx="2" fill="' + COL.glass + '"/>' +
        '<path d="M 216 249 l -6 9 h 5 l -3 8 l 8 -11 h -5 z" fill="' + COL.text +
        '" opacity="0.85"/>' +
        '<circle cx="205" cy="270" r="3" fill="' + flow + '">' +
        (live
          ? '<animate attributeName="opacity" values="0.3;1;0.3" dur="1.4s" repeatCount="indefinite"/>'
          : "") +
        "</circle>";
      if (live) {
        // charging = flow toward the car (keyPoints 1;0); exporting = away
        var kp = s.charging === true ? '1;0' : '0;1';
        for (var p = 0; p < 3; p++) {
          charger +=
            '<circle r="2.6" fill="' + flow + '"><animateMotion dur="1.4s" begin="' +
            (p * 0.47).toFixed(2) + 's" repeatCount="indefinite" keyPoints="' + kp +
            '" keyTimes="0;1" calcMode="linear"><mpath href="#cbl' + uid +
            '" xlink:href="#cbl' + uid + '"/></animateMotion></circle>';
        }
      }
    }
    var portRing =
      s.charging === true
        ? '<circle cx="155" cy="274" r="5" fill="none" stroke="' + COL.ok +
          '" stroke-width="2"><animate attributeName="r" values="4;13" dur="1.5s" repeatCount="indefinite"/>' +
          '<animate attributeName="opacity" values="0.75;0" dur="1.5s" repeatCount="indefinite"/></circle>'
        : "";

    // headlights: solid white when on, hollow outline when off/unknown
    var lampFill = s.headlights === true ? COL.text : "none";
    var lampStroke = s.headlights === true ? COL.text : COL.outline;
    var headlight = function (d) {
      return (
        '<path d="' + d + '" fill="' + lampFill + '" stroke="' + lampStroke +
        '" stroke-width="1.4"/>'
      );
    };

    return (
      '<svg class="kiaaccess-car" xmlns="http://www.w3.org/2000/svg" ' +
      'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + VBW + ' 330" width="' + w +
      '" role="img" aria-label="Vehicle status, front at top">' +
      // body (front nose rounded, rear squarer)
      '<path d="M 40 58 Q 40 22 74 22 L 126 22 Q 160 22 160 58 L 160 284 ' +
      'Q 160 304 140 304 L 60 304 Q 40 304 40 284 Z" fill="#1b1c1e" stroke="' +
      bodyStroke + '" stroke-width="3"/>' +
      // front grille bar
      '<rect x="78" y="24" width="44" height="7" rx="2" fill="' + COL.dim + '"/>' +
      // headlights (front corners)
      headlight("M 45 31 q 14 -8 25 -2 l -2 8 q -12 -5 -23 2 z") +
      headlight("M 155 31 q -14 -8 -25 -2 l 2 8 q 12 -5 23 2 z") +
      // taillight bar (rear)
      '<rect x="46" y="293" width="30" height="7" rx="2" fill="' + COL.bad + '" opacity="0.7"/>' +
      '<rect x="124" y="293" width="30" height="7" rx="2" fill="' + COL.bad + '" opacity="0.7"/>' +
      // raked windscreen + rear glass
      '<path d="M 56 92 L 144 92 L 130 66 Q 100 58 70 66 Z" fill="' + COL.glass + '"/>' +
      '<path d="M 58 246 L 142 246 L 136 272 Q 100 278 64 272 Z" fill="' + COL.glass + '"/>' +
      // roof + roof rails (SUV cue)
      '<rect x="56" y="94" width="88" height="150" rx="12" fill="#242628"/>' +
      '<rect x="58" y="96" width="3.5" height="146" rx="1.75" fill="' + COL.dim + '"/>' +
      '<rect x="138.5" y="96" width="3.5" height="146" rx="1.75" fill="' + COL.dim + '"/>' +
      // door mirrors (just aft of the windscreen base — a strong "front" cue)
      '<path d="M 40 98 l -9 3 l 3 7 l 6 -2 z" fill="' + COL.dim + '"/>' +
      '<path d="M 160 98 l 9 3 l -3 7 l -6 -2 z" fill="' + COL.dim + '"/>' +
      // frunk (small — it's tiny on the real car), fixed midway between the
      // number plate and the windscreen; no shift when open, just recolours
      panel(s.hood, 82, 38, 36, 14) +
      // full-width tailgate at the rear
      panel(s.trunk, 66, 278, 68, 20, [0, 8]) +
      // doors — centred in the gap between the front and rear wheels,
      // clear of the door mirrors
      panel(s.doorFL, 34, 112, 14, 42, [-8, 0]) +
      panel(s.doorRL, 34, 162, 14, 46, [-8, 0]) +
      panel(s.doorFR, 152, 112, 14, 42, [8, 0]) +
      panel(s.doorRR, 152, 162, 14, 46, [8, 0]) +
      // wheels — front axle well forward of the doors, larger tyres
      wheel(29, 60, tyre("FL")) +
      wheel(159, 60, tyre("FR")) +
      wheel(29, 230, tyre("RL")) +
      wheel(159, 230, tyre("RR")) +
      // charger + cable + energy flow (right strip; empty when unplugged)
      charger +
      // charge port — rear, passenger (right) side, between wheel and taillight
      '<rect x="148" y="266" width="14" height="16" rx="2" fill="#2a2c2e" stroke="' +
      COL.dim + '" stroke-width="1"/>' +
      portRing +
      '<circle cx="155" cy="274" r="4.2" fill="' + port + '"/>' +
      // centre lock + label
      lockGlyph(100, 150, s.locked) +
      (o.label
        ? '<text x="100" y="176" text-anchor="middle" font-size="12" fill="' +
          COL.dim + '">' + esc(o.label) + "</text>"
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
