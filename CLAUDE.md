# CLAUDE.md

Kia Access: a Home Assistant integration (`custom_components/kia_access`, installed through HACS) and a MagicMirror
module (`MMM-KiaAccess.js`, `node_helper.js`) for Kia/Hyundai/Genesis cars, sharing one engine in `core/` and
`kia_client.py`. The repository follows the owner's project standard (`.github/standard.yaml`,
`~/.claude/standards/STANDARD.md`).

## Every change

- Edit the root files (`core/*`, `kia_client.py`, `card/*.src.js`), then run `node scripts/sync-core.js` (it copies them
  into `custom_components/kia_access/`). After changing `core/visuals.js`, run `node docs/build-gallery.js`.
- Work in a draft pull request; drafts run no CI. Before marking it ready: `python3 regression/run.py check` passes, and
  `VERSION` plus a `CHANGELOG.md` section are bumped (patch for fixes, minor for features). `node scripts/test-python.js`
  runs the Python tests (add `--group hass` with `pip install homeassistant`). Merge when `ci-result` is green.
- A merged `VERSION` bump is the release: CI tags `v<VERSION>` and publishes the GitHub Release (what HACS installs) with
  that version's CHANGELOG section as its notes. `package.json` and `manifest.json` must carry the same version
  (`.github/scripts/check_versions.py`).
- The library pin (`hyundai_kia_connect_api`) is the same in `requirements.txt` and `manifest.json`; the weekly upstream
  review (`.github/upstream-review.json`) bumps it, not Dependabot.

## Privacy (this repository is public)

Never commit anything that identifies the owner, his family or his home, in files, commit messages, PR text or comments:
real names (use made-up ones: Morgan, Casey, Alex, Jordan, Sam), real towns, streets or addresses (use Lakeview, Hillcrest),
real coordinates (use made-up ones far from home), real NFC or Bluetooth band IDs, MAC addresses, VINs, entity or device IDs and
hostnames from the real Home Assistant, email addresses, Wi-Fi names, or credentials of any kind.

- Commit as `Legal-Copy7045 <323378128+Legal-Copy7045@users.noreply.github.com>`.
- The privacy guard (`.github/scripts/privacy_guard.py`, run by CI) checks every ready pull request and, with the private
  terms in the `PRIVACY_DENYLIST` secret, every push to main: no-reply commit addresses, no credentials, no image location
  data, nothing matching the private terms. If it fails, replace the value with a made-up one. Never put the real value
  back to make a test pass, and never print or copy the secret.
