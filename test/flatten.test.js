/* Minimal assertion-only tests. Run with: node test/flatten.test.js */
const assert = require("assert");
const U = require("../core/flatten.js");

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

// hideWhenFalsy: "*" drops every empty row without naming each key
entries = U.selectEntries(cond, { hideWhenFalsy: "*" });
assert.deepStrictEqual(entries.map((e) => e.key).sort(), ["a.plugged", "a.rate"]);
entries = U.selectEntries(cond, { hideWhenFalsy: ["*"] });
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
assert.strictEqual(U.formatValue({ key: "d", rawValue: 134 }, { formatters: { d: "durationMin" } }), "2h 14m");
assert.strictEqual(U.formatValue({ key: "d", rawValue: 45 }, { formatters: { d: "durationMin" } }), "45m");
assert.strictEqual(U.formatValue({ key: "d", rawValue: 120 }, { formatters: { d: "durationMin" } }), "2h");

// --- visuals ---
const Vis = require("../core/visuals.js");
const bg = Vis.batteryGauge(82, { charging: true });
assert.ok(bg.indexOf("<svg") === 0 && bg.indexOf("82%") > 0);
assert.strictEqual(Vis.batteryGauge(null, {}).indexOf("—") > 0, true);
const car = Vis.carDiagram({ locked: false, doorFL: true, hood: true, tyreAny: true, batteryPct: 63 });
assert.ok(car.indexOf("<svg") === 0);
assert.ok(car.indexOf("63%") > 0); // battery % drawn inside the car
assert.ok(Vis.carDiagram({ batteryPct: 63 }, { battery: false }).indexOf("63%") < 0);
// charger strip only appears when plugged; animateMotion only when live
assert.ok(Vis.carDiagram({ locked: true }).indexOf("animateMotion") < 0);
assert.ok(Vis.carDiagram({ charging: true }).indexOf("animateMotion") > 0);
assert.ok(Vis.carDiagram({ plugged: true }).indexOf("<rect x=\"200\"") > 0);
assert.ok(Vis.carDiagram({ plugged: true }).indexOf("animateMotion") < 0);
assert.strictEqual(Vis.iconFor("vehicle.ev_battery_percentage"), "fa-solid fa-battery-half");
assert.strictEqual(Vis.iconFor("vehicle.front_left_door_is_open"), "fa-solid fa-car-side");
assert.strictEqual(Vis.iconFor("vehicle.some_unknown_thing"), null);
assert.strictEqual(Vis.iconFor("x", { x: "fa-solid fa-star" }), "fa-solid fa-star");

console.log("all tests passed");
