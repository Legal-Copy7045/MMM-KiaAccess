/* node test/isoline.test.js */
const assert = require("assert");
const I = require("../core/isoline.js");

// ---- isoUrl: km -> metres, clamp, multi-range ----
let u = I.isoUrl({ apiKey: "K", lat: 40.7, lon: -79.7, rangesKm: [80, 40] });
assert.ok(u.includes("range=80000,40000"), u);
assert.ok(u.includes("type=distance") && u.includes("mode=drive"));
assert.ok(u.includes("apiKey=K"));
// past the ceiling gets clamped to MAX_DRIVE_KM, zero/neg dropped
u = I.isoUrl({ apiKey: "K", lat: 1, lon: 2, rangesKm: [800, 0, -5] });
assert.ok(u.includes("range=" + I.MAX_DRIVE_KM * 1000), u);
assert.strictEqual(I.pastMax(I.MAX_DRIVE_KM + 1), true);
assert.strictEqual(I.pastMax(I.MAX_DRIVE_KM - 1), false);

// ---- TomTom: URL + boundary -> ring ----
var tt = I.tomtomUrl({ apiKey: "TT", lat: 40.71, lon: -79.75, distanceKm: 237, mode: "drive" });
assert.ok(tt.indexOf("calculateReachableRange/40.71%2C-79.75/json") !== -1, tt);
assert.ok(tt.includes("distanceBudgetInMeters=237000") && tt.includes("key=TT") && tt.includes("travelMode=car"));
var ttRing = I.parseTomtom({ reachableRange: { center: { latitude: 40.7, longitude: -79.7 }, boundary: [
  { latitude: 41.0, longitude: -80.0 }, { latitude: 41.0, longitude: -79.4 },
  { latitude: 40.4, longitude: -79.4 }, { latitude: 40.4, longitude: -80.0 }
] } });
assert.strictEqual(ttRing.length, 5, "closed ring: 4 points + repeat first");
assert.deepStrictEqual(ttRing[0], ttRing[4]);
assert.deepStrictEqual(ttRing[0], [-80.0, 41.0], "[lon, lat] order");
assert.strictEqual(I.parseTomtom({ reachableRange: { boundary: [] } }), null);
assert.strictEqual(I.parseTomtom({}), null);

// ---- parseIso: FeatureCollection -> rings, smallest first ----
const fc = {
  features: [
    { properties: { range: 200000 }, geometry: { type: "Polygon",
      coordinates: [[[-80, 40], [-79, 40], [-79, 41], [-80, 41], [-80, 40]]] } },
    { properties: { range: 100000 }, geometry: { type: "MultiPolygon",
      coordinates: [
        [[[-79.9, 40.4], [-79.6, 40.4], [-79.6, 40.7], [-79.9, 40.7], [-79.9, 40.4]]],
        [[[0, 0], [0.1, 0], [0.1, 0.1], [0, 0]]]   // smaller ring, ignored
      ] } },
    { geometry: null }
  ]
};
const parsed = I.parseIso(fc);
assert.strictEqual(parsed.length, 2);
assert.strictEqual(parsed[0].rangeKm, 100, "smallest first");
assert.strictEqual(parsed[0].ring.length, 5, "largest ring of the MultiPolygon");
assert.strictEqual(parsed[1].rangeKm, 200);

// ---- simplify: fewer points, endpoints kept ----
const dense = [];
for (let i = 0; i <= 100; i++) dense.push([-80 + i * 0.01, 40 + Math.sin(i / 6) * 0.001]);
const simp = I.simplify(dense, 0.01);
assert.ok(simp.length < dense.length && simp.length >= 2, simp.length);
assert.deepStrictEqual(simp[0], dense[0]);
assert.deepStrictEqual(simp[simp.length - 1], dense[dense.length - 1]);

// ---- bbox: covers everything + pads ----
const b = I.bbox([[-80, 40], [-79, 41]], 0.1);
assert.ok(b[0] < -80 && b[1] < 40 && b[2] > -79 && b[3] > 41);

// ---- staticMapUrl: polygon + markers baked in ----
const smap = I.staticMapUrl({
  apiKey: "K", width: 480, height: 300,
  rings: [{ ring: parsed[1].ring, color: "#4caf50" }],
  markers: [{ lat: 40.5, lon: -79.7, color: "#e53935", text: "Home" }]
});
assert.ok(smap.startsWith("https://maps.geoapify.com/v1/staticmap?"));
assert.ok(smap.includes("width=480") && smap.includes("area=rect:"));
assert.ok(smap.includes("geometry=polygon:") && smap.includes(";linecolor:%234caf50"));
assert.ok(smap.includes("marker=lonlat:") && smap.includes(";text:H"), "marker text trimmed to 1 char");
assert.strictEqual(I.staticMapUrl({ apiKey: "K", rings: [], markers: [] }), null);

// ---- cacheKey: stable under small wiggle ----
const k1 = I.cacheKey(40.713, -79.751, [241, 118]);
const k2 = I.cacheKey(40.714, -79.749, [243, 121]);
assert.strictEqual(k1, k2, "coarse key ignores GPS jitter + range noise");

console.log("all isoline tests passed");
