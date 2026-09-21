/* node test/dest-planner.test.js
 *
 * core/dest-planner.js is the decision logic behind MMM-KiaAccess.js's
 * "Driving times" widget: which destinations survive the zone filter, what
 * order they render in, and what colour a delay badge gets. It used to live
 * inline inside drivingTimesEl() (a DOM-building method) with no coverage
 * of its own; extracted so these edge cases -- exact-match zone overrides,
 * "nearest" ignoring source grouping, threshold stops applying the HIGHEST
 * matching pctOver -- are pinned down without needing a DOM.
 */
const assert = require("assert");
const DP = require("../core/dest-planner.js");

function dest(name, source, km, extra) {
  return Object.assign({ name, source, km, reachable: true }, extra || {});
}

// ---- znorm(): strips the "zone." entity-id prefix and punctuation ----
assert.strictEqual(DP.znorm("zone.nana_s"), "nanas");
assert.strictEqual(DP.znorm("Nana's"), "nanas");
assert.strictEqual(DP.znorm(""), "");
assert.strictEqual(DP.znorm(null), "");

// ---- filterByZone(): no filter configured -> everything passes through,
// including source "zone" rows ----
{
  const rows = [dest("Work", "zone", 10), dest("Doctor", "calendar", 5)];
  assert.deepStrictEqual(DP.filterByZone(rows, {}, ""), rows);
}

// ---- filterByZone(): a whitelist only restricts source:"zone" rows --
// calendar/static entries always pass regardless of the filter ----
{
  const rows = [
    dest("Work", "zone", 10, { entityId: "zone.work" }),
    dest("Gym", "zone", 3, { entityId: "zone.gym" }),
    dest("Dentist", "calendar", 20)
  ];
  const kept = DP.filterByZone(rows, { zones: ["Work"] }, "");
  assert.deepStrictEqual(kept.map((r) => r.name), ["Work", "Dentist"], (
    "a plain zone list is a whitelist for zone-source rows only; calendar rows always pass"
  ));
}

// ---- filterByZone(): "-Name" / "!Name" excludes, matched on either the
// zone's display name or its entity id (normalised) ----
{
  const rows = [
    dest("Nana's", "zone", 10, { entityId: "zone.nana_s" }),
    dest("Work", "zone", 3, { entityId: "zone.work" })
  ];
  const kept = DP.filterByZone(rows, { zones: ["-zone.nana_s"] }, "");
  assert.deepStrictEqual(kept.map((r) => r.name), ["Work"], (
    "an exclude entry must match by entity id, not just the display name"
  ));
}

// ---- filterByZone(): HA's live mmZones override wins over the static
// config.visuals.drivingTimes.zones list when present, newline- or
// comma-separated ----
{
  const rows = [dest("Work", "zone", 10), dest("Gym", "zone", 3)];
  const kept = DP.filterByZone(rows, { zones: ["Gym"] }, "Work\n"); // mmZones set (even if it wins alone)
  assert.deepStrictEqual(kept.map((r) => r.name), ["Work"], (
    "a non-blank HA mmZones override must replace the static config list entirely, not merge with it"
  ));
}

// ---- sortDestinations(): "grouped" (default) -- calendar first (soonest
// `when` first), then static, then zone (by distance); "nearest" ignores
// source entirely ----
{
  const rows = [
    dest("Far zone", "zone", 50),
    dest("Later event", "calendar", 5, { when: "2026-09-20T18:00:00" }),
    dest("Close zone", "zone", 2),
    dest("Sooner event", "calendar", 5, { when: "2026-09-14T09:00:00" }),
    dest("Landmark", "static", 30)
  ];
  const grouped = DP.sortDestinations(rows, "grouped");
  assert.deepStrictEqual(grouped.map((r) => r.name), [
    "Sooner event", "Later event", "Landmark", "Close zone", "Far zone"
  ], "grouped order: calendar (by time) -> static -> zone (by distance)");

  const nearest = DP.sortDestinations(rows, "nearest");
  assert.deepStrictEqual(nearest.map((r) => r.name), [
    "Close zone", "Later event", "Sooner event", "Landmark", "Far zone"
  ], "nearest order: pure distance, source grouping ignored");

  // must not mutate the input array (drivingTimesEl() reuses `rows` after
  // this call for the "anyRouted"/hint checks)
  assert.strictEqual(rows[0].name, "Far zone", "sortDestinations must return a new array, not sort in place");
}

// ---- planDestinations(): filter + hideUnreachable + sort + cap to `max`,
// in that order, as one pipeline ----
{
  const rows = [
    dest("A", "zone", 1, { reachable: true }),
    dest("B", "zone", 2, { reachable: false }),
    dest("C", "zone", 3, { reachable: true }),
    dest("D", "zone", 4, { reachable: true })
  ];
  const planned = DP.planDestinations(rows, { hideUnreachable: true, order: "nearest", max: 2 }, "");
  assert.deepStrictEqual(planned.map((r) => r.name), ["A", "C"], (
    "unreachable rows dropped, remaining sorted nearest-first, capped to max"
  ));

  // default max is 8 when unset/invalid
  const many = Array.from({ length: 12 }, (_, i) => dest("D" + i, "zone", i));
  assert.strictEqual(DP.planDestinations(many, {}, "").length, 8);
  assert.strictEqual(DP.planDestinations(many, { max: "not a number" }, "").length, 8);
}

// ---- planDestinations(): places the user explicitly asked for are never
// crowded out by calendar events. With max 6, six calendar events sort ahead
// of everything and used to fill every row, silently dropping the two zones
// named in the HA "zones to show on the MagicMirror panel" option. ----
{
  const cal = (n, hh) => dest("Event " + n, "calendar", 10 + n, { when: "2026-09-22T" + hh + ":00:00Z" });
  const events = [cal(1, "09"), cal(2, "10"), cal(3, "11"), cal(4, "12"), cal(5, "13"), cal(6, "14")];
  const zones = [dest("Home", "zone", 1, { entityId: "zone.home" }), dest("Work", "zone", 20, { entityId: "zone.work" })];
  const names = (rows) => rows.map((r) => r.name);

  // the reported case: 2 zones on the whitelist + 6 calendar events, room for 6
  const planned = DP.planDestinations(events.concat(zones), { max: 6 }, "Home, Work");
  assert.deepStrictEqual(names(planned), ["Event 1", "Event 2", "Event 3", "Event 4", "Home", "Work"], (
    "both whitelisted zones shown; the 2 furthest-out calendar events dropped; " +
    "displayed order is still calendar (soonest first) then zones"
  ));

  // when the earliest event concludes (HA stops sending it) the next one moves up
  const later = DP.planDestinations(events.slice(1).concat(zones), { max: 6 }, "Home, Work");
  assert.deepStrictEqual(names(later), ["Event 2", "Event 3", "Event 4", "Event 5", "Home", "Work"]);

  // the same via the static config.visuals.drivingTimes.zones whitelist
  assert.deepStrictEqual(
    names(DP.planDestinations(events.concat(zones), { max: 6, zones: ["zone.home", "Work"] }, "")),
    ["Event 1", "Event 2", "Event 3", "Event 4", "Home", "Work"]
  );

  // static destinations are documented as "always shown" -- also guaranteed
  const stat = [dest("Gym", "static", 5), dest("Office", "static", 7)];
  assert.deepStrictEqual(
    names(DP.planDestinations(events.concat(stat), { max: 6 }, "")),
    ["Event 1", "Event 2", "Event 3", "Event 4", "Gym", "Office"]
  );

  // no whitelist = every zone is shown implicitly, none is "asked for": they
  // keep their old lowest priority, so calendar events still fill the rows
  assert.deepStrictEqual(
    names(DP.planDestinations(events.concat(zones), { max: 6 }, "")),
    ["Event 1", "Event 2", "Event 3", "Event 4", "Event 5", "Event 6"]
  );

  // nothing to trim -> nothing changes
  assert.deepStrictEqual(names(DP.planDestinations(events.slice(0, 3).concat(zones), { max: 6 }, "Home, Work")),
    ["Event 1", "Event 2", "Event 3", "Home", "Work"]);

  // more guaranteed places than rows: the cap still wins, in display order
  const manyStatic = ["S1", "S2", "S3"].map((n, i) => dest(n, "static", i));
  assert.deepStrictEqual(names(DP.planDestinations(events.concat(manyStatic), { max: 2 }, "")), ["S1", "S2"]);

  // "nearest" ordering: the guaranteed places stay, the rest fill by distance
  assert.deepStrictEqual(
    names(DP.planDestinations(events.concat(zones), { max: 3, order: "nearest" }, "Home, Work")),
    ["Home", "Event 1", "Work"]
  );

  // hideUnreachable is the user's explicit choice and still applies to them
  const far = [dest("Home", "zone", 1, { entityId: "zone.home", reachable: false }), zones[1]];
  assert.deepStrictEqual(
    names(DP.planDestinations(events.concat(far), { max: 6, hideUnreachable: true }, "Home, Work")),
    ["Event 1", "Event 2", "Event 3", "Event 4", "Event 5", "Work"]
  );
}

// ---- delayColorStops() / delayColorFor(): applies the HIGHEST-threshold
// stop the row's delayPct still meets, not the first one encountered,
// regardless of input order ----
{
  const stops = DP.delayColorStops([
    { pctOver: 50, color: "red" },
    { pctOver: 10, color: "yellow" },
    { pctOver: 200, color: "junk" }, // filtered separately below, not junk really -- just far
    { notPctOver: true }, // invalid entry, must be dropped
    { pctOver: "nope", color: "bad" } // non-finite, must be dropped
  ]);
  assert.deepStrictEqual(stops.map((s) => s.pctOver), [10, 50, 200], "sorted ascending, invalid entries dropped");

  assert.strictEqual(DP.delayColorFor({ delayPct: null }, stops), null, "no delay data -> no colour");
  assert.strictEqual(DP.delayColorFor({ delayPct: 5 }, stops), null, "below every threshold -> no colour");
  assert.strictEqual(DP.delayColorFor({ delayPct: 10 }, stops), "yellow", "exactly at a threshold counts as crossing it");
  assert.strictEqual(DP.delayColorFor({ delayPct: 75 }, stops), "red", "crossed 10 and 50 -- the HIGHER one wins");
  assert.strictEqual(DP.delayColorFor({ delayPct: 500 }, stops), "junk", "crossed every stop -- the highest applies");
}

console.log("all dest-planner tests passed");
