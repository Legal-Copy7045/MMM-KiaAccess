/* Sets up a self-contained Python venv for kia_bridge.py.
 *
 * Picks the newest python3.x it can find (the library's Cloudflare-bypass
 * release wants >= 3.12), builds ./venv, and installs requirements.txt into it.
 * node_helper.js auto-uses ./venv/bin/python3 when it exists.
 *
 * Safe to re-run. Never fails the npm install hard — prints guidance instead.
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const VENV = path.join(ROOT, "venv");
const IS_WIN = process.platform === "win32";
const venvPython = () =>
  IS_WIN ? path.join(VENV, "Scripts", "python.exe") : path.join(VENV, "bin", "python3");

function ver(bin) {
  try {
    const out = execFileSync(bin, ["-c", "import sys;print('%d.%d'%sys.version_info[:2])"], {
      encoding: "utf8"
    }).trim();
    const [maj, min] = out.split(".").map(Number);
    return { bin, maj, min, str: out };
  } catch (e) {
    return null;
  }
}

function pickPython() {
  const candidates = [
    "python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"
  ];
  const found = candidates.map(ver).filter(Boolean);
  if (found.length === 0) return null;
  // prefer highest minor version
  found.sort((a, b) => b.maj - a.maj || b.min - a.min);
  return found[0];
}

function run(bin, args) {
  const r = spawnSync(bin, args, { stdio: "inherit" });
  return r.status === 0;
}

(function main() {
  const py = pickPython();
  if (!py) {
    console.log("[MMM-KiaAccess] No python3 found on PATH. Install Python 3.12+ and re-run `npm install`.");
    process.exit(1);
  }
  console.log(`[MMM-KiaAccess] Using ${py.bin} (Python ${py.str})`);
  if (py.maj === 3 && py.min < 12) {
    console.log(
      "[MMM-KiaAccess] WARNING: Python < 3.12 — pip will fall back to an older " +
        "hyundai_kia_connect_api that may not clear Kia USA's Cloudflare check. " +
        "Consider installing python3.12+ (see README)."
    );
  }

  if (!fs.existsSync(venvPython())) {
    console.log("[MMM-KiaAccess] Creating venv ...");
    if (!run(py.bin, ["-m", "venv", VENV])) {
      console.log(
        "[MMM-KiaAccess] venv creation failed. On Debian/RPi OS: `sudo apt install python3-venv`."
      );
      process.exit(1);
    }
  }

  const vpy = venvPython();
  run(vpy, ["-m", "pip", "install", "--upgrade", "pip", "wheel"]);
  const ok = run(vpy, ["-m", "pip", "install", "-r", path.join(ROOT, "requirements.txt")]);
  if (!ok) {
    console.log("[MMM-KiaAccess] pip install failed — see errors above.");
    process.exit(1);
  }

  // sanity check
  const check = spawnSync(vpy, ["-c", "import hyundai_kia_connect_api,sys;print(hyundai_kia_connect_api.__version__ if hasattr(hyundai_kia_connect_api,'__version__') else 'ok')"], {
    encoding: "utf8"
  });
  if (check.status === 0) {
    console.log(`[MMM-KiaAccess] hyundai_kia_connect_api installed OK (${(check.stdout || "").trim()}).`);
    console.log(`[MMM-KiaAccess] Bridge will use: ${vpy}`);
  } else {
    console.log("[MMM-KiaAccess] Import check failed:", (check.stderr || "").trim());
    process.exit(1);
  }
})();
