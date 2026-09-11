# Icon

`icon.png` (256×256) and `icon@2x.png` (512×512) — car + smart-home + charging
plug mark, commissioned separately from this repo. Original artwork, not the
Kia/Hyundai/Genesis logo, since this is an unofficial community integration
with no OEM affiliation.

(These are full-bleed squares — no rounded corners baked in. The versions
originally delivered had opaque white pixels in the corners left over from
an app-icon-style export; that would show as a white-cornered box against
Home Assistant's own theming instead of blending in, so the corners were
squared off to the background navy before committing. Artwork itself is
untouched.)

## Where this actually shows up

Since Home Assistant 2026.3.0 a custom integration bundles its own brand
images instead of submitting to `home-assistant/brands` — that repo
stopped accepting new custom-integration icons entirely (a PR opened
2026-09-11 was auto-closed within seconds by their bot for exactly this
reason: see https://developers.home-assistant.io/blog/2026/02/24/brands-proxy-api).

These files are copied to `custom_components/kia_access/brand/icon.png` /
`icon@2x.png` and served locally by HA at
`/api/brands/integration/kia_access/icon.png` — no external submission,
shows up as soon as a user is on HA 2026.3+ and updates.

**HACS's own store/repository-browse listing is the one place this
doesn't reach yet** — its store UI still only reads from a separate
remote icon index (`data-v2.hacs.xyz`) and doesn't fall back to a local
`brand/` folder. That's tracked upstream as
[hacs/integration#5171](https://github.com/hacs/integration/issues/5171);
nothing to do here until HACS ships that fallback.
