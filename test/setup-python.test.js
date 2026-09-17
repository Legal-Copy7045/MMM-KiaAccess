/* node test/setup-python.test.js
 *
 * setup_python.js downloads a compiled CPython runtime over HTTPS and
 * extracts it onto the filesystem with no build/compile step to catch a
 * corrupted or tampered archive -- these tests cover the pure checksum
 * logic (parseSha256Sums/sha256File) without touching the network, so
 * they run offline and fast. The actual download+verify+extract flow in
 * fetchStandalone() is exercised manually / in CI with network access.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { parseSha256Sums, sha256File } = require("../setup_python.js");

// ---- parseSha256Sums: real-world SHA256SUMS format from
// python-build-standalone releases -- "<64 hex chars>  <filename>" per
// line, one file per supported platform triple ----
{
  const sums = [
    "72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c  cpython-3.12.14+20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
    "577b4bec0793ad1ff0cbff9adbd0df078eddde38a4c41bf5d83ad381a85ee39d  cpython-3.12.14+20260901-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
    ""
  ].join("\n");
  assert.strictEqual(
    parseSha256Sums(sums, "cpython-3.12.14+20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"),
    "72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c"
  );
  assert.strictEqual(
    parseSha256Sums(sums, "cpython-3.12.14+20260901-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz"),
    "577b4bec0793ad1ff0cbff9adbd0df078eddde38a4c41bf5d83ad381a85ee39d"
  );
}

// ---- a filename not present in the sums file must come back null, not
// throw or silently match something else -- a caller that skipped this
// check (or treated null as "no verification needed") is exactly the bug
// this feature exists to close ----
{
  const sums = "72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c  some-other-asset.tar.gz";
  assert.strictEqual(parseSha256Sums(sums, "cpython-3.12.14+20260901-riscv64-unknown-linux-gnu-install_only_stripped.tar.gz"), null);
  assert.strictEqual(parseSha256Sums("", "anything"), null);
  assert.strictEqual(parseSha256Sums(null, "anything"), null);
}

// ---- the classic `sha256sum` binary-mode marker ("*filename") must
// still match ----
{
  const sums = "72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c *cpython.tar.gz";
  assert.strictEqual(parseSha256Sums(sums, "cpython.tar.gz"), "72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c");
}

// ---- hash comparison must be case-insensitive (some tools emit
// uppercase hex) but still exact -- a near-miss must not pass ----
{
  const sums = "72748DA13197C1FB161E3AFEEF20A6A385FF24F2165E6E2758E47008E7FABA4C  x.tar.gz";
  assert.strictEqual(parseSha256Sums(sums, "x.tar.gz"), "72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c");
}

// ---- sha256File: must match a known-answer digest, and MUST NOT match
// after the file is corrupted by even one byte -- this is the actual
// integrity check that decides whether a downloaded archive gets
// extracted, so a tamper that silently passes here defeats the whole
// feature ----
{
  const tmp = path.join(os.tmpdir(), "mmm-kia-setup-python-test-" + process.pid + ".bin");
  const content = Buffer.from("this stands in for a compiled Python tarball\n");
  fs.writeFileSync(tmp, content);
  const expected = crypto.createHash("sha256").update(content).digest("hex");
  assert.strictEqual(sha256File(tmp), expected);

  // flip one byte -- simulates a truncated/corrupted/tampered download
  const tampered = Buffer.from(content);
  tampered[0] ^= 0xff;
  fs.writeFileSync(tmp, tampered);
  assert.notStrictEqual(sha256File(tmp), expected, "a corrupted file must not produce the same digest");

  fs.rmSync(tmp, { force: true });
}

console.log("all setup-python tests passed");
