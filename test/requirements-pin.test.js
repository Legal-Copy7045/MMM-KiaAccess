/* node test/requirements-pin.test.js
 *
 * hyundai_kia_connect_api is pinned (not left as a floor/open range) so a
 * fresh `npm install` / HA config-entry setup can't silently pick up an
 * upstream release this project hasn't been tested against. Guards two
 * things: requirements.txt must use an exact `==` pin, and manifest.json's
 * own requirements entry must name the identical version -- HA resolves
 * its own dependency from manifest.json, independently of requirements.txt,
 * so the two drifting apart would mean the MagicMirror/bridge side and the
 * HA integration side end up running different library versions.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PKG = "hyundai_kia_connect_api";

const reqTxt = fs.readFileSync(path.join(ROOT, "requirements.txt"), "utf8");
const reqLine = reqTxt.split(/\r?\n/).find((l) => l.trim().startsWith(PKG));
assert.ok(reqLine, "requirements.txt must list " + PKG);
const reqMatch = reqLine.trim().match(/^hyundai_kia_connect_api==([0-9][\w.]*)$/);
assert.ok(
  reqMatch,
  "requirements.txt must pin " + PKG + " with an exact '==' version, not a floor/range/unpinned spec: " +
    JSON.stringify(reqLine)
);
const reqVersion = reqMatch[1];

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "custom_components/kia_access/manifest.json"), "utf8")
);
const manifestReq = (manifest.requirements || []).find((r) => r.startsWith(PKG));
assert.ok(manifestReq, "manifest.json requirements must list " + PKG);
const manifestMatch = manifestReq.match(/^hyundai_kia_connect_api==([0-9][\w.]*)$/);
assert.ok(
  manifestMatch,
  "manifest.json must pin " + PKG + " with an exact '==' version: " + JSON.stringify(manifestReq)
);
assert.strictEqual(
  manifestMatch[1], reqVersion,
  "requirements.txt (" + reqVersion + ") and manifest.json (" + manifestMatch[1] + ") must pin the identical " + PKG + " version"
);

console.log("all requirements-pin tests passed");
