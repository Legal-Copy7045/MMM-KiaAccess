/* Canonical vehicle-state builder for MMM-KiaAccess / the HA card.
 *
 * buildState(flat, opts) turns a flat map of `vehicle.*` values (as produced by
 * flatten.js over the bridge payload) into the normalised object consumed by
 * visuals.carDiagram() and conditions.evaluate(). Pure — no `this`, no DOM — so
 * MagicMirror, the Home Assistant Lovelace card, and the contract tests all run
 * the identical logic.
 *
 *   flat  : { "vehicle.ev_battery_percentage": 63, "_meta.tokenEnrolledAt": "...", ... }
 *   opts  : { history: [{t,ev,v12}], otpLifetimeDays: 30, otpWarnDays: 7 }
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KiaAccessState = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function buildState(flat, opts) {
    var f = flat || {};
    opts = opts || {};

    var bool = function (k) {
      var v = f["vehicle." + k];
      if (v === true || v === "true" || v === 1 || v === "1") return true;
      if (v === false || v === "false" || v === 0 || v === "0") return false;
      return null;
    };
    var num = function (k) {
      var raw = f["vehicle." + k];
      if (raw == null || raw === "") return null; // Number(null) is 0 — guard it
      var v = Number(raw);
      return isFinite(v) ? v : null;
    };
    var anyTrue = function () {
      var vals = [].slice.call(arguments).map(bool);
      if (vals.some(function (v) { return v === true; })) return true;
      if (vals.every(function (v) { return v === false; })) return false;
      return null;
    };

    var hs = f["vehicle.headlamp_status"];
    var headlights = anyTrue(
      "headlamp_left_low",
      "headlamp_right_low",
      "headlamp_left_high",
      "headlamp_right_high",
      "headlamp_left_bifunc",
      "headlamp_right_bifunc"
    );
    if (headlights == null && typeof hs === "string") {
      var t = hs.trim().toLowerCase();
      headlights = t && t !== "off" && t !== "none" && t !== "0" ? true : false;
    }

    var airTempC = num("air_temperature");       // climate set-point
    var outsideTempC = num("outside_temperature");
    var climate = (function () {
      if (bool("air_control_is_on") !== true) return null;
      if (airTempC != null && outsideTempC != null) {
        if (airTempC - outsideTempC >= 1) return "heat";
        if (outsideTempC - airTempC >= 1) return "cool";
      }
      return "on";
    })();

    var chargeLimitPct = (function () {
      var ac = num("ev_charge_limits_ac");
      var dc = num("ev_charge_limits_dc");
      var vals = [ac, dc].filter(function (v) { return v != null && v > 0; });
      return vals.length ? Math.max.apply(Math, vals) : null;
    })();

    var tokenAgeDays = (function () {
      var ts = f["_meta.tokenEnrolledAt"];
      if (!ts) return null;
      var ms = Date.now() - new Date(ts).getTime();
      return isFinite(ms) && ms >= 0 ? ms / 864e5 : null;
    })();

    // genuine fault lamps the car reports (only those that exist AND are on).
    // washer fluid / key-fob battery are deliberately not here — not "critical".
    var FAULTS = [
      ["brake_oil_warning_is_on", "Brake fluid low"],
      ["brake_fluid_warning_is_on", "Brake fluid low"],
      ["breaking_oil_warning_is_on", "Brake fluid low"],
      ["battery_auxiliary_fail_warning_is_on", "12V battery system fault"],
      ["air_bag_warning_is_on", "Airbag warning"],
      ["srs_warning_is_on", "Airbag (SRS) warning"],
      ["abs_warning_is_on", "ABS fault"],
      ["esc_warning_is_on", "Stability control fault"],
      ["engine_oil_warning_is_on", "Engine oil warning"],
      ["break_pad_warning_is_on", "Brake pad wear"],
      ["brake_pad_warning_is_on", "Brake pad wear"]
    ];
    var faults = [];
    var faultSeen = {};
    FAULTS.forEach(function (row) {
      if (bool(row[0]) === true && !faultSeen[row[1]]) {
        faultSeen[row[1]] = true;
        faults.push(row[1]);
      }
    });

    return {
      batteryPct: num("ev_battery_percentage"),
      rangeKm: num("ev_driving_range"),
      chargeKw: num("ev_charging_power"),
      chargeEtaMin: num("ev_estimated_current_charge_duration"),
      charging: bool("ev_battery_is_charging"),
      plugged: bool("ev_battery_is_plugged_in"),
      v2l: bool("ev_v2l_status"),
      v2x: bool("ev_v2x_status"),
      locked: bool("is_locked"),
      carOn: anyTrue("engine_is_running", "accessory_on", "ign3", "remote_ignition"),
      headlights: headlights,
      doorFL: bool("front_left_door_is_open"),
      doorFR: bool("front_right_door_is_open"),
      doorRL: bool("back_left_door_is_open"),
      doorRR: bool("back_right_door_is_open"),
      winFL: bool("front_left_window_is_open"),
      winFR: bool("front_right_window_is_open"),
      winRL: bool("back_left_window_is_open"),
      winRR: bool("back_right_window_is_open"),
      hood: bool("hood_is_open"),
      trunk: bool("trunk_is_open"),
      sunroof: bool("sunroof_is_open"),
      defrost: bool("defrost_is_on"),
      rearHeat: bool("back_window_heater_is_on"),
      mirrorHeat: bool("side_mirror_heater_is_on"),
      steerHeat: bool("steering_wheel_heater_is_on"),
      climate: climate,
      airTempC: airTempC,
      outsideTempC: outsideTempC,
      tyreAny: bool("tire_pressure_all_warning_is_on"),
      tyreFL: bool("tire_pressure_front_left_warning_is_on"),
      tyreFR: bool("tire_pressure_front_right_warning_is_on"),
      tyreRL: bool("tire_pressure_rear_left_warning_is_on"),
      tyreRR: bool("tire_pressure_rear_right_warning_is_on"),
      // extra fields used by conditions.js (not drawn)
      car12vPct: num("car_battery_percentage"),
      chargeLimitPct: chargeLimitPct,
      capacityKwh: num("ev_battery_capacity"),
      faults: faults, // [] = no fault lamps; names of any that are on
      history: opts.history || [],
      tokenAgeDays: tokenAgeDays,
      otpLifetimeDays: opts.otpLifetimeDays,
      otpWarnDays: opts.otpWarnDays
    };
  }

  return { buildState: buildState };
});
