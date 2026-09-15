/* Real-world range & efficiency analytics -- derived entirely from data
 * MMM-KiaAccess already collects for the US market: trip/session history
 * (core/trips.js, core/sessions.js), GPS, odometer, and outside
 * temperature. Deliberately avoids anything requiring EU-only telemetry.
 *
 * Verified against the actual installed hyundai_kia_connect_api source
 * (v4.31.0) before building this: KiaUvoApiUSA.py never populates
 * ev_battery_soh_percentage (it defaults to None in the library's own
 * Vehicle dataclass) -- only the EU implementations do. So "battery
 * health" is off the table for a USA account; everything below is
 * instead framed as OBSERVED performance -- distance/SOC/range/
 * temperature/duration the car itself already reported, aggregated over
 * time. That's honest, and often more useful than a lab-condition spec
 * number: "how far does my EV9 really go in a Pittsburgh winter" beats a
 * WLTP figure Kia USA doesn't even publish per-trim.
 *
 * Three requested outputs, plus two that fall out of data every trip
 * record already carries at zero extra collection cost:
 *   - observedEfficiency():   km/% (temperature- AND speed-bucketed, plus
 *                             a monthly trend). Speed bucketing needs only
 *                             distanceKm/minutes, both already on every
 *                             trip -- no new telemetry, and it's a more
 *                             physically meaningful axis than temperature
 *                             alone (aero drag at highway speed is a much
 *                             bigger efficiency swing than most weather).
 *   - rangeAccuracy():        Kia's displayed range vs. what a trip's own
 *                             observed efficiency implies was achievable
 *                             from that same starting %.
 *   - chargingPerformance():  average charging power by SOC band, home vs.
 *                             away, entirely from sessions.js's existing
 *                             session records -- no new fields needed.
 *   - drivingPatterns():      trip frequency, average distance, average
 *                             speed -- a "usage profile" nobody currently
 *                             surfaces, from fields every trip already has.
 *
 * Considered and dropped: a tire-pressure/temperature correlation --
 * core/entities.json only exposes tire-pressure WARNING booleans, never
 * actual PSI readings, so there's no signal to correlate. Verified before
 * writing anything, not assumed.
 *
 * Pure: no DOM, no `this`, no clock of its own. Computed once, server-side
 * (node_helper.js for MM, the HA coordinator via analytics.py for HA) and
 * handed to the frontend/entities as a finished object -- not recomputed
 * on every render, since it only changes when a trip/session closes.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KiaAccessAnalytics = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MI_PER_KM = 0.621371;

  function round(n, dp) {
    if (n == null || !isFinite(n)) return null;
    const f = Math.pow(10, dp == null ? 2 : dp);
    return Math.round(n * f) / f;
  }
  function avg(nums) {
    const vals = nums.filter((v) => v != null && isFinite(v));
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  function toDisplay(km, mi) {
    return mi ? km * MI_PER_KM : km;
  }

  // Only a trip with a clean, single-charge-state SOC delta is usable for
  // efficiency/range-accuracy math -- a trip that charged partway through
  // (chargedDuring: true) has no meaningful "% used for this distance".
  function usableTrips(trips) {
    return (trips || []).filter((t) =>
      t && !t.chargedDuring && t.usedPct != null && t.usedPct > 0 &&
      t.distanceKm != null && t.distanceKm > 0
    );
  }

  /** km driven per 1 percentage point of SOC, for one trip */
  function kmPerPct(t) {
    return t.distanceKm / t.usedPct;
  }

  function monthKey(ms) {
    const d = new Date(ms);
    const m = d.getMonth() + 1;
    return d.getFullYear() + "-" + (m < 10 ? "0" + m : String(m));
  }

  // ---- 1. observed efficiency --------------------------------------------
  const TEMP_BUCKETS_C = [
    { label: "<20°F", max: -6.7 },
    { label: "20–32°F", max: 0 },
    { label: "32–45°F", max: 7.2 },
    { label: "45–60°F", max: 15.6 },
    { label: "60–75°F", max: 23.9 },
    { label: ">75°F", max: Infinity }
  ];
  const SPEED_BUCKETS_KMH = [
    { label: "city (<25 mph)", max: 40.2 },
    { label: "mixed (25–50 mph)", max: 80.5 },
    { label: "highway (>50 mph)", max: Infinity }
  ];
  const MIN_BUCKET_TRIPS = 2; // one trip isn't a "typical" for that bucket

  function bucketBy(usable, buckets, keyFn) {
    const withSamples = buckets.map((b) => Object.assign({}, b, { samples: [] }));
    usable.forEach((t) => {
      const key = keyFn(t);
      if (key == null) return;
      let bucket = null;
      for (const b of withSamples) {
        if (key <= b.max) { bucket = b; break; }
      }
      (bucket || withSamples[withSamples.length - 1]).samples.push(kmPerPct(t));
    });
    return withSamples;
  }

  function summarizeBuckets(buckets, mi) {
    return buckets
      .filter((b) => b.samples.length >= MIN_BUCKET_TRIPS)
      .map((b) => ({
        label: b.label,
        tripCount: b.samples.length,
        efficiency: round(toDisplay(avg(b.samples), mi), 2)
      }));
  }

  /**
   * @param {Array} trips  closed trip records (core/trips.js shape)
   * @param {object} opts  { units: "imperial"|"metric" }
   */
  function observedEfficiency(trips, opts) {
    opts = opts || {};
    const mi = opts.units !== "metric";
    const usable = usableTrips(trips);
    if (!usable.length) return null;

    const overallKmPerPct = avg(usable.map(kmPerPct));

    const tempUsable = usable.filter((t) => t.outsideTempC != null);
    const temperatureBuckets = summarizeBuckets(
      bucketBy(tempUsable, TEMP_BUCKETS_C, (t) => t.outsideTempC), mi
    );

    const speedUsable = usable.filter((t) => t.minutes && t.minutes > 0);
    const speedBuckets = summarizeBuckets(
      bucketBy(speedUsable, SPEED_BUCKETS_KMH, (t) => t.distanceKm / (t.minutes / 60)), mi
    );

    const byMonth = {};
    usable.forEach((t) => {
      const key = monthKey(t.endedAt);
      (byMonth[key] || (byMonth[key] = [])).push(kmPerPct(t));
    });
    const monthlyTrend = Object.keys(byMonth).sort().map((key) => ({
      month: key,
      tripCount: byMonth[key].length,
      efficiency: round(toDisplay(avg(byMonth[key]), mi), 2)
    }));

    return {
      unit: mi ? "mi/%" : "km/%",
      tripsSampled: usable.length,
      overall: round(toDisplay(overallKmPerPct, mi), 2),
      temperatureBuckets,
      speedBuckets,
      monthlyTrend
    };
  }

  // ---- 2. range accuracy --------------------------------------------------
  /**
   * Compares Kia's own displayed range at trip start against what the
   * trip's OWN observed efficiency implies was achievable from that same
   * starting %: "if you'd kept driving at this trip's efficiency until 0%,
   * how far would you have gone from where you started" versus what the
   * car itself predicted at that exact moment.
   */
  function rangeAccuracy(trips, opts) {
    opts = opts || {};
    const mi = opts.units !== "metric";
    const usable = usableTrips(trips).filter((t) =>
      t.startRangeKm != null && t.startRangeKm > 0 && t.startPct != null && t.startPct > 0
    );
    if (!usable.length) return null;

    const impliedKmEach = usable.map((t) => kmPerPct(t) * t.startPct);
    const ratios = usable.map((t, i) => impliedKmEach[i] / t.startRangeKm);
    const avgRatio = avg(ratios);
    const impliedKm = avg(impliedKmEach);
    const kiaKm = avg(usable.map((t) => t.startRangeKm));

    return {
      tripsSampled: usable.length,
      unit: mi ? "mi" : "km",
      kiaEstimate: round(toDisplay(kiaKm, mi), 0),
      observedEstimate: round(toDisplay(impliedKm, mi), 0),
      // > 0 = the car is conservative (you actually get further than it
      // says); < 0 = the car is optimistic (you get less than it says)
      accuracyPct: round((avgRatio - 1) * 100, 1),
      // clamped to a sane band -- feeds range.js's reachFactor as a
      // learned alternative to a hand-picked constant, see the README's
      // reachFactor/reserve docs. Never let a handful of unusual trips
      // (a single highway blast, one very cold morning) push this to an
      // implausible extreme the "can I get home" check would then trust.
      personalRangeFactor: round(Math.max(0.5, Math.min(1.5, avgRatio)), 3)
    };
  }

  // ---- 3. charging performance ---------------------------------------------
  const SOC_BANDS = [
    { label: "10–50%", lo: 10, hi: 50 },
    { label: "50–80%", lo: 50, hi: 80 },
    { label: "80–100%", lo: 80, hi: 101 } // 101: an exact 100 must fall in the last band
  ];

  function groupSessions(list) {
    if (!list.length) return null;
    const costs = list.map((s) => s.cost).filter((v) => v != null);
    const kws = list.map((s) => s.avgKw).filter((v) => v != null);
    // activeAvgKw is only on sessions closed by core/sessions.js after it
    // started tracking active-only minutes -- older cached sessions won't
    // have it, so this average is over whichever subset does rather than
    // falling back to avgKw (mixing whole-session and active-only rates
    // into one number would defeat the point of keeping them separate)
    const activeKws = list.map((s) => s.activeAvgKw).filter((v) => v != null);
    return {
      count: list.length,
      avgKwh: round(avg(list.map((s) => s.kwh)), 1),
      avgMinutes: round(avg(list.map((s) => s.minutes)), 0),
      // whole-session rate (pauses/tapering diluted in) -- "if I leave it
      // plugged in for a session like this, what should I plan around"
      avgKw: kws.length ? round(avg(kws), 1) : null,
      // the charger's real rate while actually drawing current
      activeAvgKw: activeKws.length ? round(avg(activeKws), 1) : null,
      avgGainedPct: round(avg(list.map((s) =>
        s.gainedPct != null ? s.gainedPct : s.endPct - s.startPct)), 0),
      avgCost: costs.length ? round(avg(costs), 2) : null
    };
  }

  function socBandsFor(list) {
    const byBand = SOC_BANDS.map((b) => Object.assign({}, b, { samples: [] }));
    list.forEach((s) => {
      // a session's own start/end % may span multiple bands -- attribute
      // its power to whichever band its MIDPOINT % falls in (simple, and
      // avoids needing sub-session power-curve data the car doesn't
      // report). Uses the ACTIVE-only rate (falling back to the
      // whole-session rate for older sessions that predate it) -- a band's
      // whole point is "what rate does charging run at here", which a
      // pause/taper folded into the whole-session average would understate.
      const kw = s.activeAvgKw != null ? s.activeAvgKw : s.avgKw;
      const mid = (s.startPct + s.endPct) / 2;
      let band = null;
      for (const b of byBand) {
        if (mid >= b.lo && mid < b.hi) { band = b; break; }
      }
      if (band && kw != null) band.samples.push(kw);
    });
    return byBand
      .filter((b) => b.samples.length >= MIN_BUCKET_TRIPS)
      .map((b) => ({ label: b.label, sessionCount: b.samples.length, avgKw: round(avg(b.samples), 1) }));
  }

  /**
   * @param {Array} sessions  closed charge-session records (core/sessions.js shape)
   */
  function chargingPerformance(sessions) {
    const usable = (sessions || []).filter((s) =>
      s && s.kwh != null && s.minutes != null && s.minutes > 0 &&
      s.startPct != null && s.endPct != null
    );
    if (!usable.length) return null;

    const home = usable.filter((s) => s.location === "home" || s.location == null);
    const away = usable.filter((s) => s.location != null && s.location !== "home");

    return {
      sessionsSampled: usable.length,
      overall: groupSessions(usable),
      home: groupSessions(home),
      away: away.length ? groupSessions(away) : null,
      // Deliberately HOME-only, not `usable` as a whole: a home L2
      // charger's power ceiling (~7-19kW) and a public DC fast charger's
      // (often 50-350kW) are different enough that averaging them into
      // one SOC-band figure produces a number that describes neither --
      // e.g. one home session at 17.5kW and one DC session at 80kW both
      // landing in the "50-80%" band would average to a meaningless
      // "50kW", nowhere near either charger's real behaviour. Home
      // charging is also the dominant, most-repeated case for most
      // owners, so it's the one worth a "here's how your charging tapers"
      // curve at all.
      socBands: socBandsFor(home)
    };
  }

  // ---- 4. driving patterns --------------------------------------------------
  /**
   * A usage profile nobody currently surfaces -- entirely from fields
   * already on every closed trip record (distanceKm, minutes, endedAt).
   * @param {Array} trips  closed trip records
   * @param {object} opts  { units, days } -- days: window for the
   *   frequency/average figures, default 30
   */
  function drivingPatterns(trips, opts) {
    opts = opts || {};
    const mi = opts.units !== "metric";
    const days = opts.days || 30;
    const cutoff = Date.now() - days * 864e5;
    const recent = (trips || []).filter((t) => t && t.endedAt != null && t.endedAt >= cutoff);
    if (!recent.length) return null;

    const totalKm = recent.reduce((sum, t) => sum + (t.distanceKm || 0), 0);
    const speedsKmh = recent
      .filter((t) => t.minutes && t.minutes > 0 && t.distanceKm != null)
      .map((t) => t.distanceKm / (t.minutes / 60));

    return {
      unit: mi ? "mi" : "km",
      windowDays: days,
      tripCount: recent.length,
      tripsPerWeek: round((recent.length / days) * 7, 1),
      totalDistance: round(toDisplay(totalKm, mi), 0),
      avgTripDistance: round(toDisplay(totalKm / recent.length, mi), 1),
      avgSpeed: speedsKmh.length ? round(toDisplay(avg(speedsKmh), mi), 0) : null
    };
  }

  return {
    observedEfficiency,
    rangeAccuracy,
    chargingPerformance,
    drivingPatterns,
    MI_PER_KM
  };
});
