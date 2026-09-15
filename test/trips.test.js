/* node test/trips.test.js */
const assert = require("assert");
const T = require("../core/trips.js");

const MIN = 60000;
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0.1);

// haversineKm must never throw or propagate NaN/Infinity/out-of-range --
// the one caller (close()) already passes a null result through round()
// safely, so it degrades to null (matching the existing null-input case)
assert.ok(T.haversineKm(40.7539, -79.8103, 40.4406, -79.9959) !== null);
assert.strictEqual(T.haversineKm(NaN, -79.8, 40.4, -79.9), null);
assert.strictEqual(T.haversineKm(Infinity, -79.8, 40.4, -79.9), null);
assert.strictEqual(T.haversineKm(500, -79.8, 40.4, -79.9), null, "out-of-range latitude");
assert.strictEqual(T.haversineKm(40.7, -200, 40.4, -79.9), null, "out-of-range longitude");

// feed a list of samples through update(), collect the closed trips
function run(samples, opts) {
  let open = null;
  const closed = [];
  for (const s of samples) {
    const r = T.update(open, s, opts || {});
    open = r.open;
    if (r.closed) closed.push(r.closed);
  }
  return { open, closed };
}

// ---- a plain home -> work drive, parked at each end ----
let t = Date.UTC(2026, 8, 10, 8, 0, 0);
const drive = run([
  { t: t + 0 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
  { t: t + 5 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
  { t: t + 20 * MIN, odometerKm: 1015, batteryPct: 87, carOn: true, locationLat: 40.62, locationLon: -79.80 },
  { t: t + 35 * MIN, odometerKm: 1030, batteryPct: 84, carOn: true, locationLat: 40.55, locationLon: -79.88 },
  { t: t + 45 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 },
  { t: t + 60 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 },
], { pricePerKwh: 0.185, capacityKwh: 100 });

assert.strictEqual(drive.closed.length, 1, "one trip closed");
const trip = drive.closed[0];
assert.strictEqual(trip.distanceKm, 30, "30 km odo delta");
assert.ok(near(trip.distanceMi, 30 * 0.621371));
assert.strictEqual(trip.usedPct, 6, "90 -> 84");
assert.ok(near(trip.kwh, 6.0), "6% of 100 kWh");
assert.ok(trip.miPerKwh > 3 && trip.miPerKwh < 3.2, trip.miPerKwh);
assert.ok(near(trip.cost, 6.0 * 0.185), trip.cost);
assert.strictEqual(trip.chargedDuring, false);
assert.ok(trip.straightLineKm > 0 && trip.straightLineKm < trip.distanceKm);

// ---- startRangeKm / outsideTempC / startPct / endPct: fed for
// core/analytics.js -- must reflect the reading at the trip's START (the
// parked anchor, refreshed right up until departure), and must not break
// anything when omitted (every existing caller before analytics.js) ----
{
  // NOTE: anchor refresh (see trips.js's "still parked at the anchor" block)
  // is gated on a fresh GPS fix arriving alongside the reading, same as
  // pct/lat already are -- a sample with no locationLat can't refresh
  // anything about the anchor, range/temp included.
  const t2 = Date.UTC(2026, 8, 11, 7, 0, 0);
  const withTelemetry = run([
    // parked, range/temp reading settles right before departure
    { t: t2 + 0 * MIN, odometerKm: 2000, batteryPct: 80, carOn: false,
      locationLat: 40.60, locationLon: -79.80, rangeKm: 300, outsideTempC: -5 },
    { t: t2 + 5 * MIN, odometerKm: 2000, batteryPct: 80, carOn: false,
      locationLat: 40.60, locationLon: -79.80, rangeKm: 295, outsideTempC: -6 }, // must "stick" as the anchor
    { t: t2 + 20 * MIN, odometerKm: 2020, batteryPct: 75, carOn: true,
      locationLat: 40.55, locationLon: -79.85, rangeKm: 270, outsideTempC: -6 }, // mid-drive -- must NOT become the trip's start
    { t: t2 + 35 * MIN, odometerKm: 2040, batteryPct: 71, carOn: true,
      locationLat: 40.50, locationLon: -79.90, rangeKm: 250, outsideTempC: -4 },
    { t: t2 + 45 * MIN, odometerKm: 2040, batteryPct: 71, carOn: false,
      locationLat: 40.50, locationLon: -79.90, rangeKm: 250, outsideTempC: -4 },
    { t: t2 + 60 * MIN, odometerKm: 2040, batteryPct: 71, carOn: false,
      locationLat: 40.50, locationLon: -79.90, rangeKm: 250, outsideTempC: -4 },
  ], { pricePerKwh: 0.185, capacityKwh: 100 });

  assert.strictEqual(withTelemetry.closed.length, 1);
  const tr = withTelemetry.closed[0];
  assert.strictEqual(tr.startPct, 80);
  assert.strictEqual(tr.endPct, 71);
  assert.strictEqual(tr.startRangeKm, 295, "must be the LAST parked reading before departure, not the first");
  assert.strictEqual(tr.outsideTempC, -6, "same for temperature");

  // omitting rangeKm/outsideTempC entirely (every pre-analytics.js caller)
  // must keep working exactly as before -- both fields simply come back null
  const noTelemetry = run([
    { t: t2 + 0 * MIN, odometerKm: 3000, batteryPct: 80, carOn: false },
    { t: t2 + 20 * MIN, odometerKm: 3020, batteryPct: 75, carOn: true },
    { t: t2 + 35 * MIN, odometerKm: 3040, batteryPct: 71, carOn: false },
    { t: t2 + 50 * MIN, odometerKm: 3040, batteryPct: 71, carOn: false },
  ], { pricePerKwh: 0.185, capacityKwh: 100 });
  assert.strictEqual(noTelemetry.closed.length, 1);
  assert.strictEqual(noTelemetry.closed[0].startRangeKm, null);
  assert.strictEqual(noTelemetry.closed[0].outsideTempC, null);
}

// ---- a driveway shuffle (< MIN_KM) never becomes a trip ----
const shuffle = run([
  { t: t, odometerKm: 2000, batteryPct: 50, carOn: false },
  { t: t + 2 * MIN, odometerKm: 2000.2, batteryPct: 50, carOn: true },
  { t: t + 20 * MIN, odometerKm: 2000.2, batteryPct: 50, carOn: false },
  { t: t + 40 * MIN, odometerKm: 2000.2, batteryPct: 50, carOn: false },
]);
assert.strictEqual(shuffle.closed.length, 0, "0.2 km is below MIN_KM");

// ---- charged during the window -> distance kept, energy nulled ----
const charged = run([
  { t: t, odometerKm: 3000, batteryPct: 40, carOn: false },
  { t: t + 10 * MIN, odometerKm: 3020, batteryPct: 30, carOn: true },
  { t: t + 30 * MIN, odometerKm: 3020, batteryPct: 80, charging: true, carOn: false },
  { t: t + 45 * MIN, odometerKm: 3020, batteryPct: 80, carOn: false },
  { t: t + 60 * MIN, odometerKm: 3020, batteryPct: 80, carOn: false },
], { capacityKwh: 100 });
assert.strictEqual(charged.closed.length, 1);
assert.strictEqual(charged.closed[0].distanceKm, 20, "distance still logged");
assert.strictEqual(charged.closed[0].kwh, null, "energy nulled when charged mid-window");
assert.strictEqual(charged.closed[0].chargedDuring, true);

// ---- cached-poll mode: no carOn signal, just odo jumps between polls ----
const cached = run([
  { t: t, odometerKm: 5000, batteryPct: 80 },
  { t: t + 30 * MIN, odometerKm: 5040, batteryPct: 72 },        // drove while we weren't looking
  { t: t + 60 * MIN, odometerKm: 5040, batteryPct: 72 },        // parked
  { t: t + 90 * MIN, odometerKm: 5040, batteryPct: 72 },
], { capacityKwh: 100 });
assert.strictEqual(cached.closed.length, 1, "odo-delta trip without carOn");
assert.strictEqual(cached.closed[0].distanceKm, 40);
assert.strictEqual(cached.closed[0].usedPct, 8);

// ---- summary over a trip list ----
const sum = T.summary([
  { endedAt: Date.now() - 2 * 864e5, distanceKm: 30, kwh: 6, cost: 1.11 },
  { endedAt: Date.now() - 5 * 864e5, distanceKm: 20, kwh: 4, cost: 0.74 },
  { endedAt: Date.now() - 90 * 864e5, distanceKm: 999, kwh: 200, cost: 40 }, // outside 30d
], 30);
assert.strictEqual(sum.count, 2);
assert.strictEqual(sum.distanceKm, 50);
assert.strictEqual(sum.kwh, 10);
assert.ok(near(sum.cost, 1.85, 0.01));
assert.ok(sum.costPerMi > 0 && sum.costPerMi < 0.1, sum.costPerMi);

// --- DEFAULT_CAPACITY_KWH (the EV9's own usable pack size) must never be
// used as a generic "capacity unknown" guess for some OTHER model -- see
// core/sessions.js's identical fix for the reasoning. ---
{
  const noCap = run([
    { t: t + 0 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
    { t: t + 5 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
    { t: t + 20 * MIN, odometerKm: 1015, batteryPct: 87, carOn: true, locationLat: 40.62, locationLon: -79.80 },
    { t: t + 45 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 },
    { t: t + 60 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 }
  ], { pricePerKwh: 0.185 }); // no capacityKwh, no model
  assert.strictEqual(noCap.closed[0].kwh, null,
    "with no configured/reported capacity and no EV9 hint, kwh must stay null, not borrow the EV9's pack size");

  const niro = run([
    { t: t + 0 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
    { t: t + 5 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
    { t: t + 20 * MIN, odometerKm: 1015, batteryPct: 87, carOn: true, locationLat: 40.62, locationLon: -79.80 },
    { t: t + 45 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 },
    { t: t + 60 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 }
  ], { pricePerKwh: 0.185, model: "Niro EV" });
  assert.strictEqual(niro.closed[0].kwh, null, "a non-EV9 model must not silently borrow the EV9's pack size");

  const ev9 = run([
    { t: t + 0 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
    { t: t + 5 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
    { t: t + 20 * MIN, odometerKm: 1015, batteryPct: 87, carOn: true, locationLat: 40.62, locationLon: -79.80 },
    { t: t + 45 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 },
    { t: t + 60 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 }
  ], { pricePerKwh: 0.185, model: "EV9" });
  assert.ok(near(ev9.closed[0].kwh, 5.988), "an EV9 with no configured capacity must still fall back to its own 99.8kWh default (6% of it)");

  // isEv9()'s (?!\d) guard and [\s-]* tolerance, proven independently at
  // the TRIP level too -- core/trips.js has its OWN copy of this logic
  // (not shared with core/sessions.js), and a v2.72.0 fix to sessions.js's
  // regex was initially missed here entirely (caught only by checking the
  // generated frontend bundle still had the old pattern) -- these trip-
  // level assertions exist so a future regex change to one copy without
  // the other fails a test instead of silently drifting again.
  const ev90 = run([
    { t: t + 0 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
    { t: t + 5 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
    { t: t + 20 * MIN, odometerKm: 1015, batteryPct: 87, carOn: true, locationLat: 40.62, locationLon: -79.80 },
    { t: t + 45 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 },
    { t: t + 60 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 }
  ], { pricePerKwh: 0.185, model: "EV90" });
  assert.strictEqual(ev90.closed[0].kwh, null,
    "a hypothetical differently-numbered model ('EV90') must not match the EV9 regex and borrow its pack size");

  const evHyphen9 = run([
    { t: t + 0 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
    { t: t + 5 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.7539, locationLon: -79.8103 },
    { t: t + 20 * MIN, odometerKm: 1015, batteryPct: 87, carOn: true, locationLat: 40.62, locationLon: -79.80 },
    { t: t + 45 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 },
    { t: t + 60 * MIN, odometerKm: 1030, batteryPct: 84, carOn: false, locationLat: 40.55, locationLon: -79.88 }
  ], { pricePerKwh: 0.185, model: "EV-9" });
  assert.ok(near(evHyphen9.closed[0].kwh, 5.988),
    "a hyphenated 'EV-9' model string must still match and fall back to the 99.8kWh default");
}

console.log("all trips tests passed");
