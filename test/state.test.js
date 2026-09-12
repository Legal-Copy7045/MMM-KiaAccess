/* node test/state.test.js */
const assert = require("assert");
const { buildState } = require("../core/state.js");
const entities = require("../core/entities.json");
const HA = require("../core/ha-discovery.js");

// entities.json is the catalogue ha-discovery generates from
assert.ok(Array.isArray(entities.entities) && entities.entities.length > 0);
assert.strictEqual(HA.SENSORS.length, entities.entities.length, "one discovery row per catalogue entry");
entities.entities.forEach((e) => {
  assert.ok(e.key && e.domain && e.name, "entity has key/domain/name: " + JSON.stringify(e));
  assert.ok(["sensor", "binary_sensor"].includes(e.domain));
});

// buildState: flat map -> normalised diagram/conditions state
const flat = {
  "vehicle.ev_battery_percentage": 63,
  "vehicle.ev_driving_range": 402,
  "vehicle.ev_battery_is_charging": "true",
  "vehicle.ev_battery_is_plugged_in": true,
  "vehicle.is_locked": "false",
  "vehicle.front_left_door_is_open": "true",
  "vehicle.air_control_is_on": "true",
  "vehicle.air_temperature": 21,
  "vehicle.outside_temperature": 4,
  "vehicle.ev_charge_limits_ac": 80,
  "vehicle.ev_charge_limits_dc": 100,
  "vehicle.car_battery_percentage": 71,
  "_meta.tokenEnrolledAt": new Date(Date.now() - 26 * 864e5).toISOString()
};
const s = buildState(flat, { history: [{ t: 1, ev: 60 }], otpLifetimeDays: 30, otpWarnDays: 7 });
assert.strictEqual(s.batteryPct, 63);
assert.strictEqual(s.rangeKm, 402);
assert.strictEqual(s.charging, true);
assert.strictEqual(s.plugged, true);
assert.strictEqual(s.locked, false);
assert.strictEqual(s.doorFL, true);
assert.strictEqual(s.doorFR, null, "unknown when absent");
assert.strictEqual(s.climate, "heat", "set 21 vs outside 4 -> heating");
assert.strictEqual(s.chargeLimitPct, 100, "max of ac/dc limits");
assert.strictEqual(s.car12vPct, 71);
assert.ok(s.tokenAgeDays > 25 && s.tokenAgeDays < 27);
assert.strictEqual(s.otpLifetimeDays, 30);
assert.deepStrictEqual(s.history, [{ t: 1, ev: 60 }]);

// bool(): some binary_sensor-shaped fields aren't strict 0/1 -- the EV9
// sends ev_battery_is_plugged_in as a connector-type code (seen live: 4
// while actively charging), not a boolean. Any nonzero number must read as
// true (0 stays false, weird strings stay unknown) -- this was a real bug:
// plugged came back null for a code of 4, so notPluggedInHome false-fired
// at home even while genuinely charging.
assert.strictEqual(
  buildState({ "vehicle.ev_battery_is_plugged_in": 4 }, {}).plugged, true,
  "nonzero connector-type code reads as plugged"
);
assert.strictEqual(
  buildState({ "vehicle.ev_battery_is_plugged_in": 0 }, {}).plugged, false
);
assert.strictEqual(
  buildState({ "vehicle.ev_battery_is_plugged_in": "unplugged" }, {}).plugged, null,
  "non-numeric, non-true/false strings stay unknown"
);

// empty flat map -> all null, no throw
const empty = buildState({}, {});
assert.strictEqual(empty.batteryPct, null);
assert.strictEqual(empty.climate, null);
assert.deepStrictEqual(empty.history, []);

// headlamp_status string fallback
assert.strictEqual(buildState({ "vehicle.headlamp_status": "on" }, {}).headlights, true);
assert.strictEqual(buildState({ "vehicle.headlamp_status": "OFF" }, {}).headlights, false);

console.log("all state tests passed");
