#!/usr/bin/env node
/* Page and walkthrough stages: the Lovelace cards and the car-state gallery rendered in Chromium, desktop
 * (1280x900) and phone (390x844), from the fictional fixtures in fixtures/. Nothing leaves the machine: the page
 * origin, Leaflet and map tiles are all served locally through request interception.
 *
 *   node regression/page/run.js --junit out.xml        page checks (regression page stage)
 *   node regression/page/run.js --walkthrough          screenshots + out/walkthrough.json + out/walkthrough-checks.json
 *
 * Needs Playwright with Chromium: `npm install --no-save playwright && npx playwright install chromium`
 * (or a global Playwright, as in the Claude cloud sessions).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(ROOT, "regression", "out");
const args = process.argv.slice(2);
const WALK = args.includes("--walkthrough");
const ji = args.indexOf("--junit");
const JUNIT = ji >= 0 ? args[ji + 1] : null;

function loadPlaywright() {
  try { return require("playwright"); } catch (e) { /* fall through */ }
  try { return require(path.join(ROOT, "node_modules", "playwright")); } catch (e) { /* fall through */ }
  const g = execSync("npm root -g").toString().trim();
  return require(require.resolve("playwright", { paths: [g] }));
}

const VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844, isMobile: true, hasTouch: true } };
const ORIGIN = "http://kia-access.test";
const BUNDLE = path.join(ROOT, "custom_components", "kia_access", "frontend", "kia-access-card.js");
const LEAFLET = path.join(ROOT, "custom_components", "kia_access", "frontend", "leaflet");
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

// Fictional cars built from fixtures/ (+ a fictional position in Lakeview so the map has something to show).
const FIXTURES = ["01-nominal-parked-locked.json", "02-unlocked-door-lowbatt.json", "04-charge-complete-oneshot.json",
  "06-all-unknown.json", "07-critical-faults.json"];
function hassFor(fixture) {
  const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", fixture), "utf8"));
  const attrs = { kia_access_raw: true, entry_id: "entry-demo", vehicle_name: "Demo EV9", region: "USA",
    account: "USA:KIA:demo@example.invalid", location_latitude: 40.71, location_longitude: -111.75 };
  for (const [k, v] of Object.entries(fx.flat || {})) attrs[k.replace(/^vehicle\./, "")] = v;
  const states = {
    "sensor.demo_ev9_status": { entity_id: "sensor.demo_ev9_status", state: "2026-11-27T10:00:00+00:00", attributes: attrs },
    "zone.home": { entity_id: "zone.home", state: "0", attributes: { friendly_name: "Home", latitude: 40.713, longitude: -111.755, radius: 100 } },
    "zone.work": { entity_id: "zone.work", state: "0", attributes: { friendly_name: "Work", latitude: 40.44, longitude: -111.99, radius: 100 } }
  };
  return { name: fx.name, states };
}

const PAGES = [];
for (const f of FIXTURES) PAGES.push({ key: `card:${f.replace(/\.json$/, "")}`, kind: "card", fixture: f });
PAGES.push({ key: "range-map:01-nominal-parked-locked", kind: "map", fixture: FIXTURES[0] });
PAGES.push({ key: "gallery:car-states", kind: "gallery" });

async function routeAll(page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN + "/kia_access/leaflet-1.9.4/")) {
      const file = path.join(LEAFLET, path.basename(new URL(url).pathname));
      if (fs.existsSync(file)) {
        return route.fulfill({ path: file, contentType: file.endsWith(".css") ? "text/css" : "text/javascript" });
      }
      return route.fulfill({ status: 404, body: "" });
    }
    if (url.startsWith(ORIGIN + "/")) return route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" });
    if (url.startsWith("file://")) return route.continue();
    if (/\.(png|jpe?g)(\?|$)/.test(url)) return route.fulfill({ contentType: "image/png", body: PNG_1x1 });
    return route.fulfill({ status: 204, body: "" });  // nothing goes to the internet
  });
}

async function mountCard(page, p) {
  await page.goto(ORIGIN + "/");
  await page.addScriptTag({ path: BUNDLE });
  const hass = hassFor(p.fixture);
  await page.evaluate(({ hass, kind }) => {
    const el = document.createElement(kind === "map" ? "kia-range-map-card" : "kia-access-card");
    el.setConfig(kind === "map" ? { height: 400 } : {});
    el.hass = Object.assign({ language: "en", locale: { language: "en" }, themes: {}, user: { is_admin: true },
      config: { unit_system: { length: "mi" }, latitude: 40.713, longitude: -111.755 },
      connection: { sendMessagePromise: () => Promise.resolve({}) }, callService: () => Promise.resolve() }, hass);
    document.body.style.margin = "8px";
    document.body.appendChild(el);
  }, { hass, kind: p.kind });
  await page.waitForTimeout(p.kind === "map" ? 1500 : 500);
}

// UX checks shared by the page and walkthrough stages: errors, sideways scroll, content wider than the viewport,
// and (phone) tap targets under 44x44.
async function measure(page, phone) {
  return page.evaluate((phone) => {
    const vw = document.documentElement.clientWidth;
    const all = [];
    (function walk(root) {
      root.querySelectorAll("*").forEach((n) => { all.push(n); if (n.shadowRoot) walk(n.shadowRoot); });
    })(document);
    const visible = (r) => r.width > 0 && r.height > 0;
    // a map's tiles and vector layers always reach past its edges (the map container clips them)
    const inMap = (n) => !!(n.closest && n.closest(".leaflet-pane, .leaflet-tile-container"));
    const wide = all.filter((n) => { const r = n.getBoundingClientRect(); return visible(r) && r.right > vw + 1 && !inMap(n); })
      .map((n) => n.tagName.toLowerCase() + (n.className && typeof n.className === "string" ? "." + n.className.split(" ")[0] : ""));
    const taps = phone ? all.filter((n) => n.matches("button, a[href], [role=button], select, input")).filter((n) => {
      const r = n.getBoundingClientRect(); return visible(r) && (r.width < 44 || r.height < 44);
    }).map((n) => (n.textContent || n.getAttribute("aria-label") || n.tagName).trim().slice(0, 30)) : [];
    const card = all.find((n) => n.tagName === "HA-CARD");
    return {
      sideways: document.documentElement.scrollWidth > vw + 1,
      wide: [...new Set(wide)].slice(0, 5),
      smallTaps: [...new Set(taps)].slice(0, 8),
      svgs: all.filter((n) => n.tagName.toLowerCase() === "svg").length,
      text: card ? (card.innerText || card.textContent || "").trim().length : document.body.innerText.trim().length,
      leaflet: all.some((n) => n.classList && n.classList.contains("leaflet-container")),
      heading: (all.find((n) => /^H[1-3]$/.test(n.tagName)) || {}).textContent || ""
    };
  }, phone);
}

function xmlEsc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const cases = [];          // {name, failure}
  const walkChecks = [];     // {key, status, detail, evidence}
  const inventory = { dashboard: { desktop: { menu: [], pages: [] }, phone: { menu: [], pages: [] } } };
  const shots = path.join(OUT, "walkthrough");
  if (WALK) fs.mkdirSync(shots, { recursive: true });

  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile,
      hasTouch: !!vp.hasTouch, deviceScaleFactor: 1 });
    for (const p of PAGES) {
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
      await routeAll(page);
      let m = null;
      let crash = "";
      try {
        if (p.kind === "gallery") {
          await page.goto("file://" + path.join(ROOT, "docs", "car-states.html"));
          await page.waitForTimeout(800);
        } else {
          await mountCard(page, p);
        }
        m = await measure(page, vpName === "phone");
      } catch (e) {
        crash = String(e).slice(0, 300);
      }
      const name = `${vpName}:${p.key}`;
      const fail = [];
      if (crash) fail.push("did not render: " + crash);
      if (errors.length) fail.push("errors: " + errors.join(" | "));
      if (m) {
        if (m.sideways) fail.push("page scrolls sideways");
        if (p.kind !== "gallery" && m.text === 0 && m.svgs === 0) fail.push("card rendered nothing");
        if (p.kind === "map" && !m.leaflet) fail.push("Leaflet map did not start");
        if (p.kind === "gallery" && m.svgs < 10) fail.push(`only ${m.svgs} diagrams`);
      }
      cases.push({ name, failure: fail.join("; ") });

      if (WALK) {
        const shot = `${vpName}-${p.key.replace(/[^a-z0-9-]+/gi, "_")}.png`;
        await page.screenshot({ path: path.join(shots, shot), fullPage: true }).catch(() => {});
        inventory.dashboard[vpName].pages.push({ name: p.key, heading: m ? m.heading.trim().slice(0, 60) : "",
          screenshot: "walkthrough/" + shot });
        const add = (check, ok, detail) => walkChecks.push({ key: `${vpName}:${p.key}:${check}`,
          status: ok ? "pass" : "fail", detail: ok ? "" : detail, evidence: "walkthrough/" + shot });
        add("no-errors", !errors.length && !crash, (crash || errors.join(" | ")).slice(0, 300));
        add("no-sideways-scroll", m && !m.sideways, "the page scrolls sideways");
        add("nothing-off-screen", m && !m.wide.length, m ? "wider than the screen: " + m.wide.join(", ") : "not measured");
        if (vpName === "phone") add("tap-targets-44px", m && !m.smallTaps.length, m ? "under 44x44: " + m.smallTaps.join(", ") : "not measured");
      }
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();

  if (JUNIT) {
    const failures = cases.filter((c) => c.failure).length;
    const xml = [`<?xml version="1.0" encoding="UTF-8"?>`,
      `<testsuite name="page" tests="${cases.length}" failures="${failures}">`,
      ...cases.map((c) => `  <testcase classname="page" name="${xmlEsc(c.name)}">` +
        (c.failure ? `<failure message="${xmlEsc(c.failure)}"/>` : "") + `</testcase>`),
      `</testsuite>`].join("\n");
    fs.mkdirSync(path.dirname(path.resolve(JUNIT)), { recursive: true });
    fs.writeFileSync(JUNIT, xml);
  }
  for (const c of cases) console.log(`${c.failure ? "FAIL" : "ok  "} ${c.name}${c.failure ? ": " + c.failure : ""}`);
  if (WALK) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "walkthrough.json"), JSON.stringify(inventory, null, 1));
    fs.writeFileSync(path.join(OUT, "walkthrough-checks.json"), JSON.stringify({ results: walkChecks }, null, 1));
  }
  process.exit(cases.some((c) => c.failure) && !WALK ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
