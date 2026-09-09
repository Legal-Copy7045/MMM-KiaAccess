/* node test/range.test.js */
const assert = require("assert");
const R = require("../core/range.js");

const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0.5);

// ---- reach(): reserve + factor + round trip ----
// 300 km range, 10% reserve, factor 0.92 -> 300*0.9*0.92 = 248.4
assert.ok(near(R.reach(300), 248.4), R.reach(300));
// round trip halves it
assert.ok(near(R.reach(300, { roundTrip: true }), 124.2));
// absolute reserve wins over percent
assert.ok(near(R.reach(300, { reserveKm: 30, reservePct: 50 }), 270 * 0.92));
// no factor / no reserve
assert.ok(near(R.reach(200, { factor: 1, reservePct: 0 }), 200));
// junk / empty / already flat
assert.strictEqual(R.reach(0), null);
assert.strictEqual(R.reach("x"), null);
assert.strictEqual(R.reach(null), null);
assert.strictEqual(R.reach(5, { reserveKm: 50 }), 0, "reserve past range -> 0");

// ---- haversine + bearing ----
// Sarver PA -> downtown Pittsburgh ~ 33 km, bearing ~ SW
const dHome = R.haversineKm(40.71374, -79.75464, 40.4406, -79.9959);
assert.ok(dHome > 28 && dHome < 40, dHome);
const b = R.bearingDeg(40.71374, -79.75464, 40.4406, -79.9959);
assert.ok(b > 180 && b < 260, "bearing SW-ish: " + b);

// ---- poiStatus: sorted, reachable flag, margin ----
const car = [40.71374, -79.75464];
const pois = [
  { name: "Shore", lat: 38.34, lon: -75.08 },   // ~400 km, far
  { name: "Work", lat: 40.4406, lon: -79.9959 }, // ~33 km, near
  { name: "Cabin", lat: 39.87, lon: -79.49 },    // ~95 km
  { name: "bad", lat: null, lon: 1 }             // dropped
];
const st = R.poiStatus(car[0], car[1], pois, 120);
assert.deepStrictEqual(st.map((p) => p.name), ["Work", "Cabin", "Shore"], "nearest first, bad dropped");
assert.strictEqual(st[0].reachable, true);
assert.strictEqual(st[2].reachable, false);
assert.ok(st[0].marginKm > 80, "Work has lots of spare");
assert.ok(st[2].marginKm < 0, "Shore is short by a lot");

// ---- circleRing: closed ring, right size ----
const ring = R.circleRing(40.71374, -79.75464, 100, 32);
assert.strictEqual(ring.length, 33, "n+1 points, closed");
assert.deepStrictEqual(ring[0], ring[32], "ring is closed");
// north point ~ 100 km / 111.32 deg north
assert.ok(near(ring[0][1] - 40.71374, 100 / 111.32, 0.02));

// ---- summary: both distances + active + circle ----
const s = R.summary(car[0], car[1], 300, pois, { roundTrip: true });
assert.ok(near(s.oneWayKm, 248.4));
assert.ok(near(s.roundTripKm, 124.2));
assert.strictEqual(s.reachKm, s.roundTripKm, "active = round trip");
assert.strictEqual(s.pois[0].name, "Work");
assert.ok(Array.isArray(s.circle) && s.circle.length > 10);

console.log("all range tests passed");
