/* node test/routing.test.js */
const assert = require("assert");
const R = require("../core/routing.js");

const origin = { lat: 40.71374, lon: -79.75464 };
const targets = [
  { lat: 40.4406, lon: -79.9959 },
  { lat: 39.87, lon: -79.49 }
];

// ---- matrixRequest: geoapify ----
const g = R.matrixRequest("geoapify", origin, targets, "KEY");
assert.strictEqual(g.method, "POST");
assert.ok(g.url.includes("routematrix?apiKey=KEY"));
const gb = JSON.parse(g.body);
assert.deepStrictEqual(gb.sources[0].location, [-79.75464, 40.71374], "lon,lat order");
assert.strictEqual(gb.targets.length, 2);
assert.strictEqual(gb.mode, "drive");

// ---- matrixRequest: tomtom ----
const t = R.matrixRequest("tomtom", origin, targets, "KEY2", { traffic: false });
assert.ok(t.url.includes("matrix/2?key=KEY2"));
const tb = JSON.parse(t.body);
assert.strictEqual(tb.origins[0].point.latitude, 40.71374);
assert.strictEqual(tb.options.traffic, "historical");
assert.strictEqual(tb.options.travelMode, "car");

// ---- guards ----
assert.strictEqual(R.matrixRequest("geoapify", origin, targets, ""), null, "no key");
assert.strictEqual(R.matrixRequest("geoapify", origin, [], "KEY"), null, "no targets");
assert.strictEqual(R.matrixRequest("nope", origin, targets, "KEY"), null, "unknown provider");
assert.strictEqual(
  R.matrixRequest("geoapify", { lat: null, lon: 1 }, targets, "KEY"), null, "bad origin");

// bad targets are filtered out
const g2 = R.matrixRequest("geoapify", origin, [targets[0], { lat: null, lon: 2 }], "KEY");
assert.strictEqual(JSON.parse(g2.body).targets.length, 1);

// ---- parseMatrix: geoapify ----
const gResp = {
  sources_to_targets: [[
    { source_index: 0, target_index: 0, distance: 42000, time: 2400 },
    { source_index: 0, target_index: 1, distance: null, time: null } // no route
  ]]
};
const gp = R.parseMatrix("geoapify", gResp, 2);
assert.strictEqual(gp[0].durationMin, 40);
assert.ok(Math.abs(gp[0].distanceKm - 42) < 0.001);
assert.strictEqual(gp[1], null, "no-route target -> null");

// ---- parseMatrix: tomtom ----
const tResp = {
  data: [
    { originIndex: 0, destinationIndex: 0,
      routeSummary: { lengthInMeters: 42000, travelTimeInSeconds: 2400 } },
    { originIndex: 0, destinationIndex: 1,
      routeSummary: { lengthInMeters: 95000, travelTimeInSeconds: 5400 } }
  ]
};
const tp = R.parseMatrix("tomtom", tResp, 2);
assert.strictEqual(tp[0].durationMin, 40);
assert.strictEqual(tp[1].durationMin, 90);
assert.ok(Math.abs(tp[1].distanceKm - 95) < 0.001);

// ---- parseMatrix: junk / empty ----
assert.deepStrictEqual(R.parseMatrix("geoapify", null, 2), [null, null]);
assert.deepStrictEqual(R.parseMatrix("tomtom", {}, 1), [null]);
assert.deepStrictEqual(R.parseMatrix("nope", tResp, 2), [null, null]);

// ---- geocodeRequest / parseGeocode ----
const gg = R.geocodeRequest("geoapify", "409 Sarver Rd, Sarver PA", "K");
assert.strictEqual(gg.method, "GET");
assert.ok(gg.url.includes("geocode/search?text=409%20Sarver"));
assert.ok(gg.url.includes("countrycode:us") && gg.url.includes("apiKey=K"));
const tg = R.geocodeRequest("tomtom", "409 Sarver Rd", "K2");
assert.ok(tg.url.includes("/geocode/409%20Sarver%20Rd.json") && tg.url.includes("countrySet=US"));
assert.strictEqual(R.geocodeRequest("geoapify", "", "K"), null);
assert.strictEqual(R.geocodeRequest("nope", "x", "K"), null);

const ggResp = { features: [{ properties: { lat: 40.71, lon: -79.75, formatted: "Sarver, PA" } }] };
assert.deepStrictEqual(R.parseGeocode("geoapify", ggResp),
  { lat: 40.71, lon: -79.75, name: "Sarver, PA" });
const tgResp = { results: [{ position: { lat: 40.71, lon: -79.75 },
  address: { freeformAddress: "Sarver, PA" } }] };
assert.deepStrictEqual(R.parseGeocode("tomtom", tgResp),
  { lat: 40.71, lon: -79.75, name: "Sarver, PA" });
assert.strictEqual(R.parseGeocode("geoapify", { features: [] }), null);
assert.strictEqual(R.parseGeocode("tomtom", null), null);

// ---- routeRequest / parseRoute ----
const rr = R.routeRequest("tomtom", origin, targets[0], "K");
assert.strictEqual(rr.method, "GET");
assert.ok(rr.url.includes("/calculateRoute/40.71374,-79.75464:40.4406,-79.9959/json"));
assert.ok(rr.url.includes("computeTravelTimeFor=all") && rr.url.includes("traffic=true"));
assert.strictEqual(R.routeRequest("tomtom", origin, { lat: null, lon: 1 }, "K"), null);
assert.strictEqual(R.routeRequest("nope", origin, targets[0], "K"), null);
const gr = R.routeRequest("geoapify", origin, targets[0], "K");
assert.ok(gr.url.includes("routing?waypoints=40.71374,-79.75464|40.4406,-79.9959"));

const ttRoute = {
  routes: [{
    summary: {
      lengthInMeters: 34000, travelTimeInSeconds: 2040,
      noTrafficTravelTimeInSeconds: 1800, trafficDelayInSeconds: 240
    },
    guidance: {
      instructions: [
        { routeOffsetInMeters: 0, roadNumbers: ["PA 28"], street: "" },
        { routeOffsetInMeters: 22000, roadNumbers: [], street: "Greensburg Rd" },
        { routeOffsetInMeters: 33900, roadNumbers: [], street: "Twin Oaks Dr" },
        { routeOffsetInMeters: 34000 }
      ]
    }
  }]
};
const pr = R.parseRoute("tomtom", ttRoute);
assert.strictEqual(pr.durationMin, 34);
assert.strictEqual(pr.typicalMin, 30);
assert.strictEqual(pr.delayMin, 4);
assert.ok(Math.abs(pr.distanceKm - 34) < 0.001);
assert.strictEqual(pr.via, "PA 28 · Greensburg Rd", "roads >300m only, route order");

// no traffic model + junk
assert.strictEqual(R.parseRoute("tomtom", { routes: [] }), null);
assert.strictEqual(R.parseRoute("geoapify", null), null);
const gpRoute = { features: [{ properties: { time: 600, distance: 8000,
  legs: [{ steps: [{ name: "Main St", distance: 5000 }, { name: "", distance: 100 }] }] } }] };
const gpr = R.parseRoute("geoapify", gpRoute);
assert.strictEqual(gpr.durationMin, 10);
assert.strictEqual(gpr.typicalMin, null);
assert.strictEqual(gpr.via, "Main St");

console.log("all routing tests passed");
