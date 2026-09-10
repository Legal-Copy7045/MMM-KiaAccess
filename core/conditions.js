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
    evBatteryCritical: { enabled: true, level: "critical", belowPct: 8, clearPct: 12 },
    battery12vLow: { enabled: true, level: "warning", belowPct: 55, clearPct: 60 },
    battery12vCritical: { enabled: true, level: "critical", belowPct: 40, clearPct: 45 },
    battery12vDrain: { enabled: true, level: "warning", dropPct: 8, overHours: 12 },
    vehicleFault: { enabled: true, level: "critical" },
    otpExpiring: { enabled: true, level: "warning" }, // lifetimeDays / warnDays fall back to config
    // "amber" issues — worth knowing, safe to drive: locking, open panels, charging
    unlocked: { enabled: true, level: "warning" },
    doorOpen: { enabled: true, level: "warning" },
    windowOpen: { enabled: true, level: "warning" },
    hoodOpen: { enabled: true, level: "warning" },
    liftgateOpen: { enabled: true, level: "warning" },
    sunroofOpen: { enabled: true, level: "warning" },
    // "red" issues — the do-not-drive set
    tyrePressure: { enabled: true, level: "critical" },
    chargeComplete: { enabled: true, level: "info", targetPct: null },
    chargeInterrupted: { enabled: true, level: "warning", targetPct: null, minGapPct: 3 },
    chargingStarted: { enabled: true, level: "info" },
    serviceDue: { enabled: true, level: "warning", belowKm: 800 }, // ~500 mi
    // needs s.atHome from the caller (MM: visuals.location.homeLat/Lon;
    // HA: zone.home). afterHour/beforeHour null = any time.
    notPluggedInHome: {
      enabled: true, level: "warning", graceMin: 20, afterHour: null, beforeHour: null
    },
    // GPS moved while the odometer stayed put and the car was off (tow / theft)
    unexpectedMove: {
      enabled: true, level: "critical", thresholdKm: 0.5, sustainedMin: 3
    },
    // not enough range to drive home (only when away from home)
    cantGetHome: {
      enabled: true, level: "warning", reservePct: 15, roadFactor: 1.3,
      roundTrip: false, warnMarginPct: 25
    }
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
    threshold("ev_battery_critical", num(s.batteryPct), checkCfg(cfg, "evBatteryCritical"), "EV battery critically");
    threshold("battery_12v_low", num(s.car12vPct), checkCfg(cfg, "battery12vLow"), "12V battery");
    threshold("battery_12v_critical", num(s.car12vPct), checkCfg(cfg, "battery12vCritical"), "12V battery critically");

    // ---- vehicle fault lamps (brake fluid, 12V system, ABS, airbag, …) ----
    var cFault = checkCfg(cfg, "vehicleFault");
    if (cFault.enabled) {
      var faults = Array.isArray(s.faults) ? s.faults : null;
      var fActive = faults == null ? null : faults.length > 0;
      emit("vehicle_fault", cFault.level, fActive,
        fActive === true
          ? "Warning light: " + faults.join(", ")
          : "No fault lights",
        { faults: faults || [] });
    }

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

    // ---- charging started (one-shot: reassurance it plugged in OK) ----
    var cCS = checkCfg(cfg, "chargingStarted");
    if (cCS.enabled) {
      var startedNow = prev._charging !== true && s.charging === true;
      var kw = num(s.chargeKw);
      emit("charging_started", cCS.level, startedNow ? true : false,
        "Charging started" + (kw ? " — " + (Math.round(kw * 10) / 10) + " kW" : ""),
        { kw: kw, pct: soc }, true);
    }

    // ---- next service due ----
    var cSV = checkCfg(cfg, "serviceDue");
    if (cSV.enabled) {
      var svKm = num(s.serviceKm);
      var belowKm = num(cSV.belowKm) != null ? num(cSV.belowKm) : 800;
      var dueActive = svKm == null ? null : svKm <= belowKm;
      var dist = svKm == null
        ? null
        : s.units === "metric"
        ? Math.round(svKm) + " km"
        : Math.round(svKm * 0.621371) + " mi";
      emit("service_due", cSV.level, dueActive,
        dueActive !== true ? "Service not due"
          : svKm <= 0 ? "Service overdue"
          : "Service due — " + dist + " to go",
        { km: svKm, remaining: dist });
    }

    // ---- home but not plugged in ----
    // needs s.atHome (bool) + s.homeUnpluggedMin (minutes home+unplugged) from
    // the caller; inert when s.atHome isn't provided.
    var cHP = checkCfg(cfg, "notPluggedInHome");
    if (cHP.enabled && !driving) {
      var grace = num(cHP.graceMin) != null ? num(cHP.graceMin) : 20;
      var homeMin = num(s.homeUnpluggedMin);
      var hr = new Date().getHours();
      var inWindow =
        (cHP.afterHour == null || hr >= num(cHP.afterHour)) &&
        (cHP.beforeHour == null || hr < num(cHP.beforeHour));
      var hpActive;
      if (s.plugged === true || s.atHome !== true) hpActive = false;
      else if (homeMin != null && homeMin >= grace && inWindow) hpActive = true;
      else hpActive = prev.not_plugged_home === true; // home+unplugged, pre-grace: hold
      emit("not_plugged_home", cHP.level, hpActive,
        "Home and not plugged in",
        { minutesHome: homeMin });
    }

    // ---- moved while parked (tow / theft) ----
    // needs s.movedWhileParkedKm + s.movedWhileParkedMin from the caller: how
    // far the GPS has shifted, and for how long, while the odometer stayed put
    // and the car was off. Inert when not provided.
    var cMv = checkCfg(cfg, "unexpectedMove");
    if (cMv.enabled) {
      var mk = num(s.movedWhileParkedKm);
      var mmin = num(s.movedWhileParkedMin);
      var thr = num(cMv.thresholdKm) != null ? num(cMv.thresholdKm) : 0.5;
      var sustained = num(cMv.sustainedMin) != null ? num(cMv.sustainedMin) : 3;
      var mvActive;
      if (mk == null) mvActive = null;
      else if (s.carOn === true) mvActive = false; // being driven — not a tow
      else if (mk >= thr && (mmin == null || mmin >= sustained)) mvActive = true;
      else if (mk < thr / 2) mvActive = false;
      else mvActive = prev.unexpected_move === true;
      emit("unexpected_move", cMv.level, mvActive,
        mk != null && mk >= thr
          ? "Vehicle moved " +
            (mk >= 1 ? Math.round(mk) + " km" : Math.round(mk * 1000) + " m") +
            " while parked and off"
          : "Parked position steady",
        { movedKm: mk != null ? Math.round(mk * 100) / 100 : null });
    }

    // ---- not enough range to get home ----
    // needs s.atHome (false when away) + s.homeDistanceKm (car->home, km) +
    // s.rangeKm from the caller. Level escalates warning -> critical.
    var cGH = checkCfg(cfg, "cantGetHome");
    if (cGH.enabled && s.atHome === false) {
      var dHome = num(s.homeDistanceKm);
      var rng = num(s.rangeKm);
      if (dHome != null && rng != null && rng > 0) {
        var resv = num(cGH.reservePct) != null ? num(cGH.reservePct) : 15;
        var road = num(cGH.roadFactor) || 1.3;
        var usable = rng * (1 - resv / 100);
        if (cGH.roundTrip === true) usable = usable / 2;
        var need = dHome * road;
        var slack = usable - need;
        var warnAt = need * ((num(cGH.warnMarginPct) || 25) / 100);
        var ghActive;
        if (slack < 0) ghActive = true;
        else if (slack > warnAt) ghActive = false;
        else ghActive = prev.cant_get_home === true;
        emit("cant_get_home", slack < 0 ? "critical" : "warning", ghActive,
          slack < 0
            ? "Not enough range to get home — need ~" + Math.round(need) +
              " km, ~" + Math.round(usable) + " km usable"
            : "Range getting tight for the drive home — ~" + Math.round(slack) + " km slack",
          { homeKm: Math.round(dHome), usableKm: Math.round(usable), needKm: Math.round(need) });
      }
    }

    return { conditions: out, meta: { charging: triState(s.charging) } };
  }

  return { evaluate: evaluate, CHECK_DEFAULTS: CHECK_DEFAULTS, DEFAULTS: DEFAULTS };
});
