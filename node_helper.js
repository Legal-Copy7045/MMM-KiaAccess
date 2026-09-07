/* MagicMirror² node_helper for MMM-KiaAccess
 *
 * Fetches vehicle data by shelling out to `kia_bridge.py`, which uses the
 * actively-maintained `hyundai_kia_connect_api` Python library. That library
 * handles Kia USA's Cloudflare bot protection, which blocks the Node
 * `bluelinky` library (HTTP 403).
 *
 * Credentials are passed to the child process on stdin (never argv), so they
 * do not show up in the process list.
 */
const NodeHelper = require("node_helper");
const Log = require("logger");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

/** Prefer the bundled venv (built by setup_python.js) unless the user set pythonBin. */
function resolvePython(configured) {
  if (configured && configured !== "python3") return configured;
  const venv =
    process.platform === "win32"
      ? path.join(__dirname, "venv", "Scripts", "python.exe")
      : path.join(__dirname, "venv", "bin", "python3");
  if (fs.existsSync(venv)) return venv;
  return configured || process.env.PYTHON || "python3";
}

module.exports = NodeHelper.create({
  start() {
    this.inFlight = {};
    Log.info("[MMM-KiaAccess] node_helper started");
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "KIA_FETCH") {
      this.handleFetch(payload);
    }
  },

  identifierFor(config) {
    return [config.region, config.brand, config.username, config.vin || "auto"].join("|");
  },

  handleFetch(config) {
    const id = this.identifierFor(config);
    if (this.inFlight[id]) {
      Log.info("[MMM-KiaAccess] fetch already in progress, skipping");
      return;
    }
    this.inFlight[id] = true;

    const pythonBin = resolvePython(config.pythonBin);
    const script = path.join(__dirname, "kia_bridge.py");
    const job = {
      username: config.username,
      password: config.password,
      pin: config.pin,
      brand: config.brand || "KIA",
      region: config.region || "USA",
      vin: config.vin || "",
      refresh: config.refresh !== false
    };

    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(pythonBin, [script], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      this.inFlight[id] = false;
      return this.fail(id, config, `could not start ${pythonBin}: ${err.message}`);
    }

    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, (config.fetchTimeout || 90) * 1000);

    child.on("error", (err) => {
      clearTimeout(killTimer);
      this.inFlight[id] = false;
      this.fail(id, config, `failed to run ${pythonBin}: ${err.message}`);
    });

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      clearTimeout(killTimer);
      this.inFlight[id] = false;

      let result;
      try {
        result = JSON.parse(lastJsonLine(stdout));
      } catch (e) {
        return this.fail(
          id,
          config,
          `bridge produced no JSON (exit ${code}). ${truncate(stderr || stdout)}`
        );
      }

      if (!result.ok) {
        return this.fail(id, config, result.error || "unknown bridge error");
      }

      // one module instance == one vehicle (first match)
      const vehicle = result.vehicles[0];
      const payload = {
        vehicle,
        _meta: {
          fetchedAt: new Date().toISOString(),
          vehicleCount: result.vehicles.length
        }
      };
      this.sendSocketNotification("KIA_DATA", { identifier: id, config, payload });
    });

    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  },

  fail(id, config, message) {
    Log.error("[MMM-KiaAccess] fetch failed: " + message);
    this.sendSocketNotification("KIA_ERROR", { identifier: id, config, error: message });
  }
});

function lastJsonLine(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("{")) return lines[i];
  }
  return text;
}

function truncate(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  n = n || 300;
  return s.length > n ? s.slice(0, n) + "…" : s;
}
