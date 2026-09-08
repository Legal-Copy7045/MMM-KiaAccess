/* Semantic vehicle conditions for MMM-KiaAccess.
 *
 * Pure function: turn a visualState()-style object into a list of named
 * conditions, each with an `active` flag. The frontend diffs `active` against
 * the previous tick and fires notifications only on a change (edge-triggered).
 *
 * No DOM / MagicMirror deps — unit-testable.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KiaConditions = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var CORNER = { FL: "Front-left", FR: "Front-right", RL: "Rear-left", RR: "Rear-right" };
  var CORNERS = ["FL", "FR", "RL", "RR"];

  function num(v) {
    if (v == null || v === "") return null; // Number(null) is 0 — guard it
    v = Number(v);
    return isFinite(v) ? v : null;
  }

  /** true if any corner is open, false if all are explicitly closed, null if unknown */
  function anyOpen(s, prefix) {
    var vals = CORNERS.map(function (c) { return s[prefix + c]; });
    if (vals.some(function (v) { return v === true; })) return true;
    if (vals.every(function (v) { return v === false; })) return false;
    return null;
  }
  function openList(s, prefix) {
    return CORNERS.filter(function (c) { return s[prefix + c] === true; });
  }
  function triState(v) {
    return v === true ? true : v === false ? false : null;
  }

  // built-in per-check config; user config is merged over this per key
  var CHECK_DEFAULTS = {
    evBatteryLow: { enabled: true, level: "warning", belowPct: 20, clearPct: 25 },
    battery12vLow: { enabled: true, level: "warning", belowPct: 55, clearPct: 60 },
    battery12vDrain: { enabled: true, level: "warning", dropPct: 8, overHours: 12 },
    otpExpiring: { enabled: true, level: "warning" }, // lifetimeDays / warnDays fall back to config
    unlocked: { enabled: true, level: "warning" },
    doorOpen: { enabled: true, level: "warning" },
    windowOpen: { enabled: true, level: "info" },
    hoodOpen: { enabled: true, level: "warning" },
    liftgateOpen: { enabled: true, level: "warning" },
    sunroofOpen: { enabled: true, level: "info" },
    tyrePressure: { enabled: true, level: "critical" },
    chargeComplete: { enabled: true, level: "info", targetPct: null },
    chargeInterrupted: { enabled: true, level: "warning", targetPct: null, minGapPct: 3 }
  };

  var DEFAULTS = {
    title: "Kia EV9",
    quietWhileDriving: true,
    checks: {}
  };

  function checkCfg(cfg, name) {
    var d = CHECK_DEFAULTS[name] || { enabled: true, level: "warning" };
    var u = (cfg.checks || {})[name];
    if (u === false) return { enabled: false };
    if (u === true || u == null) return Object.assign({}, d);
    return Object.assign({}, d, u);
  }

  /**
   * @param {object} s      visualState()-style object (see MMM-KiaAccess.js)
   * @param {object} cfg    config.notifications
   * @param {object} prev   { <reason>: bool, _charging: bool|null } from last tick
   * @returns {{conditions: Array, meta: {charging: (bool|null)}}}
   */
  function evaluate(s, cfg, prev) {
    s = s || {};
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    prev = prev || {};
    var title = cfg.title || DEFAULTS.title;
    var driving = cfg.quietWhileDriving !== false && s.carOn === true;
    var out = [];

    function emit(reason, level, active, message, value, oneShot) {
      out.push({
        reason: reason,
        level: level || "warning",
        active: active,
        oneShot: oneShot === true,
        title: title,
        message: message,
        value: value || {}
      });
    }

    // ---- battery thresholds (with hysteresis dead-band) ----
    function threshold(reason, cur, c, label) {
      if (!c.enabled) return;
      if (cur == null) {
        emit(reason, c.level, null, label + " level unknown", {});
        return;
      }
      var below = num(c.belowPct);
      var clear = c.clearPct != null ? num(c.clearPct) : below;
      var active;
      if (below == null) active = null;
      else if (cur <= below) active = true;
      else if (cur >= clear) active = false;
      else active = prev[reason] === true; // hold previous state in the band
      emit(reason, c.level, active, label + " low — " + Math.round(cur) + "%", {
        pct: cur,
        threshold: below
      });
    }
    threshold("ev_battery_low", num(s.batteryPct), checkCfg(cfg, "evBatteryLow"), "EV battery");
    threshold("battery_12v_low", num(s.car12vPct), checkCfg(cfg, "battery12vLow"), "12V battery");

    // ---- 12V draining while parked ----
    var cVD = checkCfg(cfg, "battery12vDrain");
    if (cVD.enabled) {
      var parked = s.carOn !== true && s.charging !== true && s.plugged !== true;
      var overMs = (num(cVD.overHours) || 12) * 3600e3;
      var drop = num(cVD.dropPct) || 8;
      var recent = (s.history || [])
        .filter(function (h) {
          return h && num(h.v12) != null && Date.now() - h.t <= overMs;
        })
        .sort(function (a, b) { return a.t - b.t; });
      var delta = recent.length >= 2 ? num(recent[0].v12) - num(recent[recent.length - 1].v12) : null;
      var vdActive;
      if (!parked || delta == null) vdActive = prev.battery_12v_drain === true ? false : null;
      else if (delta >= drop) vdActive = true;
      else if (delta <= drop / 2) vdActive = false;
      else vdActive = prev.battery_12v_drain === true;
      emit("battery_12v_drain", cVD.level, vdActive,
        delta != null
          ? "12V battery down " + Math.round(delta) + "% while parked"
          : "12V battery trend",
        { dropPct: delta != null ? Math.round(delta) : null, overHours: num(cVD.overHours) || 12 });
    }

    // ---- OTP / refresh-token expiry warning ----
    var cO = checkCfg(cfg, "otpExpiring");
    if (cO.enabled) {
      var age = num(s.tokenAgeDays);
      var life = num(cO.lifetimeDays) != null ? num(cO.lifetimeDays) : num(s.otpLifetimeDays) || 30;
      var warn = num(cO.warnDays) != null ? num(cO.warnDays) : num(s.otpWarnDays) || 7;
      if (age == null) {
        emit("otp_expiring", cO.level, null, "OTP age unknown");
      } else {
        var remaining = Math.max(0, Math.ceil(life - age));
        emit("otp_expiring", cO.level, life - age <= warn,
          remaining > 0
            ? "OTP enrolment expires in ~" + remaining + " day" + (remaining === 1 ? "" : "s")
            : "OTP enrolment has likely expired — re-run enroll.py",
          { remainingDays: remaining, ageDays: Math.round(age) });
      }
    }

    // ---- unlocked ----
    var cU = checkCfg(cfg, "unlocked");
    if (cU.enabled && !driving) {
      emit("unlocked", cU.level, triState(s.locked === false ? true : s.locked === true ? false : null),
        "Vehicle is unlocked");
    }

    // ---- open parts ----
    function openBool(reason, cKey, message, raw) {
      var c = checkCfg(cfg, cKey);
      if (!c.enabled || driving) return;
      emit(reason, c.level, triState(raw), message);
    }
    var cD = checkCfg(cfg, "doorOpen");
    if (cD.enabled && !driving) {
      var doors = openList(s, "door");
      emit("door_open", cD.level, anyOpen(s, "door"),
        doors.length === 1
          ? CORNER[doors[0]] + " door is open"
          : doors.length > 1
          ? doors.length + " doors are open"
          : "Doors closed",
        { corners: doors });
    }
    var cW = checkCfg(cfg, "windowOpen");
    if (cW.enabled && !driving) {
      var wins = openList(s, "win");
      emit("window_open", cW.level, anyOpen(s, "win"),
        wins.length === 1
          ? CORNER[wins[0]] + " window is open"
          : wins.length > 1
          ? wins.length + " windows are open"
          : "Windows closed",
        { corners: wins });
    }
    openBool("hood_open", "hoodOpen", "Hood (frunk) is open", s.hood);
    openBool("liftgate_open", "liftgateOpen", "Liftgate is open", s.trunk);
    openBool("sunroof_open", "sunroofOpen", "Sunroof is open", s.sunroof);

    // ---- tyre pressure ----
    var cT = checkCfg(cfg, "tyrePressure");
    if (cT.enabled) {
      var tyres = CORNERS.filter(function (c) { return s["tyre" + c] === true; });
      var tActive;
      if (s.tyreAny === true || tyres.length > 0) tActive = true;
      else if (s.tyreAny === false && CORNERS.every(function (c) { return s["tyre" + c] !== true; }))
        tActive = false;
      else tActive = null;
      emit("tyre_pressure", cT.level, tActive,
        tActive === true
          ? tyres.length
            ? "Low tyre pressure — " + tyres.map(function (c) { return CORNER[c]; }).join(", ")
            : "Tyre pressure warning"
          : "Tyre pressure OK",
        { corners: tyres });
    }

    // ---- charging complete / interrupted (one-shot events) ----
    var wasCharging = prev._charging === true;
    var stoppedNow = wasCharging && s.charging === false;
    var soc = num(s.batteryPct);

    var cC = checkCfg(cfg, "chargeComplete");
    if (cC.enabled) {
      var targetC = num(cC.targetPct);
      if (targetC == null) targetC = num(s.chargeLimitPct);
      if (targetC == null) targetC = 95;
      var complete = stoppedNow && soc != null && soc >= targetC - 1;
      emit("charge_complete", cC.level, complete ? true : false,
        "Charging complete" + (soc != null ? " — " + Math.round(soc) + "%" : ""),
        { pct: soc, target: targetC }, true);
    }
    var cI = checkCfg(cfg, "chargeInterrupted");
    if (cI.enabled) {
      var targetI = num(cI.targetPct);
      if (targetI == null) targetI = num(s.chargeLimitPct);
      if (targetI == null) targetI = 95;
      var gap = cI.minGapPct != null ? num(cI.minGapPct) : 3;
      var interrupted =
        stoppedNow && s.plugged === true && soc != null && soc < targetI - gap;
      emit("charge_interrupted", cI.level, interrupted ? true : false,
        "Charging stopped early" + (soc != null ? " — " + Math.round(soc) + "%" : ""),
        { pct: soc, target: targetI }, true);
    }

    return { conditions: out, meta: { charging: triState(s.charging) } };
  }

  return { evaluate: evaluate, CHECK_DEFAULTS: CHECK_DEFAULTS, DEFAULTS: DEFAULTS };
});
