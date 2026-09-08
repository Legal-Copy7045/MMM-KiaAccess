/* Regenerate docs/car-states.html from the current core/visuals.js.
 *
 *   node docs/build-gallery.js
 *
 * Pure Node, no dependencies. The HTML is self-contained (visuals.js is
 * inlined) and shows every state the car diagram can present, with the
 * animations live. car-states.png is a screenshot of this page.
 */
const fs = require("fs");
const path = require("path");

const visuals = fs.readFileSync(path.join(__dirname, "..", "core", "visuals.js"), "utf8");

const GROUPS = [
  ["Lock (body outline colour)", [
    ["Locked", {}],
    ["Unlocked", { locked: false }],
    ["Lock unknown", { locked: null }],
  ]],
  ["Battery level (centre cell)", [
    ["High charge", { batteryPct: 82 }],
    ["Mid charge", { batteryPct: 35 }],
    ["Low charge", { batteryPct: 8 }],
    ["No battery data", { batteryPct: null }],
  ]],
  ["Charging / plug (rear-right port)", [
    ["Unplugged", {}],
    ["Plugged, not charging", { plugged: true }],
    ["Charging", { charging: true, batteryPct: 64 }],
    ["Exporting (V2L / V2X)", { v2l: true, batteryPct: 64 }],
  ]],
  ["Doors, frunk, liftgate", [
    ["A door open", { locked: false, doorFL: true }],
    ["A rear door open", { locked: false, doorRR: true }],
    ["Frunk open", { locked: false, hood: true }],
    ["Liftgate open", { locked: false, trunk: true }],
  ]],
  ["Windows & sunroof", [
    ["A window open (door shut)", { winFL: true }],
    ["Sunroof shut", {}],
    ["Sunroof open", { sunroof: true }],
  ]],
  ["Lights", [
    ["Headlights off", { headlights: false }],
    ["Headlights on", { headlights: true }],
    ["Car off (taillights outline)", { carOn: false }],
    ["Ignition / accessory on", { carOn: true }],
  ]],
  ["Tyres", [
    ["One tyre warning", { tyreFL: true }],
    ["All-tyre warning", { tyreAny: true }],
  ]],
  ["Critical issue", [
    ["Warning triangle", { critical: true }],
    ["Critical + charging", { critical: true, charging: true, batteryPct: 41 }],
  ]],
  ["Heaters", [
    ["Defrost (front + rear)", { defrost: true }],
    ["Rear-window heater", { rearHeat: true }],
    ["Side-mirror heaters", { mirrorHeat: true }],
    ["Steering-wheel heater", { steerHeat: true }],
  ]],
  ["Air conditioning", [
    ["Heating", { climate: "heat" }],
    ["Cooling", { climate: "cool" }],
    ["On (direction unknown)", { climate: "on" }],
  ]],
  ["Combined example", [
    ["Cold morning, many states", {
      locked: false, batteryPct: 11, charging: true, doorRR: true, hood: true,
      sunroof: true, headlights: true, carOn: true, tyreFR: true,
      climate: "heat", defrost: true, rearHeat: true, mirrorHeat: true, steerHeat: true,
    }],
  ]],
];

const BASE = { locked: true, batteryPct: 78, carOn: false, headlights: false };
const groupsJson = JSON.stringify(
  GROUPS.map(([title, cards]) => [
    title,
    cards.map(([name, s]) => [name, Object.assign({}, BASE, s)]),
  ])
);

const html = `<!doctype html><html><head><meta charset="utf-8">
<title>MMM-KiaAccess — car diagram states</title>
<style>
:root{color-scheme:dark}
body{background:#000;color:#e8eaed;font-family:system-ui,'Segoe UI',Roboto,sans-serif;margin:0;padding:28px}
h1{font-weight:300;font-size:19px;margin:0 0 4px}
p.sub{color:#8a8f94;font-size:13px;margin:0 0 22px}
h2{font-weight:600;font-size:13px;color:#9aa0a6;letter-spacing:.06em;text-transform:uppercase;
   margin:26px 0 12px;border-bottom:1px solid #1e1f22;padding-bottom:6px}
.grid{display:flex;flex-wrap:wrap;gap:20px}
.card{background:#0b0b0c;border:1px solid #16171a;border-radius:10px;padding:14px 16px 10px;width:200px}
.card svg{display:block;margin:0 auto;max-width:100%;height:auto}
.t{font-size:12.5px;color:#e8eaed;margin-top:8px;text-align:center}
</style></head><body>
<h1>MMM-KiaAccess — car diagram states &amp; widgets</h1>
<p class="sub">Every state the top-down diagram can present, plus the optional widgets.
Front of the car is up. Animations play live here; car-states.png is a snapshot.</p>
<div id="out"></div>
<script>${visuals}</script>
<script>
const V = KiaAccessVisuals;
const groups = ${groupsJson};
const out = document.getElementById("out");
function section(title){ const h=document.createElement("h2"); h.textContent=title; out.appendChild(h);
  const g=document.createElement("div"); g.className="grid"; out.appendChild(g); return g; }
function card(g, name, html){ const c=document.createElement("div"); c.className="card";
  c.innerHTML = html + '<div class="t">' + name + '</div>'; g.appendChild(c); }

for (const [title, cards] of groups) {
  const g = section(title);
  for (const [name, state] of cards) card(g, name, V.carDiagram(state, { width: 200 }));
}

// ---- optional widgets ----
const now = Date.now();
const hist = Array.from({ length: 30 }, (_, i) => ({
  t: now - (29 - i) * 864e5, v: 92 - i * 1.4 + (i % 4) * 3
}));
let g = section("Optional widgets");
card(g, "SoC / 12V sparkline", V.sparkline(hist, { width: 200, height: 44 }));
card(g, "Charge progress (64% → 80%)", V.chargeBar(64, 80, { width: 200 }));
card(g, "Range ring", V.rangeRing(64, { centreText: "201 mi" }));
card(g, "Range ring — charging", V.rangeRing(48, { charging: true, centreText: "150 mi" }));
card(g, "Range ring — low", V.rangeRing(9, { centreText: "28 mi" }));
</script></body></html>
`;

fs.writeFileSync(path.join(__dirname, "car-states.html"), html);
console.log("wrote docs/car-states.html");
