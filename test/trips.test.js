/* node test/trips.test.js */
const assert = require("assert");
const T = require("../core/trips.js");

const MIN = 60000;
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0.1);

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
  { t: t + 0 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.71, locationLon: -79.75 },
  { t: t + 5 * MIN, odometerKm: 1000, batteryPct: 90, carOn: false, locationLat: 40.71, locationLon: -79.75 },
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

console.log("all trips tests passed");
