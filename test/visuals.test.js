/* node test/visuals.test.js */
const assert = require("assert");
const V = require("../core/visuals.js");

// ---- default (EV) behaviour must be byte-identical to before powertrain
// variants existed -- carDiagram()'s centre-cell rendering used to be
// hardcoded to verticalBattery()+battery12v(); it's now routed through
// mainPowerCell(), which must be a no-op for every existing caller that
// never passes o.powertrain. ----
{
  const s = { locked: true, batteryPct: 78, carOn: false, car12vPct: 88 };
  const withoutOpt = V.carDiagram(s, { width: 200 });
  const withEvOpt = V.carDiagram(s, { width: 200, powertrain: "ev" });
  assert.strictEqual(withoutOpt, withEvOpt, "omitting powertrain must render identically to powertrain:'ev'");
  assert.ok(withoutOpt.includes(">78%<"), "EV diagram must still show the drive battery %");
}

// ---- o.battery === false must still suppress the centre cell(s)
// entirely, regardless of powertrain ----
{
  const svg = V.carDiagram({ locked: true, batteryPct: 78, fuelPct: 50 }, { width: 200, powertrain: "hybrid", battery: false });
  assert.ok(!svg.includes(">78%<") && !svg.includes(">50%<"), "battery:false must omit every centre cell");
}

// ---- gas: a fuel tank in place of the drive battery, no drive battery at
// all -- the 12V accessory battery is unaffected (every car has one) ----
{
  const svg = V.carDiagram({ locked: true, fuelPct: 62, car12vPct: 80 }, { width: 200, powertrain: "gas" });
  assert.ok(svg.includes(">62%<"), "gas diagram must show the fuel level");
  assert.ok(svg.includes(">80%<"), "gas diagram must still show the 12V battery");
  const tankOnly = V.verticalFuelTank(62, 100, false);
  assert.ok(tankOnly.includes(">62%<"));
}

// ---- hybrid: BOTH a (smaller) drive battery and a fuel tank, side by
// side, plus the 12V battery -- this is the exact scenario a Kia Access
// hybrid/PHEV account should render, unlike the EV-only diagram this
// module originally shipped with ----
{
  const svg = V.carDiagram(
    { locked: true, batteryPct: 64, fuelPct: 71, car12vPct: 80, charging: true },
    { width: 200, powertrain: "hybrid" }
  );
  assert.ok(svg.includes(">64%<"), "hybrid diagram must show the drive battery %");
  assert.ok(svg.includes(">71%<"), "hybrid diagram must show the fuel level");
  assert.ok(svg.includes(">80%<"), "hybrid diagram must still show the 12V battery");
  // charging must still animate the drive-battery bolt in hybrid mode
  assert.ok(svg.includes("animate attributeName=\"opacity\" values=\"0.35;1;0.35\""), "hybrid charging must still show the bolt animation");
}

// ---- hybrid layout's battery topper icon: the lightning bolt must stay
// fully inside the small battery outline, with roughly equal clearance
// top and bottom -- it previously overshot the bottom edge (negative
// margin) because its start point wasn't offset to account for the
// bolt's own bounding box being taller than the body's own centred fit ----
{
  const svg = V.verticalBattery(64, false, 84, true, true);
  const rects = [...svg.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g)];
  const [rx, ry, rw, rh] = rects[1].slice(1, 5).map(Number); // topper's own outline rect
  const pm = svg.match(/<path d="M ([-\d.]+) ([-\d.]+)((?: [lh] [-\d.]+(?: [-\d.]+)?)+) z" fill="/);
  let x = +pm[1], y = +pm[2];
  let minY = y, maxY = y, minX = x, maxX = x;
  const toks = pm[3].trim().split(/\s+/);
  for (let i = 0; i < toks.length; ) {
    const cmd = toks[i++];
    if (cmd === "l") { x += +toks[i++]; y += +toks[i++]; }
    else if (cmd === "h") { x += +toks[i++]; }
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
  }
  const topMargin = minY - ry, bottomMargin = (ry + rh) - maxY;
  assert.ok(topMargin > 0.5, "bolt must clear the top edge of the battery outline: " + topMargin);
  assert.ok(bottomMargin > 0.5, "bolt must not touch/overshoot the bottom edge of the battery outline: " + bottomMargin);
  assert.ok(Math.abs(topMargin - bottomMargin) < 0.1, "bolt must be vertically centred (equal top/bottom margins)");
  assert.ok(Math.abs((minX + maxX) / 2 - (rx + rw / 2)) < 0.1, "bolt must be horizontally centred");
}

// ---- verticalFuelTank()/verticalBattery() standalone: unknown level ----
{
  const tank = V.verticalFuelTank(null, 100, false);
  assert.ok(tank.includes(">—<"), "unknown fuel level must render as an em dash, not NaN%");
  const batt = V.verticalBattery(null, false, 100, false);
  assert.ok(batt.includes(">—<"), "unknown battery level must render as an em dash, not NaN%");
}

// ---- powerTile()/fuelTile()/batteryTile(): the standalone icon-tile
// widget (icon + level bar + big % label) -- a caption-widget alternative
// to batteryGauge(), not something embedded in the small car-body diagram ----
{
  const fuel = V.fuelTile(52, { width: 210 });
  assert.ok(fuel.includes(">52%<"), "fuelTile must show the fuel level");
  assert.ok(fuel.includes("kiaaccess-powertile"), "fuelTile must render the powertile svg");

  const batt = V.batteryTile(62, { width: 210 });
  assert.ok(batt.includes(">62%<"), "batteryTile must show the battery level");

  // fuel reads amber/gold in its normal range (distinct from the battery's
  // green), still escalating to red when critically low
  const fuelNormal = V.fuelTile(52, {});
  assert.ok(fuelNormal.includes(V.COL.warn), "fuel in its normal range must use the amber/gold fill colour");
  const fuelCritical = V.fuelTile(9, {});
  assert.ok(fuelCritical.includes(V.COL.bad), "critically low fuel must still use the red fill colour");

  const battCharging = V.batteryTile(48, { width: 210, charging: true });
  assert.ok(battCharging.includes("animate"), "batteryTile must pulse while charging");
  const battIdle = V.batteryTile(48, { width: 210 });
  assert.ok(!battIdle.includes("animate"), "batteryTile must not animate when not charging");

  const unknown = V.fuelTile(null, {});
  assert.ok(unknown.includes(">—<"), "unknown fuel level must render as an em dash");
}

// ---- live charge readout: kW AND amps while charging. Kia USA reports
// realTimePower (kW) only -- hyundai_kia_connect_api's ev_charging_current is
// "Europe feature only" -- so a Kia USA car never has chargeAmps, and the
// diagram used to show kW with no amps at all. ----
{
  const amps = (svg) => (svg.match(/>(~?\d+A)</) || [])[1] || null;
  const draw = (state) => V.carDiagram(Object.assign({ locked: true, batteryPct: 50 }, state), { width: 200 });

  // a value the car reports itself is shown as-is, never marked as an estimate
  const reported = draw({ charging: true, chargeKw: 7.4, chargeAmps: 32 });
  assert.ok(reported.includes(">7.4kW<"), "kW must be shown");
  assert.strictEqual(amps(reported), "32A", "a reported current must be shown unmodified, without a ~");

  // AC charging with no reported current (the Kia USA case): estimate from kW at
  // a nominal 240 V, and mark it as an estimate
  const ac = draw({ charging: true, chargeKw: 7.4 });
  assert.ok(ac.includes(">7.4kW<"));
  assert.strictEqual(amps(ac), "~31A", "7.4 kW / 240 V = 30.8 A");
  assert.strictEqual(amps(draw({ charging: true, chargeKw: 11 })), "~46A", "11 kW / 240 V = 45.8 A");

  // under 3 kW is a Level 1 (120 V) trickle charge, not a Level 2 one at low power
  assert.strictEqual(amps(draw({ charging: true, chargeKw: 1.4 })), "~12A", "1.4 kW / 120 V = 11.7 A");
  assert.strictEqual(amps(draw({ charging: true, chargeKw: 2.9 })), "~24A", "2.9 kW / 120 V = 24.2 A");
  assert.strictEqual(amps(draw({ charging: true, chargeKw: 3 })), "~13A", "3 kW is the first 240 V value: 12.5 A");
  assert.strictEqual(amps(draw({ charging: true, chargeKw: 0.05 })), null, "a sub-1 A estimate is noise, not a reading");
  assert.ok(draw({ charging: true, chargeKw: 1.4 }).includes(">1.4kW<"));

  // the top of the estimate range is a home Level 2 charger's physical maximum
  // (80 A x 240 V = 19.2 kW); above that it is DC fast charging
  assert.strictEqual(amps(draw({ charging: true, chargeKw: 19.2 })), "~80A");
  assert.strictEqual(amps(draw({ charging: true, chargeKw: 19.3 })), null,
    "above the AC range there is no reliable voltage, so no amps are invented");

  // DC fast charging with no reported current: kW only. The voltage depends
  // on the car's pack and isn't reported, so any figure could be off by 2x.
  const dc = draw({ charging: true, chargeKw: 150 });
  assert.ok(dc.includes(">150kW<"));
  assert.strictEqual(amps(dc), null, "no invented amps for DC fast charging");
  // ...but a reported current is still shown there
  assert.strictEqual(amps(draw({ charging: true, chargeKw: 150, chargeAmps: 375 })), "375A");

  // a reported 0 A while charging carries no information: fall back to the estimate
  assert.strictEqual(amps(draw({ charging: true, chargeKw: 7.4, chargeAmps: 0 })), "~31A");

  // no power reading -> nothing to estimate from; not charging -> no readout at all
  assert.strictEqual(amps(draw({ charging: true })), null);
  assert.strictEqual(amps(draw({ charging: false, chargeKw: 7.4 })), null);
}

console.log("all visuals tests passed");
