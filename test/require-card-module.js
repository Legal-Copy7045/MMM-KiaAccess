/* Loads the GENERATED Lovelace card bundle (custom_components/kia_access/
 * frontend/kia-access-card.js -- scripts/sync-core.js's concatenation of
 * core/state.js, visuals.js, conditions.js, range.js, isoline.js, trips.js
 * + both card/*.src.js sources) OUTSIDE a real browser, the same
 * vm.runInThisContext approach test/require-mm-module.js uses for
 * MMM-KiaAccess.js: this file isn't CommonJS, it talks to browser globals
 * (`HTMLElement`, `customElements.define`, `self`/`window`, `document`,
 * `localStorage`) rather than `require()`/`module.exports`.
 *
 * Loading the GENERATED bundle (not the two card/*.src.js files directly)
 * means a test here is exercising the exact artifact HACS ships -- and
 * incidentally catches a forgotten `node scripts/sync-core.js` the same
 * way `scripts/sync-core.js --check` does in CI, just earlier.
 *
 * Deliberately does NOT stub a real DOM (no jsdom): the tests this loader
 * exists for (test/card-map-keys.test.js) exercise the key-sourcing logic
 * only (_inputs()/_rangeInputs(), _maybeFetchKeys()/_maybeFetchMapKeys())
 * by calling those methods directly, never _render()/_draw() -- those
 * need Leaflet + a real shadow DOM this harness doesn't attempt to fake.
 *
 * Usage: const loadCardModule = require("./require-card-module.js");
 *        const { KiaAccessCard, KiaRangeMapCard } = loadCardModule();
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

class FakeShadowRoot {
  appendChild() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  getElementById() { return null; }
  set innerHTML(_v) { /* discarded -- no test here inspects rendered markup */ }
  get innerHTML() { return ""; }
}

class FakeHTMLElement {
  attachShadow() { return new FakeShadowRoot(); }
}

function loadCardModule() {
  const filePath = path.join(
    __dirname, "..", "custom_components", "kia_access", "frontend", "kia-access-card.js"
  );
  const src = fs.readFileSync(filePath, "utf8");

  const captured = {};
  global.HTMLElement = FakeHTMLElement;
  global.customElements = {
    define(name, cls) { captured[name] = cls; },
    get(name) { return captured[name]; }
  };
  global.self = global;
  global.window = global;
  global.document = {
    createElement() {
      return { setAttribute() {}, style: {}, addEventListener() {}, remove() {} };
    },
    head: { appendChild() {} }
  };
  // per-test-process, not per-card-instance -- matches a real browser's
  // one shared localStorage; individual tests that care about the
  // selected-vehicle store reset it themselves
  global.localStorage = global.localStorage || {
    _s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem(k, v) { this._s[k] = String(v); },
    removeItem(k) { delete this._s[k]; }
  };

  // core/range.js and core/isoline.js (bundled ahead of the card sources)
  // are UMD-wrapped: `if (typeof module === "object" && module.exports)
  // module.exports = factory(); else root.KiaAccessRange = factory();`.
  // vm.runInThisContext shares this test FILE's own `module`/`exports`/
  // `require` bindings (they're visible as ambient globals in this Node
  // version) -- without shadowing them, the UMD check sees a real
  // `module.exports` and takes that branch, silently overwriting the test
  // file's own module.exports instead of setting `self.KiaAccessRange`/
  // `self.KiaAccessIsoline`, which every card method that computes a
  // reachable distance then needs. Wrapping in an IIFE with its own
  // (undefined) module/exports/require params shadows the leaked globals
  // so the UMD wrappers correctly fall through to the `self.X = factory()`
  // branch instead.
  vm.runInThisContext(
    "(function (module, exports, require) {\n" + src + "\n})(undefined, undefined, undefined);",
    { filename: filePath }
  );

  if (!captured["kia-access-card"] || !captured["kia-range-map-card"]) {
    throw new Error(
      "customElements.define(...) did not register both cards -- did the " +
      "generated bundle's shape change? (run: node scripts/sync-core.js)"
    );
  }
  return {
    KiaAccessCard: captured["kia-access-card"],
    KiaRangeMapCard: captured["kia-range-map-card"]
  };
}

module.exports = loadCardModule;
