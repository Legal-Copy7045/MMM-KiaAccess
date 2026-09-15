/* node test/card-map-keys.test.js
 *
 * Regression coverage for v2.67.0/v2.67.1's fix: custom:kia-range-map-card
 * and custom:kia-access-card's range_map: panel no longer need an api_key/
 * tomtom_key typed into Lovelace YAML -- they source it from the Kia
 * Access integration's own Options (the kia_access/map_keys websocket
 * command, see __init__.py's _map_keys_for_entry / test/map_keys_test.py
 * for the backend side of this). This file is the missing frontend half:
 * without it, only the backend's key-selection logic was tested, not that
 * either CARD actually calls the websocket command and merges the result
 * in correctly -- the exact kind of gap that let the "big circle instead
 * of a real route" bug ship unnoticed.
 *
 * Loads the real GENERATED bundle (see require-card-module.js) and drives
 * each card's key-sourcing methods directly (_inputs()/_maybeFetchKeys()
 * for the map card, _rangeInputs()/_maybeFetchMapKeys() for the main
 * card) -- never _render()/_draw(), which need Leaflet + a real shadow DOM
 * this harness doesn't attempt to fake.
 */
const assert = require("assert");
const loadCardModule = require("./require-card-module.js");

function fakeHass(overrides) {
  const calls = [];
  let resolveFn = null;
  const pending = new Promise((resolve) => { resolveFn = resolve; });
  const hass = Object.assign({
    connection: {
      sendMessagePromise(msg) {
        calls.push(msg);
        return pending;
      }
    },
    states: {},
    config: { unit_system: {} }
  }, overrides);
  return { hass, calls, resolveFetch: (v) => resolveFn(v) };
}

function statusEntity(entryId) {
  return {
    state: "2026-01-01T00:00:00+00:00",
    attributes: {
      kia_access_raw: true,
      entry_id: entryId,
      account: "USA:KIA:u@e.com",
      location_latitude: 40.0,
      location_longitude: -74.0,
      ev_driving_range: 200
    }
  };
}

// ---- KiaRangeMapCard._inputs(): no explicit config key -> fetches once
// from the backend, using THIS vehicle's own entry_id ----
{
  const { KiaRangeMapCard } = loadCardModule();
  const card = new KiaRangeMapCard();
  card.setConfig({ entity: "sensor.melodev_status" });
  const { hass, calls } = fakeHass({
    states: { "sensor.melodev_status": statusEntity("entry-1") }
  });
  card._hass = hass;

  const inp = card._inputs();
  assert.strictEqual(calls.length, 1, "must ask the backend for keys exactly once");
  assert.deepStrictEqual(calls[0], { type: "kia_access/map_keys", entry_id: "entry-1" });
  assert.strictEqual(inp.apiKey, null, "no key resolved yet -- first render falls back safely");
  assert.strictEqual(inp.tomtomKey, null);

  // a second call before the fetch resolves must NOT fire a second request
  card._inputs();
  assert.strictEqual(calls.length, 1, "must not re-fetch while a request for this entry_id is already in flight");
}

// ---- KiaRangeMapCard._inputs(): once the backend call resolves, the next
// _inputs() call picks up the fetched keys ----
{
  const { KiaRangeMapCard } = loadCardModule();
  const card = new KiaRangeMapCard();
  card.setConfig({ entity: "sensor.melodev_status" });
  const { hass } = fakeHass({
    states: { "sensor.melodev_status": statusEntity("entry-2") }
  });
  card._hass = hass;
  card._inputs(); // kicks off the fetch
  card._fetchedKeys = { api_key: "geo-secret", tomtom_key: "tt-secret" }; // simulate resolution
  const inp = card._inputs();
  assert.strictEqual(inp.apiKey, "geo-secret");
  assert.strictEqual(inp.tomtomKey, "tt-secret");
}

// ---- KiaRangeMapCard: an explicit range_map.api_key/tomtom_key in the
// card config ALWAYS wins, and must never trigger a websocket call at all
// -- the whole point is a real key never has to leave the dashboard's
// author, but if they DO choose to hardcode one, it has to actually work ----
{
  const { KiaRangeMapCard } = loadCardModule();
  const card = new KiaRangeMapCard();
  card.setConfig({
    entity: "sensor.melodev_status",
    range_map: { api_key: "configured-geo", tomtom_key: "configured-tt" }
  });
  const { hass, calls } = fakeHass({
    states: { "sensor.melodev_status": statusEntity("entry-3") }
  });
  card._hass = hass;
  const inp = card._inputs();
  assert.strictEqual(calls.length, 0, "an explicit card-config key must never trigger the websocket fetch");
  assert.strictEqual(inp.apiKey, "configured-geo");
  assert.strictEqual(inp.tomtomKey, "configured-tt");
}

// ---- KiaRangeMapCard: switching to a different vehicle (different
// entry_id) mid-flight must fetch fresh keys for the NEW vehicle, not
// silently reuse/ignore based on the old one ----
{
  const { KiaRangeMapCard } = loadCardModule();
  const card = new KiaRangeMapCard();
  card.setConfig({}); // auto-discovery, no entity: pinned
  const { hass, calls } = fakeHass({
    states: {
      "sensor.car_a_status": statusEntity("entry-a"),
      "sensor.car_b_status": statusEntity("entry-b")
    }
  });
  hass.states["sensor.car_a_status"].attributes.kia_access_raw = true;
  card._hass = hass;
  card._config = { entity: "sensor.car_a_status" };
  card._inputs();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].entry_id, "entry-a");

  card._config = { entity: "sensor.car_b_status" };
  card._inputs();
  assert.strictEqual(calls.length, 2, "a different vehicle's entry_id must trigger its own fetch");
  assert.strictEqual(calls[1].entry_id, "entry-b");
}

// ---- KiaAccessCard._rangeInputs(): range_map: {} (no key at all) still
// fetches from the backend -- this card has no plain-tile fallback, so
// without SOME key (config or fetched) the feature must stay off, not
// throw ----
{
  const { KiaAccessCard } = loadCardModule();
  const card = new KiaAccessCard();
  card.setConfig({ entity: "sensor.melodev_status", range_map: {} });
  const { hass, calls } = fakeHass({
    states: { "sensor.melodev_status": statusEntity("entry-4") }
  });
  card._hass = hass;
  card._entryId = "entry-4"; // normally set by _render() before _rangeInputs() runs
  const flat = { "vehicle.location_latitude": 40, "vehicle.location_longitude": -74, "vehicle.ev_driving_range": 200 };

  const inp1 = card._rangeInputs(flat);
  assert.strictEqual(calls.length, 1, "range_map: {} must still ask the backend for a key");
  assert.strictEqual(inp1, null, "no key resolved yet -> the panel must stay off, not crash");

  card._fetchedKeys = { api_key: "geo-secret", tomtom_key: null };
  const inp2 = card._rangeInputs(flat);
  assert.ok(inp2, "once a key resolves, the panel must turn on");
  assert.strictEqual(card._mapApiKey(), "geo-secret");
}

// ---- KiaAccessCard: no range_map: block configured at all -> never
// fetches (the feature is opt-in; a card without range_map: shouldn't
// silently start making websocket calls) ----
{
  const { KiaAccessCard } = loadCardModule();
  const card = new KiaAccessCard();
  card.setConfig({ entity: "sensor.melodev_status" }); // no range_map key
  const { hass, calls } = fakeHass({
    states: { "sensor.melodev_status": statusEntity("entry-5") }
  });
  card._hass = hass;
  card._entryId = "entry-5";
  const flat = { "vehicle.location_latitude": 40, "vehicle.location_longitude": -74, "vehicle.ev_driving_range": 200 };
  const inp = card._rangeInputs(flat);
  assert.strictEqual(inp, null);
  assert.strictEqual(calls.length, 0, "a card with no range_map: block must never call the backend for map keys");
}

// ---- KiaAccessCard: an explicit range_map.api_key still overrides the
// backend, and tomtom_key can be set independently of api_key (mixed:
// explicit tomtom_key, backend-sourced api_key) ----
{
  const { KiaAccessCard } = loadCardModule();
  const card = new KiaAccessCard();
  card.setConfig({ entity: "sensor.melodev_status", range_map: { tomtom_key: "configured-tt" } });
  const { hass, calls } = fakeHass({
    states: { "sensor.melodev_status": statusEntity("entry-6") }
  });
  card._hass = hass;
  card._entryId = "entry-6";
  const flat = { "vehicle.location_latitude": 40, "vehicle.location_longitude": -74, "vehicle.ev_driving_range": 200 };

  card._rangeInputs(flat); // kicks off the fetch (api_key still missing)
  assert.strictEqual(calls.length, 1, "api_key is still missing even though tomtom_key was set -- must fetch");
  card._fetchedKeys = { api_key: "backend-geo", tomtom_key: "backend-tt" };
  card._rangeInputs(flat);
  assert.strictEqual(card._mapApiKey(), "backend-geo", "api_key must come from the backend, config never set one");
  assert.strictEqual(card._mapTomtomKey(), "configured-tt", "tomtom_key must stay the explicitly configured one, not the backend's");
}

console.log("all card-map-keys tests passed");
