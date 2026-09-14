/* Loads node_helper.js OUTSIDE a real MagicMirror install.
 *
 * node_helper.js does `require("node_helper")` and `require("logger")` --
 * both are modules MagicMirror's own loader provides at runtime; neither
 * exists as a real npm package, so a bare `node` process can't resolve
 * them. This temporarily patches Node's own module resolver to hand back
 * the stubs in test/stubs/ for exactly those two bare specifiers, requires
 * node_helper.js, then restores the resolver -- every OTHER require inside
 * node_helper.js (mqtt, ./core/*.js, ./exporter.js, ...) resolves exactly
 * as normal, untouched.
 *
 * Usage: const helperFactory = require("./require-node-helper.js");
 *        const helper = helperFactory(); // a fresh module.exports each call
 */
"use strict";
const Module = require("module");
const path = require("path");

const STUBS = {
  node_helper: path.join(__dirname, "stubs", "node_helper.js"),
  logger: path.join(__dirname, "stubs", "logger.js")
};

function loadNodeHelperModule() {
  const nodeHelperPath = path.join(__dirname, "..", "node_helper.js");
  // Fresh load every call: node_helper.js is a plain object (via
  // NodeHelper.create(spec) => spec), not a class, so re-requiring after
  // clearing the cache is how each test gets an independent instance with
  // its own inFlight/state/mqttClients/etc. -- reusing one shared instance
  // across tests would leak state between them.
  delete require.cache[require.resolve(nodeHelperPath)];

  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return origResolve.call(this, request, ...rest);
  };
  try {
    return require(nodeHelperPath);
  } finally {
    Module._resolveFilename = origResolve;
  }
}

module.exports = loadNodeHelperModule;
