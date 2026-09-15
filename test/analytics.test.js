/* node test/analytics.test.js
 *
 * core/analytics.js -- observed efficiency, range accuracy, charging
 * performance, driving patterns. Fixtures here are shared (same numbers,
 * same expected results) with test/analytics_test.py, so both language
 * ports are pinned to the identical math, not just "each internally
 * consistent with itself."
 */
const assert = require("assert");
const A = require("../core/analytics.js");

const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= (tol || 0.05);

// ---- observedEfficiency(): overall, temperature buckets, speed buckets,
// monthly trend, and excluding trips that charged mid-drive ----
{
  const trips = [
    // cold, city-speed trips (Jan) -- 40km/45min = 53.3 km/h ("mixed" bucket)
    { distanceKm: 40, usedPct: 15, minutes: 45, endedAt: Date.UTC(2026, 0, 15), chargedDuring: false, outsideTempC: -10 },
    { distanceKm: 60, usedPct: 22, minutes: 68, endedAt: Date.UTC(2026, 0, 20), chargedDuring: false, outsideTempC: -8 },
    // warm, highway-speed trips (June) -- 100km/70min = 85.7 km/h ("highway").
    // Both temps clearly above the 23.9°C (75°F) bucket boundary.
    { distanceKm: 100, usedPct: 30, minutes: 70, endedAt: Date.UTC(2026, 5, 15), chargedDuring: false, outsideTempC: 28 },
    { distanceKm: 90, usedPct: 27, minutes: 63, endedAt: Date.UTC(2026, 5, 20), chargedDuring: false, outsideTempC: 30 },
    // a trip that charged partway through -- must be excluded from EVERY
    // efficiency/accuracy computation (its "% used" is meaningless)
    { distanceKm: 50, usedPct: 5, minutes: 60, endedAt: Date.UTC(2026, 5, 22), chargedDuring: true, outsideTempC: 20 },
    // no distance / no usedPct -- must not crash the bucketing
    { distanceKm: null, usedPct: null, minutes: 10, endedAt: Date.UTC(2026, 5, 23), chargedDuring: false }
  ];

  const eff = A.observedEfficiency(trips, { units: "imperial" });
  assert.ok(eff, "must return a result when usable trips exist");
  assert.strictEqual(eff.tripsSampled, 4, "the charged-during-trip and the no-distance trip must both be excluded");
  assert.strictEqual(eff.unit, "mi/%");

  // overall = avg(40/15, 60/22, 100/30, 90/27) km/% -> mi/%
  const expectedOverallKmPerPct = (40 / 15 + 60 / 22 + 100 / 30 + 90 / 27) / 4;
  assert.ok(near(eff.overall, expectedOverallKmPerPct * 0.621371), eff.overall);

  // temperature buckets: two trips <20°F, two trips >75°F
  assert.strictEqual(eff.temperatureBuckets.length, 2, JSON.stringify(eff.temperatureBuckets));
  const cold = eff.temperatureBuckets.find((b) => b.label === "<20°F");
  const warm = eff.temperatureBuckets.find((b) => b.label === ">75°F");
  assert.strictEqual(cold.tripCount, 2);
  assert.strictEqual(warm.tripCount, 2);
  // the warm bucket must show BETTER efficiency than the cold one -- this
  // is the whole point of the feature, not just "some numbers came out"
  assert.ok(warm.efficiency > cold.efficiency, `warm ${warm.efficiency} vs cold ${cold.efficiency}`);

  // speed buckets: two "mixed" (~53 km/h), two "highway" (~86 km/h)
  assert.strictEqual(eff.speedBuckets.length, 2, JSON.stringify(eff.speedBuckets));
  const mixed = eff.speedBuckets.find((b) => b.label.indexOf("mixed") === 0);
  const highway = eff.speedBuckets.find((b) => b.label.indexOf("highway") === 0);
  assert.strictEqual(mixed.tripCount, 2);
  assert.strictEqual(highway.tripCount, 2);

  // monthly trend: Jan then June, oldest first
  assert.strictEqual(eff.monthlyTrend.length, 2);
  assert.strictEqual(eff.monthlyTrend[0].month, "2026-01");
  assert.strictEqual(eff.monthlyTrend[1].month, "2026-06");
  assert.strictEqual(eff.monthlyTrend[0].tripCount, 2);
  assert.strictEqual(eff.monthlyTrend[1].tripCount, 2);
}

// ---- observedEfficiency(): no usable trips -> null, not a crash ----
{
  assert.strictEqual(A.observedEfficiency([], {}), null);
  assert.strictEqual(A.observedEfficiency([{ chargedDuring: true }], {}), null);
  assert.strictEqual(A.observedEfficiency(null, {}), null);
}

// ---- rangeAccuracy(): a car that under-delivers on its own estimate ----
{
  const trips = [
    { distanceKm: 40, usedPct: 15, minutes: 45, endedAt: 1, chargedDuring: false, startRangeKm: 300, startPct: 80 },
    { distanceKm: 60, usedPct: 22, minutes: 68, endedAt: 2, chargedDuring: false, startRangeKm: 310, startPct: 85 },
    { distanceKm: 100, usedPct: 30, minutes: 70, endedAt: 3, chargedDuring: false, startRangeKm: 320, startPct: 90 },
    { distanceKm: 90, usedPct: 27, minutes: 63, endedAt: 4, chargedDuring: false, startRangeKm: 315, startPct: 88 }
  ];
  const acc = A.rangeAccuracy(trips, { units: "imperial" });
  assert.ok(acc);
  assert.strictEqual(acc.tripsSampled, 4);
  // hand-verified: avg ratio 0.832 -> kiaEstimate 193mi, observedEstimate 161mi, accuracyPct -16.8
  assert.strictEqual(acc.kiaEstimate, 193);
  assert.strictEqual(acc.observedEstimate, 161);
  assert.ok(near(acc.accuracyPct, -16.8, 0.2), acc.accuracyPct);
  assert.ok(near(acc.personalRangeFactor, 0.832, 0.01), acc.personalRangeFactor);

  // a trip missing startRangeKm/startPct must be excluded, not crash
  const partial = A.rangeAccuracy(trips.concat([
    { distanceKm: 10, usedPct: 5, minutes: 10, endedAt: 5, chargedDuring: false }
  ]), { units: "imperial" });
  assert.strictEqual(partial.tripsSampled, 4, "the trip with no startRangeKm must not count");
}

// ---- rangeAccuracy(): personalRangeFactor must be clamped to a sane band,
// so a handful of unusual trips (one highway blast, one very cold
// morning) can never push a downstream "can I get home" check to an
// implausible extreme ----
{
  const wild = A.rangeAccuracy([
    { distanceKm: 500, usedPct: 5, minutes: 300, endedAt: 1, chargedDuring: false, startRangeKm: 50, startPct: 10 },
    { distanceKm: 500, usedPct: 5, minutes: 300, endedAt: 2, chargedDuring: false, startRangeKm: 50, startPct: 10 }
  ], {});
  assert.ok(wild.personalRangeFactor <= 1.5, wild.personalRangeFactor);

  const starved = A.rangeAccuracy([
    { distanceKm: 1, usedPct: 50, minutes: 10, endedAt: 1, chargedDuring: false, startRangeKm: 400, startPct: 90 },
    { distanceKm: 1, usedPct: 50, minutes: 10, endedAt: 2, chargedDuring: false, startRangeKm: 400, startPct: 90 }
  ], {});
  assert.ok(starved.personalRangeFactor >= 0.5, starved.personalRangeFactor);
}

// ---- chargingPerformance(): home vs. away, and SOC bands computed
// HOME-ONLY (mixing a home L2 charger with a public DC-fast session would
// average two entirely different power ceilings into one meaningless
// number -- the exact bug caught and fixed while building this) ----
{
  const sessions = [
    { startPct: 20, endPct: 45, minutes: 100, kwh: 25, avgKw: 15, location: "home", cost: 3.5 },
    { startPct: 45, endPct: 70, minutes: 90, kwh: 25, avgKw: 16.7, location: "home", cost: 3.5 },
    { startPct: 55, endPct: 78, minutes: 85, kwh: 23, avgKw: 16.2, location: "home", cost: 3.2 },
    { startPct: 78, endPct: 95, minutes: 70, kwh: 17, avgKw: 14.6, location: "home", cost: 2.4 },
    // a DC-fast session landing in the SAME nominal SOC band as some of
    // the home sessions above -- must NOT be blended into socBands
    { startPct: 30, endPct: 90, minutes: 45, kwh: 60, avgKw: 80, location: "away", cost: 22 }
  ];
  const cp = A.chargingPerformance(sessions);
  assert.ok(cp);
  assert.strictEqual(cp.sessionsSampled, 5);
  assert.strictEqual(cp.home.count, 4);
  assert.strictEqual(cp.away.count, 1);
  assert.ok(near(cp.away.avgKw, 80));

  // socBands must be HOME-only -- none of them should show anything near
  // the DC-fast session's 80kW
  cp.socBands.forEach((b) => {
    assert.ok(b.avgKw < 20, `socBands must exclude the away DC-fast session, got ${b.avgKw} for ${b.label}`);
  });
  // two sessions have midpoints in 10-50% (32.5, 57.5 is NOT in 10-50 --
  // recompute: session1 mid=32.5 -> 10-50%; session2 mid=57.5 -> 50-80%;
  // session3 mid=66.5 -> 50-80%; session4 mid=86.5 -> 80-100%)
  const band5080 = cp.socBands.find((b) => b.label === "50–80%");
  assert.ok(band5080, "the 50-80% band must have enough home sessions to report");
  assert.strictEqual(band5080.sessionCount, 2);
}

// ---- chargingPerformance(): no usable sessions -> null ----
{
  assert.strictEqual(A.chargingPerformance([]), null);
  assert.strictEqual(A.chargingPerformance(null), null);
}

// ---- drivingPatterns(): a usage profile from fields every trip already
// has, no new telemetry needed ----
{
  const now = Date.now();
  const DAY = 864e5;
  const trips = [
    { distanceKm: 40, minutes: 48, endedAt: now - 2 * DAY },  // 50 km/h
    { distanceKm: 20, minutes: 24, endedAt: now - 5 * DAY },  // 50 km/h
    { distanceKm: 60, minutes: 72, endedAt: now - 40 * DAY }  // outside the 30-day window
  ];
  const dp = A.drivingPatterns(trips, { units: "imperial", days: 30 });
  assert.ok(dp);
  assert.strictEqual(dp.tripCount, 2, "the 40-day-old trip must be outside the window");
  assert.ok(near(dp.avgTripDistance, (40 + 20) / 2 * 0.621371, 0.5));
  assert.ok(near(dp.avgSpeed, 50 * 0.621371, 1));
  assert.strictEqual(dp.windowDays, 30);
}

console.log("all analytics tests passed");
