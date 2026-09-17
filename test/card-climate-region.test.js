/* node test/card-climate-region.test.js
 *
 * climTempBounds() decides which unit/bounds the climate panel's set_temp
 * slider uses for a given vehicle region. Canada must NOT be treated as a
 * Fahrenheit region: hyundai_kia_connect_api's KiaUvoApiCA.start_climate
 * takes set_temp in Celsius (a hard `.index()` lookup into a 14.0-31.5C
 * tuple in 0.5 steps) -- only KiaUvoApiUSA actually wants Fahrenheit.
 * Treating CA as Fahrenheit sent a 62-82 value that's never in that
 * tuple, so start_climate raised an unhandled ValueError on every call
 * for a real Canadian account. See kia_client.py's matching fix/test.
 *
 * Loads the real GENERATED bundle, same as test/card-map-keys.test.js.
 */
const assert = require("assert");
const loadCardModule = require("./require-card-module.js");

const { KiaAccessCard } = loadCardModule();

const usa = KiaAccessCard._climTempBounds("USA");
assert.strictEqual(usa.fahrenheit, true);
assert.deepStrictEqual([usa.min, usa.max, usa.step], [62, 82, 1]);

const ca = KiaAccessCard._climTempBounds("CA");
assert.strictEqual(ca.fahrenheit, false, "Canada is metric, not Fahrenheit");
assert.deepStrictEqual([ca.min, ca.max, ca.step], [16, 30, 0.5]);

const eu = KiaAccessCard._climTempBounds("EU");
assert.strictEqual(eu.fahrenheit, false);
assert.deepStrictEqual([eu.min, eu.max, eu.step], [16, 30, 0.5]);

// case-insensitive, and an unset region defaults to USA (matches
// climTempBounds()'s own `region || "USA"` fallback)
assert.strictEqual(KiaAccessCard._climTempBounds("ca").fahrenheit, false);
assert.strictEqual(KiaAccessCard._climTempBounds().fahrenheit, true);
assert.strictEqual(KiaAccessCard._climTempBounds(undefined).fahrenheit, true);

console.log("all card-climate-region tests passed");
