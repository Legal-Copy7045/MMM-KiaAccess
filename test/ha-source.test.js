/* node test/ha-source.test.js */
const assert = require("assert");
const { fetchFromHA, HaLiveClient } = require("../ha_source.js");

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
    },
    "/api/states/sensor.kia_ev9_range_reach": {
      entity_id: "sensor.kia_ev9_range_reach",
      state: "180",
      attributes: {
        one_way_km: 180, drive_time_source: "tomtom",
        pois: [{ name: "Work", km: 21, duration_min: 34, source: "zone" }]
      }
    }
  });

  const out = await fetchFromHA({ url: "http://ha.local:8123/", token: "T" });
  assert.strictEqual(out.vehicle.ev_battery_percentage, 63);
  assert.strictEqual(out.vehicle.is_locked, "true");
  assert.strictEqual(out.rangeReach.driveTimeSource, "tomtom", "range_reach attached");
  assert.strictEqual(out.rangeReach.pois[0].name, "Work");
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

  // range_reach fetch failing must not break the payload
  global.fetch = mockFetch({
    "/api/states/sensor.kia_ev9_status": { attributes: { kia_access_raw: true, ev_battery_percentage: 50 } }
  });
  const out3 = await fetchFromHA({ url: "http://ha.local:8123", token: "T", entity: "sensor.kia_ev9_status" });
  assert.strictEqual(out3.vehicle.ev_battery_percentage, 50);
  assert.ok(!("rangeReach" in out3), "no rangeReach when the sensor 404s");
  global.fetch = mockFetch({
    "/api/states": [
      { entity_id: "sensor.other", attributes: {} },
      { entity_id: "sensor.kia_ev9_status", attributes: { kia_access_raw: true, ev_battery_percentage: 63 } }
    ],
    "/api/states/sensor.kia_ev9_status": {
      state: "2026-09-07T10:00:00+00:00",
      attributes: { kia_access_raw: true, ev_battery_percentage: 41 }
    },
    "/api/states/sensor.kia_ev9_range_reach": { attributes: { pois: [] } }
  });

  // missing config
  await assert.rejects(() => fetchFromHA({ url: "", token: "" }), /needs homeassistant/);

  // no summary entity
  global.fetch = mockFetch({ "/api/states": [{ entity_id: "x", attributes: {} }] });
  await assert.rejects(
    () => fetchFromHA({ url: "http://ha.local:8123", token: "T" }),
    /no Kia Access summary entity/
  );

  // ---- HaLiveClient: drive a fake WebSocket through the handshake ----
  const sent = [];
  let fakeWs;
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this._l = {};
      fakeWs = this;
    }
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
    send(s) { sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; (this._l.close || []).forEach((f) => f()); }
    _emit(obj) { (this._l.message || []).forEach((f) => f({ data: JSON.stringify(obj) })); }
  }
  global.WebSocket = FakeWS;
  global.fetch = mockFetch({
    "/api/states/sensor.kia_ev9_status": {
      entity_id: "sensor.kia_ev9_status",
      state: "2026-09-07T10:00:00+00:00",
      attributes: { kia_access_raw: true, ev_battery_percentage: 41 }
    }
  });

  const payloads = [];
  const live = new HaLiveClient(
    { url: "http://ha.local:8123", token: "T", entity: "sensor.kia_ev9_status" },
    { onPayload: (p) => payloads.push(p), onStatus: () => {} }
  );
  assert.strictEqual(HaLiveClient.supported, true);
  live.start();
  fakeWs._emit({ type: "auth_required" });
  assert.deepStrictEqual(sent[0], { type: "auth", access_token: "T" });
  fakeWs._emit({ type: "auth_ok" });
  await new Promise((r) => setTimeout(r, 10)); // let the async entity resolve run
  const sub = sent.find((m) => m.type === "subscribe_trigger");
  assert.ok(sub && sub.trigger.entity_id === "sensor.kia_ev9_status", "subscribed");
  assert.ok(live.healthy, "healthy after auth_ok + subscribe");
  assert.ok(payloads.some((p) => p.vehicle.ev_battery_percentage === 41), "primed from REST");

  // a state-change event pushes a payload
  fakeWs._emit({
    id: sub.id,
    type: "event",
    event: { variables: { trigger: { to_state: {
      entity_id: "sensor.kia_ev9_status",
      state: "2026-09-07T11:00:00+00:00",
      attributes: { kia_access_raw: true, ev_battery_percentage: 44, is_locked: "false" }
    } } } }
  });
  await new Promise((r) => setTimeout(r, 10)); // _emit awaits the range_reach fetch
  const last = payloads[payloads.length - 1];
  assert.strictEqual(last.vehicle.ev_battery_percentage, 44);
  assert.strictEqual(last.vehicle.is_locked, "false");
  assert.strictEqual(last._meta.via, "push");

  live.stop();
  assert.strictEqual(live.healthy, false, "not healthy after stop");
  delete global.WebSocket;

  console.log("all ha-source tests passed");
})();
