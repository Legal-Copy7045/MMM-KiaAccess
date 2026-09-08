# Contract fixtures

Each `*.json` here is one anonymised scenario run through **both** engines in CI:

- `test/contract.test.js` — `core/state.js` + `core/conditions.js`
- `test/contract_test.py` — `vehicle_state.py` + `conditions.py`

Any drift between the JavaScript and Python ports fails the build.

## Fixture shape

```jsonc
{
  "name": "human label",
  "flat": { "vehicle.ev_battery_percentage": 55 },   // input to build_state
  "expectState": { "batteryPct": 55, "locked": false }, // subset check on build_state output
  "state": { ... },          // OPTIONAL — explicit state for evaluate() instead of build_state(flat).
                             //   history entries may use { "hoursAgo": 6, "v12": 70 } (converted to t)
  "cfg": {},                 // notifications config passed to evaluate()
  "prev": { "_charging": true }, // previous-tick condition map
  "expectConditions": { "unlocked": true, "ev_battery_low": false, "otp_expiring": null }
}
```

`expectConditions` values are matched against each condition's `active`
(`true` / `false` / `null` = unknown). A reason not listed is not checked.
