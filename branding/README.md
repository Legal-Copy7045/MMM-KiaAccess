# Icon

`icon.svg` is the source; `icon.png` (256×256) and `icon@2x.png` (512×512)
are rendered from it. Original mark — a car silhouette + charging badge —
not the Kia/Hyundai/Genesis logo, deliberately, since this is an
unofficial community integration with no OEM affiliation.

To regenerate the PNGs after editing `icon.svg`:

```bash
npm install @resvg/resvg-js --no-save
node -e "
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const svg = fs.readFileSync('branding/icon.svg', 'utf8');
for (const size of [256, 512]) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  fs.writeFileSync(size === 256 ? 'branding/icon.png' : 'branding/icon@2x.png', r.render().asPng());
}
"
```

## Making it show up in HACS / the HA integrations list

HACS and Home Assistant don't read icons from this repo — they pull from
[home-assistant/brands](https://github.com/home-assistant/brands). To
activate it:

1. Fork `home-assistant/brands`.
2. Add `custom_integrations/kia_access/icon.png` and
   `custom_integrations/kia_access/icon@2x.png` (copies of the files here).
3. Open a PR. Their `manifest.json` check just wants a domain that matches
   this integration's `custom_components/kia_access/manifest.json`
   (`"domain": "kia_access"`) — no HA core review needed for a custom
   integration, just their brands-repo bot checks (square, non-transparent
   corners inside the standard mask, correct sizes).
4. Once merged, HACS and the HA integrations page pick it up automatically
   within a day or so — no new release of this repo needed.
