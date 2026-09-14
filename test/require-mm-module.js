/* Loads MMM-KiaAccess.js OUTSIDE a real MagicMirror browser environment.
 *
 * Unlike node_helper.js this file isn't CommonJS at all -- MagicMirror's
 * frontend loader concatenates module files as plain <script>s, so it talks
 * to two ambient GLOBALS (`Module.register(name, spec)`, `Log`) rather than
 * `require()`. A bare `node MMM-KiaAccess.js` would throw
 * "Module is not defined" before it got anywhere near the logic worth
 * testing.
 *
 * This defines `global.Module`/`global.Log` (once; safe to call repeatedly)
 * and runs the file's source with `vm.runInThisContext` (same V8 realm as
 * the test -- unlike `vm.createContext`, which spins up a SEPARATE realm
 * with its own Object/Array built-ins; objects the module builds
 * internally, e.g. every `{}` literal in start(), would then have a
 * different prototype than the `{}` object literals in the test file
 * itself, making assert.deepStrictEqual fail even on genuinely
 * identical-looking objects). `global.Log` is deliberately left in place
 * (not restored) after loading: MMM-KiaAccess.js's methods reference the
 * free variable `Log` at CALL time, not at load time, and a test calls
 * captured methods long after this function returns -- restoring it here
 * would leave `Log` undefined the moment any test method logs anything.
 * That's fine: this loader is only ever used from within a test process
 * dedicated to exercising this one module.
 *
 * Usage: const loadMMModule = require("./require-mm-module.js");
 *        const mod = loadMMModule(); // a fresh spec object each call
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadMMModule() {
  const filePath = path.join(__dirname, "..", "MMM-KiaAccess.js");
  const src = fs.readFileSync(filePath, "utf8");

  let captured = null;
  global.Module = {
    register(_name, spec) {
      captured = spec;
    }
  };
  global.Log = global.Log || {
    info() {},
    warn() {},
    error() {},
    debug() {},
    log() {}
  };
  vm.runInThisContext(src, { filename: filePath });

  if (!captured) {
    throw new Error("Module.register(...) was never called -- did MMM-KiaAccess.js's top-level structure change?");
  }
  return captured;
}

module.exports = loadMMModule;
