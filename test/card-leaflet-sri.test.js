/* node test/card-leaflet-sri.test.js
 *
 * kia-range-map-card.src.js loads Leaflet from cdnjs -- INSIDE the Home
 * Assistant dashboard's own origin, where `hass` and the user's auth token
 * live. Without Subresource Integrity, a CDN or DNS compromise serving
 * different bytes under that same URL would be a full HA account
 * takeover, not just a broken map. This pins both the JS and CSS loads to
 * cdnjs' own published SHA-512 hashes for the exact pinned Leaflet
 * version and requires crossOrigin so the browser actually enforces it
 * (SRI is silently skipped on a non-CORS request).
 *
 * The require-card-module.js test harness stubs document.createElement()
 * with a plain object (no real DOM), so this checks the GENERATED bundle's
 * source text directly rather than driving loadLeafletJs() -- lighter, and
 * still fails if someone removes the integrity/crossOrigin assignments or
 * the hash stops matching the pinned version.
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
assert.ok(bundle.includes('s.crossOrigin = "anonymous"'), "the Leaflet <script> must be a CORS request (SRI is silently skipped otherwise)");
assert.ok(bundle.includes('css.integrity = LEAFLET_CSS_SRI'), "the Leaflet <link> must set .integrity");
assert.ok(bundle.includes('css.crossOrigin = "anonymous"'), "the Leaflet <link> must be a CORS request");

const jsHashMatch = bundle.match(/LEAFLET_JS_SRI = "(sha512-[^"]+)"/);
const cssHashMatch = bundle.match(/LEAFLET_CSS_SRI = "(sha512-[^"]+)"/);
assert.ok(jsHashMatch && cssHashMatch, "both SRI hash constants must be present");

// cdnjs.com publishes the SRI hash for every file/version it serves --
// this is the authoritative source these were pinned from
// (https://api.cdnjs.com/libraries/leaflet/<version>?fields=sri).
const KNOWN_HASHES = {
  "1.9.4": {
    "leaflet.js": "sha512-BwHfrr4c9kmRkLw6iXFdzcdWV/PGkVgiIyIWLLlTSXzWQzxuSg4DiQUCpauz/EWjgk5TYQqX/kvn9pG1NpYfqg==",
    "leaflet.css": "sha512-Zcn6bjR/8RZbLEpLIeOwNtzREBAJnUKESxces60Mpoj+2okopSAcSUIUOseddDm0cxnGQzxIR7vJgsLZbdLE3w=="
  }
};
const known = KNOWN_HASHES[version];
assert.ok(known, `no known-good SRI hash recorded here for Leaflet ${version} -- if you bumped ` +
  "LEAFLET_VER, fetch the new hashes from https://api.cdnjs.com/libraries/leaflet/" + version +
  "?fields=sri and add them to both kia-range-map-card.src.js and this test");
assert.strictEqual(jsHashMatch[1], known["leaflet.js"], `LEAFLET_JS_SRI must match cdnjs' published hash for leaflet.js ${version}`);
assert.strictEqual(cssHashMatch[1], known["leaflet.css"], `LEAFLET_CSS_SRI must match cdnjs' published hash for leaflet.css ${version}`);

console.log("all card-leaflet-sri tests passed");
