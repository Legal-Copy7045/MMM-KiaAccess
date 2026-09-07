/* Minimal assertion-only tests. Run with: node test/flatten.test.js */
const assert = require("assert");
const U = require("../flatten.js");

const payload = {
  status: {
    engine: { batteryCharge: 82, charging: false, range: 410 },
    chassis: { locked: true, openDoors: { frontLeft: false } }
  },
  odometer: { value: 1234.5, unit: "km" },
  _meta: { fetchedAt: "2026-09-05T10:00:00.000Z", vin: "SECRET" }
};

const flat = U.flatten(payload);
assert.strictEqual(flat["status.engine.batteryCharge"], 82);
assert.strictEqual(flat["status.chassis.openDoors.frontLeft"], false);
assert.strictEqual(flat["odometer.value"], 1234.5);

// include / exclude
let entries = U.selectEntries(flat, {
  include: ["status.engine.*"],
  exclude: ["status.engine.charging"]
});
assert.deepStrictEqual(
  entries.map((e) => e.key).sort(),
  ["status.engine.batteryCharge", "status.engine.range"]
);

// exclude glob hides _meta.vin
entries = U.selectEntries(flat, { exclude: ["_meta.vin"] });
assert.ok(!entries.some((e) => e.key === "_meta.vin"));

// order puts a path first
entries = U.selectEntries(flat, { order: ["odometer.value"] });
assert.strictEqual(entries[0].key, "odometer.value");

// hideWhenFalsy drops false/0/null rows but keeps truthy ones
const cond = U.flatten({
  a: { charging: false, plugged: true, power: 0, rate: 7.2, note: "" }
});
entries = U.selectEntries(cond, {
  hideWhenFalsy: ["a.charging", "a.plugged", "a.power", "a.rate", "a.note"]
});
assert.deepStrictEqual(entries.map((e) => e.key).sort(), ["a.plugged", "a.rate"]);
assert.strictEqual(U.isEmptyValue(0), true);
assert.strictEqual(U.isEmptyValue("false"), true);
assert.strictEqual(U.isEmptyValue(3.3), false);

// formatters
assert.strictEqual(
  U.formatValue({ key: "b", rawValue: 82 }, { formatters: { b: "percent" }, decimals: 0 }),
  "82 %"
);
assert.strictEqual(
  U.formatValue({ key: "r", rawValue: 410 }, { formatters: { r: "distanceKm" }, units: "imperial", decimals: 0 }),
  "255 mi"
);
assert.strictEqual(
  U.formatValue({ key: "l", rawValue: true }, { formatters: { l: "boolean" } }),
  "Yes"
);
assert.strictEqual(U.prettifyKey("status.engine.batteryCharge"), "Battery Charge");

console.log("all tests passed");
