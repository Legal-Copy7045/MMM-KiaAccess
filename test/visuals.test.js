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

console.log("all visuals tests passed");
