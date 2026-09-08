/* Home Assistant MQTT discovery for MMM-KiaAccess.
 *
 * Publishes retained <discoveryPrefix>/<component>/<node>/<key>/config messages
 * so a curated set of entities appears in Home Assistant automatically. Each
 * entity points at the per-key state topic the node_helper already publishes
 * (`<prefix>/<key>`), with `<prefix>/status` as the availability topic.
 *
 * Pure module (no deps) so it can be unit-tested.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KiaHaDiscovery = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // component, key (matches the flat state topic), and HA config extras
  var SENSORS = [
    ["sensor", "ev_battery_percentage", { name: "EV battery", device_class: "battery", unit_of_measurement: "%", state_class: "measurement" }],
    ["sensor", "ev_battery_soh_percentage", { name: "EV battery health", unit_of_measurement: "%", icon: "mdi:heart-pulse" }],
    ["sensor", "car_battery_percentage", { name: "12V battery", device_class: "battery", unit_of_measurement: "%", state_class: "measurement" }],
    ["sensor", "ev_driving_range", { name: "EV range", device_class: "distance", unit_of_measurement: "km" }],
    ["sensor", "total_driving_range", { name: "Total range", device_class: "distance", unit_of_measurement: "km" }],
    ["sensor", "ev_charging_power", { name: "Charge power", device_class: "power", unit_of_measurement: "kW" }],
    ["sensor", "ev_estimated_current_charge_duration", { name: "Time to full", device_class: "duration", unit_of_measurement: "min" }],
    ["sensor", "odometer", { name: "Odometer", device_class: "distance", unit_of_measurement: "km", state_class: "total_increasing" }],
    ["sensor", "outside_temperature", { name: "Outside temperature", device_class: "temperature", unit_of_measurement: "°C" }],
    ["sensor", "last_updated_at", { name: "Car last reported", device_class: "timestamp" }],

    ["binary_sensor", "ev_battery_is_charging", { name: "Charging", device_class: "battery_charging", payload_on: "true", payload_off: "false" }],
    ["binary_sensor", "ev_battery_is_plugged_in", { name: "Plugged in", device_class: "plug", payload_on: "true", payload_off: "false" }],
    ["binary_sensor", "is_locked", { name: "Locked", device_class: "lock", payload_on: "false", payload_off: "true" }], // HA lock: on = unlocked
    ["binary_sensor", "front_left_door_is_open", { name: "Front-left door", device_class: "door", payload_on: "true", payload_off: "false" }],
    ["binary_sensor", "front_right_door_is_open", { name: "Front-right door", device_class: "door", payload_on: "true", payload_off: "false" }],
    ["binary_sensor", "back_left_door_is_open", { name: "Rear-left door", device_class: "door", payload_on: "true", payload_off: "false" }],
    ["binary_sensor", "back_right_door_is_open", { name: "Rear-right door", device_class: "door", payload_on: "true", payload_off: "false" }],
    ["binary_sensor", "hood_is_open", { name: "Frunk", device_class: "door", payload_on: "true", payload_off: "false" }],
    ["binary_sensor", "trunk_is_open", { name: "Liftgate", device_class: "door", payload_on: "true", payload_off: "false" }],
    ["binary_sensor", "sunroof_is_open", { name: "Sunroof", device_class: "window", payload_on: "true", payload_off: "false" }],
    ["binary_sensor", "tire_pressure_all_warning_is_on", { name: "Tyre pressure warning", device_class: "problem", payload_on: "true", payload_off: "false" }],
    ["binary_sensor", "defrost_is_on", { name: "Defrost", device_class: "running", payload_on: "true", payload_off: "false" }],
    ["binary_sensor", "air_control_is_on", { name: "Climate", device_class: "running", payload_on: "true", payload_off: "false" }]
  ];

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  }

  function build(opts) {
    opts = opts || {};
    var prefix = String(opts.prefix || "kia").replace(/\/+$/, "");
    var disc = String(opts.discoveryPrefix || "homeassistant").replace(/\/+$/, "");
    var node = slug(prefix) || "kia";
    var vin = (opts.vehicle && (opts.vehicle.VIN || opts.vehicle.id)) || node;

    var device = Object.assign(
      {
        identifiers: ["mmm_kiaaccess_" + slug(vin)],
        name: (opts.device && opts.device.name) ||
          (opts.vehicle && (opts.vehicle.name || opts.vehicle.model)) || "Kia",
        manufacturer: "Kia",
        model: (opts.vehicle && opts.vehicle.model) || undefined,
        via_device: undefined
      },
      opts.device || {}
    );

    return SENSORS.map(function (row) {
      var component = row[0], key = row[1], extra = row[2];
      var cfg = Object.assign(
        {
          name: extra.name || key,
          unique_id: "mmm_kia_" + slug(vin) + "_" + key,
          object_id: node + "_" + key,
          state_topic: prefix + "/" + key,
          availability_topic: prefix + "/status",
          payload_available: "online",
          payload_not_available: "offline",
          device: device
        },
        extra
      );
      return {
        topic: disc + "/" + component + "/" + node + "/" + key + "/config",
        payload: JSON.stringify(cfg)
      };
    });
  }

  /** publish discovery configs on an mqtt.js client (retained) */
  function publish(client, opts) {
    build(opts).forEach(function (m) {
      client.publish(m.topic, m.payload, { retain: true });
    });
  }

  return { build: build, publish: publish, SENSORS: SENSORS };
});
