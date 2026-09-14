/* Stand-in for MagicMirror's own `node_helper` module (the real one only
 * resolves inside a running MagicMirror install, via its own module loader
 * -- `require("node_helper")` fails outright in a plain `node` process).
 * See test/require-node-helper.js for how this gets substituted in.
 *
 * The real NodeHelper.create() does more (wires up sendSocketNotification
 * to the actual IPC channel, a `name` property, etc.) -- for these tests
 * that machinery is either irrelevant (nothing here talks over real IPC)
 * or replaced directly on the instance (sendSocketNotification is always
 * overridden by the test itself to capture what node_helper.js sends).
 * Handing the spec straight back, unmodified, is enough for every method
 * on it to be called and to see a consistent `this`.
 */
module.exports = {
  create(spec) {
    return spec;
  }
};
