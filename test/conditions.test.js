/* node test/conditions.test.js */
const assert = require("assert");
const C = require("../core/conditions.js");

const base = {}; // all fields undefined -> null / unknown

function find(res, reason) {
  return res.conditions.find((c) => c.reason === reason);
}

// --- battery threshold + hysteresis ---
let r = C.evaluate({ batteryPct: 12 }, {}, {});
assert.strictEqual(find(r, "ev_battery_low").active, true);

r = C.evaluate({ batteryPct: 22 }, {}, { ev_battery_low: true });
assert.strictEqual(find(r, "ev_battery_low").active, true, "holds in the 20-25 dead band");

r = C.evaluate({ batteryPct: 26 }, {}, { ev_battery_low: true });
assert.strictEqual(find(r, "ev_battery_low").active, false, "clears above clearPct");

r = C.evaluate({ batteryPct: 5 }, { checks: { evBatteryLow: { belowPct: 10, clearPct: 15 } } }, {});
assert.strictEqual(find(r, "ev_battery_low").active, true, "custom belowPct");
r = C.evaluate(
  { batteryPct: 12 },
  { checks: { evBatteryLow: { belowPct: 10, clearPct: 15 } } },
  {}
);
assert.strictEqual(find(r, "ev_battery_low").active, false, "dead band, no prev -> inactive");

// --- disable a check ---
r = C.evaluate({ batteryPct: 5 }, { checks: { evBatteryLow: false } }, {});
assert.strictEqual(find(r, "ev_battery_low"), undefined);

// --- unlocked, and quietWhileDriving ---
r = C.evaluate({ locked: false }, {}, {});
assert.strictEqual(find(r, "unlocked").active, true);
r = C.evaluate({ locked: false, carOn: true }, {}, {});
assert.strictEqual(find(r, "unlocked"), undefined, "muted while driving");
r = C.evaluate({ locked: false, carOn: true }, { quietWhileDriving: false }, {});
assert.strictEqual(find(r, "unlocked").active, true);

// --- doors: aggregate + message ---
r = C.evaluate({ doorFL: true, doorFR: false, doorRL: false, doorRR: false }, {}, {});
assert.strictEqual(find(r, "door_open").active, true);
assert.ok(/Front-left door is open/.test(find(r, "door_open").message));
r = C.evaluate({ doorFL: true, doorFR: true, doorRL: false, doorRR: false }, {}, {});
assert.ok(/2 doors are open/.test(find(r, "door_open").message));
r = C.evaluate({ doorFL: false, doorFR: false, doorRL: false, doorRR: false }, {}, {});
assert.strictEqual(find(r, "door_open").active, false);
r = C.evaluate({}, {}, {});
assert.strictEqual(find(r, "door_open").active, null, "unknown when no data");

// --- tyre pressure ---
r = C.evaluate({ tyreAny: true }, {}, {});
assert.strictEqual(find(r, "tyre_pressure").active, true);
r = C.evaluate({ tyreFL: true }, {}, {});
assert.ok(/Front-left/.test(find(r, "tyre_pressure").message));

// --- charge complete / interrupted (one-shot) ---
r = C.evaluate({ charging: false, batteryPct: 100, plugged: true, chargeLimitPct: 100 }, {}, { _charging: true });
assert.strictEqual(find(r, "charge_complete").active, true);
assert.strictEqual(find(r, "charge_complete").oneShot, true);

r = C.evaluate({ charging: false, batteryPct: 62, plugged: true, chargeLimitPct: 80 }, {}, { _charging: true });
assert.strictEqual(find(r, "charge_interrupted").active, true);
assert.strictEqual(find(r, "charge_complete").active, false);

// unplugged + stopped = neither
r = C.evaluate({ charging: false, batteryPct: 62, plugged: false, chargeLimitPct: 80 }, {}, { _charging: true });
assert.strictEqual(find(r, "charge_interrupted").active, false);
assert.strictEqual(find(r, "charge_complete").active, false);

// meta carries charging state for the next tick
r = C.evaluate({ charging: true }, {}, {});
assert.strictEqual(r.meta.charging, true);

// --- 12V drain while parked ---
const t = Date.now();
const drainHist = [
  { t: t - 11 * 3600e3, v12: 82, ev: 60 },
  { t: t - 1 * 3600e3, v12: 70, ev: 60 }
];
r = C.evaluate({ history: drainHist, carOn: false, charging: false, plugged: false }, {}, {});
assert.strictEqual(find(r, "battery_12v_drain").active, true);
// plugged in -> not a concern
r = C.evaluate({ history: drainHist, carOn: false, charging: false, plugged: true }, {}, {});
assert.strictEqual(find(r, "battery_12v_drain").active, null);
// small drop -> inactive
r = C.evaluate(
  { history: [{ t: t - 6 * 3600e3, v12: 71 }, { t, v12: 70 }], carOn: false, charging: false, plugged: false },
  {},
  {}
);
assert.strictEqual(find(r, "battery_12v_drain").active, false);

// --- OTP expiry ---
r = C.evaluate({ tokenAgeDays: 26, otpLifetimeDays: 30, otpWarnDays: 7 }, {}, {});
assert.strictEqual(find(r, "otp_expiring").active, true);
assert.ok(/expires in ~4 days/.test(find(r, "otp_expiring").message));
r = C.evaluate({ tokenAgeDays: 10, otpLifetimeDays: 30, otpWarnDays: 7 }, {}, {});
assert.strictEqual(find(r, "otp_expiring").active, false);
r = C.evaluate({ tokenAgeDays: null }, {}, {});
assert.strictEqual(find(r, "otp_expiring").active, null);

// --- charging started (one-shot) ---
r = C.evaluate({ charging: true, chargeKw: 7.4 }, {}, { _charging: false });
assert.strictEqual(find(r, "charging_started").active, true);
assert.ok(/7\.4 kW/.test(find(r, "charging_started").message));
r = C.evaluate({ charging: true }, {}, { _charging: true }); // already charging last tick
assert.strictEqual(find(r, "charging_started").active, false);

// --- service due ---
r = C.evaluate({ serviceKm: 600, units: "imperial" }, {}, {});
assert.strictEqual(find(r, "service_due").active, true);
assert.ok(/373 mi to go/.test(find(r, "service_due").message));
r = C.evaluate({ serviceKm: 4000 }, {}, {});
assert.strictEqual(find(r, "service_due").active, false);
r = C.evaluate({ serviceKm: -10, units: "metric" }, {}, {});
assert.ok(/overdue/.test(find(r, "service_due").message));
r = C.evaluate({ serviceKm: null }, {}, {});
assert.strictEqual(find(r, "service_due").active, null);

// --- home but not plugged in ---
r = C.evaluate({ atHome: true, plugged: false, homeUnpluggedMin: 30 }, {}, {});
assert.strictEqual(find(r, "not_plugged_home").active, true);
r = C.evaluate({ atHome: true, plugged: true, homeUnpluggedMin: null }, {}, {});
assert.strictEqual(find(r, "not_plugged_home").active, false);
r = C.evaluate({ atHome: true, plugged: false, homeUnpluggedMin: 5 }, {}, {}); // pre-grace
assert.strictEqual(find(r, "not_plugged_home").active, false);
r = C.evaluate({ atHome: true, plugged: false, homeUnpluggedMin: 5 }, {}, { not_plugged_home: true }); // hold
assert.strictEqual(find(r, "not_plugged_home").active, true);
r = C.evaluate({ plugged: false, homeUnpluggedMin: 60 }, {}, {}); // no atHome -> inert
assert.strictEqual(find(r, "not_plugged_home").active, false);
// time window
r = C.evaluate(
  { atHome: true, plugged: false, homeUnpluggedMin: 30 },
  { checks: { notPluggedInHome: { afterHour: 25 } } }, // impossible hour -> never in window
  {}
);
assert.strictEqual(find(r, "not_plugged_home").active, false);

// --- moved while parked (tow / theft) ---
r = C.evaluate({ movedWhileParkedKm: 1.2, movedWhileParkedMin: 5, carOn: false }, {}, {});
assert.strictEqual(find(r, "unexpected_move").active, true);
assert.ok(/moved 1 km/.test(find(r, "unexpected_move").message));
// sustained-minutes gate: far but only just started
r = C.evaluate({ movedWhileParkedKm: 1.2, movedWhileParkedMin: 1, carOn: false }, {}, {});
assert.strictEqual(find(r, "unexpected_move").active, false);
// being driven -> not a tow
r = C.evaluate({ movedWhileParkedKm: 5, movedWhileParkedMin: 30, carOn: true }, {}, {});
assert.strictEqual(find(r, "unexpected_move").active, false);
// no data -> inert
r = C.evaluate({}, {}, {});
assert.strictEqual(find(r, "unexpected_move").active, null);
// small jitter clears
r = C.evaluate({ movedWhileParkedKm: 0.1, carOn: false }, {}, { unexpected_move: true });
assert.strictEqual(find(r, "unexpected_move").active, false);

// --- can't get home ---
// 250 km range, 15% reserve -> 212 usable; home 200 km * 1.3 = 260 need -> short
r = C.evaluate({ atHome: false, homeDistanceKm: 200, rangeKm: 250 }, {}, {});
assert.strictEqual(find(r, "cant_get_home").active, true);
assert.strictEqual(find(r, "cant_get_home").level, "critical");
// plenty of range
r = C.evaluate({ atHome: false, homeDistanceKm: 40, rangeKm: 250 }, {}, {});
assert.strictEqual(find(r, "cant_get_home").active, false);
// tight but makes it -> warning level, holds in band
r = C.evaluate({ atHome: false, homeDistanceKm: 150, rangeKm: 250 }, {}, {});
const gh = find(r, "cant_get_home");
assert.strictEqual(gh.level, "warning");
// at home -> not evaluated
r = C.evaluate({ atHome: true, homeDistanceKm: 200, rangeKm: 50 }, {}, {});
assert.strictEqual(find(r, "cant_get_home"), undefined);
// away but no range data -> not evaluated
r = C.evaluate({ atHome: false, homeDistanceKm: 200 }, {}, {});
assert.strictEqual(find(r, "cant_get_home"), undefined);

console.log("all conditions tests passed");
