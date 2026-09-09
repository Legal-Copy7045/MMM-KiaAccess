/* webhook.js — filter logic + a real POST against a throwaway local server */
"use strict";
const assert = require("assert");
const http = require("http");
const { post, wants } = require("../webhook.js");

let pass = 0;
const ok = (c, m) => {
  assert.ok(c, m);
  pass++;
};

// ---- wants(): events / levels filters ----
const ev = { reason: "door_open", level: "warning" };

ok(wants({}, ev), "no filters -> match");
ok(wants({ events: "all", levels: "all" }, ev), '"all" strings -> match');
ok(wants({ events: ["door_open", "unlocked"] }, ev), "reason in list -> match");
ok(!wants({ events: ["unlocked"] }, ev), "reason not in list -> skip");
ok(wants({ levels: ["warning", "critical"] }, ev), "level in list -> match");
ok(!wants({ levels: ["critical"] }, ev), "level not in list -> skip");
ok(
  !wants({ events: ["door_open"], levels: ["critical"] }, ev),
  "one filter fails -> skip"
);

// ---- post(): headers, body, status code, bad URL, timeout ----
(async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({
        method: req.method,
        auth: req.headers.authorization,
        ctype: req.headers["content-type"],
        body: JSON.parse(body)
      });
      if (seen.length === 1) {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(500);
        res.end("nope");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/hook`;

  const code = await post(
    url,
    { reason: "charge_complete", level: "info" },
    { headers: { Authorization: "Bearer secret" } }
  );
  ok(code === 204, "2xx status returned (" + code + ")");
  ok(seen[0].method === "POST", "defaults to POST");
  ok(seen[0].auth === "Bearer secret", "custom header sent");
  ok(seen[0].ctype === "application/json", "json content-type");
  ok(seen[0].body.reason === "charge_complete", "body round-trips");

  const code2 = await post(url, { x: 1 });
  ok(code2 === 500, "non-2xx status is returned, not thrown (" + code2 + ")");

  await assert.rejects(() => post("ftp://nope/x", {}), /http\(s\)/, "rejects non-http url");
  await assert.rejects(() => post("::::", {}), /invalid webhook url/, "rejects garbage url");

  // timeout: server that never responds
  const dead = http.createServer(() => {});
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  await assert.rejects(
    () => post(`http://127.0.0.1:${dead.address().port}/`, {}, { timeoutMs: 150 }),
    /timeout/,
    "times out"
  );

  server.close();
  dead.close();
  console.log(`all webhook tests passed (${pass} assertions)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
