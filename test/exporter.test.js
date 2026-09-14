/* node test/exporter.test.js */
const assert = require("assert");
const http = require("http");
const E = require("../exporter.js");

const flat = {
  "vehicle.ev_battery_percentage": 63,
  "vehicle.ev_charging_power": 7.4,
  "vehicle.is_locked": "true",
  "vehicle.ev_battery_is_charging": false,
  "vehicle.model": "EV9",                 // string -> skipped
  "vehicle.outside_temperature": "",      // empty -> skipped
  "vehicle.data.raw_blob": 99,            // raw dump -> skipped
  "_meta.fetchedAt": "x"                  // not vehicle.* -> skipped
};

// ---- numericFields ----
const nf = E.numericFields(flat);
const keys = nf.map((x) => x.key).sort();
assert.deepStrictEqual(keys, [
  "ev_battery_is_charging", "ev_battery_percentage", "ev_charging_power", "is_locked"
]);
assert.strictEqual(nf.find((x) => x.key === "is_locked").value, 1, "bool string -> 1");
assert.strictEqual(nf.find((x) => x.key === "ev_battery_is_charging").value, 0);

// ---- lineProtocol ----
const lp = E.lineProtocol("kia_vehicle", { vin: "ABC 1" }, nf, 1700000000);
assert.ok(lp.startsWith("kia_vehicle,vin=ABC\\ 1 "), lp);
assert.ok(lp.includes("ev_battery_percentage=63"));
assert.ok(lp.endsWith(" 1700000000"));
assert.strictEqual(E.lineProtocol("m", {}, [], null), null, "no fields -> null");

// ---- promText ----
const pt = E.promText(flat, { stale: true }, "kia", { vin: "ABC" });
assert.ok(pt.includes('kia_ev_battery_percentage{vin="ABC"} 63'));
assert.ok(pt.includes("# TYPE kia_ev_charging_power gauge"));
assert.ok(pt.includes('kia_stale{vin="ABC"} 1'));

// ---- PromServer serves /metrics ----
(async () => {
  const srv = new E.PromServer({ port: 9271, prefix: "kia", labels: { vin: "Z" } });
  srv.start();
  srv.setSnapshot(flat, { stale: false });
  await new Promise((r) => setTimeout(r, 150));
  const body = await new Promise((resolve, reject) => {
    http.get("http://127.0.0.1:9271/metrics", (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ code: res.statusCode, d }));
    }).on("error", reject);
  });
  srv.stop();
  assert.strictEqual(body.code, 200);
  assert.ok(body.d.includes('kia_ev_battery_percentage{vin="Z"} 63'), body.d);
  assert.ok(body.d.includes("kia_stale{vin=\"Z\"} 0"));

  // ---- PromServer, rotate mode: several vehicles sharing one server/port
  // must each keep their own label-series -- the last vehicle processed
  // must NOT silently overwrite the others' numbers (nor appear mislabeled
  // under whichever vehicle's vin happened to create the server first). ----
  const srv2 = new E.PromServer({ port: 9273, prefix: "kia", labels: {} });
  srv2.start();
  const flatA = { "vehicle.ev_battery_percentage": 40 };
  const flatB = { "vehicle.ev_battery_percentage": 90 };
  srv2.setSnapshot(flatA, { stale: false }, "VIN1");
  srv2.setSnapshot(flatB, { stale: true }, "VIN2");
  await new Promise((r) => setTimeout(r, 150));
  const body2 = await new Promise((resolve, reject) => {
    http.get("http://127.0.0.1:9273/metrics", (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
  srv2.stop();
  assert.ok(body2.includes('kia_ev_battery_percentage{vin="VIN1"} 40'), body2);
  assert.ok(body2.includes('kia_ev_battery_percentage{vin="VIN2"} 90'), body2);
  assert.ok(body2.includes('kia_stale{vin="VIN2"} 1'), body2);
  // exactly one TYPE line per metric name, not one per vehicle -- Prometheus
  // exposition format expects a metric's TYPE declared once
  assert.strictEqual(
    (body2.match(/# TYPE kia_ev_battery_percentage gauge/g) || []).length, 1,
    body2
  );

  // updating one vehicle's snapshot again must not disturb the other's
  srv2.setSnapshot({ "vehicle.ev_battery_percentage": 41 }, { stale: false }, "VIN1");
  const text3 = srv2._text;
  assert.ok(text3.includes('kia_ev_battery_percentage{vin="VIN1"} 41'), text3);
  assert.ok(text3.includes('kia_ev_battery_percentage{vin="VIN2"} 90'), text3);

  // removeSnapshot(): a vehicle retired from config (or from the account)
  // must stop appearing at /metrics entirely, not linger forever at its
  // last-known value
  srv2.removeSnapshot("VIN2");
  const text4 = srv2._text;
  assert.ok(text4.includes('kia_ev_battery_percentage{vin="VIN1"} 41'), text4);
  assert.ok(!text4.includes("VIN2"), text4);
  srv2.removeSnapshot("does-not-exist"); // no-op, must not throw
  srv2.removeSnapshot("VIN1");
  assert.strictEqual(srv2._text, "# no data yet\n", "no vehicles left -> empty snapshot text");

  // ---- pushInflux hits /api/v2/write with the token header + line body ----
  const seen = {};
  const mock = http.createServer((req, res) => {
    seen.url = req.url;
    seen.auth = req.headers.authorization;
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { seen.body = b; res.writeHead(204); res.end(); });
  });
  await new Promise((r) => mock.listen(9272, r));
  const code = await E.pushInflux(
    { url: "http://127.0.0.1:9272", bucket: "ev", org: "home", token: "tkn" },
    flat, { stale: false }
  );
  mock.close();
  assert.strictEqual(code, 204);
  assert.ok(seen.url.startsWith("/api/v2/write?bucket=ev"), seen.url);
  assert.strictEqual(seen.auth, "Token tkn");
  assert.ok(seen.body.includes("ev_battery_percentage=63"), seen.body);

  console.log("all exporter tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
