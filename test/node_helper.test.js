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
const exporter = require("../exporter.js");

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

// ---- _handleBridgeClose(): Kia USA rotate mode -- KiaUvoApiUSA never
// populates a vehicle's real VIN at all (confirmed against the installed
// hyundai_kia_connect_api source), so a Kia USA account's vehicles come
// back with VIN blank and only `id` populated. Before vehicleIdentity()
// existed, rotate filtering read ONLY vehicle.VIN/vehicle.vin -- every
// vehicle on a Kia USA multi-vehicle account computed the SAME empty
// identity, matched nothing in config.vehicles, and got silently dropped:
// zero onPayload() calls from an otherwise-successful account fetch, with
// no error anywhere. This is exactly the same fallback kia_client.py's
// _vehicle_key()/_vehicle_key_dict() already use for HA's config flow and
// AccountPoller.select_own_vehicle() -- proven here on the Node/rotate
// side too. ----
{
  const helper = freshHelper();
  const onPayloadCalls = [];
  helper.onPayload = (id, config, payload) => onPayloadCalls.push({ id, payload });
  helper._retireVehicle = () => {};

  // config.vehicles' vin: is set to each car's own `id` (what a Kia USA
  // user has to configure, per node_helper.js's vehicleIdentity() docstring
  // and the README) -- neither vehicle in the account response below has
  // a VIN at all.
  const usaConfig = {
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "ABC123" }, { vin: "XYZ789" }]
  };
  const usaAcctId = helper.identifierFor({ ...usaConfig, vin: "" });
  const usaStdout = JSON.stringify({
    ok: true,
    vehicles: [
      { id: "ABC123", VIN: "", model: "EV9", ev_battery_percentage: 55 },
      { id: "XYZ789", VIN: "", model: "EV9", ev_battery_percentage: 70 }
    ]
  });
  helper._handleBridgeClose(usaAcctId, usaConfig, true, 0, usaStdout, "", () => {
    throw new Error("must not report a failure for a clean Kia USA multi-vehicle result");
  });
  assert.strictEqual(onPayloadCalls.length, 2, (
    "both Kia USA vehicles (VIN blank, id-only) must reach onPayload() -- not silently dropped"
  ));
  const usaSubIds = onPayloadCalls.map((c) => c.id).sort();
  assert.deepStrictEqual(usaSubIds, [
    "USA|KIA|u@e.com|ABC123", "USA|KIA|u@e.com|XYZ789"
  ], "each Kia USA vehicle must still get its own separate subId (cache/MQTT/Influx/Prometheus identity)");

  // mixed case: one vehicle reports a real VIN, the other (Kia USA-style)
  // only an id -- exactly where identity normalisation tends to regress by
  // working for the "easy" vehicle and silently dropping the other
  onPayloadCalls.length = 0;
  const mixedConfig = {
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "REALVIN1" }, { vin: "ONLYID2" }]
  };
  const mixedAcctId = helper.identifierFor({ ...mixedConfig, vin: "" });
  const mixedStdout = JSON.stringify({
    ok: true,
    vehicles: [
      { id: "internal-1", VIN: "REALVIN1", model: "EV6" },
      { id: "ONLYID2", VIN: "", model: "EV9" }
    ]
  });
  helper._handleBridgeClose(mixedAcctId, mixedConfig, true, 0, mixedStdout, "", () => {
    throw new Error("must not report a failure for a clean mixed VIN/id result");
  });
  const mixedSubIds = onPayloadCalls.map((c) => c.id).sort();
  assert.deepStrictEqual(mixedSubIds, [
    "USA|KIA|u@e.com|ONLYID2", "USA|KIA|u@e.com|REALVIN1"
  ], "a real-VIN vehicle and an id-only vehicle must BOTH reach onPayload(), each under its own identity");
}

// ---- runExporters()/publishMqtt(): the same VIN-or-id fallback must apply
// to the Influx/Prometheus tag and the rotate-mode MQTT topic segment, not
// just onPayload() dispatch -- otherwise a Kia USA rotate account would
// still have every vehicle collide onto the SAME MQTT topics (the exact
// scenario publishMqtt()'s own comment warns about) even after dispatch
// itself was fixed. ----
{
  const helper = freshHelper();
  const rotateConfig = {
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "ABC123" }],
    mqtt: { enabled: true, url: "mqtt://broker" }
  };
  let published = null;
  helper.mqttClient = () => ({
    publish: (topic) => { published = published || topic; }
  });
  helper.publishMqtt(rotateConfig, { vehicle: { id: "ABC123", VIN: "" }, _meta: {} });
  assert.ok(published && published.indexOf("/ABC123/") !== -1, (
    "a Kia USA vehicle (VIN blank) in rotate mode must still get its own " +
    "id-scoped MQTT topic segment, not collide onto the un-scoped base topic: " + published
  ));

  const exporterConfig = {
    exporter: { influx: { url: "http://influx", bucket: "b" } }
  };
  let capturedTags = null;
  const origPushInflux = exporter.pushInflux;
  exporter.pushInflux = (cfg) => { capturedTags = cfg.tags; return Promise.resolve(204); };
  try {
    helper.runExporters(exporterConfig, { vehicle: { id: "ABC123", VIN: "" }, _meta: {} });
  } finally {
    exporter.pushInflux = origPushInflux;
  }
  assert.strictEqual(capturedTags && capturedTags.vin, "ABC123", (
    "a Kia USA vehicle's Influx tag must fall back to its id, not be silently omitted: " +
    JSON.stringify(capturedTags)
  ));
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

// ---- _retireRemovedFromConfig(): the config-removal retirement diff must
// run unconditionally -- an adversarial-review finding: retirement used to
// live ONLY inside _handleBridgeClose's success branch, so a vehicle
// removed from config.vehicles while every fetch kept failing (bad
// credentials, a cooldown, an outage) stayed "online"/reporting stale
// numbers in MQTT/Prometheus for as long as the fetch kept failing --
// backwards, since the config change itself needs no account data to
// detect. handleFetch() now calls this at the very top, before any fetch
// is even attempted; exercised directly here (not via handleFetch(), which
// would need a real subprocess) to prove it's independent of fetch outcome
// by construction, not just "still passes on the success path". ----
{
  const helper = freshHelper();
  const retired = [];
  helper._retireVehicle = (config, vin) => retired.push(vin);

  const config = {
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "VIN_A" }, { vin: "VIN_B" }]
  };
  const acctId = helper.identifierFor({ ...config, vin: "" });

  // establish rotateVins -- no fetch involved at all
  helper._retireRemovedFromConfig(acctId, config);
  assert.deepStrictEqual(retired, []);

  // VIN_B removed from config -- must retire immediately, with NO fetch
  // (successful or otherwise) ever having happened for this call
  const configWithoutB = { ...config, vehicles: [{ vin: "VIN_A" }] };
  helper._retireRemovedFromConfig(acctId, configWithoutB);
  assert.deepStrictEqual(retired, ["VIN_B"], (
    "removing a vehicle from config must retire it even with zero successful fetches -- " +
    "this diff only needs config.vehicles, never account data"
  ));

  // a non-rotating config (no vehicles: list) must be a no-op, not throw
  retired.length = 0;
  helper._retireRemovedFromConfig(acctId, { region: "USA", brand: "KIA", username: "u@e.com" });
  assert.deepStrictEqual(retired, []);
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

// ---- mqttClient(): the LWT topic must be exposed on the client (as
// _kiaStatusTopic) so publishMqtt() can hand it to ha-discovery.js -- a
// hostile-audit finding: HA discovery previously pointed availability_topic
// at a topic with no real MQTT Last-Will, so a vehicle stayed "online" in
// HA forever after an ungraceful process death. ----
{
  const helper = freshHelper();
  const client = helper.mqttClient({ url: "mqtt://127.0.0.1:1", username: "a@b.com", topicPrefix: "kia" });
  assert.strictEqual(client._kiaStatusTopic, client.options.will.topic, (
    "_kiaStatusTopic must be exactly the connection's real LWT-backed topic"
  ));
  Object.values(helper.mqttClients).forEach((c) => { if (c && c.end) c.end(true); });
}

// ---- publishMqtt(): discovery must be given BOTH the connection's LWT
// topic and the per-vehicle status topic, so HA's availability actually
// reflects an ungraceful process death -- not just the best-effort,
// non-LWT-backed per-VIN "online" publish. Every vehicle with a
// resolvable identity gets its own scoped status topic now, rotating or
// not -- see publishMqtt()'s own comment for why "only in rotate mode"
// missed the equally-real multiple-single-vehicle-module-blocks case. ----
{
  const helper = freshHelper();
  const haDiscovery = require("../core/ha-discovery.js");
  const calls = [];
  const origPublish = haDiscovery.publish;
  haDiscovery.publish = (client, opts) => calls.push(opts);
  try {
    const rotateConfig = {
      vehicles: [{ vin: "VIN1" }],
      mqtt: { enabled: true, url: "mqtt://127.0.0.1:1", topicPrefix: "kia", homeAssistant: { enabled: true } }
    };
    helper.publishMqtt(rotateConfig, { vehicle: { VIN: "VIN1" }, _meta: {} });
    assert.strictEqual(calls.length, 1);
    const client = helper.mqttClients[Object.keys(helper.mqttClients)[0]];
    assert.strictEqual(calls[0].lwtTopic, client._kiaStatusTopic);
    assert.strictEqual(calls[0].vehicleStatusTopic, "kia/VIN1/status", (
      "rotate mode must pass the per-VIN status topic alongside the LWT topic"
    ));

    calls.length = 0;
    const singleConfig = {
      mqtt: { enabled: true, url: "mqtt://127.0.0.1:2", topicPrefix: "kia2", homeAssistant: { enabled: true } }
    };
    helper.publishMqtt(singleConfig, { vehicle: { VIN: "VIN9" }, _meta: {} });
    assert.strictEqual(calls[0].vehicleStatusTopic, "kia2/VIN9/status", (
      "a lone single-vehicle module config must ALSO get a per-vehicle status topic -- " +
      "not just rotate mode -- since it can still share its mqtt connection with a " +
      "DIFFERENT single-vehicle module block (two separate module instances is a " +
      "documented way to run more than one car)"
    ));
  } finally {
    haDiscovery.publish = origPublish;
    Object.values(helper.mqttClients).forEach((c) => { if (c && c.end) c.end(true); });
  }
}

// ---- publishMqtt(): two SEPARATE module instances (each its own
// single-vehicle `vin:` config, README's "add this module more than once"
// option -- neither one "rotating") sharing one mqtt connection must NOT
// collapse onto the same topics -- a hostile-review finding: this was
// real cross-vehicle data corruption (car B's telemetry retained-
// overwriting car A's under a topic/HA-discovery device still labelling
// it car A), not just a missing convenience, since the old scoping logic
// only looked at whether THIS config had config.vehicles set, never at
// whether the underlying connection was actually shared. Proves both the
// multi-module-block path and the single-module rotate path produce the
// SAME isolation contract. ----
{
  const helper = freshHelper();
  const published = [];
  helper.mqttClient = () => ({ publish: (topic, payload) => published.push({ topic, payload }) });

  const mqttCfg = { enabled: true, url: "mqtt://broker", topicPrefix: "kia" };
  const configA = { region: "USA", brand: "KIA", username: "u@e.com", vin: "CAR_A", mqtt: mqttCfg };
  const configB = { region: "USA", brand: "KIA", username: "u@e.com", vin: "CAR_B", mqtt: mqttCfg };

  helper.publishMqtt(configA, { vehicle: { VIN: "CAR_A", ev_battery_percentage: 50 }, _meta: {} });
  helper.publishMqtt(configB, { vehicle: { VIN: "CAR_B", ev_battery_percentage: 60 }, _meta: {} });

  const stateTopics = published.filter((p) => p.topic.endsWith("/state")).map((p) => p.topic).sort();
  assert.deepStrictEqual(stateTopics, ["kia/CAR_A/state", "kia/CAR_B/state"], (
    "two separate single-vehicle module configs sharing one mqtt connection must publish " +
    "to SEPARATE, per-vehicle-scoped topics, not the same unscoped kia/state for both: " +
    JSON.stringify(stateTopics)
  ));
  const aState = JSON.parse(published.find((p) => p.topic === "kia/CAR_A/state").payload);
  const bState = JSON.parse(published.find((p) => p.topic === "kia/CAR_B/state").payload);
  assert.strictEqual(aState.VIN, "CAR_A", "kia/CAR_A/state must hold car A's own data, not car B's");
  assert.strictEqual(bState.VIN, "CAR_B", "kia/CAR_B/state must hold car B's own data, not car A's");

  // the same isolation contract, produced the ROTATE-mode way instead (one
  // module config, config.vehicles listing both cars) -- must land on the
  // exact same topic shape as the two-separate-module-blocks case above
  const helper2 = freshHelper();
  const published2 = [];
  helper2.mqttClient = () => ({ publish: (topic, payload) => published2.push({ topic, payload }) });
  const rotateConfig = {
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "CAR_A" }, { vin: "CAR_B" }], mqtt: mqttCfg
  };
  helper2.publishMqtt(rotateConfig, { vehicle: { VIN: "CAR_A", ev_battery_percentage: 50 }, _meta: {} });
  helper2.publishMqtt(rotateConfig, { vehicle: { VIN: "CAR_B", ev_battery_percentage: 60 }, _meta: {} });
  const rotateStateTopics = published2.filter((p) => p.topic.endsWith("/state")).map((p) => p.topic).sort();
  assert.deepStrictEqual(rotateStateTopics, stateTopics, (
    "rotate mode and multiple single-vehicle module blocks must produce the identical " +
    "per-vehicle topic shape for the same two cars"
  ));
}

// ---- onPayload(): a poll where ONLY rangeReach changed (no vehicle
// telemetry change, no session/trip change) must still persist to disk --
// a hostile-audit finding. rangeReach is a sibling of payload.vehicle, not
// part of it, so dataChanged (computed from payload.vehicle alone) never
// reflects a rangeReach-only update; the persist decision used to run
// BEFORE emitData() folded the new rangeReach into s.rangeReach, so such a
// cycle could skip persist() entirely, leaving the disk cache stale until
// some unrelated later change also happened to trigger one. ----
{
  const dir = tmpCacheDir();
  const helper = freshHelper(dir);
  const id = helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN1" });
  const config = {};

  const vehicle = { VIN: "VIN1", ev_battery_percentage: 80 };
  helper.onPayload(id, config, {
    vehicle,
    rangeReach: { driveTimeSource: "estimate", pois: [] },
    _meta: {}
  });
  const onDiskFirst = JSON.parse(fs.readFileSync(helper.cacheFile(id), "utf8"));
  assert.deepStrictEqual(onDiskFirst.rangeReach, { driveTimeSource: "estimate", pois: [] });

  // second poll: identical vehicle telemetry (no dataChanged), no session/
  // trip activity, but a genuinely NEW rangeReach (e.g. traffic conditions
  // changed the routed drive time) -- this alone must still persist
  helper.onPayload(id, config, {
    vehicle, // same object/content -> dataChanged === false
    rangeReach: { driveTimeSource: "tomtom", pois: [{ name: "Work", km: 10 }] },
    _meta: {}
  });
  const onDiskSecond = JSON.parse(fs.readFileSync(helper.cacheFile(id), "utf8"));
  assert.deepStrictEqual(onDiskSecond.rangeReach, { driveTimeSource: "tomtom", pois: [{ name: "Work", km: 10 }] }, (
    "a rangeReach-only change must still be written to disk, not deferred until some unrelated " +
    "later change also happens to trigger a persist"
  ));

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- onPayload() -> core/analytics.js: a full trip/charge cycle driven
// through the real onPayload() must flow rangeKm/outsideTempC into closed
// trips and come out the other end as real, non-null payload.analytics
// (observedEfficiency/rangeAccuracy/chargingPerformance/drivingPatterns) --
// proving the wiring added tonight (tripState.rangeKm/outsideTempC ->
// trips.update() -> s.analytics) actually works end to end, not just at
// the unit level each piece was already tested at. ----
{
  const dir = tmpCacheDir();
  const helper = freshHelper(dir);
  const notifications = [];
  helper.sendSocketNotification = (name, data) => notifications.push({ name, data });
  const id = helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN1" });
  const config = {
    units: "imperial",
    tripLog: { minKm: 0.5, parkGapMin: 1 },
    // the charging-session poll samples below sit at this exact GPS point --
    // without a home point configured, atHome stays unknown/null and the
    // session would land in the "unknown" bucket instead of "home"
    chargeLog: { homeLat: 40.1, homeLon: -74.0, homeRadiusKm: 0.5 }
  };

  const HOME = { lat: 40.0, lon: -74.0 };
  // onPayload() timestamps every sample with Date.now() internally (trips.js's
  // parkGapMin gating needs real elapsed time, not a `t` field this test can
  // pass in directly) -- fake the clock so trip 1/2's park->drive->park cycles
  // actually cross the 1-minute parkGapMin without the test itself sleeping.
  let t = Date.now() - 10 * 864e5; // 10 days ago -- well inside drivingPatterns' 30-day window
  const realNow = Date.now;
  Date.now = () => t;

  function poll(vehicle) {
    // model: "EV9" -- this fixture has no configured capacity_kwh and no
    // reported ev_battery_capacity, relying on sessions.js/trips.js's
    // EV9-only DEFAULT_CAPACITY_KWH fallback to have a real pack size to
    // compute kwh from at all (see that fallback's own tests for why it's
    // gated on the model, not applied blindly to every vehicle).
    helper.onPayload(id, config, { vehicle: Object.assign({ model: "EV9" }, vehicle), _meta: {} });
  }

  try {
    // -- trip 1: park (anchor: range 250km, 20C outside) -> drive 10km,
    // using 5% -> park again long enough to close --
    poll({ VIN: "VIN1", odometer: 1000, ev_battery_percentage: 80, engine_is_running: false,
      location_latitude: HOME.lat, location_longitude: HOME.lon,
      ev_driving_range: 250, outside_temperature: 20 });
    t += 10e3;
    poll({ VIN: "VIN1", odometer: 1010, ev_battery_percentage: 75, engine_is_running: true,
      location_latitude: 40.05, location_longitude: -74.0,
      ev_driving_range: 235, outside_temperature: 20 });
    t += 70e3; // past the 1-minute parkGapMin from the drive sample above
    poll({ VIN: "VIN1", odometer: 1010, ev_battery_percentage: 75, engine_is_running: false,
      location_latitude: 40.05, location_longitude: -74.0,
      ev_driving_range: 235, outside_temperature: 20 });

    // -- trip 2: same shape, a second closed trip so tripsSampled > 1 --
    t += 10e3;
    poll({ VIN: "VIN1", odometer: 1010, ev_battery_percentage: 95, engine_is_running: false,
      location_latitude: 40.05, location_longitude: -74.0,
      ev_driving_range: 300, outside_temperature: 18 });
    t += 10e3;
    poll({ VIN: "VIN1", odometer: 1022, ev_battery_percentage: 89, engine_is_running: true,
      location_latitude: 40.1, location_longitude: -74.0,
      ev_driving_range: 283, outside_temperature: 18 });
    t += 70e3;
    poll({ VIN: "VIN1", odometer: 1022, ev_battery_percentage: 89, engine_is_running: false,
      location_latitude: 40.1, location_longitude: -74.0,
      ev_driving_range: 283, outside_temperature: 18 });

    // -- one home charging session: plug in + charge (a second still-charging
    // sample so the session has nonzero minutes, since avgKw needs > 0) +
    // stop -- config.chargeLog.homeLat/homeLon (set on `config` above) makes
    // node_helper.js's own atHome computation resolve to true for these GPS
    // coords; without it atHome stays unknown/null and the session would
    // land in the "unknown" location bucket instead of "home" (see
    // sessions.js's update()).
    poll({ VIN: "VIN1", odometer: 1022, ev_battery_percentage: 89, engine_is_running: false,
      ev_battery_is_charging: true, ev_battery_is_plugged_in: true, ev_charging_power: 11,
      location_latitude: 40.1, location_longitude: -74.0 });
    t += 30 * 60e3;
    poll({ VIN: "VIN1", odometer: 1022, ev_battery_percentage: 93, engine_is_running: false,
      ev_battery_is_charging: true, ev_battery_is_plugged_in: true, ev_charging_power: 11,
      location_latitude: 40.1, location_longitude: -74.0 });
    t += 30 * 60e3;
    poll({ VIN: "VIN1", odometer: 1022, ev_battery_percentage: 97, engine_is_running: false,
      ev_battery_is_charging: false, ev_battery_is_plugged_in: false, ev_charging_power: 0,
      location_latitude: 40.1, location_longitude: -74.0 });

    assert.ok(helper.st(id).trips.length >= 2, "both trips must have closed: " + JSON.stringify(helper.st(id).trips));
    assert.ok(helper.st(id).sessions.length >= 1, "the charge session must have closed");

    const last = notifications[notifications.length - 1];
    assert.strictEqual(last.name, "KIA_DATA");
    const a = last.data.payload.analytics;
    assert.ok(a, "onPayload() must produce payload.analytics");
    assert.ok(a.observedEfficiency && a.observedEfficiency.overall > 0, (
      "observedEfficiency must reflect the closed trips' rangeKm/outsideTempC-bearing samples: " +
      JSON.stringify(a.observedEfficiency)
    ));
    assert.ok(a.rangeAccuracy && a.rangeAccuracy.kiaEstimate > 0, (
      "rangeAccuracy needs startRangeKm, which only flows through if tripState.rangeKm reached " +
      "trips.update() -- " + JSON.stringify(a.rangeAccuracy)
    ));
    assert.ok(a.chargingPerformance && a.chargingPerformance.home && a.chargingPerformance.home.count === 1);
    assert.ok(a.drivingPatterns && a.drivingPatterns.tripCount >= 2);
  } finally {
    Date.now = realNow;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- emitData(): the post-restart lazy-analytics fallback -- a cache file
// with trips/sessions but no persisted `analytics` key (an old cache file
// written before this feature existed, or any restart, since s.analytics is
// a derived value and deliberately never persisted) must still produce
// payload.analytics on the very first emitData() call, not sit empty until
// the next trip/session change. ----
{
  const dir = tmpCacheDir();
  const helper = freshHelper(dir);
  const id = helper.identifierFor({ region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN1" });

  const cacheOnDisk = {
    _kiaAccessIdHash: helper._idHash(id),
    trips: [{
      startedAt: Date.now() - 3600e3, endedAt: Date.now() - 3000e3, minutes: 10,
      distanceKm: 10, distanceMi: 6.2, usedPct: 5, startPct: 80, endPct: 75,
      chargedDuring: false, startRangeKm: 250, outsideTempC: 20
    }],
    sessions: [{
      startedAt: Date.now() - 7200e3, endedAt: Date.now() - 7000e3, minutes: 60,
      startPct: 40, endPct: 80, gainedPct: 40, kwh: 40, avgKw: 40, location: "home"
    }],
    openTrip: null, openSession: null, history: [], lastGood: null, failStreak: 0
  };
  fs.writeFileSync(helper.cacheFile(id), JSON.stringify(cacheOnDisk));

  const s = helper.st(id);
  assert.strictEqual(s.analytics, undefined, "a restored cache with no analytics key must leave s.analytics unset until first access");

  const notifications = [];
  helper.sendSocketNotification = (name, data) => notifications.push({ name, data });
  helper.emitData(id, { units: "imperial" }, { vehicle: {}, _meta: {} });

  const a = notifications[0].data.payload.analytics;
  assert.ok(a, "emitData() must lazily compute analytics on first access after a restart");
  assert.ok(a.observedEfficiency && a.observedEfficiency.overall > 0);
  assert.ok(a.rangeAccuracy && a.rangeAccuracy.kiaEstimate > 0);
  assert.ok(a.chargingPerformance && a.chargingPerformance.home && a.chargingPerformance.home.count === 1);
  assert.strictEqual(helper.st(id).analytics, a, "the lazily-computed value must be cached on s.analytics, not recomputed every call");

  fs.rmSync(dir, { recursive: true, force: true });
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
