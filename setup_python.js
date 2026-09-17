/* Sets up Python for kia_bridge.py.
 *
 *   1. Find the newest usable python3 (>= 3.12) — system, pyenv, or a
 *      previously-downloaded standalone build.
 *   2. If none is >= 3.12, download a self-contained CPython 3.12 from
 *      astral-sh/python-build-standalone (no compiler needed) into
 *      ./python-standalone/.
 *   3. Build ./venv from it and install requirements.txt.
 *
 * node_helper.js auto-uses ./venv/bin/python3 when it exists.
 * Safe to re-run. Never hard-fails npm install — prints guidance instead.
 *
 * Overrides (env):
 *   MMM_KIA_PYTHON        absolute path to a python3 to use as-is
 *   MMM_KIA_PBS_RELEASE   python-build-standalone release tag (default below)
 *   MMM_KIA_NO_DOWNLOAD=1 never download; fail with guidance instead
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const ROOT = __dirname;
const VENV = path.join(ROOT, "venv");
const STANDALONE = path.join(ROOT, "python-standalone");
const IS_WIN = process.platform === "win32";
const MIN = [3, 12]; // hyundai_kia_connect_api now requires python_requires >= 3.12
const PBS_RELEASE = process.env.MMM_KIA_PBS_RELEASE || "20260901";
const PBS_PY = "3.12.14";

const venvPython = () =>
  IS_WIN ? path.join(VENV, "Scripts", "python.exe") : path.join(VENV, "bin", "python3");

function ver(bin) {
  try {
    const out = execFileSync(bin, ["-c", "import sys;print('%d %d'%sys.version_info[:2])"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const [maj, min] = out.split(/\s+/).map(Number);
    return { bin, maj, min, str: `${maj}.${min}`, ok: maj > 3 || (maj === 3 && min >= MIN[1]) };
  } catch (e) {
    return null;
  }
}

function ge(a, b) {
  return a.maj > b.maj || (a.maj === b.maj && a.min >= b.min);
}

function candidates() {
  const names = [
    "python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"
  ];
  const list = [];
  if (process.env.MMM_KIA_PYTHON) list.push(process.env.MMM_KIA_PYTHON);
  list.push(path.join(STANDALONE, "python", "bin", IS_WIN ? "python.exe" : "python3"));
  names.forEach((n) => list.push(n));
  // pyenv installs
  try {
    const root = process.env.PYENV_ROOT || path.join(os.homedir(), ".pyenv");
    const vdir = path.join(root, "versions");
    if (fs.existsSync(vdir)) {
      fs.readdirSync(vdir).forEach((v) =>
        list.push(path.join(vdir, v, "bin", "python3"))
      );
    }
  } catch (e) {
    /* ignore */
  }
  return list;
}

function pickPython() {
  const found = candidates().map(ver).filter(Boolean);
  found.sort((a, b) => b.maj - a.maj || b.min - a.min);
  return found;
}

function run(bin, args, opts) {
  const r = spawnSync(bin, args, Object.assign({ stdio: "inherit" }, opts || {}));
  return r.status === 0;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u, depth) => {
      if (depth > 6) return reject(new Error("too many redirects"));
      https
        .get(u, { headers: { "User-Agent": "MMM-KiaAccess-setup" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return get(res.headers.location, depth + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          res.pipe(file);
          file.on("finish", () => file.close(() => resolve()));
        })
        .on("error", reject);
    };
    get(url, 0);
  });
}

// same redirect-following GET as download(), but buffers the response
// instead of writing to disk -- used for the small SHA256SUMS text file.
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const get = (u, depth) => {
      if (depth > 6) return reject(new Error("too many redirects"));
      https
        .get(u, { headers: { "User-Agent": "MMM-KiaAccess-setup" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return get(res.headers.location, depth + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        })
        .on("error", reject);
    };
    get(url, 0);
  });
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

// pure text parsing, kept separate from the network/fs calls above so it
// can be unit-tested without hitting the network -- `sums` is the raw
// contents of a `sha256sum`-style SHA256SUMS file ("<hex>  <filename>" per
// line); returns the lowercase hex digest for `filename`, or null if that
// filename isn't listed.
function parseSha256Sums(sums, filename) {
  const lines = String(sums || "").split(/\r?\n/);
  for (const line of lines) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2] === filename) return m[1].toLowerCase();
  }
  return null;
}

function standaloneTriple() {
  const arch = os.arch(); // 'arm', 'arm64', 'x64', ...
  let libc = "gnu";
  try {
    const o = spawnSync("ldd", ["--version"], { encoding: "utf8" });
    if (/musl/i.test((o.stdout || "") + (o.stderr || ""))) libc = "musl";
  } catch (e) {
    /* assume gnu */
  }
  if (arch === "x64") return `x86_64-unknown-linux-${libc}`;
  if (arch === "arm64") return `aarch64-unknown-linux-${libc}`;
  if (arch === "arm") return "armv7-unknown-linux-gnueabihf";
  return null;
}

async function fetchStandalone() {
  if (process.platform !== "linux") return null;
  if (process.env.MMM_KIA_NO_DOWNLOAD === "1") return null;
  const triple = standaloneTriple();
  if (!triple) return null;

  const asset = `cpython-${PBS_PY}+${PBS_RELEASE}-${triple}-install_only_stripped.tar.gz`;
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${asset}`;
  const sumsUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/SHA256SUMS`;
  const tmp = path.join(os.tmpdir(), asset);

  console.log(`[MMM-KiaAccess] Downloading standalone CPython ${PBS_PY} (${triple}) ...`);
  console.log(`[MMM-KiaAccess]   ${url}`);
  try {
    await download(url, tmp);
  } catch (e) {
    console.log(`[MMM-KiaAccess] Download failed: ${e.message}`);
    return null;
  }

  // verify against the release's own SHA256SUMS before extracting anything
  // from the archive -- this is a compiled Python runtime that ends up on
  // PATH, so a corrupted or tampered download must never be trusted just
  // because the HTTPS transfer itself succeeded.
  let expectedHash;
  try {
    const sums = (await fetchBuffer(sumsUrl)).toString("utf8");
    expectedHash = parseSha256Sums(sums, asset);
  } catch (e) {
    console.log(`[MMM-KiaAccess] Could not fetch SHA256SUMS for verification: ${e.message}`);
    fs.rmSync(tmp, { force: true });
    return null;
  }
  if (!expectedHash) {
    console.log(`[MMM-KiaAccess] ${asset} is not listed in the release's SHA256SUMS — refusing to install.`);
    fs.rmSync(tmp, { force: true });
    return null;
  }
  const actualHash = sha256File(tmp);
  if (actualHash !== expectedHash) {
    console.log(
      `[MMM-KiaAccess] Checksum mismatch for ${asset} — expected ${expectedHash}, got ${actualHash}. ` +
        "Discarding the download; it will be retried on the next `npm install`."
    );
    fs.rmSync(tmp, { force: true });
    return null;
  }
  console.log(`[MMM-KiaAccess] SHA-256 verified: ${actualHash}`);

  fs.rmSync(STANDALONE, { recursive: true, force: true });
  fs.mkdirSync(STANDALONE, { recursive: true });
  if (!run("tar", ["-xzf", tmp, "-C", STANDALONE])) {
    console.log("[MMM-KiaAccess] Could not extract the archive (need `tar`).");
    return null;
  }
  try {
    fs.unlinkSync(tmp);
  } catch (e) {
    /* ignore */
  }
  const py = path.join(STANDALONE, "python", "bin", "python3");
  return fs.existsSync(py) ? ver(py) : null;
}

async function main() {
  let ranked = pickPython();
  let best = ranked[0];

  if (!best || !ge(best, { maj: MIN[0], min: MIN[1] })) {
    console.log(
      best
        ? `[MMM-KiaAccess] Best Python found is ${best.str} — need >= ${MIN[0]}.${MIN[1]}.`
        : "[MMM-KiaAccess] No python3 found on PATH."
    );
    const dl = await fetchStandalone();
    if (dl) {
      best = dl;
      console.log(`[MMM-KiaAccess] Using standalone Python ${dl.str} at ${dl.bin}`);
    }
  }

  if (!best || !ge(best, { maj: MIN[0], min: MIN[1] })) {
    console.log(
      "[MMM-KiaAccess] Could not obtain Python >= 3.12. Options:\n" +
        "  - install python3.12 (pyenv, or your distro), then re-run `npm install`\n" +
        "  - set MMM_KIA_PYTHON=/path/to/python3 and re-run\n" +
        "  - see the README 'Python version' section"
    );
    process.exit(1);
  }

  console.log(`[MMM-KiaAccess] Using ${best.bin} (Python ${best.str})`);

  // (re)build venv from the chosen interpreter
  const needRebuild =
    !fs.existsSync(venvPython()) ||
    (() => {
      const v = ver(venvPython());
      return !v || !ge(v, { maj: MIN[0], min: MIN[1] });
    })();
  if (needRebuild) {
    fs.rmSync(VENV, { recursive: true, force: true });
    console.log("[MMM-KiaAccess] Creating venv ...");
    if (!run(best.bin, ["-m", "venv", VENV])) {
      console.log("[MMM-KiaAccess] venv creation failed. Install your OS's python3-venv package (Debian/Ubuntu: `sudo apt install python3-venv`).");
      process.exit(1);
    }
  }

  const vpy = venvPython();
  run(vpy, ["-m", "pip", "install", "--upgrade", "pip", "wheel"]);
  if (!run(vpy, ["-m", "pip", "install", "-r", path.join(ROOT, "requirements.txt")])) {
    console.log("[MMM-KiaAccess] pip install failed — see errors above.");
    process.exit(1);
  }

  const check = spawnSync(
    vpy,
    ["-c", "import hyundai_kia_connect_api as m; print(getattr(m,'__version__','ok'))"],
    { encoding: "utf8" }
  );
  if (check.status === 0) {
    console.log(`[MMM-KiaAccess] hyundai_kia_connect_api installed OK (${(check.stdout || "").trim()}).`);
    console.log(`[MMM-KiaAccess] Bridge will use: ${vpy}`);
  } else {
    console.log("[MMM-KiaAccess] Import check failed:", (check.stderr || "").trim());
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseSha256Sums, sha256File };
