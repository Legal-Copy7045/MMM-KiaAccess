/* node test/mmm-kiaaccess.test.js
 *
 * MMM-KiaAccess.js (the frontend module) had no direct test coverage in
 * production -- it's a MagicMirror frontend module, coupled to browser
 * globals (`Module`, `Log`, `document`) rather than `require()`, and every
 * rotate-mode bug in it (per-vehicle state bleed, wrong routing of
 * KIA_DATA/KIA_ERROR to the active vs. cached vehicle, cache-identifier
 * construction) was previously verified only by a throwaway script during
 * that one fix. This file loads the real MMM-KiaAccess.js (see
 * require-mm-module.js for how it substitutes the browser globals) and
 * exercises the highest-risk, DOM-independent logic directly: per-vehicle
 * condition-state swapping (_loadCondState/_saveCondState/_CTX_FIELDS),
 * identifier construction (_fullIdentifier/vinFromIdentifier/isForMe), and
 * socketNotificationReceived()'s active-vs-cached vehicle routing.
 *
 * getDom() and the *El() rendering helpers are NOT covered here -- they
 * need a real DOM and are addressed separately (see the core/visuals.js
 * split).
 */
const assert = require("assert");
const loadMMModule = require("./require-mm-module.js");

// Builds a fresh module instance, runs start() (which schedules real
// timers -- fetch watchdog, vehicle-rotate interval), then immediately
// clears every timer start() may have armed so `node` can exit and so
// scheduleFetch()'s 0ms KIA_FETCH doesn't fire mid-test. Tests that
// specifically want a timer (scheduleRotate()) re-arm and re-clear it
// themselves.
function freshModule(overrides) {
  const mod = loadMMModule();
  mod.sendSocketNotification = () => {};
  mod.updateDom = () => {};
  mod.config = Object.assign({}, mod.defaults, overrides);
  mod.start();
  clearTimeout(mod._timer);
  clearTimeout(mod._watchdog);
  clearInterval(mod._rotateTimer);
  return mod;
}

// ---- _fullIdentifier / vinFromIdentifier: must build exactly the same
// shape node_helper.js's identifierFor() does, so KIA_LAST_PARKED and
// KIA_DATA/KIA_ERROR for one vehicle always land in the same slot ----
{
  const mod = freshModule({
    region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN1"
  });
  assert.strictEqual(mod._fullIdentifier(null), "USA|KIA|u@e.com|VIN1", (
    "non-rotating: falls back to config.vin"
  ));
  assert.strictEqual(mod._fullIdentifier("VIN2"), "USA|KIA|u@e.com|VIN2", (
    "an explicit vin overrides config.vin (rotate mode)"
  ));
  assert.strictEqual(mod.vinFromIdentifier("USA|KIA|u@e.com|VIN1"), "VIN1");
  // String(identifier || "").split("|") always yields at least one (possibly
  // empty) segment, so both a missing and an empty identifier come back as ""
  assert.strictEqual(mod.vinFromIdentifier(""), "");
  assert.strictEqual(mod.vinFromIdentifier(undefined), "");
}

// ---- isForMe(): non-rotating mode accepts only its own account+vin
// identifier; rotate mode accepts any configured vehicle's, rejects one
// that was never configured ----
{
  const single = freshModule({
    region: "USA", brand: "KIA", username: "u@e.com", vin: "VIN1"
  });
  assert.strictEqual(single.isForMe("USA|KIA|u@e.com|VIN1"), true);
  assert.strictEqual(single.isForMe("USA|KIA|u@e.com|VIN2"), false);
  assert.strictEqual(single.isForMe("EU|KIA|u@e.com|VIN1"), false, "region mismatch must be rejected");

  const rotating = freshModule({
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "VIN_A" }, { vin: "VIN_B" }]
  });
  assert.strictEqual(rotating.isForMe("USA|KIA|u@e.com|VIN_A"), true);
  assert.strictEqual(rotating.isForMe("USA|KIA|u@e.com|VIN_B"), true);
  assert.strictEqual(rotating.isForMe("USA|KIA|u@e.com|VIN_C"), false, (
    "a vehicle the account has but that isn't configured here must be rejected"
  ));
}

// ---- activeVin() / rotateHeader(): pure functions of activeVehicleIndex,
// null outside rotate mode ----
{
  const single = freshModule({ vin: "VIN1" });
  assert.strictEqual(single.activeVin(), null, "no `vehicles:` configured -- not rotating");

  const rotating = freshModule({
    vehicles: [{ vin: "VIN_A", header: "Car A" }, { vin: "VIN_B" }]
  });
  assert.strictEqual(rotating.activeVin(), "VIN_A");
  assert.strictEqual(rotating.rotateHeader(), "Car A", "explicit header: wins");
  rotating.activeVehicleIndex = 1;
  assert.strictEqual(rotating.activeVin(), "VIN_B");
  assert.strictEqual(rotating.rotateHeader(), null, (
    "no header: override and no cached payload yet -- falls back to null (caller uses config.header)"
  ));
  rotating.vehiclePayloads.VIN_B = { vehicle: { name: "My EV9" } };
  assert.strictEqual(rotating.rotateHeader(), "My EV9", "falls back to the vehicle's own reported name");
}

// ---- scheduleRotate(): only arms an interval with 2+ configured vehicles;
// a no-op (no timer) with 0 or 1 ----
{
  const single = freshModule({ vin: "VIN1" });
  single.scheduleRotate();
  assert.strictEqual(single._rotateTimer, undefined, "a single (or zero) vehicle must never arm a rotate timer");

  const rotating = freshModule({
    vehicles: [{ vin: "VIN_A" }, { vin: "VIN_B" }],
    vehicleRotateInterval: 20000
  });
  rotating.scheduleRotate();
  assert.ok(rotating._rotateTimer, "2+ configured vehicles must arm a rotate timer");
  clearInterval(rotating._rotateTimer); // avoid keeping the test process alive
}

// ---- _loadCondState / _saveCondState / _CTX_FIELDS: the per-vehicle
// context swap that stops one car's hysteresis/alert/tow-detection state
// from leaking onto another car when rotating. This is the exact class of
// bug described in the code's own comment above _CTX_FIELDS: switching
// cars must never compare car B's GPS reading against car A's parked
// anchor. ----
{
  const mod = freshModule({
    vehicles: [{ vin: "VIN_A" }, { vin: "VIN_B" }]
  });

  // car A: parks in Pittsburgh, one-shot alert already announced
  mod._loadCondState("VIN_A");
  mod._lastParked = { lat: 40.44, lon: -79.99, odo: 12345 };
  mod._homeUnpluggedSince = 1000;
  mod.announcedActive = { batteryLow: true };
  mod._saveCondState("VIN_A");

  // car B: fresh state, never touched this session yet -- must NOT see any
  // of car A's values, not even as defaults
  mod._loadCondState("VIN_B");
  assert.strictEqual(mod._lastParked, null, "car B must start with no parked anchor, not car A's");
  assert.strictEqual(mod._homeUnpluggedSince, null);
  assert.deepStrictEqual(mod.announcedActive, {});
  mod._lastParked = { lat: 41.5, lon: -81.7, odo: 500 }; // Cleveland
  mod._saveCondState("VIN_B");

  // back to car A: must restore EXACTLY what was saved, unaffected by B
  mod._loadCondState("VIN_A");
  assert.deepStrictEqual(mod._lastParked, { lat: 40.44, lon: -79.99, odo: 12345 }, (
    "switching back to car A must restore its own anchor, not car B's Cleveland position " +
    "(the exact bug this state-swap exists to prevent)"
  ));
  assert.strictEqual(mod._homeUnpluggedSince, 1000);
  assert.deepStrictEqual(mod.announcedActive, { batteryLow: true });

  // every _CTX_FIELDS entry must round-trip, not just the ones asserted above
  mod._CTX_FIELDS.forEach((f) => {
    assert.notStrictEqual(mod[f], undefined, `_CTX_FIELDS entry "${f}" must be defined on \`this\` after _loadCondState`);
  });
}

// ---- _loadCondState(vin): first touch this session seeds _lastParked from
// that vehicle's own cached KIA_DATA payload (survives a MagicMirror
// restart), not from whatever car was active before it ----
{
  const mod = freshModule({
    vehicles: [{ vin: "VIN_A" }, { vin: "VIN_B" }]
  });
  mod.vehiclePayloads.VIN_B = { lastParked: { lat: 9, lon: 9, odo: 9 } };
  mod._loadCondState("VIN_B");
  assert.deepStrictEqual(mod._lastParked, { lat: 9, lon: 9, odo: 9 }, (
    "a vehicle's first-touch state must seed from ITS OWN cached payload's lastParked"
  ));
}

// ---- _loadCondState(null) (non-rotating mode): one-time restore of
// _lastParked from rawPayload, and only ever once (undefined vs. legitimate
// null must be distinguishable) ----
{
  const mod = freshModule({ vin: "VIN1" });
  mod.rawPayload = { lastParked: { lat: 5, lon: 5, odo: 5 } };
  assert.strictEqual(mod._lastParked, undefined, "never touched yet this session");
  mod._loadCondState(null);
  assert.deepStrictEqual(mod._lastParked, { lat: 5, lon: 5, odo: 5 });

  // now a legitimate null (car has no anchor yet) must NOT be silently
  // overwritten by a stale rawPayload on the next poll
  mod._lastParked = null;
  mod.rawPayload = { lastParked: { lat: 99, lon: 99, odo: 99 } };
  mod._loadCondState(null);
  assert.strictEqual(mod._lastParked, null, (
    "a legitimate null anchor must not be re-fetched from a later, unrelated payload"
  ));
}

// ---- socketNotificationReceived(): rotate mode must only touch
// rawPayload/rendering for the ACTIVE vehicle; a non-active vehicle's
// KIA_DATA/KIA_ERROR is cached silently and must not disturb what's on
// screen ----
{
  const mod = freshModule({
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "VIN_A" }, { vin: "VIN_B" }]
  });
  // VIN_A is active (activeVehicleIndex 0 from start())
  assert.strictEqual(mod.activeVin(), "VIN_A");
  mod.rawPayload = { vehicle: { VIN: "VIN_A" }, _meta: {} };
  const sentinelRawPayload = mod.rawPayload;

  const idB = mod._fullIdentifier("VIN_B");
  mod.socketNotificationReceived("KIA_DATA", {
    identifier: idB,
    payload: { vehicle: { VIN: "VIN_B", ev_battery_percentage: 42 }, _meta: {} }
  });

  assert.strictEqual(mod.rawPayload, sentinelRawPayload, (
    "a non-active vehicle's KIA_DATA must never touch rawPayload (the active vehicle's own data)"
  ));
  assert.strictEqual(mod.vehiclePayloads.VIN_B.vehicle.ev_battery_percentage, 42, (
    "the non-active vehicle's payload must still be cached for when it becomes active"
  ));

  // now KIA_DATA for the ACTIVE vehicle must update rawPayload
  const idA = mod._fullIdentifier("VIN_A");
  mod.socketNotificationReceived("KIA_DATA", {
    identifier: idA,
    payload: { vehicle: { VIN: "VIN_A", ev_battery_percentage: 77 }, _meta: {} }
  });
  assert.strictEqual(mod.rawPayload.vehicle.ev_battery_percentage, 77, (
    "the active vehicle's own KIA_DATA must update rawPayload"
  ));

  // an identifier for a vehicle that was never configured must be ignored
  // entirely (isForMe() gate) -- must not throw, must not create a cache entry
  mod.socketNotificationReceived("KIA_DATA", {
    identifier: "USA|KIA|u@e.com|VIN_UNCONFIGURED",
    payload: { vehicle: { VIN: "VIN_UNCONFIGURED" }, _meta: {} }
  });
  assert.strictEqual(mod.vehiclePayloads.VIN_UNCONFIGURED, undefined, (
    "an unconfigured vehicle's data must be dropped by the isForMe() gate, not cached"
  ));

  clearTimeout(mod._timer);
  clearTimeout(mod._watchdog);
}

// ---- socketNotificationReceived(): payload.analytics (core/analytics.js's
// observed-performance data, computed server-side by node_helper.js) must
// flow into mod.analytics for the active vehicle, and must be cached in
// vehiclePayloads for a non-active one exactly like trips/sessions/rangeMap
// already are -- the analyticsEl() widget (untested here, needs a real DOM)
// reads mod.analytics directly, so if this plumbing silently dropped the
// field the widget would just stay blank with no error anywhere. ----
{
  const mod = freshModule({
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "VIN_A" }, { vin: "VIN_B" }]
  });
  assert.strictEqual(mod.analytics, null, "starts unset");

  const fakeAnalytics = {
    observedEfficiency: { overall: 2.5, unit: "mi/%" },
    rangeAccuracy: { accuracyPct: -12, kiaEstimate: 250, observedEstimate: 220, unit: "mi" },
    chargingPerformance: { home: { avgKw: 11.2 } },
    drivingPatterns: { tripsPerWeek: 5.2, avgTripDistance: 14, unit: "mi" }
  };

  // a non-active vehicle's analytics must be cached, not applied to mod.analytics
  const idB = mod._fullIdentifier("VIN_B");
  mod.socketNotificationReceived("KIA_DATA", {
    identifier: idB,
    payload: { vehicle: { VIN: "VIN_B" }, analytics: fakeAnalytics, _meta: {} }
  });
  assert.strictEqual(mod.analytics, null, "a non-active vehicle's analytics must not touch the active vehicle's view");
  assert.deepStrictEqual(mod.vehiclePayloads.VIN_B.analytics, fakeAnalytics, (
    "the non-active vehicle's analytics must still be cached for when it becomes active"
  ));

  // the active vehicle's own analytics must land on mod.analytics
  const idA = mod._fullIdentifier("VIN_A");
  mod.socketNotificationReceived("KIA_DATA", {
    identifier: idA,
    payload: { vehicle: { VIN: "VIN_A" }, analytics: fakeAnalytics, _meta: {} }
  });
  assert.deepStrictEqual(mod.analytics, fakeAnalytics);

  // a later poll with no analytics key at all (e.g. before a trip/session
  // has ever closed) must clear the stale value, not leave the previous
  // vehicle/poll's figures on screen
  mod.socketNotificationReceived("KIA_DATA", {
    identifier: idA,
    payload: { vehicle: { VIN: "VIN_A", ev_battery_percentage: 1 }, _meta: {} }
  });
  assert.strictEqual(mod.analytics, null, "a payload with no analytics must not leave the previous poll's stale figures showing");

  clearTimeout(mod._timer);
  clearTimeout(mod._watchdog);
}

// ---- socketNotificationReceived(): KIA_ERROR follows the same
// active-vs-cached routing as KIA_DATA ----
{
  const mod = freshModule({
    region: "USA", brand: "KIA", username: "u@e.com",
    vehicles: [{ vin: "VIN_A" }, { vin: "VIN_B" }]
  });
  mod.errorMessage = null;

  const idB = mod._fullIdentifier("VIN_B");
  mod.socketNotificationReceived("KIA_ERROR", { identifier: idB, error: "auth failed for B" });
  assert.strictEqual(mod.errorMessage, null, "a non-active vehicle's error must not surface on screen");
  assert.strictEqual(mod.vehicleErrors.VIN_B, "auth failed for B");

  const idA = mod._fullIdentifier("VIN_A");
  mod.socketNotificationReceived("KIA_ERROR", { identifier: idA, error: "auth failed for A" });
  assert.strictEqual(mod.errorMessage, "auth failed for A", "the active vehicle's error must surface");

  clearTimeout(mod._timer);
  clearTimeout(mod._watchdog);
}

// ---- drivingTimesEl(): every value interpolated into its innerHTML must be
// escaped, even when it comes from Home Assistant (driveTimeSource,
// dbg.errors) or from the local delayStops config (a colour dropped
// straight into a style="color:..." attribute) rather than the Kia API --
// a security-review finding: these two were building `hint`/the style
// attribute by string concatenation without this.escape(), unlike every
// other dynamic value in this file. Needs a minimal `document` stub since
// this method (deliberately, see recommendation #5's scoping) was not
// extracted into the DOM-free core/dest-planner.js split. ----
{
  const prevDocument = global.document;
  global.document = {
    createElement: () => ({ className: "", innerHTML: "", style: {} })
  };
  try {
    const mod = freshModule({
      visuals: { drivingTimes: { enabled: true, delayStops: [{ pctOver: 10, color: 'red" onmouseover="alert(3)' }] } }
    });
    // core/dest-planner.js isn't loaded as a browser global in this harness
    // (see require-mm-module.js) -- wire it in directly so delayColorFor()
    // actually runs, same as getScripts() would in a real MagicMirror page.
    mod.destPlanner = require("../core/dest-planner.js");
    mod.rangeReach = {
      pois: [{ name: "Home", source: "zone", km: 10, duration_min: 20, delay_min: 5, delay_pct: 80, routed: false }],
      driveTimeSource: "<img src=x onerror=alert(1)>",
      debug: { errors: ["<script>alert(2)</script>"] }
    };
    const el = mod.drivingTimesEl();
    assert.ok(el, "drivingTimesEl() must return an element for this setup");

    assert.ok(!el.innerHTML.includes("<img src=x onerror"), (
      "driveTimeSource from Home Assistant must be escaped before landing in the hint text"
    ));
    assert.ok(el.innerHTML.includes("&lt;img src=x onerror"), "the escaped form must be present instead");

    assert.ok(!el.innerHTML.includes("<script>alert(2)"), (
      "dbg.errors[0] from Home Assistant must be escaped"
    ));
    assert.ok(el.innerHTML.includes("&lt;script&gt;alert(2)"), "the escaped form must be present instead");

    assert.ok(!el.innerHTML.includes('onmouseover="alert(3)'), (
      "a delayStops colour from local config must be escaped before landing in a style attribute " +
      "-- an unescaped quote would let it break out and inject an attribute"
    ));
    assert.ok(el.innerHTML.includes("&quot; onmouseover=&quot;alert(3)"), "the escaped form must be present instead");
  } finally {
    global.document = prevDocument;
  }
}

// ---- drivingTimesEl(): the arrival-kWh hint's pack-size fallback must be
// gated on the vehicle actually being an EV9 (see core/sessions.js's
// isEv9()/resolveCap() for why) -- this method has its OWN separate
// "|| 99.8" fallback for the same reason and had the same bug: blindly
// assuming a 99.8kWh pack for ANY vehicle with no configured/reported
// capacity, silently producing a wrong estimate for every other model. ----
{
  const prevDocument = global.document;
  global.document = {
    createElement: () => ({ className: "", innerHTML: "", style: {} })
  };
  try {
    function buildMod(model) {
      const mod = freshModule({
        visuals: { drivingTimes: { enabled: true } }
      });
      mod.sessionLib = require("../core/sessions.js");
      mod.destPlanner = require("../core/dest-planner.js");
      mod.visualState = () => ({ batteryPct: 70 });
      mod.rawPayload = { vehicle: { model } };
      mod.rangeReach = {
        pois: [{ name: "Home", source: "zone", km: 10, duration_min: 20, arrival_pct: 40 }],
        driveTimeSource: "estimate"
      };
      return mod;
    }

    const nonEv9 = buildMod("Niro EV");
    const elNonEv9 = nonEv9.drivingTimesEl();
    assert.ok(elNonEv9, "must still render for a non-EV9 vehicle");
    assert.ok(!elNonEv9.innerHTML.includes("kWh"), (
      "a non-EV9 model with no configured/reported capacity must NOT show a " +
      "kWh estimate borrowed from the EV9's own pack size: " + elNonEv9.innerHTML
    ));

    const ev9 = buildMod("EV9");
    const elEv9 = ev9.drivingTimesEl();
    assert.ok(elEv9.innerHTML.includes("kWh"), (
      "an actual EV9 with no configured capacity must still fall back to " +
      "its own 99.8kWh default: " + elEv9.innerHTML
    ));
  } finally {
    global.document = prevDocument;
  }
}

// ---- _modalReason: MagicMirror has exactly ONE mirror-wide alert-module
// modal slot -- a hostile-audit finding: in rotate mode, two DIFFERENT
// vehicles' critical conditions must never both believe they independently
// own it. Car A's modal must stay open (car B falls back to a plain
// notification growl) until car A's own condition actually clears. ----
{
  const mod = freshModule({
    vehicles: [{ vin: "VIN_A" }, { vin: "VIN_B" }],
    notifications: { enabled: true, criticalPopup: true, notifyOnStartup: true }
  });
  const sent = [];
  mod.sendNotification = (n, payload) => sent.push({ n, payload });
  mod.flatMap = {}; // just needs to be truthy for processConditions() to proceed
  // A minimal conditions.evaluate() stub -- real threshold logic isn't the
  // point of this test, only that TWO DIFFERENT reasons (one per vehicle)
  // each independently go critical+active.
  let reason;
  mod.conditions = {
    evaluate: () => ({
      conditions: [{ reason, level: "critical", active: true, oneShot: false, title: "t", message: "m" }],
      meta: { charging: null }
    })
  };

  reason = "battery_critical_a";
  mod._loadCondState("VIN_A");
  mod.processConditions();
  mod._saveCondState("VIN_A");
  const modalsAfterA = sent.filter((s) => s.n === "SHOW_ALERT" && s.payload.type === "alert");
  assert.strictEqual(modalsAfterA.length, 1, "car A's critical condition must open the modal");

  reason = "battery_critical_b";
  mod._loadCondState("VIN_B");
  mod.processConditions();
  mod._saveCondState("VIN_B");
  const modalsAfterB = sent.filter((s) => s.n === "SHOW_ALERT" && s.payload.type === "alert");
  assert.strictEqual(modalsAfterB.length, 1, (
    "car B must NOT open a second modal while car A's own (different reason) modal is still open -- " +
    "the whole mirror has exactly one modal slot, not one per vehicle"
  ));
  const growlsAfterB = sent.filter((s) => s.n === "SHOW_ALERT" && s.payload.type === "notification");
  assert.strictEqual(growlsAfterB.length, 1, "car B must fall back to a plain notification growl instead");

  // car A's condition clears (still car A's own context) -- its modal, and
  // only its modal, must be the one dismissed
  mod._loadCondState("VIN_A");
  reason = "battery_critical_a";
  mod.conditions.evaluate = () => ({
    conditions: [{ reason: "battery_critical_a", level: "critical", active: false, oneShot: false, title: "t", message: "m" }],
    meta: { charging: null }
  });
  mod.processConditions();
  mod._saveCondState("VIN_A");
  const hides = sent.filter((s) => s.n === "HIDE_ALERT");
  assert.strictEqual(hides.length, 1, "car A's own modal clearing must dismiss it");
}

console.log("all mmm-kiaaccess tests passed");
