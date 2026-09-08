/* Home Assistant MQTT discovery for MMM-KiaAccess.
 *
 * Publishes retained <discoveryPrefix>/<component>/<node>/<key>/config messages
 * so a curated set of entities appears in Home Assistant automatically. Each
 * entity points at the per-key state topic the node_helper already publishes
 * (`<prefix>/<key>`), with `<prefix>/status` as the availability topic.
 *
 * The entity list is generated from core/entities.json — the single catalogue
 * shared with the native HA integration and the docs.
 *
 * Pure module (no runtime deps) so it can be unit-tested.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./entities.json"));
  } else {
    root.KiaHaDiscovery = factory(root.KiaAccessEntities || { entities: [] });
  }
})(typeof self !== "undefined" ? self : this, function (CATALOGUE) {
  "use strict";

  // Flatten the catalogue into the [component, key, extra] rows this module
  // has always worked with, so downstream expectations (and SENSORS.length)
  // are unchanged.
  var SENSORS = (CATALOGUE.entities || []).map(function (e) {
    var extra = { name: e.name || e.key };
    if (e.domain === "binary_sensor") {
      extra.device_class = e.device_class;
      extra.payload_on = e.invert ? "false" : "true";
      extra.payload_off = e.invert ? "true" : "false";
    } else {
      if (e.device_class) extra.device_class = e.device_class;
      if (e.unit) extra.unit_of_measurement = e.unit;
      if (e.state_class) extra.state_class = e.state_class;
      if (e.icon) extra.icon = e.icon;
    }
    return [e.domain, e.key, extra];
  });

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
