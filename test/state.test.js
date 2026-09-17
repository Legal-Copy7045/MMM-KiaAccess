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
// allow-list, not a deny-list: an unrecognized string must stay unknown, not read as "on"
["unknown", "unavailable", "error", "not_available", "unsupported"].forEach((v) => {
  assert.strictEqual(
    buildState({ "vehicle.headlamp_status": v }, {}).headlights, null,
    `headlamp_status ${JSON.stringify(v)} must stay unknown, not read as on`
  );
});

// powertrain/fuelPct: buildState() must expose these so any consumer (the
// MagicMirror module, the HA Lovelace card) can drive carDiagram()'s gas/
// hybrid rendering from the shared state object alone, without each caller
// re-deriving engine_type mapping itself -- previously only the Lovelace
// card did this derivation locally, so MM's own diagram never switched out
// of EV-only rendering when a PHEV/HEV/ICE account was configured, even
// though the underlying vehicle.engine_type sensor updated correctly.
assert.strictEqual(buildState({}, {}).powertrain, "ev", "unset engine_type defaults to ev");
assert.strictEqual(buildState({ "vehicle.engine_type": "EV" }, {}).powertrain, "ev");
assert.strictEqual(buildState({ "vehicle.engine_type": "ICE" }, {}).powertrain, "gas");
assert.strictEqual(buildState({ "vehicle.engine_type": "PHEV" }, {}).powertrain, "hybrid");
assert.strictEqual(buildState({ "vehicle.engine_type": "HEV" }, {}).powertrain, "hybrid");
assert.strictEqual(buildState({ "vehicle.engine_type": "phev" }, {}).powertrain, "hybrid", "case-insensitive");
assert.strictEqual(buildState({ "vehicle.engine_type": "bogus" }, {}).powertrain, "ev", "unrecognised value stays ev, never hides a real battery reading");
assert.strictEqual(buildState({ "vehicle.fuel_level": 42 }, {}).fuelPct, 42);
assert.strictEqual(buildState({}, {}).fuelPct, null);

// canPlugIn: distinguishes a plug-in hybrid (PHEV) from a conventional,
// non-plug hybrid (HEV -- e.g. a Kia Sportage Hybrid or Hyundai Tucson
// Hybrid, sold alongside a PHEV version of the same car). Both map to the
// same powertrain:"hybrid" bucket, which isn't fine enough for anything
// that means "has a plug" (conditions.js's notPluggedInHome, the card's
// charging button group).
assert.strictEqual(buildState({}, {}).canPlugIn, true, "unset engine_type defaults to true (safe default)");
assert.strictEqual(buildState({ "vehicle.engine_type": "EV" }, {}).canPlugIn, true);
assert.strictEqual(buildState({ "vehicle.engine_type": "PHEV" }, {}).canPlugIn, true);
assert.strictEqual(buildState({ "vehicle.engine_type": "HEV" }, {}).canPlugIn, false, "a conventional hybrid has no plug");
assert.strictEqual(buildState({ "vehicle.engine_type": "ICE" }, {}).canPlugIn, false);
assert.strictEqual(buildState({ "vehicle.engine_type": "hev" }, {}).canPlugIn, false, "case-insensitive");

// rangeKm: falls back to total_driving_range when ev_driving_range is
// absent (an ICE/PHEV-on-gas vehicle never sets it) -- must not silently
// go null when a perfectly usable range figure exists under a different key
assert.strictEqual(buildState({ "vehicle.ev_driving_range": 300 }, {}).rangeKm, 300, "ev_driving_range preferred when present");
assert.strictEqual(buildState({ "vehicle.total_driving_range": 450 }, {}).rangeKm, 450, "falls back to total_driving_range");
assert.strictEqual(
  buildState({ "vehicle.ev_driving_range": 0, "vehicle.total_driving_range": 450 }, {}).rangeKm, 450,
  "a zero ev_driving_range (not just missing) still falls back"
);
assert.strictEqual(buildState({}, {}).rangeKm, null, "no range data at all -> null, not a crash");

console.log("all state tests passed");
