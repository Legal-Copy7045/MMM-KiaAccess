/* node test/card-powertrain-rows.test.js
 *
 * KiaAccessCard._hidePowertrainRow() -- for a pure EV, hyundai_kia_connect_api
 * falls back to reporting the SAME distanceToEmpty figure for
 * fuel_driving_range that total_driving_range/ev_driving_range already show
 * (a BEV has no real "gas mode range" to report), so the card's row table
 * used to show three identical numbers under three different labels
 * ("EV range" / "Total range" / "Fuel range"), plus a meaningless "Fuel
 * level: 0%" row. total_driving_range is already the API's own
 * powertrain-agnostic combined figure and always stays; this predicate is
 * what hides the redundant EV-only/ICE-only sub-rows so a PHEV/HEV (where
 * both readings ARE genuinely distinct information) keeps seeing both.
 *
 * Loads the real GENERATED bundle, same as test/card-map-keys.test.js.
 */
const assert = require("assert");
const loadCardModule = require("./require-card-module.js");

const { KiaAccessCard } = loadCardModule();
// the bundle's UMD wrapper sets this as a global (self === global under
// require-card-module.js's harness) -- see that file's header comment.
const buildState = global.KiaAccessState.buildState;

// ---- pure EV: fuel_driving_range / fuel_level / fuel_level_is_low are
// noise (mirror total_driving_range) and must be hidden ----
assert.strictEqual(KiaAccessCard._hidePowertrainRow("fuel_driving_range", "EV"), true);
assert.strictEqual(KiaAccessCard._hidePowertrainRow("fuel_level", "EV"), true);
assert.strictEqual(KiaAccessCard._hidePowertrainRow("fuel_level_is_low", "EV"), true);
// ev_driving_range and total_driving_range are the real numbers for an EV
// -- must stay visible
assert.strictEqual(KiaAccessCard._hidePowertrainRow("ev_driving_range", "EV"), false);
assert.strictEqual(KiaAccessCard._hidePowertrainRow("total_driving_range", "EV"), false);

// ---- pure ICE: the symmetric case -- no drive battery, so ev_driving_range
// is never real information ----
assert.strictEqual(KiaAccessCard._hidePowertrainRow("ev_driving_range", "ICE"), true);
// fuel_driving_range and total_driving_range ARE the real numbers for ICE
assert.strictEqual(KiaAccessCard._hidePowertrainRow("fuel_driving_range", "ICE"), false);
assert.strictEqual(KiaAccessCard._hidePowertrainRow("total_driving_range", "ICE"), false);
assert.strictEqual(KiaAccessCard._hidePowertrainRow("fuel_level", "ICE"), false);

// ---- PHEV/HEV: both readings are genuinely distinct real information
// alongside the combined total -- nothing gets hidden ----
for (const engineType of ["PHEV", "HEV"]) {
  assert.strictEqual(KiaAccessCard._hidePowertrainRow("fuel_driving_range", engineType), false, engineType);
  assert.strictEqual(KiaAccessCard._hidePowertrainRow("ev_driving_range", engineType), false, engineType);
  assert.strictEqual(KiaAccessCard._hidePowertrainRow("fuel_level", engineType), false, engineType);
  assert.strictEqual(KiaAccessCard._hidePowertrainRow("total_driving_range", engineType), false, engineType);
}

// ---- unknown/missing engine_type (older API response, or the Enum
// serialization bug from before it was fixed): must fail SAFE by showing
// everything, never silently hiding real data because the type is unclear ----
assert.strictEqual(KiaAccessCard._hidePowertrainRow("fuel_driving_range", ""), false);
assert.strictEqual(KiaAccessCard._hidePowertrainRow("ev_driving_range", ""), false);

// ---- an unrelated field key is never touched by this predicate,
// regardless of powertrain ----
assert.strictEqual(KiaAccessCard._hidePowertrainRow("odometer", "EV"), false);
assert.strictEqual(KiaAccessCard._hidePowertrainRow("odometer", "ICE"), false);

// KiaAccessCard used to carry its own _powertrainFor()/_canPlugInFor()
// statics, duplicating logic core/state.js's buildState() already computes
// (same mapping, a second copy of the same explanatory comment, maintained
// twice in one file) -- the card now reads state.powertrain/state.canPlugIn
// directly instead. That mapping's own correctness (unset -> "ev"/true,
// case-insensitivity, ICE/PHEV/HEV/EV handling) is already covered by
// test/state.test.js and test/contract_test.py against the real
// buildState() -- no need to re-test the same mapping a second time here
// against a card-local copy that no longer exists.

// ---- KiaAccessCard._rowVisible(): the `rows:` config allow-list, layered
// on top of the powertrain hide rule ----
{
  // unset (null) filter -- unchanged from before this option existed,
  // only the powertrain rule can hide a row
  assert.strictEqual(KiaAccessCard._rowVisible("odometer", null, "EV"), true);
  assert.strictEqual(KiaAccessCard._rowVisible("fuel_level", null, "EV"), false, "powertrain rule still applies");

  // an explicit allow-list hides anything not named in it
  const only = ["ev_battery_percentage", "odometer"];
  assert.strictEqual(KiaAccessCard._rowVisible("ev_battery_percentage", only, "EV"), true);
  assert.strictEqual(KiaAccessCard._rowVisible("odometer", only, "EV"), true);
  assert.strictEqual(KiaAccessCard._rowVisible("is_locked", only, "EV"), false, "not in the allow-list");

  // the allow-list and the powertrain rule both apply -- a key present in
  // the allow-list can still be hidden by the powertrain rule (listing
  // "fuel_level" for a pure EV doesn't force it to show meaningless data)
  assert.strictEqual(KiaAccessCard._rowVisible("fuel_level", ["fuel_level"], "EV"), false);
  // ...but the same key shows fine for a powertrain where it's real
  assert.strictEqual(KiaAccessCard._rowVisible("fuel_level", ["fuel_level"], "PHEV"), true);

  // an empty array is a deliberate "hide everything", not the same as
  // unset -- every row fails the allow-list check
  assert.strictEqual(KiaAccessCard._rowVisible("odometer", [], "EV"), false);
}

// ---- actionsGroupsHtml(): the "charge" category button group (open/close
// charge port, start/stop charging) must not render at all for a vehicle
// with no plug -- gas, or a conventional (non-plug) hybrid. Other
// categories (security, find, climate, ...) are unaffected. ----
{
  const gas = KiaAccessCard._actionsGroupsHtml(false);
  assert.ok(!gas.includes("data-cmd='start_charge'"), "no plug: no start_charge button");
  assert.ok(!gas.includes("data-cmd='stop_charge'"), "no plug: no stop_charge button");
  assert.ok(!gas.includes("data-cmd='open_charge_port'"), "no plug: no open_charge_port button");
  assert.ok(!gas.includes("data-cmd='close_charge_port'"), "no plug: no close_charge_port button");
  assert.ok(gas.includes("data-cmd='lock'"), "no plug: non-charge commands unaffected");
  assert.ok(gas.includes("data-cmd='flash_lights'"), "no plug: non-charge commands unaffected");

  const ev = KiaAccessCard._actionsGroupsHtml(true);
  assert.ok(ev.includes("data-cmd='start_charge'"), "can plug in: charging commands present");

  // no argument at all -> same as true (safe default, never hides a real
  // vehicle's controls just because the caller omitted it)
  const unset = KiaAccessCard._actionsGroupsHtml();
  assert.ok(unset.includes("data-cmd='start_charge'"), "no argument -> defaults to showing");

  // exercised end-to-end through the real buildState(), matching how the
  // render path actually calls this (actionsGroupsHtml(state.canPlugIn))
  // -- a PHEV shows charging controls, an HEV does not, even though both
  // share the same buildState() powertrain:"hybrid" bucket
  const phev = KiaAccessCard._actionsGroupsHtml(buildState({ "vehicle.engine_type": "PHEV" }, {}).canPlugIn);
  assert.ok(phev.includes("data-cmd='start_charge'"), "PHEV: charging commands present");
  const hev = KiaAccessCard._actionsGroupsHtml(buildState({ "vehicle.engine_type": "HEV" }, {}).canPlugIn);
  assert.ok(!hev.includes("data-cmd='start_charge'"), "HEV: no charging commands (no plug)");
}

console.log("all card-powertrain-rows tests passed");
