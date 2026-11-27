# Regression suite

Kia Access's regression, walkthrough and full check, on the project standard's contract
(`~/.claude/standards/STANDARD.md` section 3). The global `/regression`, `/walkthrough` and `/full-check` skills
drive it from `profile.yaml`.

| Stage | Prefix | What |
|---|---|---|
| `ci` | CI | syntax, byte-compile, `sync-core --check`, gallery fresh, versions, privacy guard, bandit, pip-audit, npm audit |
| `unit` | UNIT | one check per test file: every `npm test` file and every Python test (`scripts/test-python.js --list`); the Home Assistant tests skip when `homeassistant` isn't installed |
| `page` | PAGE | `page/run.js`: both Lovelace cards (five fictional car states) and the car-state gallery in Chromium, desktop and phone, no network |
| `live` | LIVE | `live.py`: the latest GitHub release vs `VERSION`; with `HA_URL` and `HA_TOKEN`, a read-only look at the owner's Home Assistant |
| `manual` | MAN | `manual.yaml`: a real car, a real mirror, a fresh HACS install |
| `walkthrough` | WALK | `page/run.js --walkthrough`: screenshots of every card state on desktop and phone, UX checks |

```bash
python3 regression/run.py check          # ci + unit: before marking a PR ready
python3 regression/run.py                # every stage
python3 regression/run.py summary        # short result
```

Needs Node, Python with `pip install -r requirements.txt pyyaml` (add `homeassistant` for the integration tests,
`bandit pip-audit` for the scanners) and Playwright with Chromium for `page` and `walkthrough`
(`npm install --no-save playwright && npx playwright install chromium`).

The cards have no roles of their own, so the walkthrough has one role (`dashboard`). The MagicMirror screen needs
MagicMirror itself and stays a manual check.
