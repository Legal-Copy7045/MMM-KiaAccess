/* node test/ha_discovery.test.js */
const assert = require("assert");
const HA = require("../ha_discovery.js");

const msgs = HA.build({
  prefix: "kia/ev9/",
  discoveryPrefix: "homeassistant",
  vehicle: { VIN: "ABC123", model: "EV9", name: "My EV9" }
});
const by = {};
msgs.forEach((m) => (by[m.topic] = JSON.parse(m.payload)));

// battery sensor
const batt = by["homeassistant/sensor/kia_ev9/ev_battery_percentage/config"];
assert.ok(batt, "battery discovery topic");
assert.strictEqual(batt.state_topic, "kia/ev9/ev_battery_percentage");
assert.strictEqual(batt.device_class, "battery");
assert.strictEqual(batt.unit_of_measurement, "%");
assert.strictEqual(batt.availability_topic, "kia/ev9/status");
assert.deepStrictEqual(batt.device.identifiers, ["mmm_kiaaccess_abc123"]);
assert.ok(/abc123/.test(batt.unique_id));

// lock is inverted for HA (on = unlocked)
const lock = by["homeassistant/binary_sensor/kia_ev9/is_locked/config"];
assert.strictEqual(lock.payload_on, "false");
assert.strictEqual(lock.payload_off, "true");

// a door binary_sensor
const door = by["homeassistant/binary_sensor/kia_ev9/front_left_door_is_open/config"];
assert.strictEqual(door.device_class, "door");
assert.strictEqual(door.payload_on, "true");

// publish() calls client.publish for each, retained
let n = 0;
HA.publish({ publish: (t, p, o) => { n++; assert.strictEqual(o.retain, true); } }, { prefix: "kia" });
assert.strictEqual(n, HA.SENSORS.length);

console.log("all ha_discovery tests passed");
