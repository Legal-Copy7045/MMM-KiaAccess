# Security Policy

## Supported versions

Only the latest release is supported. Please update to the newest version
before reporting an issue.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on this repository
(<https://github.com/Legal-Copy7045/MMM-KiaAccess/security/advisories/new>).

You'll get an acknowledgement within a few days. Once a fix is released,
the advisory is published with credit unless you ask otherwise.

## Scope

This project stores Kia/Hyundai/Genesis account credentials and an OAuth
token locally (Home Assistant config entry, or `token.json` / `config.js`
for MagicMirror — both git-ignored). Reports about credential handling,
token leakage in logs/diagnostics, the webhook/exporter outputs, or the
bundled Lovelace card are in scope. Issues in `hyundai_kia_connect_api`
or Home Assistant itself should go to those projects.
