/* The "which destinations to show, in what order, with what delay colour"
 * decision logic behind MMM-KiaAccess.js's drivingTimesEl() widget.
 *
 * Extracted out of the DOM-rendering method it used to live inline in --
 * zone include/exclude matching, source-grouped vs. nearest-first sorting,
 * and the delay-colour threshold lookup are all real decision logic with
 * their own edge cases (an excluded zone should still be overridable by an
 * exact match, "nearest" order ignores source entirely, a calendar entry
 * without a `when` sorts by empty string, threshold stops must apply the
 * HIGHEST matching pctOver, not the first). None of that needs a DOM, so
 * pulling it out here makes it unit-testable without jsdom, the same way
 * core/visuals.js keeps rendering maths out of the innerHTML-building code.
 *
 * Pure functions only: no `document`, no MagicMirror globals. The caller
 * (drivingTimesEl()) still owns every bit of HTML/escaping — this module
 * only decides which rows survive, their order, and (via delayColorFor) the
 * colour a row's delay should render in.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.KiaAccessDestPlanner = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // "zone.nana_s" and "Nana's" must match the same filter entry -- strip the
  // "zone." entity-id prefix and any punctuation, lowercase the rest.
  function znorm(s) {
    return String(s || "").toLowerCase()
      .replace(/^zone\./, "").replace(/[^a-z0-9]+/g, "");
  }

  // HA's mmZones (a live per-vehicle override, newline/comma separated)
  // wins over the static config.visuals.drivingTimes.zones list when
  // present. Entries are a whitelist unless prefixed "-"/"!" (exclude).
  // Returns the normalised { inc, exc } match keys.
  function parseZoneFilter(dt, mmZones) {
    const raw = String(mmZones || "");
    const zfRaw = raw.trim()
      ? raw.split(/[\n,]/)
      : (Array.isArray(dt.zones) ? dt.zones : []);
    const inc = [];
    const exc = [];
    zfRaw.map((z) => String(z).trim()).filter(Boolean).forEach((z) => {
      (z[0] === "-" || z[0] === "!" ? exc : inc).push(znorm(z.replace(/^[-!]/, "")));
    });
    return { inc: inc, exc: exc };
  }

  function zoneKeys(r) {
    return [znorm(r.name), znorm(r.entityId)].filter(Boolean);
  }

  // Calendar and static rows are never filtered by this (only source "zone"
  // rows are zone-name-based to begin with).
  function filterByZone(rows, dt, mmZones) {
    const f = parseZoneFilter(dt, mmZones);
    if (!f.inc.length && !f.exc.length) return rows;
    return rows.filter((r) => {
      if (r.source !== "zone") return true;
      const keys = zoneKeys(r);
      if (f.exc.some((e) => keys.includes(e))) return false;
      return f.inc.length === 0 || f.inc.some((k) => keys.includes(k));
    });
  }

  // "grouped" (default): calendar events first (soonest `when` first),
  // then static destinations, then everything else (zones) by distance.
  // "nearest": pure distance order, source ignored entirely.
  function sortDestinations(rows, order) {
    const sorted = rows.slice();
    if (order === "nearest") {
      sorted.sort((a, b) => a.km - b.km);
      return sorted;
    }
    const rank = { calendar: 0, static: 1, zone: 2 };
    sorted.sort((a, b) => {
      const g = (rank[a.source] != null ? rank[a.source] : 3) -
        (rank[b.source] != null ? rank[b.source] : 3);
      if (g) return g;
      if (a.source === "calendar") {
        return String(a.when || "").localeCompare(String(b.when || ""));
      }
      return a.km - b.km;
    });
    return sorted;
  }

  // The rows the user explicitly asked to see: static (fixed) destinations, and
  // zones named in a zone whitelist. With no whitelist every zone is shown
  // implicitly, so none of them counts as asked for.
  function isPinned(r, inc) {
    if (r.source === "static") return true;
    if (r.source !== "zone" || !inc.length) return false;
    const keys = zoneKeys(r);
    return inc.some((k) => keys.includes(k));
  }

  // Filters, sorts and caps the destination list to what drivingTimesEl()
  // should actually render, in render order.
  //
  // When there are more rows than `max`, the pinned rows are kept first and
  // the remaining slots go to everything else in the chosen order -- so with
  // "grouped" that is the soonest calendar events, and the furthest-out ones
  // are the ones that drop, until an earlier event ends and frees a slot.
  // Rows keep their display order either way. If there are more pinned rows
  // than `max`, the cap still wins.
  function planDestinations(rows, dt, mmZones) {
    dt = dt || {};
    let planned = filterByZone(rows || [], dt, mmZones);
    if (dt.hideUnreachable) planned = planned.filter((r) => r.reachable);
    planned = sortDestinations(planned, dt.order || "grouped");
    const max = Number(dt.max) || 8;
    if (planned.length <= max) return planned;
    const inc = parseZoneFilter(dt, mmZones).inc;
    const keep = new Set(planned.filter((r) => isPinned(r, inc)).slice(0, max));
    for (const r of planned) {
      if (keep.size >= max) break;
      keep.add(r);
    }
    return planned.filter((r) => keep.has(r));
  }

  // delayStops: [{ pctOver, color }, ...], unordered and possibly containing
  // junk entries -- normalises to ascending pctOver with invalid entries
  // dropped, ready for repeated delayColorFor() calls across many rows.
  function delayColorStops(delayStops) {
    return (Array.isArray(delayStops) ? delayStops : [])
      .filter((s) => s && isFinite(s.pctOver))
      .sort((a, b) => a.pctOver - b.pctOver);
  }

  // The colour for a row's delay badge: the HIGHEST-threshold stop whose
  // pctOver the row's delayPct still meets or exceeds (stops must already
  // be ascending -- see delayColorStops()), or null for no delay data / no
  // stop crossed yet.
  function delayColorFor(row, stops) {
    if (row.delayPct == null) return null;
    let col = null;
    (stops || []).forEach((s) => {
      if (row.delayPct >= s.pctOver) col = s.color || null;
    });
    return col;
  }

  return {
    znorm: znorm,
    parseZoneFilter: parseZoneFilter,
    filterByZone: filterByZone,
    isPinned: isPinned,
    sortDestinations: sortDestinations,
    planDestinations: planDestinations,
    delayColorStops: delayColorStops,
    delayColorFor: delayColorFor
  };
});
