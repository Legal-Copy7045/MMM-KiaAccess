/* node test/isoline.test.js */
const assert = require("assert");
const I = require("../core/isoline.js");

// ---- isoUrl: km -> metres, clamp, multi-range ----
let u = I.isoUrl({ apiKey: "K", lat: 40.7, lon: -79.7, rangesKm: [240, 120] });
assert.ok(u.includes("range=240000,120000"), u);
assert.ok(u.includes("type=distance") && u.includes("mode=drive"));
assert.ok(u.includes("apiKey=K"));
// past the ceiling gets clamped, zero/neg dropped
u = I.isoUrl({ apiKey: "K", lat: 1, lon: 2, rangesKm: [800, 0, -5] });
assert.ok(u.includes("range=500000"), u);
assert.strictEqual(I.pastMax(600), true);
assert.strictEqual(I.pastMax(300), false);

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
