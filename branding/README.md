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

## Making it show up in HACS / the HA integrations list

HACS and Home Assistant don't read icons from this repo — they pull from
[home-assistant/brands](https://github.com/home-assistant/brands). To
activate it:

1. Fork `home-assistant/brands`.
2. Add `custom_integrations/kia_access/icon.png` and
   `custom_integrations/kia_access/icon@2x.png` (copies of the files here).
3. Open a PR. Their check just wants a domain that matches this
   integration's `custom_components/kia_access/manifest.json`
   (`"domain": "kia_access"`) plus their standard image checks (square,
   correct sizes, no obviously broken pixels) — no HA core review needed
   for a custom integration.
4. Once merged, HACS and the HA integrations page pick it up automatically
   within a day or so — no new release of this repo needed.
