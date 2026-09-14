/* Stand-in for MagicMirror's `logger` module (same resolution problem as
 * node_helper.js -- see test/require-node-helper.js). Tests don't want
 * console noise from every Log.info()/warn() call node_helper.js makes
 * along the way, so these are no-ops by default; set
 * process.env.KIA_TEST_VERBOSE=1 to see them while debugging a test.
 */
const verbose = process.env.KIA_TEST_VERBOSE === "1";
function make(level) {
  return verbose ? (...args) => console.log(`[${level}]`, ...args) : () => {};
}
module.exports = {
  info: make("info"),
  warn: make("warn"),
  error: make("error"),
  debug: make("debug"),
  log: make("log")
};
