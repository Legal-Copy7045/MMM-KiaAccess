/* node test/conditions.test.js */
const assert = require("assert");
const C = require("../conditions.js");

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

console.log("all conditions tests passed");
