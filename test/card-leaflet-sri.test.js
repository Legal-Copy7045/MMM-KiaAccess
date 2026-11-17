/* node test/card-leaflet-sri.test.js
 *
 * kia-range-map-card.src.js runs INSIDE the Home Assistant dashboard's own
 * origin, where `hass` and the user's auth token live, so it must never load
 * code from the internet. Leaflet ships with the integration
 * (custom_components/kia_access/frontend/leaflet/) and is served by HA
 * itself (LEAFLET_URL in __init__.py). This checks:
 *   - the card loads Leaflet from that local path, and no http(s) script
 *     or stylesheet URL is left in the bundle,
 *   - the vendored files are the unmodified upstream leaflet@<version>
 *     (their SHA-512 equals the published SRI hash), and the card still
 *     sets .integrity to those hashes as a second check,
 *   - the URL the card uses matches the one __init__.py serves.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const bundle = fs.readFileSync(
  path.join(__dirname, "..", "custom_components", "kia_access", "frontend", "kia-access-card.js"),
  "utf8"
);

const verMatch = bundle.match(/LEAFLET_VER = "([\d.]+)"/);
assert.ok(verMatch, "must find the pinned Leaflet version");
const version = verMatch[1];

assert.ok(bundle.includes('s.integrity = LEAFLET_JS_SRI'), "the Leaflet <script> must set .integrity");
assert.ok(bundle.includes('css.integrity = LEAFLET_CSS_SRI'), "the Leaflet <link> must set .integrity");

const jsHashMatch = bundle.match(/LEAFLET_JS_SRI = "(sha512-[^"]+)"/);
const cssHashMatch = bundle.match(/LEAFLET_CSS_SRI = "(sha512-[^"]+)"/);
assert.ok(jsHashMatch && cssHashMatch, "both SRI hash constants must be present");

// published SRI hashes for leaflet's dist files (https://api.cdnjs.com/
// libraries/leaflet/<version>?fields=sri; identical to the npm package).
const KNOWN_HASHES = {
  "1.9.4": {
    "leaflet.js": "sha512-BwHfrr4c9kmRkLw6iXFdzcdWV/PGkVgiIyIWLLlTSXzWQzxuSg4DiQUCpauz/EWjgk5TYQqX/kvn9pG1NpYfqg==",
    "leaflet.css": "sha512-Zcn6bjR/8RZbLEpLIeOwNtzREBAJnUKESxces60Mpoj+2okopSAcSUIUOseddDm0cxnGQzxIR7vJgsLZbdLE3w=="
  }
};
const known = KNOWN_HASHES[version];
assert.ok(known, `no known-good SRI hash recorded here for Leaflet ${version} -- if you bumped ` +
  "LEAFLET_VER, replace frontend/leaflet/ with the new dist files, fetch the hashes from " +
  "https://api.cdnjs.com/libraries/leaflet/" + version + "?fields=sri and update the card, " +
  "LEAFLET_URL in __init__.py and this test");
assert.strictEqual(jsHashMatch[1], known["leaflet.js"], `LEAFLET_JS_SRI must match the published hash for leaflet.js ${version}`);
assert.strictEqual(cssHashMatch[1], known["leaflet.css"], `LEAFLET_CSS_SRI must match the published hash for leaflet.css ${version}`);

// the vendored files are byte-identical to upstream (same hash as published)
const crypto = require("crypto");
const vendor = path.join(__dirname, "..", "custom_components", "kia_access", "frontend", "leaflet");
for (const f of ["leaflet.js", "leaflet.css"]) {
  const sri = "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(path.join(vendor, f))).digest("base64");
  assert.strictEqual(sri, known[f], `vendored ${f} must be the unmodified leaflet ${version} file`);
}
assert.ok(fs.existsSync(path.join(vendor, "LICENSE")), "Leaflet's licence must ship with it");

// loaded from Home Assistant itself, never a remote host
assert.ok(bundle.includes('var LEAFLET_BASE = "/kia_access/leaflet-" + LEAFLET_VER + "/";'),
  "the card must load Leaflet from the integration's own static path");
assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(bundle) && !/LEAFLET_\w+\s*=\s*"https?:/.test(bundle),
  "no remote script or stylesheet URL may be left in the card bundle");
assert.ok(!bundle.includes("cdnjs"), "the card must not reference a CDN");

const init = fs.readFileSync(
  path.join(__dirname, "..", "custom_components", "kia_access", "__init__.py"), "utf8");
assert.ok(init.includes(`LEAFLET_URL = f"/{DOMAIN}/leaflet-${version}"`),
  "__init__.py must serve Leaflet at the URL (and version) the card loads");
assert.ok(/StaticPathConfig\(LEAFLET_URL, _LEAFLET_DIR, True\)/.test(init),
  "__init__.py must register the Leaflet folder as a static path");

console.log("all card-leaflet-sri tests passed");
