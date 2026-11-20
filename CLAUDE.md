# CLAUDE.md

## Privacy (this repository is public)

Never commit anything that identifies the owner, his family or his home, in files, commit messages, PR text or comments:
real names (use made-up ones: Morgan, Casey, Alex, Jordan, Sam), real towns, streets or addresses (use Lakeview, Hillcrest),
real coordinates (use made-up ones far from home), real NFC or Bluetooth band IDs, MAC addresses, VINs, entity or device IDs and
hostnames from the real Home Assistant, email addresses, Wi-Fi names, or credentials of any kind.

- Commit as `Legal-Copy7045 <323378128+Legal-Copy7045@users.noreply.github.com>`.
- The **Privacy guard** workflow (`.github/scripts/privacy_guard.py`) checks every push and pull request: no-reply commit
  addresses, no credentials, and nothing matching the private terms in the `PRIVACY_DENYLIST` Actions secret. If it fails,
  replace the value with a made-up one. Never put the real value back to make a test pass, and never print or copy the secret.
