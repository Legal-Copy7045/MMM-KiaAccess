/* node test/ha-source.test.js */
const assert = require("assert");
const { fetchFromHA } = require("../ha_source.js");

function mockFetch(routes) {
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (!(path in routes)) return { ok: false, status: 404, statusText: "Not Found" };
    return { ok: true, status: 200, json: async () => routes[path] };
  };
}

(async () => {
  // auto-detect the summary entity, then build the payload
  global.fetch = mockFetch({
    "/api/states": [
      { entity_id: "sensor.other", attributes: {} },
      {
        entity_id: "sensor.kia_ev9_status",
        attributes: { kia_access_raw: true, ev_battery_percentage: 63, is_locked: "true" }
      }
    ],
    "/api/states/sensor.kia_ev9_status": {
      entity_id: "sensor.kia_ev9_status",
      state: "2026-09-07T10:00:00+00:00",
      last_changed: "2026-09-07T10:00:00+00:00",
      attributes: {
        kia_access_raw: true,
        friendly_name: "Kia EV9 Status",
        ev_battery_percentage: 63,
        is_locked: "true",
        note: "cached"
      }
    }
  });

  const out = await fetchFromHA({ url: "http://ha.local:8123/", token: "T" });
  assert.strictEqual(out.vehicle.ev_battery_percentage, 63);
  assert.strictEqual(out.vehicle.is_locked, "true");
  assert.ok(!("friendly_name" in out.vehicle), "cosmetic attrs stripped");
  assert.ok(!("kia_access_raw" in out.vehicle));
  assert.strictEqual(out._meta.source, "homeassistant");
  assert.strictEqual(out._meta.haEntity, "sensor.kia_ev9_status");
  assert.strictEqual(out._meta.note, "cached");

  // explicit entity
  const out2 = await fetchFromHA({
    url: "http://ha.local:8123",
    token: "T",
    entity: "sensor.kia_ev9_status"
  });
  assert.strictEqual(out2.vehicle.ev_battery_percentage, 63);

  // missing config
  await assert.rejects(() => fetchFromHA({ url: "", token: "" }), /needs homeassistant/);

  // no summary entity
  global.fetch = mockFetch({ "/api/states": [{ entity_id: "x", attributes: {} }] });
  await assert.rejects(
    () => fetchFromHA({ url: "http://ha.local:8123", token: "T" }),
    /no Kia Access summary entity/
  );

  console.log("all ha-source tests passed");
})();
