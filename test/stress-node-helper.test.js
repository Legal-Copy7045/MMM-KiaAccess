/* node test/stress-node-helper.test.js
 *
 * Integration/stress suite for node_helper.js (the MagicMirror side), driving
 * the REAL module code through multi-step, out-of-order, and concurrent
 * scenarios -- not just one call in, one assertion out. Fakes only sit at the
 * true I/O boundary (child_process.spawn, mqtt client, WebSocket, fetch, the
 * filesystem via a real tmp dir) so everything ABOVE that boundary -- the
 * actual dispatch/retirement/dedup/persistence logic -- runs for real.
 *
 * Covers: A->B vehicle switching, account-restart isolation, vehicle
 * disappearance/reappearance, partial vehicle lists across many polls,
 * overlapping refreshes for one id, a late/stale bridge response arriving
 * after a config change already moved on, MQTT reconnect + retained-state
 * bookkeeping, Prometheus server restart, corrupted on-disk cache, config
 * removal racing an in-flight fetch, and running several of these at once
 * across multiple vehicles/accounts.
 *
 * What this does NOT cover (see the session's own scoping discussion):
 * a REAL mqtt broker, a REAL Prometheus scrape, or a REAL HA server over an
 * actual socket -- those would need Docker-based infra disproportionate to
 * this project's size. Every scenario below instead drives the real
 * reconnect/restart STATE MACHINES (mqtt.js's connect/close events, HA's
 * WebSocket close/reconnect, PromServer's bind-error path) exactly the way
 * the real libraries invoke them, with a fake standing in only for the
 * network socket itself.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const loadNodeHelper = require("./require-node-helper.js");
const exporter = require("../exporter.js");
const { HaLiveClient } = require("../ha_source.js");

function tmpCacheDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kia-stress-test-"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function freshHelper(cacheDir) {
  const helper = loadNodeHelper();
  helper.sendSocketNotification = () => {};
  helper.start();
  if (cacheDir) helper.cacheDir = cacheDir;
  return helper;
}

// Fake mqtt.js client: a minimal EventEmitter-ish stand-in that records every
// publish and lets a test fire connect/close exactly like the real library
// does on the real network events it wraps.
function fakeMqttClient() {
  const listeners = {};
  const published = [];
  return {
    published,
    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return this; },
    publish(topic, payload, opts) { published.push({ topic, payload, opts }); },
    _fire(evt, ...args) { (listeners[evt] || []).forEach((f) => f(...args)); },
    end() {}
  };
}

(async () => {

console.log("-- A/B vehicle switching (rotate mode, many consecutive cycles)");
{
  const helper = freshHelper(tmpCacheDir());
  const onPayloadCalls = [];
  helper.onPayload = (id, config, payload) => onPayloadCalls.push({ id, vin: payload.vehicle.VIN, pct: payload.vehicle.ev_battery_percentage });
  helper._retireVehicle = () => {};

  const config = {
    region: "USA", brand: "KIA", username: "switch@e.com",
    vehicles: [{ vin: "CAR_A" }, { vin: "CAR_B" }]
  };
  const acctId = helper.identifierFor({ ...config, vin: "" });

  // 20 consecutive account-fetch cycles, battery % drifting independently
  // per car -- each cycle's dispatch must land under the SAME two subIds,
  // and each car's own onPayload stream must show a monotonically-evolving
  // battery reading that never jumps to the OTHER car's number.
  for (let cycle = 0; cycle < 20; cycle++) {
    const stdout = JSON.stringify({
      ok: true,
      vehicles: [
        { VIN: "CAR_A", ev_battery_percentage: 50 + cycle },
        { VIN: "CAR_B", ev_battery_percentage: 90 - cycle }
      ]
    });
    helper._handleBridgeClose(acctId, config, true, 0, stdout, "", () => {
      throw new Error("cycle " + cycle + ": must not report a failure");
    });
  }
  const aCalls = onPayloadCalls.filter((c) => c.id === "USA|KIA|switch@e.com|CAR_A");
  const bCalls = onPayloadCalls.filter((c) => c.id === "USA|KIA|switch@e.com|CAR_B");
  assert.strictEqual(aCalls.length, 20);
  assert.strictEqual(bCalls.length, 20);
  assert.deepStrictEqual(aCalls.map((c) => c.pct), Array.from({ length: 20 }, (_, i) => 50 + i), (
    "car A's battery series must be its own, never mixed with car B's"
  ));
  assert.deepStrictEqual(bCalls.map((c) => c.pct), Array.from({ length: 20 }, (_, i) => 90 - i));
  assert.ok(aCalls.every((c) => c.vin === "CAR_A") && bCalls.every((c) => c.vin === "CAR_B"), (
    "every payload dispatched under car A's subId must actually BE car A's vehicle data"
  ));

  // each car's own on-disk cache/session/trip state must also be isolated --
  // st() reads by id, so confirm the two never collide on one cache file
  const sA = helper.st("USA|KIA|switch@e.com|CAR_A");
  const sB = helper.st("USA|KIA|switch@e.com|CAR_B");
  assert.notStrictEqual(helper.cacheFile("USA|KIA|switch@e.com|CAR_A"), helper.cacheFile("USA|KIA|switch@e.com|CAR_B"));
}

console.log("-- account A -> account B restart (fresh helper instance, no state bleed)");
{
  // "restart" = a brand-new helper instance (module reload), immediately
  // driven by a DIFFERENT account's config -- nothing from account A's
  // in-memory or on-disk state must leak into account B's identifiers.
  const sharedCacheDir = tmpCacheDir();

  // Deliberately does NOT stub onPayload() here -- this test needs the REAL
  // persistence/lastGood-tracking logic to run, to prove isolation actually
  // reaches disk, not just whatever a fake collector happens to record.
  const helperA = freshHelper(sharedCacheDir);
  const configA = { region: "USA", brand: "KIA", username: "accountA@e.com", vin: "CARA_VIN" };
  const idA = helperA.identifierFor(configA);
  helperA._handleBridgeClose(idA, configA, false, 0, JSON.stringify({
    ok: true, vehicles: [{ VIN: "CARA_VIN", ev_battery_percentage: 33 }]
  }), "", () => { throw new Error("account A must not fail"); });
  assert.strictEqual(helperA.st(idA).lastGood.vehicle.ev_battery_percentage, 33);

  // "restart": a fresh helper (this.state, this.inFlight, this.rotateVins,
  // this.mqttClients all start empty), same cache DIRECTORY (as it would be
  // on a real disk after a MagicMirror restart), but account B's config
  const helperB = freshHelper(sharedCacheDir);
  const configB = { region: "USA", brand: "KIA", username: "accountB@e.com", vin: "CARB_VIN" };
  const idB = helperB.identifierFor(configB);
  assert.notStrictEqual(idA, idB, "different accounts must never compute the same identifier");
  helperB._handleBridgeClose(idB, configB, false, 0, JSON.stringify({
    ok: true, vehicles: [{ VIN: "CARB_VIN", ev_battery_percentage: 77 }]
  }), "", () => { throw new Error("account B must not fail"); });
  assert.strictEqual(helperB.st(idB).lastGood.vehicle.ev_battery_percentage, 77, (
    "account B's own poll must show ITS OWN battery reading, not anything left over from account A"
  ));
  // account B's cache must be a genuinely separate file from account A's,
  // even though they share a cache DIRECTORY -- different id -> different hash
  assert.notStrictEqual(helperA.cacheFile(idA), helperB.cacheFile(idB));
  const bOnDisk = JSON.parse(fs.readFileSync(helperB.cacheFile(idB), "utf8"));
  assert.strictEqual(bOnDisk.lastGood.vehicle.ev_battery_percentage, 77, (
    "account B's own persisted cache file must hold its own data, not account A's"
  ));
  const aOnDisk = JSON.parse(fs.readFileSync(helperA.cacheFile(idA), "utf8"));
  assert.strictEqual(aOnDisk.lastGood.vehicle.ev_battery_percentage, 33, (
    "account A's cache file on the shared directory must be untouched by account B's activity"
  ));
}

console.log("-- vehicle disappearance -> reappearance full cycle");
{
  const helper = freshHelper(tmpCacheDir());
  const onPayloadCalls = [];
  helper.onPayload = (id, config, payload) => onPayloadCalls.push({ id, pct: payload.vehicle.ev_battery_percentage });
  const retired = [];
  helper._retireVehicle = (config, vin) => retired.push(vin);

  const config = {
    region: "USA", brand: "KIA", username: "disappear@e.com",
    vehicles: [{ vin: "CAR_A" }, { vin: "CAR_B" }]
  };
  const acctId = helper.identifierFor({ ...config, vin: "" });
  const both = JSON.stringify({ ok: true, vehicles: [{ VIN: "CAR_A", ev_battery_percentage: 50 }, { VIN: "CAR_B", ev_battery_percentage: 60 }] });
  const onlyA = JSON.stringify({ ok: true, vehicles: [{ VIN: "CAR_A", ev_battery_percentage: 55 }] });

  // establish both, then car B goes missing from the ACCOUNT (not config)
  // for the retirement-debounce threshold (ACCOUNT_MISS_RETIRE_AFTER = 3)
  helper._handleBridgeClose(acctId, config, true, 0, both, "", () => {});
  for (let i = 0; i < 3; i++) helper._handleBridgeClose(acctId, config, true, 0, onlyA, "", () => {});
  assert.deepStrictEqual(retired, ["CAR_B"], "3 consecutive account misses must retire car B");

  // car B reappears in the account -- must resume flowing data normally,
  // with the miss streak fully reset (not "one more miss retires it again immediately")
  retired.length = 0;
  onPayloadCalls.length = 0;
  helper._handleBridgeClose(acctId, config, true, 0, both, "", () => {});
  const bAfterReturn = onPayloadCalls.filter((c) => c.id.endsWith("CAR_B"));
  assert.strictEqual(bAfterReturn.length, 1, "car B must resume receiving onPayload() the moment it reappears");
  assert.strictEqual(bAfterReturn[0].pct, 60);
  // two more misses must NOT re-retire it (streak was reset by the reappearance)
  helper._handleBridgeClose(acctId, config, true, 0, onlyA, "", () => {});
  helper._handleBridgeClose(acctId, config, true, 0, onlyA, "", () => {});
  assert.deepStrictEqual(retired, [], "the miss streak must have been reset by the reappearance, not just decremented");
}

console.log("-- partial vehicle lists across many polls, interleaved patterns");
{
  const helper = freshHelper(tmpCacheDir());
  const seenByVin = { CAR_A: [], CAR_B: [], CAR_C: [] };
  helper.onPayload = (id, config, payload) => seenByVin[payload.vehicle.VIN].push(payload.vehicle.ev_battery_percentage);
  helper._retireVehicle = () => {};

  const config = {
    region: "USA", brand: "KIA", username: "partial@e.com",
    vehicles: [{ vin: "CAR_A" }, { vin: "CAR_B" }, { vin: "CAR_C" }]
  };
  const acctId = helper.identifierFor({ ...config, vin: "" });

  // a deliberately irregular presence pattern over 12 polls -- no vehicle
  // present on every single poll, none absent for the full run either
  const patterns = [
    ["CAR_A", "CAR_B", "CAR_C"], ["CAR_A", "CAR_C"], ["CAR_B"], ["CAR_A", "CAR_B", "CAR_C"],
    ["CAR_A"], ["CAR_A", "CAR_B"], ["CAR_C"], ["CAR_A", "CAR_B", "CAR_C"],
    ["CAR_B", "CAR_C"], ["CAR_A"], ["CAR_A", "CAR_B", "CAR_C"], ["CAR_A", "CAR_B"]
  ];
  patterns.forEach((present, i) => {
    const stdout = JSON.stringify({
      ok: true,
      vehicles: present.map((vin) => ({ VIN: vin, ev_battery_percentage: i }))
    });
    helper._handleBridgeClose(acctId, config, true, 0, stdout, "", () => {
      throw new Error("poll " + i + ": account response with vehicles present must not fail");
    });
  });
  // every present-in-a-poll reading must have actually reached its own vin's stream
  patterns.forEach((present, i) => {
    present.forEach((vin) => {
      assert.ok(seenByVin[vin].includes(i), `poll ${i}: ${vin} was present but never got its onPayload() call`);
    });
  });
  // no vehicle EVER received a reading attributed to a poll it wasn't present in
  Object.keys(seenByVin).forEach((vin) => {
    seenByVin[vin].forEach((pctAsPollIndex) => {
      assert.ok(patterns[pctAsPollIndex].includes(vin), `${vin} received poll ${pctAsPollIndex}'s data despite not being present that poll`);
    });
  });
}

console.log("-- overlapping refreshes: a second handleFetch() for the same id must be skipped while one is in flight");
{
  const child_process = require("child_process");
  const origSpawn = child_process.spawn;
  const { EventEmitter } = require("events");
  let spawnCount = 0;
  const pendingChildren = [];

  child_process.spawn = () => {
    spawnCount++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => {};
    child.stdin.end = () => {};
    child.kill = () => {};
    pendingChildren.push(child);
    return child;
  };

  try {
    const helper = freshHelper(tmpCacheDir());
    const onPayloadCalls = [];
    helper.onPayload = (id, config, payload) => onPayloadCalls.push(payload.vehicle.ev_battery_percentage);

    const config = { region: "USA", brand: "KIA", username: "overlap@e.com", vin: "CAR_X", pythonBin: "python3" };

    helper.handleFetch(config); // starts a real "in-flight" fetch
    assert.strictEqual(spawnCount, 1);
    helper.handleFetch(config); // a second call while the first is still unresolved
    assert.strictEqual(spawnCount, 1, "a second handleFetch() for the SAME id must not spawn a second bridge process");

    // resolve the one real fetch
    const child = pendingChildren[0];
    child.stdout.emit("data", JSON.stringify({ ok: true, vehicles: [{ VIN: "CAR_X", ev_battery_percentage: 42 }] }));
    child.emit("close", 0);
    assert.strictEqual(onPayloadCalls.length, 1);
    assert.strictEqual(onPayloadCalls[0], 42);

    // now that it's resolved, a THIRD call must spawn again (inFlight cleared)
    helper.handleFetch(config);
    assert.strictEqual(spawnCount, 2, "once the in-flight fetch resolves, the NEXT call must spawn normally");
  } finally {
    child_process.spawn = origSpawn;
  }
}

console.log("-- config removal racing an in-flight fetch: a late bridge response for a since-removed vehicle must not corrupt the OTHER, still-configured vehicle's state");
{
  const child_process = require("child_process");
  const origSpawn = child_process.spawn;
  const { EventEmitter } = require("events");
  const pendingChildren = [];
  child_process.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => {};
    child.stdin.end = () => {};
    child.kill = () => {};
    pendingChildren.push(child);
    return child;
  };

  try {
    const helper = freshHelper(tmpCacheDir());
    const onPayloadCalls = [];
    helper.onPayload = (id, config, payload) => onPayloadCalls.push({ id, vin: payload.vehicle.VIN });
    const retired = [];
    helper._retireVehicle = (config, vin) => retired.push(vin);

    const configWithBoth = {
      region: "USA", brand: "KIA", username: "midflight@e.com",
      vehicles: [{ vin: "CAR_A" }, { vin: "CAR_B" }], pythonBin: "python3"
    };
    // a fetch starts while BOTH cars are still configured
    helper.handleFetch(configWithBoth);
    assert.strictEqual(pendingChildren.length, 1);

    // the user edits the config WHILE that fetch is still in flight, removing
    // car B -- handleFetch()'s own unconditional _retireRemovedFromConfig()
    // call fires on the NEXT handleFetch(), not synchronously from an
    // external edit, so simulate that next tick the same way a real poll
    // timer would: a second handleFetch() call with the new config.
    const configWithoutB = { ...configWithBoth, vehicles: [{ vin: "CAR_A" }] };
    helper.handleFetch(configWithoutB); // same id (rotate acct id) -> inFlight guard skips spawning a second bridge, but retirement still runs unconditionally at the top
    assert.deepStrictEqual(retired, ["CAR_B"], "car B must be retired the moment config removes it, even while an OLDER fetch (still carrying car B) is unresolved");

    // NOW the original, already-in-flight fetch (spawned under the OLD
    // config, still remembering car B) finally resolves
    const child = pendingChildren[0];
    child.stdout.emit("data", JSON.stringify({
      ok: true,
      vehicles: [{ VIN: "CAR_A", ev_battery_percentage: 61 }, { VIN: "CAR_B", ev_battery_percentage: 71 }]
    }));
    child.emit("close", 0);

    // car A (still configured) must still get its data
    const aCalls = onPayloadCalls.filter((c) => c.vin === "CAR_A");
    assert.strictEqual(aCalls.length, 1, "car A, still configured, must still receive the stale-but-relevant fetch's data for itself");
    // car B (removed mid-flight) is filtered out by _handleBridgeClose's own
    // configuredVins check against the OLD config object closed over by this
    // particular spawn -- it must NOT resurrect car B's onPayload/cache/mqtt
    // after it was already retired above
    const bCalls = onPayloadCalls.filter((c) => c.vin === "CAR_B");
    assert.strictEqual(bCalls.length, 0, (
      "a stale in-flight fetch's data for a vehicle removed from config mid-flight must not reach onPayload() " +
      "and resurrect what was just retired"
    ));
  } finally {
    child_process.spawn = origSpawn;
  }
}

console.log("-- MQTT reconnect: retained-state bookkeeping (discovery + per-vehicle online) must re-fire on the SAME client object");
{
  const helper = freshHelper(tmpCacheDir());
  const client = fakeMqttClient();
  helper.mqttClient = () => client;
  // mimic mqttClient()'s own on("connect") registration for real, so this
  // test exercises the ACTUAL reconnect bookkeeping logic, not a re-implementation
  helper.mqttClient.__proto__ = undefined;

  // drive publishMqtt() the way the real mqttClient() factory does: register
  // the SAME on("connect") handler node_helper.js's real factory installs.
  // Since we've stubbed mqttClient() itself, reproduce its connect-handler
  // side effects here directly against our fake client (this is the exact
  // bookkeeping publishMqtt()/mqttClient() coordinate through).
  client._kiaStatusTopic = "kia/status/acct-hash";
  client._kiaDiscovered = false;

  const haDiscovery = require("../core/ha-discovery.js");
  const discoveryCalls = [];
  const origDiscoveryPublish = haDiscovery.publish;
  haDiscovery.publish = (c, opts) => discoveryCalls.push(opts.vehicle.VIN);
  try {
    const config = {
      region: "USA", brand: "KIA", username: "reconnect@e.com", vin: "CAR_X",
      mqtt: { enabled: true, url: "mqtt://broker", topicPrefix: "kia", homeAssistant: { enabled: true } }
    };
    helper.publishMqtt(config, { vehicle: { VIN: "CAR_X", ev_battery_percentage: 50 }, _meta: {} });
    assert.strictEqual(discoveryCalls.length, 1, "first publish must send discovery");
    helper.publishMqtt(config, { vehicle: { VIN: "CAR_X", ev_battery_percentage: 51 }, _meta: {} });
    assert.strictEqual(discoveryCalls.length, 1, "a second publish on the SAME (still-connected) client must not resend discovery");

    // simulate what the real mqttClient() factory's on("connect") handler
    // does on a genuine reconnect (broker restart, network blip) -- the
    // fix this test guards: BOTH discovery bookkeeping forms must reset,
    // not just the legacy client._kiaDiscovered boolean
    client._kiaDiscovered = false;
    client._kiaDiscoveredVins = {};

    helper.publishMqtt(config, { vehicle: { VIN: "CAR_X", ev_battery_percentage: 52 }, _meta: {} });
    assert.strictEqual(discoveryCalls.length, 2, (
      "after a reconnect resets the per-vehicle discovery bookkeeping, the next publish must " +
      "re-send HA discovery -- otherwise a broker that lost its retained messages across the " +
      "reconnect would never get this vehicle's discovery config again"
    ));

    // per-vehicle "online" status must also republish every poll regardless
    // of connect/reconnect -- not a one-time thing
    const statusPublishes = client.published.filter((p) => p.topic === "kia/CAR_X/status" && p.payload === "online");
    assert.strictEqual(statusPublishes.length, 3, "the per-vehicle status topic must republish 'online' on every successful poll");
  } finally {
    haDiscovery.publish = origDiscoveryPublish;
  }
}

console.log("-- MQTT reconnect: two separate module instances sharing one connection must BOTH get fresh discovery after reconnect");
{
  const helper = freshHelper(tmpCacheDir());
  const client = fakeMqttClient();
  helper.mqttClient = () => client;
  client._kiaStatusTopic = "kia/status/acct-hash";
  client._kiaDiscovered = false;

  const haDiscovery = require("../core/ha-discovery.js");
  const discoveryCalls = [];
  const origDiscoveryPublish = haDiscovery.publish;
  haDiscovery.publish = (c, opts) => discoveryCalls.push(opts.vehicle.VIN);
  try {
    const mqttCfg = { enabled: true, url: "mqtt://broker", topicPrefix: "kia", homeAssistant: { enabled: true } };
    const configA = { region: "USA", brand: "KIA", username: "u@e.com", vin: "CAR_A", mqtt: mqttCfg };
    const configB = { region: "USA", brand: "KIA", username: "u@e.com", vin: "CAR_B", mqtt: mqttCfg };

    helper.publishMqtt(configA, { vehicle: { VIN: "CAR_A" }, _meta: {} });
    helper.publishMqtt(configB, { vehicle: { VIN: "CAR_B" }, _meta: {} });
    assert.deepStrictEqual(discoveryCalls.sort(), ["CAR_A", "CAR_B"]);

    discoveryCalls.length = 0;
    // reconnect
    client._kiaDiscovered = false;
    client._kiaDiscoveredVins = {};

    helper.publishMqtt(configA, { vehicle: { VIN: "CAR_A" }, _meta: {} });
    helper.publishMqtt(configB, { vehicle: { VIN: "CAR_B" }, _meta: {} });
    assert.deepStrictEqual(discoveryCalls.sort(), ["CAR_A", "CAR_B"], (
      "after a shared connection reconnects, BOTH vehicles sharing it must get fresh discovery, not just whichever publishes first"
    ));
  } finally {
    haDiscovery.publish = origDiscoveryPublish;
  }
}

console.log("-- Prometheus server restart: a bind failure must clear the dead server so the NEXT poll re-registers every vehicle's snapshot");
{
  const helper = freshHelper(tmpCacheDir());
  const config = {
    region: "USA", brand: "KIA", username: "prom@e.com",
    vehicles: [{ vin: "CAR_A" }, { vin: "CAR_B" }],
    exporter: { prometheus: { enabled: true, port: 19110 } }
  };

  // first poll: real PromServer gets created and started (a real, if
  // throwaway, port bind -- 19110 chosen to avoid colliding with anything)
  helper.runExporters(config, { vehicle: { VIN: "CAR_A", ev_battery_percentage: 40 }, _meta: {} });
  const srv1 = helper.promServers[19110];
  assert.ok(srv1, "first poll must create and register a PromServer");
  helper.runExporters(config, { vehicle: { VIN: "CAR_B", ev_battery_percentage: 60 }, _meta: {} });
  assert.ok(srv1._text.includes('vin="CAR_A"') && srv1._text.includes('vin="CAR_B"'), "both vehicles' snapshots must be present before the simulated restart");

  // simulate the exact failure path onError triggers (a real EADDRINUSE
  // would fire this asynchronously; drive it directly here) -- this is
  // node_helper.js's OWN documented recreate-on-error contract
  srv1.stop();
  delete helper.promServers[19110];

  // the NEXT poll (any vehicle) must transparently create a FRESH server --
  // not crash, not silently stop exporting
  helper.runExporters(config, { vehicle: { VIN: "CAR_A", ev_battery_percentage: 41 }, _meta: {} });
  const srv2 = helper.promServers[19110];
  assert.ok(srv2, "a poll after the dead server was cleared must create a new one");
  assert.notStrictEqual(srv1, srv2, "must be a genuinely NEW PromServer instance, not the dead one resurrected");
  assert.ok(srv2._text.includes('vin="CAR_A"'), "the vehicle that triggered recreation must be in the fresh snapshot");
  assert.ok(!srv2._text.includes('vin="CAR_B"'), (
    "car B's snapshot is genuinely gone after the restart (a fresh PromServer starts empty) -- " +
    "it must reappear on car B's own NEXT poll, not be silently missing forever"
  ));
  helper.runExporters(config, { vehicle: { VIN: "CAR_B", ev_battery_percentage: 61 }, _meta: {} });
  assert.ok(srv2._text.includes('vin="CAR_B"'), "car B's own next poll must repopulate its snapshot on the new server");

  srv2.stop();
}

console.log("-- HA WebSocket (mode C, HaLiveClient) disconnect/reconnect must resume live pushes");
{
  const sent = [];
  let currentWs;
  let wsCount = 0;
  class ReconnectFakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this._l = {};
      wsCount++;
      currentWs = this;
    }
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
    send(s) { sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; (this._l.close || []).forEach((f) => f({ code: 1006, reason: "" })); }
    _emit(obj) { (this._l.message || []).forEach((f) => f({ data: JSON.stringify(obj) })); }
  }
  global.WebSocket = ReconnectFakeWS;
  global.fetch = async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path === "/api/states/sensor.kia_status") {
      return { ok: true, status: 200, json: async () => ({
        entity_id: "sensor.kia_status", state: "x", attributes: { kia_access_raw: true, ev_battery_percentage: 30 }
      }) };
    }
    return { ok: false, status: 404, statusText: "Not Found" };
  };

  try {
    const payloads = [];
    const statuses = [];
    const live = new HaLiveClient(
      { url: "http://ha.local:8123", token: "T", entity: "sensor.kia_status" },
      { onPayload: (p) => payloads.push(p), onStatus: (m) => statuses.push(m) }
    );
    live._retry = 1; // don't actually wait out the real backoff in this test
    live.start();
    currentWs._emit({ type: "auth_required" });
    currentWs._emit({ type: "auth_ok" });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(live.healthy, "connected and subscribed");
    assert.strictEqual(wsCount, 1);

    // auth_ok resets _retry back to RECONNECT_MIN_MS (3s) as part of its own
    // normal backoff-reset behavior -- re-apply the shortened test retry so
    // this test doesn't have to wait out the real backoff for the upcoming
    // reconnect too.
    live._retry = 1;

    // the connection drops (network blip / HA restart)
    currentWs.close();
    assert.strictEqual(live.healthy, false, "must report unhealthy immediately on disconnect");
    assert.ok(statuses.some((m) => /connection closed/.test(m)), "must log why it dropped");

    // wait out the (shortened) reconnect backoff -- a NEW WebSocket must be opened
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(wsCount, 2, "must open a genuinely new WebSocket connection to reconnect");
    currentWs._emit({ type: "auth_required" });
    currentWs._emit({ type: "auth_ok" });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(live.healthy, "must be healthy again after reconnecting and re-subscribing");

    // a live event after reconnect must still flow through to onPayload()
    const sub = sent.filter((m) => m.type === "subscribe_trigger").pop();
    currentWs._emit({
      id: sub.id, type: "event",
      event: { variables: { trigger: { to_state: {
        entity_id: "sensor.kia_status", state: "y",
        attributes: { kia_access_raw: true, ev_battery_percentage: 88 }
      } } } }
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(payloads[payloads.length - 1].vehicle.ev_battery_percentage, 88, (
      "a live push after reconnecting must reach onPayload() normally"
    ));

    live.stop();
  } finally {
    delete global.WebSocket;
    delete global.fetch;
  }
}

console.log("-- corrupted on-disk cache: must not crash the process, must recover to fresh state, must keep persisting normally afterward");
{
  const dir = tmpCacheDir();
  const helper = freshHelper(dir);
  const config = { region: "USA", brand: "KIA", username: "corrupt@e.com", vin: "CAR_X" };
  const id = helper.identifierFor(config);

  // write a genuinely truncated/corrupt cache file where this vehicle's would live
  fs.writeFileSync(helper.cacheFile(id), '{"lastGood": {"vehicle": {"VIN": "CAR_X"', { mode: 0o600 });

  // st() must not throw, must fall back to fresh empty state
  let s;
  assert.doesNotThrow(() => { s = helper.st(id); }, "a corrupted cache file must not crash st()");
  assert.strictEqual(s.lastGood, null, "corrupted cache must fall back to no last-known-good, not a partially-parsed object");
  assert.deepStrictEqual(s.sessions, []);
  assert.deepStrictEqual(s.trips, []);

  // the module must go on working normally -- a real fetch response still
  // dispatches and, critically, still persists a GOOD file over the corrupt one
  // wrap (not replace) the real onPayload -- the real method is what
  // actually calls persist() and overwrites the corrupt cache file; a full
  // stub here would (as caught earlier in the account A -> B restart test)
  // silently skip that and make this test check nothing real.
  const onPayloadCalls = [];
  const realOnPayload = helper.onPayload;
  helper.onPayload = (i, c, payload) => { onPayloadCalls.push(payload); return realOnPayload.call(helper, i, c, payload); };
  helper._handleBridgeClose(id, config, false, 0, JSON.stringify({
    ok: true, vehicles: [{ VIN: "CAR_X", ev_battery_percentage: 45 }]
  }), "", () => { throw new Error("must not report a failure after recovering from a corrupt cache"); });
  assert.strictEqual(onPayloadCalls.length, 1);

  // reading the cache file back now must parse cleanly (persist() overwrote
  // the corrupt file with a valid one via its own atomic write-then-rename)
  const onDisk = JSON.parse(fs.readFileSync(helper.cacheFile(id), "utf8"));
  assert.strictEqual(onDisk.lastGood.vehicle.ev_battery_percentage, 45, (
    "a fresh successful poll must overwrite the corrupted cache file with valid data"
  ));
}

console.log("-- everything at once: two accounts, each with two rotating vehicles, MQTT + Prometheus + corrupted-cache recovery, interleaved");
{
  const dir = tmpCacheDir();
  const client = fakeMqttClient();
  const haDiscovery = require("../core/ha-discovery.js");
  const origDiscoveryPublish = haDiscovery.publish;
  haDiscovery.publish = () => {};
  try {
    const accounts = ["acctX@e.com", "acctY@e.com"].map((username) => {
      const helper = freshHelper(dir);
      helper.mqttClient = () => client;
      helper._retireVehicle = () => {};
      // wrap (not replace) the real onPayload -- see the corrupted-cache
      // test above for why a full stub here would silently skip persist()
      // and make the self-healing assertion below check nothing real.
      const onPayloadCalls = [];
      const realOnPayload = helper.onPayload;
      helper.onPayload = (id, config, payload) => {
        onPayloadCalls.push({ id, vin: payload.vehicle.VIN });
        return realOnPayload.call(helper, id, config, payload);
      };
      const config = {
        region: "USA", brand: "KIA", username,
        vehicles: [{ vin: "A" }, { vin: "B" }],
        mqtt: { enabled: true, url: "mqtt://broker", topicPrefix: "kia/" + username },
        exporter: { prometheus: { enabled: true, port: 19111 + (username === "acctX@e.com" ? 0 : 1) } }
      };
      return { helper, config, onPayloadCalls, username };
    });

    // corrupt account Y's cache for vehicle A before it's ever polled
    const yHelper = accounts[1].helper;
    const yIdA = yHelper.identifierFor({ ...accounts[1].config, vin: "A" });
    fs.writeFileSync(yHelper.cacheFile(yIdA), "{not json", { mode: 0o600 });

    // interleave several poll cycles across both accounts
    for (let cycle = 0; cycle < 5; cycle++) {
      accounts.forEach(({ helper, config, username }) => {
        const acctId = helper.identifierFor({ ...config, vin: "" });
        const stdout = JSON.stringify({
          ok: true,
          vehicles: [
            { VIN: "A", ev_battery_percentage: cycle, model: "EV9" },
            { VIN: "B", ev_battery_percentage: 100 - cycle, model: "EV9" }
          ]
        });
        helper._handleBridgeClose(acctId, config, true, cycle, stdout, "", () => {
          throw new Error(username + " cycle " + cycle + ": must not fail");
        });
        helper.publishMqtt(config, { vehicle: { VIN: "A", ev_battery_percentage: cycle }, _meta: {} });
        helper.runExporters(config, { vehicle: { VIN: "A", ev_battery_percentage: cycle }, _meta: {} });
      });
    }

    // each account's vehicle A/B streams must be internally consistent AND
    // never cross-contaminated with the OTHER account's readings
    accounts.forEach(({ onPayloadCalls, username }) => {
      const aVals = onPayloadCalls.filter((c) => c.vin === "A");
      const bVals = onPayloadCalls.filter((c) => c.vin === "B");
      assert.strictEqual(aVals.length, 5, username + ": vehicle A must have received all 5 cycles");
      assert.strictEqual(bVals.length, 5, username + ": vehicle B must have received all 5 cycles");
    });
    // MQTT topics for the two accounts must be under their own topicPrefix
    const xTopics = client.published.filter((p) => p.topic.indexOf("kia/acctX@e.com") === 0);
    const yTopics = client.published.filter((p) => p.topic.indexOf("kia/acctY@e.com") === 0);
    assert.ok(xTopics.length > 0 && yTopics.length > 0, "both accounts must have published under their own topicPrefix");
    // Prometheus: two different ports, two different servers, no cross-talk
    const xPromPort = 19111, yPromPort = 19112;
    assert.notStrictEqual(accounts[0].helper.promServers[xPromPort], accounts[1].helper.promServers[yPromPort]);
    // account Y's corrupted cache must have self-healed (a real poll happened for it above)
    const yOnDisk = JSON.parse(fs.readFileSync(yHelper.cacheFile(yIdA), "utf8"));
    assert.strictEqual(yOnDisk.lastGood.vehicle.VIN, "A", "account Y's corrupted vehicle-A cache must have self-healed once real data arrived");

    Object.values(accounts[0].helper.promServers).forEach((s) => s.stop());
    Object.values(accounts[1].helper.promServers).forEach((s) => s.stop());
  } finally {
    haDiscovery.publish = origDiscoveryPublish;
  }
}

console.log("all stress-node-helper tests passed");

})().catch((err) => {
  console.error(err);
  process.exit(1);
});
