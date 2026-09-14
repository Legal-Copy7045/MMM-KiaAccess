/* node test/node_helper.test.js
 *
 * node_helper.js has no direct test coverage in production -- it's the
 * MagicMirror backend, deeply coupled to child_process/mqtt/fs, and until
 * now every fix to it was verified only by a one-off throwaway script
 * during that fix, then discarded. This file makes that permanent: it
 * loads the real node_helper.js (see require-node-helper.js for how it
 * gets around `require("node_helper")`/`require("logger")` only existing
 * inside a running MagicMirror), and exercises the highest-risk logic
 * directly -- cache identity/migration, the rotate-mode vehicle pipeline
 * (_handleBridgeClose, extracted from handleFetch()'s child.on("close")
 * specifically so it's callable without spawning a real bridge process),
 * failure fan-out, vehicle retirement, and the MQTT connection identity
 * rules.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const loadNodeHelper = require("./require-node-helper.js");

function freshHelper(cacheDir) {
  const helper = loadNodeHelper();
  helper.sendSocketNotification = () => {}; // overridden per-test where the calls matter
  helper.start();
  if (cacheDir) helper.cacheDir = cacheDir;
  return helper;
}

function tmpCacheDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kia-node-helper-test-"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- identifierFor ----
{
  const helper = freshHelper();
  assert.strictEqual(
    helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN1" }),
    "USA|KIA|u@e.com|VIN1"
  );
  assert.strictEqual(
    helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "" }),
    "USA|KIA|u@e.com|auto",
    "a blank vin falls back to the account-level 'auto' identity"
  );
}

// ---- cache identity / persist / migration ----
{
  const dir = tmpCacheDir();
  const helper = freshHelper(dir);
  const idA = helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN_A" });
  const idB = helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN_B" });

  // persist() writes an identity tag; st() round-trips everything through it
  const sA = helper.st(idA);
  sA.lastGood = { vehicle: { VIN: "VIN_A" } };
  sA.history = [{ t: 1, ev: 50, v12: 90 }];
  sA.lastParked = { lat: 1, lon: 2, odo: 100 };
  helper.persist(idA);

  const onDisk = JSON.parse(fs.readFileSync(helper.cacheFile(idA), "utf8"));
  assert.ok(onDisk._kiaAccessIdHash, "persist() must tag the file with an identity hash");
  assert.deepStrictEqual(onDisk.lastParked, { lat: 1, lon: 2, odo: 100 });

  // a second st() call for the SAME id after clearing in-memory state must
  // restore from disk, not start blank
  delete helper.state[idA];
  const reloaded = helper.st(idA);
  assert.deepStrictEqual(reloaded.lastParked, { lat: 1, lon: 2, odo: 100 });
  assert.strictEqual(reloaded.history.length, 1);

  // migrateLegacyCache(): a genuinely untagged (pre-v2.43.1) leftover file,
  // and ONLY that kind, may be adopted for a brand-new vehicle's first
  // cache file
  const legacyFile = path.join(dir, "some-old-hash.json");
  fs.writeFileSync(legacyFile, JSON.stringify({ lastGood: { vehicle: { VIN: "OLD" } } }));
  const bId = helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN_NEW" });
  const bFile = helper.cacheFile(bId);
  assert.ok(fs.existsSync(bFile), "the untagged legacy file must have been adopted");
  assert.strictEqual(fs.existsSync(legacyFile), false, "adopting a file renames it, not copies it");
  // mirrors production: the vehicle's first successful fetch writes its own
  // TAGGED data over the migrated (still content-untagged) file -- without
  // this, the renamed-but-not-yet-persisted file would still look like an
  // eligible untagged leftover to the NEXT brand-new vehicle below.
  helper.st(bId).lastGood = { vehicle: { VIN: "VIN_NEW" } };
  helper.persist(bId);

  // a THIRD brand-new vehicle now finds no untagged leftovers at all (A's
  // and B's own files both exist, but both are tagged) -- must start
  // fresh, not silently inherit either one's history
  const cId = helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN_C" });
  const cFile = helper.cacheFile(cId);
  const cDisk = fs.existsSync(cFile) ? JSON.parse(fs.readFileSync(cFile, "utf8")) : null;
  assert.ok(!cDisk, "a vehicle with no untagged leftover to adopt must start with no cache file at all");

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- migrateLegacyCache() must NEVER adopt an already-tagged file (a
// DIFFERENT vehicle's real v2.56+ cache) even when it's the only leftover
// present -- this is the exact bug fixed in v2.57: a brand-new vehicle's
// first cache file silently inheriting another vehicle's history. ----
{
  const dir = tmpCacheDir();
  const helper = freshHelper(dir);
  const otherId = helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN_OTHER" });
  helper.st(otherId).lastGood = { vehicle: { VIN: "VIN_OTHER" } };
  helper.persist(otherId); // writes a TAGGED file -- the only file in the dir

  const newId = helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN_NEW2" });
  const newFile = helper.cacheFile(newId);
  assert.strictEqual(fs.existsSync(newFile), false, (
    "a tagged file belonging to a DIFFERENT vehicle must never be adopted, " +
    "even as the sole leftover -- otherwise a new vehicle's first cache " +
    "silently inherits another car's trip/charge history"
  ));
  const stillThere = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.strictEqual(stillThere.length, 1, "the other vehicle's own file must be untouched");

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- _reportFailure() / _reportServe(): dedup + fan-out ----
{
  const helper = freshHelper();
  const failCalls = [];
  helper.fail = (id, config, message) => failCalls.push({ id, message });

  const nonRotatingConfig = { region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN1" };
  helper._reportFailure("acct-id", nonRotatingConfig, false, "boom");
  assert.deepStrictEqual(failCalls, [{ id: "acct-id", message: "boom" }], (
    "not rotating: must report exactly once, under the given account-level id"
  ));

  failCalls.length = 0;
  const rotatingConfig = {
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "vin1" }, { vin: "VIN1" }, { vin: "vin2" }] // "vin1" duplicated, different case
  };
  helper._reportFailure("acct-id", rotatingConfig, true, "boom");
  const ids = failCalls.map((c) => c.id).sort();
  assert.deepStrictEqual(ids, [
    "USA|KIA|u@e.com|VIN1", "USA|KIA|u@e.com|VIN2"
  ], "rotating: fanned out once per DISTINCT configured vin, duplicates collapsed");

  const serveCalls = [];
  helper.serve = (id, config, opts) => serveCalls.push({ id, opts });
  helper._reportServe("acct-id", rotatingConfig, true, { stale: true, note: "capped" });
  assert.strictEqual(serveCalls.length, 2, "serve fan-out must also dedup duplicate vins");
}

// ---- _handleBridgeClose(): the core rotate-mode pipeline, extracted from
// handleFetch()'s child.on("close") so it's callable without a real bridge
// process. ----
{
  const helper = freshHelper();
  const onPayloadCalls = [];
  helper.onPayload = (id, config, payload) => onPayloadCalls.push({ id, payload });
  helper._retireVehicle = () => {}; // exercised separately below

  const config = {
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "VIN_A" }, { vin: "VIN_B" }]
  };
  const acctId = helper.identifierFor({ ...config, vin: "" });

  // bad JSON -> reportOnce with a clear message, nothing processed
  {
    const reports = [];
    helper._handleBridgeClose(acctId, config, true, 1, "not json", "stderr text", (m) => reports.push(m));
    assert.strictEqual(reports.length, 1);
    assert.ok(/bridge produced no JSON/.test(reports[0]));
    assert.strictEqual(onPayloadCalls.length, 0);
  }

  // result.ok === false -> reportOnce with that error, nothing processed
  {
    const reports = [];
    helper._handleBridgeClose(
      acctId, config, true, 0,
      JSON.stringify({ ok: false, error: "auth failed" }), "", (m) => reports.push(m)
    );
    assert.deepStrictEqual(reports, ["auth failed"]);
    assert.strictEqual(onPayloadCalls.length, 0);
  }

  // empty vehicles array -> reportOnce, nothing processed
  {
    const reports = [];
    helper._handleBridgeClose(
      acctId, config, true, 0,
      JSON.stringify({ ok: true, vehicles: [] }), "", (m) => reports.push(m)
    );
    assert.deepStrictEqual(reports, ["bridge returned no vehicles"]);
  }

  // THE finding this test exists to pin down: an account with MORE
  // vehicles than are configured must only process the configured ones.
  {
    onPayloadCalls.length = 0;
    const stdout = JSON.stringify({
      ok: true,
      vehicles: [
        { VIN: "VIN_A", ev_battery_percentage: 50 },
        { VIN: "VIN_B", ev_battery_percentage: 60 },
        { VIN: "VIN_C", ev_battery_percentage: 70 } // NOT in config.vehicles
      ]
    });
    helper._handleBridgeClose(acctId, config, true, 0, stdout, "", () => {
      throw new Error("must not report a failure for a clean multi-vehicle result");
    });
    const seenVins = onPayloadCalls.map((c) => c.payload.vehicle.VIN).sort();
    assert.deepStrictEqual(seenVins, ["VIN_A", "VIN_B"], (
      "an unconfigured vehicle returned by the account must never reach onPayload()"
    ));
    // each vehicle must be routed under its OWN subId, not the account id
    const subIds = onPayloadCalls.map((c) => c.id).sort();
    assert.deepStrictEqual(subIds, [
      "USA|KIA|u@e.com|VIN_A", "USA|KIA|u@e.com|VIN_B"
    ]);
  }

  // non-rotating (single-vehicle) path: uses the FIRST vehicle, under the
  // given `id` directly (no per-vin subId)
  {
    onPayloadCalls.length = 0;
    const singleConfig = { region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN_X" };
    const singleId = helper.identifierFor(singleConfig);
    const stdout = JSON.stringify({ ok: true, vehicles: [{ VIN: "VIN_X" }] });
    helper._handleBridgeClose(singleId, singleConfig, false, 0, stdout, "", () => {
      throw new Error("must not report a failure");
    });
    assert.strictEqual(onPayloadCalls.length, 1);
    assert.strictEqual(onPayloadCalls[0].id, singleId);
  }
}

// ---- _handleBridgeClose(): vehicle retirement (both the config-removal
// path and the account-miss debounce) ----
{
  const helper = freshHelper();
  helper.onPayload = () => {};
  const retired = [];
  helper._retireVehicle = (config, vin) => retired.push(vin);

  const config = {
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "VIN_A" }, { vin: "VIN_B" }]
  };
  const acctId = helper.identifierFor({ ...config, vin: "" });
  const bothPresent = JSON.stringify({
    ok: true, vehicles: [{ VIN: "VIN_A" }, { VIN: "VIN_B" }]
  });

  // cycle 1: both configured and both present -- establishes rotateVins,
  // nothing retired yet
  helper._handleBridgeClose(acctId, config, true, 0, bothPresent, "", () => {});
  assert.deepStrictEqual(retired, []);

  // cycle 2: VIN_B removed from config entirely -- must retire immediately
  // (config-removal path doesn't need a debounce: it's an explicit choice,
  // not a possibly-transient account hiccup)
  const configWithoutB = { ...config, vehicles: [{ vin: "VIN_A" }] };
  const onlyAReturned = JSON.stringify({ ok: true, vehicles: [{ VIN: "VIN_A" }] });
  helper._handleBridgeClose(acctId, configWithoutB, true, 0, onlyAReturned, "", () => {});
  assert.deepStrictEqual(retired, ["VIN_B"], "removing a vehicle from config must retire it on the very next fetch");

  // account-miss debounce: VIN_B re-added to config, but the ACCOUNT stops
  // returning it -- must NOT retire on the first (or second) miss
  retired.length = 0;
  const configWithB = config;
  for (let i = 0; i < 2; i++) {
    helper._handleBridgeClose(acctId, configWithB, true, 0, onlyAReturned, "", () => {});
  }
  assert.deepStrictEqual(retired, [], "a vehicle missing from the account 1-2 times must not be retired yet");

  // third consecutive miss -- now it retires
  helper._handleBridgeClose(acctId, configWithB, true, 0, onlyAReturned, "", () => {});
  assert.deepStrictEqual(retired, ["VIN_B"], "the Nth consecutive miss must retire it exactly once");

  // it must not retire AGAIN on a further miss (already retired, streak reset)
  retired.length = 0;
  helper._handleBridgeClose(acctId, configWithB, true, 0, onlyAReturned, "", () => {});
  assert.deepStrictEqual(retired, [], "retirement must not repeat every subsequent miss");

  // and reappearing resets the streak entirely
  retired.length = 0;
  helper._handleBridgeClose(acctId, configWithB, true, 0, bothPresent, "", () => {});
  helper._handleBridgeClose(acctId, configWithB, true, 0, onlyAReturned, "", () => {});
  helper._handleBridgeClose(acctId, configWithB, true, 0, onlyAReturned, "", () => {});
  assert.deepStrictEqual(retired, [], "reappearing must reset the miss streak, not just decrement it");
}

// ---- _retireVehicle(): MQTT offline publish + Prometheus snapshot removal ----
{
  const helper = freshHelper();
  const published = [];
  helper.mqttClient = () => ({ publish: (topic, payload, opts) => published.push({ topic, payload, opts }) });
  const removed = [];
  helper.promServers = { 9110: { removeSnapshot: (vin) => removed.push(vin) } };

  const config = {
    mqtt: { enabled: true, url: "mqtt://broker", topicPrefix: "kia/ev9" },
    exporter: { prometheus: { enabled: true, port: 9110 } }
  };
  helper._retireVehicle(config, "VIN_B");
  assert.deepStrictEqual(published, [
    { topic: "kia/ev9/VIN_B/status", payload: "offline", opts: { retain: true } }
  ]);
  assert.deepStrictEqual(removed, ["VIN_B"]);

  // disabled mqtt / exporter -- must not throw, must not publish/remove
  const helper2 = freshHelper();
  helper2.mqttClient = () => { throw new Error("must not be called when mqtt is disabled"); };
  helper2.promServers = {};
  helper2._retireVehicle({ mqtt: { enabled: false }, exporter: null }, "VIN_X");
}

// ---- mqttClient(): connection identity + prefix-collision warning ----
{
  const helper = freshHelper();
  // url|username|password|topicPrefix -- two configs differing ONLY by
  // password must NOT share a connection (this was a real defect: the
  // second config silently reused the first's credentials)
  const clients = new Set();
  const configs = [
    { url: "mqtt://127.0.0.1:1", username: "a", password: "pw1", topicPrefix: "kia" },
    { url: "mqtt://127.0.0.1:1", username: "a", password: "pw2", topicPrefix: "kia" }
  ];
  configs.forEach((m) => {
    const client = helper.mqttClient(m);
    assert.ok(client, "mqtt package is installed in this repo -- connect() must return a client object");
    clients.add(client);
  });
  assert.strictEqual(clients.size, 2, "different passwords must produce different connections");

  // the SAME config must reuse the cached connection, not reconnect
  const again = helper.mqttClient(configs[0]);
  assert.ok(clients.has(again), "an identical config must reuse the existing connection");

  // clean up: close every real (if never-actually-connected) client so the
  // test process can exit promptly
  Object.values(helper.mqttClients).forEach((c) => { if (c && c.end) c.end(true); });
}

console.log("all node_helper tests passed");
