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
  // rangeReach (HA's driving-times data, mode C) must round-trip through the
  // cache the same as lastParked/rangeMap/etc, or a MagicMirror restart
  // silently drops the "Driving times" widget back to empty until HA
  // supplies fresh data.
  sA.rangeReach = { driveTimeSource: "tomtom", pois: [{ name: "Work", km: 12 }] };
  helper.persist(idA);

  const onDisk = JSON.parse(fs.readFileSync(helper.cacheFile(idA), "utf8"));
  assert.ok(onDisk._kiaAccessIdHash, "persist() must tag the file with an identity hash");
  assert.deepStrictEqual(onDisk.lastParked, { lat: 1, lon: 2, odo: 100 });
  assert.deepStrictEqual(onDisk.rangeReach, { driveTimeSource: "tomtom", pois: [{ name: "Work", km: 12 }] });
  if (process.platform !== "win32") {
    const mode = fs.statSync(helper.cacheFile(idA)).mode & 0o777;
    assert.strictEqual(mode, 0o600, (
      "the cache file carries the vehicle's raw API dump (GPS/location " +
      "history, VIN) -- it must be owner-only, same as token.json"
    ));
  }

  // a second st() call for the SAME id after clearing in-memory state must
  // restore from disk, not start blank
  delete helper.state[idA];
  const reloaded = helper.st(idA);
  assert.deepStrictEqual(reloaded.lastParked, { lat: 1, lon: 2, odo: 100 });
  assert.deepStrictEqual(reloaded.rangeReach, { driveTimeSource: "tomtom", pois: [{ name: "Work", km: 12 }] });
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

// ---- mqttClient(): the account-scoped status topic's identity segment must
// never collide between two genuinely different accounts, even when their
// usernames sanitise to the same readable text (e.g. "/" stripped makes
// "foo/bar@x" and "foo_bar@x" identical) ----
{
  const helper = freshHelper();
  const a = helper.mqttClient({
    url: "mqtt://127.0.0.1:1", username: "foo/bar@example.com", topicPrefix: "kia"
  });
  const b = helper.mqttClient({
    url: "mqtt://127.0.0.1:1", username: "foo_bar@example.com", topicPrefix: "kia"
  });
  assert.notStrictEqual(a.options.will.topic, b.options.will.topic, (
    "two different usernames that sanitise to the same text must still get " +
    "different status topics, or one account's online/offline status can " +
    "silently apply to the other"
  ));
  assert.ok(a.options.will.topic.startsWith("kia/status/foo_bar@example.com-"), a.options.will.topic);

  Object.values(helper.mqttClients).forEach((c) => { if (c && c.end) c.end(true); });
}

// ---- request/hour cap: must be keyed by ACCOUNT (region|brand|username),
// not by the vin-scoped `id` -- a hostile-audit finding: two module configs
// covering the SAME real Kia account under different vin-scopes (e.g. one
// single-vehicle block plus a separate rotate block for the same login)
// used to each get their own independent request budget, silently doubling
// the real request rate against Kia's servers despite maxRequestsPerHour
// being set identically on both. ----
{
  const helper = freshHelper();
  const single = { region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN1", maxRequestsPerHour: 1 };
  const rotate = {
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "VIN1" }, { vin: "VIN2" }], maxRequestsPerHour: 1
  };
  assert.strictEqual(
    helper.acctKeyFor(single), helper.acctKeyFor(rotate),
    "the same real account must produce the same rate-limit key regardless of vin-scope"
  );
  const idSingle = helper.identifierFor(single);
  const idRotate = helper.identifierFor({ ...rotate, vin: "" });
  assert.notStrictEqual(idSingle, idRotate, "sanity check: the two configs really do have different vehicle-cache ids");

  // end-to-end: exhaust the shared cap via the single-vehicle config, then
  // confirm the ROTATE config (a different `id`, but the SAME real account)
  // is blocked by the very next call -- not just that the key helper
  // matches, but that handleFetch() actually enforces one shared bucket.
  // A deliberately-invalid pythonBin means any spawn that DOES slip through
  // fails harmlessly and asynchronously -- this test only inspects
  // synchronous state (inFlight / the served-from-cache report), so it
  // never needs to wait for that failure to land.
  const served = [];
  helper.serve = (id, config, opts) => served.push({ id, opts });
  const badBin = { pythonBin: "this-binary-does-not-exist-kia-test" };

  helper.handleFetch(Object.assign({}, single, badBin));
  assert.strictEqual(helper.inFlight[idSingle], true, "the first call (under cap) must proceed to spawn");
  assert.strictEqual(served.length, 0, "the first call must not be served-from-cache -- it's under the cap");

  helper.handleFetch(Object.assign({}, rotate, badBin));
  assert.strictEqual(helper.inFlight[idRotate], undefined, (
    "the rotate config's call must be BLOCKED by the cap the single-vehicle config already used up -- " +
    "they share one real Kia account and must share one request budget"
  ));
  assert.strictEqual(served.length, 2, ( // fanned out per configured vehicle, see _reportServe()
    "the second call must be served from cache (rate-limited), not spawn a second bridge process"
  ));
}

// ---- maybeRangeMap(): an older, slower fetch must never overwrite a
// newer, faster one's result with stale data -- a hostile-audit finding.
// s.rangeMap used to be written unconditionally with no check that the
// writer was still the LATEST call for this id, so a car that moved
// between two overlapping calls (concretely reachable in HA poll mode,
// whose 30s default interval is often shorter than this function's own
// up-to-~30s worst-case external-API time) could have its map silently
// regress to an old, wrong-location image whenever the earlier call
// happened to resolve after a later one. ----
async function testRangeMapRace() {
  const dir = tmpCacheDir();
  const helper = freshHelper(dir);
  const id = helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN1" });

  const prevFetch = global.fetch;
  const pending = [];
  global.fetch = (url) => new Promise((resolve) => pending.push({ url, resolve }));
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const boundary = [
    { longitude: 0, latitude: 0 }, { longitude: 0, latitude: 1 },
    { longitude: 1, latitude: 1 }, { longitude: 1, latitude: 0 }
  ];
  const tomtomOk = { ok: true, json: async () => ({ reachableRange: { boundary } }) };
  const config = { rangeMap: { apiKey: "geo-key", tomtomKey: "tt-key", width: 200, height: 200 } };

  try {
    // cycle 1: the car's OLD position (key1) -- kept pending throughout
    const payload1 = { vehicle: { location_latitude: 40.0, location_longitude: -80.0, ev_driving_range: 300 } };
    const p1 = helper.maybeRangeMap(id, config, payload1);
    await flush();
    assert.strictEqual(pending.length, 1, "cycle 1's oneWay fetch must be in flight");

    // cycle 2: the car's NEWER position (key2) -- starts while cycle 1 is still pending
    const payload2 = { vehicle: { location_latitude: 41.0, location_longitude: -81.0, ev_driving_range: 300 } };
    const p2 = helper.maybeRangeMap(id, config, payload2);
    await flush();
    assert.strictEqual(pending.length, 2, "cycle 2's oneWay fetch must also now be in flight");

    // resolve cycle 2 FULLY first -- the newer cycle finishes before the older one
    pending[1].resolve(tomtomOk);
    await flush();
    assert.strictEqual(pending.length, 3, "cycle 2's round-trip fetch must now be in flight");
    pending[2].resolve(tomtomOk);
    await p2;

    const s = helper.st(id);
    const key2 = s.rangeMap && s.rangeMap.key;
    assert.ok(key2, "cycle 2 must have written a rangeMap");

    // NOW let cycle 1 (older, slower, now-stale) finish
    pending[0].resolve(tomtomOk);
    await flush();
    assert.strictEqual(pending.length, 4, "cycle 1's round-trip fetch must now be in flight");
    pending[3].resolve(tomtomOk);
    await p1;

    assert.strictEqual(s.rangeMap.key, key2, (
      "cycle 1 (older, slower, now-stale) must never overwrite cycle 2's (newer, faster) " +
      "rangeMap -- this is the exact stale-write race the generation guard exists to prevent"
    ));
  } finally {
    global.fetch = prevFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

testRangeMapRace()
  .then(() => console.log("all node_helper tests passed"))
  .catch((err) => { console.error(err); process.exitCode = 1; });
