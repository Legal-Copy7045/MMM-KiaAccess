/* Runs the Python side of the test suite -- the JS/Python parity checks
 * (test/*_test.py, e.g. sessions_test.py/trips_test.py/analytics_test.py)
 * that pin the two ports of core/*.js to identical behaviour.
 *
 * `npm test` only runs the JS suite -- a JS-only change to core/sessions.js
 * etc. that silently drifts from its Python mirror (sessions.py) would pass
 * `npm test` cleanly and only get caught by CI's separate "python" job.
 * This gives that same check as one local command, mirroring
 * .github/workflows/ci.yml's "python" + "hass" jobs exactly (keep this
 * list in sync with that file if either changes).
 *
 *   node scripts/test-python.js             # both groups
 *   npm run test:python                     # same, via package.json
 *
 * The "hass" group needs `pip install homeassistant` (a large optional
 * dependency most contributors won't have installed) -- if it's missing,
 * that group is SKIPPED with a warning rather than failing the whole run,
 * same as a contributor who only ran `pip install -r requirements.txt`.
 */
const { spawnSync } = require("child_process");

const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");

// mirrors ci.yml's "python" job step order
const CORE_TESTS = [
  "test/spec_check.py",
  "test/contract_test.py",
  "test/dump_vehicle_test.py",
  "test/region_map_test.py",
  "test/token_file_test.py",
  "test/auth_cooldown_test.py",
  "test/sessions_test.py",
  "test/range_test.py",
  "test/routing_test.py",
  "test/route_budget_test.py",
  "test/trips_test.py",
  "test/analytics_test.py",
  "test/account_poll_test.py"
];

// mirrors ci.yml's "hass" job -- each of these imports the real
// `homeassistant` package, not just this repo's own requirements.txt
const HASS_TESTS = [
  "test/ha_import_check.py",
  "test/coordinator_analytics_test.py",
  "test/coordinator_stress_test.py",
  "test/coordinator_stale_test.py",
  "test/coordinator_wake_test.py",
  "test/climate_entity_test.py",
  "test/coordinator_alerts_test.py",
  "test/coordinator_charger_alert_test.py",
  "test/entity_gating_test.py",
  "test/service_authorization_test.py",
  "test/map_keys_test.py",
  "test/coordinator_routing_budget_test.py",
  "test/coordinator_geocode_test.py"
];

// Options (CI uses them; with none it behaves as before):
//   --group core|hass|all   which list to run (default all)
//   --fail-fast             stop at the first failing file
//   --require-hass          a missing `homeassistant` fails instead of skipping
//   --list                  print the files (for regression/run.py) and exit
const args = process.argv.slice(2);
const opt = (name) => args.includes(name);
const gi = args.indexOf("--group");
const group = gi >= 0 ? args[gi + 1] : "all";
if (!["core", "hass", "all"].includes(group)) {
  process.stderr.write(`test-python: unknown --group ${group}\n`);
  process.exit(2);
}

if (opt("--list")) {
  const files = [
    ...(group !== "hass" ? CORE_TESTS.map((f) => "core " + f) : []),
    ...(group !== "core" ? HASS_TESTS.map((f) => "hass " + f) : [])
  ];
  process.stdout.write(files.join("\n") + "\n");
  process.exit(0);
}

function run(file) {
  process.stdout.write(`-- ${file}\n`);
  const res = spawnSync(PY, [file], { stdio: "inherit" });
  if (res.error) throw res.error;
  return res.status === 0;
}

function hassAvailable() {
  const res = spawnSync(PY, ["-c", "import homeassistant"], { stdio: "ignore" });
  return res.status === 0;
}

const failed = [];
function runAll(files) {
  for (const file of files) {
    if (!run(file)) {
      failed.push(file);
      if (opt("--fail-fast")) return;
    }
  }
}

if (group !== "hass") runAll(CORE_TESTS);

if (group !== "core" && !(failed.length && opt("--fail-fast"))) {
  if (hassAvailable()) {
    runAll(HASS_TESTS);
  } else if (opt("--require-hass")) {
    failed.push("(homeassistant is not installed -- pip install homeassistant)");
  } else {
    process.stdout.write(
      "\nSkipping the \"hass\" group (ha_import_check.py, coordinator_analytics_test.py, " +
      "map_keys_test.py) -- `homeassistant` isn't installed. Run `pip install homeassistant` " +
      "to include it, or see .github/workflows/ci.yml's \"hass\" job (this is what CI runs).\n"
    );
  }
}

if (failed.length) {
  process.stderr.write(`\ntest-python: failed: ${failed.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("\nall Python tests passed\n");
