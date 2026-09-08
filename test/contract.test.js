/* node test/contract.test.js
 * Runs every fixtures/*.json through core/state.js + core/conditions.js.
 * test/contract_test.py runs the same files through the Python ports; CI runs
 * both, so any JS<->Python drift fails the build.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { buildState } = require("../core/state.js");
const { evaluate } = require("../core/conditions.js");

const DIR = path.join(__dirname, "..", "fixtures");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
assert.ok(files.length >= 5, "expected a fixture corpus");

function resolveHistory(hist) {
  if (!Array.isArray(hist)) return hist;
  const now = Date.now();
  return hist.map((h) =>
    h && h.hoursAgo != null ? Object.assign({}, h, { t: now - h.hoursAgo * 3600e3 }) : h
  );
}

let checks = 0;
for (const file of files) {
  const fx = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));
  const label = `${file}: ${fx.name}`;

  let state;
  if (fx.state) {
    state = Object.assign({}, fx.state, { history: resolveHistory(fx.state.history) });
  } else {
    state = buildState(fx.flat || {}, {});
  }

  for (const [k, want] of Object.entries(fx.expectState || {})) {
    assert.deepStrictEqual(state[k], want, `${label} — state.${k}`);
    checks++;
  }

  const res = evaluate(state, fx.cfg || {}, fx.prev || {});
  for (const [reason, want] of Object.entries(fx.expectConditions || {})) {
    const c = res.conditions.find((x) => x.reason === reason);
    assert.ok(c, `${label} — condition '${reason}' not emitted`);
    assert.strictEqual(c.active, want, `${label} — ${reason}.active`);
    checks++;
  }
}

console.log(`all contract tests passed (${files.length} fixtures, ${checks} assertions)`);
