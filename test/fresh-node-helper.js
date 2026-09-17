/* Shared by every test file that needs a fresh, real node_helper.js instance
 * (test/node_helper.test.js, test/stress-node-helper.test.js) -- used to be
 * copy-pasted into each near-verbatim (only the tmp-dir prefix string
 * differed), a real drift risk if node_helper.js's own bootstrap ever grows
 * a new required field that only one copy gets updated for.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const loadNodeHelper = require("./require-node-helper.js");

function freshHelper(cacheDir) {
  const helper = loadNodeHelper();
  helper.sendSocketNotification = () => {}; // overridden per-test where the calls matter
  helper.start();
  if (cacheDir) helper.cacheDir = cacheDir;
  return helper;
}

function tmpCacheDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "kia-node-helper-test-"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { freshHelper, tmpCacheDir };
