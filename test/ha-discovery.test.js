/* node test/ha-discovery.test.js */
const assert = require("assert");
const HA = require("../core/ha-discovery.js");

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

// ---- availability: without lwtTopic/vehicleStatusTopic (a caller that
// hasn't been updated, or non-rotating mode where node_helper only passes
// lwtTopic), falls back to a single availability_topic -- the case above
// (no options at all) already covers "neither given" via
// `batt.availability_topic === "kia/ev9/status"`. ----
{
  const only = HA.build({ prefix: "kia/ev9", lwtTopic: "kia/status/acct-abc12345" });
  const b = only.find((m) => m.topic.endsWith("/ev_battery_percentage/config"));
  const cfg = JSON.parse(b.payload);
  assert.strictEqual(cfg.availability_topic, "kia/status/acct-abc12345", (
    "lwtTopic alone (non-rotating mode) must be used as the single availability_topic"
  ));
  assert.ok(!("availability" in cfg), "must not emit the combined-list form when only one topic is given");
}

// ---- availability: a hostile-audit finding -- rotate mode's per-VIN
// status topic has no MQTT Last-Will of its own (only the account-level
// connection topic does), so HA would keep showing a vehicle "online"
// forever after an ungraceful process death if discovery pointed
// availability_topic at the per-VIN topic alone. Both must be required
// (availability_mode: "all"). ----
{
  const combined = HA.build({
    prefix: "kia/ev9/VIN1",
    lwtTopic: "kia/status/acct-abc12345",
    vehicleStatusTopic: "kia/ev9/VIN1/status"
  });
  const b = combined.find((m) => m.topic.endsWith("/ev_battery_percentage/config"));
  const cfg = JSON.parse(b.payload);
  assert.strictEqual(cfg.availability_mode, "all");
  assert.deepStrictEqual(
    (cfg.availability || []).map((a) => a.topic).sort(),
    ["kia/ev9/VIN1/status", "kia/status/acct-abc12345"].sort(),
    "must require BOTH the connection's real LWT topic and the per-vehicle status topic"
  );
  assert.ok(!("availability_topic" in cfg), "must not also emit the single-topic form alongside the list");
}

console.log("all ha-discovery tests passed");
