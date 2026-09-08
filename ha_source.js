/* Read vehicle state from a Home Assistant instance instead of polling Kia.
 *
 * Used when the module is configured with `source: "homeassistant"`. It reads
 * the Kia Access integration's diagnostic summary sensor (the entity whose
 * attributes carry the whole flat payload, `kia_access_raw: true`) over the HA
 * REST API and returns the same payload shape the Python bridge produces:
 *
 *   { vehicle: { <flat vehicle attrs> }, _meta: { fetchedAt, source, ... } }
 *
 * Node >= 18 (global fetch). No external deps.
 */
"use strict";

const SKIP_ATTRS = new Set([
  "kia_access_raw",
  "entry_id",
  "vehicle_name",
  "note",
  "friendly_name",
  "icon",
  "device_class",
  "state_class",
  "unit_of_measurement",
  "entity_picture",
  "supported_features"
]);

const HTTP_TIMEOUT_MS = 20000;

async function haGet(base, token, urlPath) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(base + urlPath, {
      headers: { Authorization: "Bearer " + token },
      signal: ctl.signal
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("HA " + urlPath + " timed out after " + HTTP_TIMEOUT_MS / 1000 + "s");
    }
    throw new Error("HA " + urlPath + " -> " + (err && err.message ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error("HA " + urlPath + " -> HTTP " + res.status + " " + res.statusText);
  }
  return res.json();
}

async function findSummaryEntity(base, token, configured) {
  if (configured) return configured;
  const states = await haGet(base, token, "/api/states");
  const hit = states.find(
    (s) => s.attributes && s.attributes.kia_access_raw === true
  );
  if (!hit) {
    throw new Error(
      "no Kia Access summary entity found in Home Assistant — set homeassistant.entity"
    );
  }
  return hit.entity_id;
}

/**
 * @param {object} ha  { url, token, entity? }
 * @returns {Promise<{vehicle: object, _meta: object}>}
 */
async function fetchFromHA(ha) {
  if (!ha || !ha.url || !ha.token) {
    throw new Error("source 'homeassistant' needs homeassistant.url and homeassistant.token");
  }
  const base = String(ha.url).replace(/\/+$/, "");
  const entity = await findSummaryEntity(base, ha.token, ha.entity);
  const state = await haGet(base, ha.token, "/api/states/" + encodeURIComponent(entity));

  const attrs = state.attributes || {};
  const vehicle = {};
  Object.keys(attrs).forEach((k) => {
    if (SKIP_ATTRS.has(k)) return;
    vehicle[k] = attrs[k];
  });

  const meta = {
    fetchedAt: new Date().toISOString(),
    source: "homeassistant",
    haEntity: entity,
    haLastChanged: state.last_changed || null
  };
  if (attrs.note) meta.note = attrs.note;
  if (!Object.keys(vehicle).length) {
    meta.warning = "Home Assistant returned no vehicle attributes yet";
  }
  return { vehicle, _meta: meta };
}

module.exports = { fetchFromHA };
