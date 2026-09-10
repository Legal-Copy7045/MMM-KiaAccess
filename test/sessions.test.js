/* node test/sessions.test.js */
const assert = require("assert");
const S = require("../core/sessions.js");

const MIN = 60000;
const opts = { pricePerKwh: 0.185, capacityKwh: 100 };

// a normal overnight AC charge: 40% -> 80%, one pause in the middle
let open = null;
let r;
const t0 = Date.parse("2026-09-08T22:00:00Z");
r = S.update(open, { t: t0, charging: true, plugged: true, batteryPct: 40, chargeKw: 7.4 }, opts);
open = r.open;
assert.ok(open && open.startPct === 40);
assert.strictEqual(r.closed, null);

// still charging an hour later
r = S.update(open, { t: t0 + 60 * MIN, charging: true, plugged: true, batteryPct: 55, chargeKw: 7.2 }, opts);
open = r.open;

// scheduled pause (not charging, still plugged, 20 min) — stays open
r = S.update(open, { t: t0 + 80 * MIN, charging: false, plugged: true, batteryPct: 55 }, opts);
open = r.open;
assert.ok(open, "20-min pause keeps the session open");

// resumes
r = S.update(open, { t: t0 + 100 * MIN, charging: true, plugged: true, batteryPct: 62, chargeKw: 7.3 }, opts);
open = r.open;

// finishes at 80, sits plugged
r = S.update(open, { t: t0 + 200 * MIN, charging: true, plugged: true, batteryPct: 80, chargeKw: 1.1 }, opts);
open = r.open;

// unplugged in the morning -> session closes
r = S.update(open, { t: t0 + 600 * MIN, charging: false, plugged: false, batteryPct: 80 }, opts);
assert.strictEqual(r.open, null);
assert.ok(r.closed, "unplug closes the session");
assert.strictEqual(r.closed.startPct, 40);
assert.strictEqual(r.closed.endPct, 80);
assert.strictEqual(r.closed.gainedPct, 40);
assert.strictEqual(r.closed.kwh, 40); // 40% of 100 kWh
assert.strictEqual(r.closed.cost, 7.4); // 40 * 0.185
assert.strictEqual(r.closed.peakKw, 7.4);

// trickle / noise below MIN_KWH is discarded
open = S.update(null, { t: t0, charging: true, plugged: true, batteryPct: 79 }, opts).open;
r = S.update(open, { t: t0 + 5 * MIN, charging: false, plugged: false, batteryPct: 79 }, opts);
assert.strictEqual(r.closed, null, "0 kWh session dropped");

// plugged but never charging -> no session
r = S.update(null, { t: t0, charging: false, plugged: true, batteryPct: 50 }, opts);
assert.strictEqual(r.open, null);
assert.strictEqual(r.closed, null);

// long plugged-idle gap (> 45 min) closes even while still plugged
open = S.update(null, { t: t0, charging: true, plugged: true, batteryPct: 50, chargeKw: 50 }, opts).open;
open = S.update(open, { t: t0 + 30 * MIN, charging: true, plugged: true, batteryPct: 90, chargeKw: 20 }, opts).open;
r = S.update(open, { t: t0 + 90 * MIN, charging: false, plugged: true, batteryPct: 90 }, opts);
assert.ok(r.closed, "45-min idle closes a still-plugged session");
assert.strictEqual(r.closed.kwh, 40);

// --- progress (live in-flight figures) ---
open = S.update(null, { t: t0, charging: true, plugged: true, batteryPct: 40, chargeKw: 7.4 }, opts).open;
open = S.update(open, { t: t0 + 60 * MIN, charging: true, plugged: true, batteryPct: 55, chargeKw: 7.2 }, opts).open;
// at the last sample: 15% of 100 kWh = 15 kWh, no drift
let pr = S.progress(open, { t: t0 + 60 * MIN, charging: true, batteryPct: 55, chargeKw: 7.2 }, opts);
assert.strictEqual(pr.kwh, 15);
assert.strictEqual(pr.cost, 2.78); // 15 * 0.185
// 10 min later, no new poll — extrapolates 7.2 kW * (10/60) h ≈ 1.2 kWh
pr = S.progress(open, { t: t0 + 70 * MIN, charging: true, batteryPct: 55, chargeKw: 7.2 }, opts);
assert.ok(pr.kwh > 16 && pr.kwh < 16.5, "extrapolated: " + pr.kwh);
// drift capped at 15 min
pr = S.progress(open, { t: t0 + 200 * MIN, charging: true, batteryPct: 55, chargeKw: 7.2 }, opts);
assert.ok(pr.kwh < 17, "drift capped: " + pr.kwh);
// no open session -> null
assert.strictEqual(S.progress(null, { t: t0, charging: true }, opts), null);

// summary
const sessions = [
  { endedAt: Date.now() - 2 * 864e5, kwh: 40, cost: 7.4 },
  { endedAt: Date.now() - 10 * 864e5, kwh: 25, cost: 4.63 },
  { endedAt: Date.now() - 40 * 864e5, kwh: 30, cost: 5.55 } // outside 30d
];
const sum = S.summary(sessions, 30);
assert.strictEqual(sum.count, 2);
assert.strictEqual(sum.kwh, 65);
assert.strictEqual(sum.cost, 12.03);

// --- home vs away rate ---
const haOpts = { pricePerKwh: 0.185, awayPricePerKwh: 0.55, capacityKwh: 100 };
// away session: 40% -> 40 kWh at the away rate
open = S.update(null, { t: t0, charging: true, plugged: true, batteryPct: 20, chargeKw: 120, atHome: false }, haOpts).open;
assert.strictEqual(open.atHome, false);
r = S.update(open, { t: t0 + 30 * MIN, charging: false, plugged: false, batteryPct: 60 }, haOpts);
assert.strictEqual(r.closed.location, "away");
assert.strictEqual(r.closed.kwh, 40);
assert.strictEqual(r.closed.cost, 22); // 40 * 0.55
assert.strictEqual(r.closed.pricePerKwh, 0.55);

// home session: same energy at the home rate
open = S.update(null, { t: t0, charging: true, plugged: true, batteryPct: 20, chargeKw: 7, atHome: true }, haOpts).open;
r = S.update(open, { t: t0 + 30 * MIN, charging: false, plugged: false, batteryPct: 60 }, haOpts);
assert.strictEqual(r.closed.location, "home");
assert.strictEqual(r.closed.cost, 7.4); // 40 * 0.185

// unknown location (no home zone) -> home rate, location "home"
open = S.update(null, { t: t0, charging: true, plugged: true, batteryPct: 20, chargeKw: 7, atHome: null }, haOpts).open;
r = S.update(open, { t: t0 + 30 * MIN, charging: false, plugged: false, batteryPct: 60 }, haOpts);
assert.strictEqual(r.closed.location, "home");
assert.strictEqual(r.closed.cost, 7.4);

// away rate 0 -> away session falls back to the home rate
open = S.update(null, { t: t0, charging: true, plugged: true, batteryPct: 20, chargeKw: 50, atHome: false },
  { pricePerKwh: 0.185, capacityKwh: 100 }).open;
r = S.update(open, { t: t0 + 30 * MIN, charging: false, plugged: false, batteryPct: 60 },
  { pricePerKwh: 0.185, capacityKwh: 100 });
assert.strictEqual(r.closed.location, "away");
assert.strictEqual(r.closed.cost, 7.4);

// atHome learned on a later sample when the first was unknown
open = S.update(null, { t: t0, charging: true, plugged: true, batteryPct: 20, chargeKw: 7 }, haOpts).open;
assert.strictEqual(open.atHome, null);
open = S.update(open, { t: t0 + 5 * MIN, charging: true, plugged: true, batteryPct: 25, chargeKw: 7, atHome: false }, haOpts).open;
assert.strictEqual(open.atHome, false);

// summary splits home / away
const mixed = [
  { endedAt: Date.now() - 1 * 864e5, kwh: 40, cost: 22, location: "away" },
  { endedAt: Date.now() - 2 * 864e5, kwh: 30, cost: 5.55, location: "home" },
  { endedAt: Date.now() - 3 * 864e5, kwh: 10, cost: 1.85 } // no location -> home
];
const ms = S.summary(mixed, 30);
assert.strictEqual(ms.count, 3);
assert.strictEqual(ms.home.count, 2);
assert.strictEqual(ms.home.kwh, 40);
assert.strictEqual(ms.away.count, 1);
assert.strictEqual(ms.away.cost, 22);

// --- per-zone rate override (cur.rate / cur.rateLabel) ---
open = S.update(null, { t: t0, charging: true, plugged: true, batteryPct: 20, chargeKw: 50,
  atHome: false, rate: 0.31, rateLabel: "Work" }, haOpts).open;
assert.strictEqual(open.rate, 0.31);
r = S.update(open, { t: t0 + 30 * MIN, charging: false, plugged: false, batteryPct: 60 }, haOpts);
assert.strictEqual(r.closed.location, "Work");
assert.strictEqual(r.closed.cost, 12.4); // 40 * 0.31, not the 0.55 away rate
assert.strictEqual(r.closed.pricePerKwh, 0.31);

// a rate labelled "home" keeps the session in the home bucket
open = S.update(null, { t: t0, charging: true, plugged: true, batteryPct: 20, chargeKw: 7,
  rate: 0.12, rateLabel: "home" }, haOpts).open;
r = S.update(open, { t: t0 + 30 * MIN, charging: false, plugged: false, batteryPct: 60 }, haOpts);
assert.strictEqual(r.closed.location, "home");
assert.strictEqual(r.closed.cost, 4.8); // 40 * 0.12

// rate learned on a later sample when the first was unknown
open = S.update(null, { t: t0, charging: true, plugged: true, batteryPct: 20, chargeKw: 7 }, haOpts).open;
open = S.update(open, { t: t0 + 5 * MIN, charging: true, plugged: true, batteryPct: 25, chargeKw: 7,
  rate: 0.4, rateLabel: "Depot" }, haOpts).open;
assert.strictEqual(open.rate, 0.4);
assert.strictEqual(open.rateLabel, "Depot");

// summary files a zone-named session under away
const zoned = S.summary([
  { endedAt: Date.now() - 1 * 864e5, kwh: 40, cost: 12.4, location: "Work" },
  { endedAt: Date.now() - 2 * 864e5, kwh: 30, cost: 5.55, location: "home" }
], 30);
assert.strictEqual(zoned.away.count, 1);
assert.strictEqual(zoned.away.cost, 12.4);
assert.strictEqual(zoned.home.count, 1);

// --- applyCost: adopt a real / manual figure ---
const est = { startedAt: 1, kwh: 30, cost: 16.5, costSource: "rate", location: "away" };
const real = S.applyCost(est, 24.99, "external");
assert.strictEqual(real.cost, 24.99);
assert.strictEqual(real.costSource, "external");
assert.strictEqual(real.estimatedCost, 16.5, "rate estimate kept");
assert.strictEqual(est.cost, 16.5, "original untouched");
// second override keeps the first estimate, not the override
const real2 = S.applyCost(real, 20, "manual");
assert.strictEqual(real2.estimatedCost, 16.5);
assert.strictEqual(real2.cost, 20);
// junk cost -> unchanged cost, still copied
assert.strictEqual(S.applyCost(est, "x", "external").cost, 16.5);
assert.strictEqual(S.applyCost(null, 5, "external"), null);

console.log("all sessions tests passed");
