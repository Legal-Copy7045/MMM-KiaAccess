/* Optional graphical widgets for MMM-KiaAccess.
 *
 * Pure functions that return SVG / markup strings — no DOM, no MagicMirror
 * deps — so they can be unit-tested and the frontend just drops the string
 * into an element's innerHTML.
 *
 * Everything is theme-agnostic: colours are explicit, backgrounds transparent.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.KiaAccessVisuals = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var COL = {
    outline: "#9aa0a6",
    dim: "#5f6368",
    ok: "#4caf50",
    warn: "#ffb300",
    bad: "#e53935",
    text: "#e8eaed",
    glass: "#3a3d40",
    accent: "#4fc3f7",
    heat: "#ff7043"
  };

  // User-supplied gas-pump glyph (their own reference icon, not a
  // hand-drawn approximation) -- recoloured to COL.text with the white
  // background made transparent, downscaled to 64x62 (plenty for the ~15-18
  // unit topper slot it renders into; the source was 320x312) and embedded
  // as a data URI so pumpTopper() stays a pure, dependency-free function
  // like everything else in this file, with no separate asset file to
  // resolve a path to across the different contexts this module is
  // inlined into (MagicMirror's own module dir, the HA card's static
  // frontend hosting, docs/build-gallery.js's standalone HTML).
  var PUMP_ICON_PNG =
    "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAA+CAYAAACbQR1vAAAKGElEQVR42u1bbWxkVRl+3nPO3Dudj85ut51tBVkgYTFZN4QsEEyEbBOVRP2hqCuiJCJGI7oRQ6I/t0UjEpeY+JFgjJIgCbrVX4TIH9IJBBBCAWF/Ydwsy27b6XTa+b5f55zXH3OnmW27H512dwuZk5zM/Lg3557nfc77vuf9AC4wjh1jycySmcVlnJKZJa70YGaxXddnZmJm2uwa6nyLE5E9daZ4Vyad+l4YhEMgWDDoku2YwAAooVQlDII/E9FzzExExKu+TRKR6fwHYFc/sykAjh07JonIFIuLn3OSA887jgOlFIjockgdUkokHOfLcwtLX4xBWNkwABCRidlB8X/qCGzLGAAATPQjx3VQq1b9Cz27ZSQgAjPr7OBgktj+EMBzU1NTK7QnIp6dX/jJ4nLtuwRwaany9MzMzOO33HJLxMwKgNkIG+h89J8rLhbS6fSdzWbTAFitlDiemyf+2u8wqXRatlrNl8fyw3cwMxUKBTk+Pq5ni6X7RoaHn6rXGwAIyaSLVst7NbL2obHhHa93f/+mGUAgS+vz3gohpOM4m9691hpaawNArGICgWEBYGJigiYmJjj+pq+GYaTDMDTMrILAs6lU+lOk9Uul8vKjy+XSo0QUXCwb1EYZYq1FOp2Wvu83fT+YxTpK6qLOOjERkwXxzlQqNdJqtew669E6/+cdJ6GYWbdBI9FqtTSARC6XO0IkPn+6WHyIiF5ZrTB7AWDN/tPptAjC8MWQ9QN+tfrBDTfcYHs5CjMzM3TgwAGanZ0d9CAeGRgY+IHneWuY0L32EWZhSqXHK5XqXblcbk+1WtUxMBIAV6tVnUqlbgUwXSwt/7rVqPyCiPzp6Wl18ODBddlwXh0wXyxPpzPpg41GQ3cWcRxXhCa4fWx4+LVeNe866yWLC0snZEKN6SiyAGw6k1HNRuOlsd3Dd3aUX2e9998vfSyVdR5Puu49vu9Dax11CdMAELncDuH5rbdMqH+czw+9BKBjKc5ig9gQa4lEEPhGMVc6TkrHIellHjlyRMTOTAhwWSmF87GJiCwziz17RmZHhnLf8JrNe4nog8HBwQQzd96TAKharURSyJshRWFhsfKrt99+O0VEZnp6WnU7UBv29IQQHEW0Inki4l7nxMQEd2jJIEkXZyZtDJzM53c9YyL/Nq/VetpxHCGE6JauarVaxmiDTCb9s6s/ft3Lc6Xl8fHxcR2ziXoCIJY6b6Xtn9jg85OTkzZ2gOTu3bvnh3ftuM9a85DrugqA7QJLAEyVSiWSSt2UkOKFhcXK0VOnTg3FR4KuqK+/BU5Th9IitPpFrfW6eo2IlO97xmitR3blHk4kUz8nIlsoFOT2BoBAsT1XzNyZsvsMx9rdJphrURQFQghxDj0iGOBWoA3AmZ51wGWULggUEpEmoij+1URk4jMsuxVxPp9/n4D/Oo5zbg+1bU0kty1FT37A5do8Bb7PDFw7Vyz9FCAJMEtSgUjIk4L1DBGd6jg6hUKBxsfHdbFU/qebTH7S8zzbPv8XdvC2JQDMLKIoYinl9dnsjsc6AmUGjNFoeaa+tFx7rlFv/ZKI3mXmBDNTqdT8Y71WO5xIODu1jta7v6w9F9tZAxhjbKWyHFUqlahSqUS1WiVqNBoazFk3mbwnnU29Ojtf+hYRRQBUPp+Zs1o/6LouCSEkwPrDDECHqqIzmSEBSGutrdWqkTEmlUql/npmvvQlIoqOHz/ujI3l/96sN76jlPIzmWziXN7upgC4wPna8Ni3EgZYqwtc15WdqZQSWFFgpIwxRmsNJcQTs7OzI/v27YveeOONxNjY8JNRoG/3g+AfSiqfxLkva6KH80lKWR2HojYV/Izfl4eIjF21fWov1grC8EQYBieDMDxhjFlIpVJKCCHix2UURdFgbsdukokHiIjr9QN87BjL0dGhd0aGcl+z1r6TdAcEAMubvA0SAJ1KpVSz1dpPRO9tFQPOnFm6Rinx8TAMOF7HpNJp1Ww136xXyp9JJpMCAKSUaZ/o61KIo8zsxCCIIPCZSNzNzI91GBILiIsLS0xEaLvcvLnrMDOLMAxZSfH7YrGUAtS7RJHo5TocRSA1oAwiHoPApJJyMOgOjBABDN67d2/Q9ZoH4A/zC+Ubs4ODh+u1WsTMMggCYsYnSqXSaD6fn4vZZYmI54vl84YyN2oGKYoiOI4z6g6kn/K8Foh6iwo5EmDLcAZcMAOe11rXdsdeHwHgmZkZdeDAATtXKj1vtD7cCacxWyuVymprrwIw13n+oi53vXhoURTZRqNujDGste55GmPY8zzj+545R+gtpi6YiPjEiROWiAwJtxyGYVfegFhJCWY5sKVR4Q0GMnsdohdXqWt5jgMml2vxj9boA9AHoA9AH4A+AH0A+gD0AegD0AfgIzAUb/xa3mdAH4A+AH0A+gD0AegD0AegD0D3mJqaojjkzLjimfJLW7Kv1klCiDgOb2eLpYEtroe62EHWGAAY6JTGMbMoFApx7FtTJyHTjobHyc/E+iCulbrgdQGIkxAGAGaLi19xEomb4+rNy929IXzPt47j3DQ3V76HiP52MdW8pHFWEwUzU7G0JFeEyCtlugYADh48iLOKHU8tLl5VKlf+srC49DoBU9Za11pLV4T7YBhjHAh+plSuvlYqV55cWlq6pl1gLbwoikxc6gYA1nVdWMI1RMQnT7a5UK1WdwB8fRAEzMwizrwyGy6t1gGCiNgxODo8lLtfSnVrXMnNW5gB6qlCBIAVRLcND+W+HUT2twDAYeM0gxeVUtSdsyTw94vFYua668gnIvZDfTidzgwZY0wnm2WMIRLiPwBQKBQ6afh2Le58sfxmciC53/M83mb1Q3pgYIA8z39vND+0v62fFp/NZrJfaDTqBoBkZriuS1EYvceE42AeAfDprqpQFkKQZW6Gnr1xz56R2TWFkgy2RKTocvTGbNxaKRBHU1NT7RJX5j91Z4GJCGEYGsd19g5ms3enUuk7OnnDWMgmm80SAVPx5iUR8YfODzh06JBhZrF79/CzjXrtXzt37kwACGMFLoIgMLVaTXteS68cX2btum6i0WhW2YhHOoxY4wcQSDCz6WqH2TbTtrWx7DJtRDD3N+r1t4aGhtx4U7pTxB0rRw3ApDPZBBH5OgzvHRvbeTIuP7LdZrBdfEQoZTIpGQSBTCQSuEI+wBozZ4wWO3IZFBeCMrDSQoPR0dHi6dOnP0skjqqE+mY6nUmwtSsJdCEEoihEFIX/rjdrD1979dWvTE+zIiK9qhap3XtXLC7vd9zEE5HRe9jYs5LwV65qtK28lEp8oMPWgyMjI291JNjdsFEul/dBqLuMtjdZa3YJJTww/idU4oXf/eboC5OTk3a99plzdYwMLi4ubgfxww4Pc7694fq5qta6KX2hRtDztsx0/P9euzAv8aXgvBvtlN116Y2V2qL4Hd5I3yBtwwLqSyKU/wMlINV9sltuQAAAAABJRU5ErkJggg==";

  // Monotonic counter for namespacing SVG element ids so multiple diagrams on
  // one page don't collide. Not security-sensitive — just needs to be unique
  // within the document (was Math.random, which CodeQL flags).
  var _uidSeq = 0;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Celsius number -> "21°" (or "70°" for unit "F")
  function tempStr(c, unit) {
    if (c == null || isNaN(c)) return null;
    var v = unit === "F" ? c * 9 / 5 + 32 : c;
    return Math.round(v) + "°";
  }

  function batteryColor(pct) {
    if (pct == null || isNaN(pct)) return COL.dim;
    if (pct <= 15) return COL.bad;
    if (pct <= 40) return COL.warn;
    return COL.ok;
  }

  /**
   * Horizontal battery gauge — shows the charge % only. Any extra readouts
   * (range, charge rate, times to full) are rendered by the frontend as a
   * caption block underneath.
   * @param {number} pct 0..100 (null -> empty/unknown)
   * @param {object} o { charging, width }
   */
  function batteryGauge(pct, o) {
    o = o || {};
    var w = o.width || 210;
    var h = 46;
    // the battery BODY is centred in the svg (the terminal nub sits in the
    // right margin) so the % text sits exactly on the svg centre-line and
    // lines up with the lock icon in the car above it
    var bw = w - 24;
    var bx = (w - bw) / 2; // -> body centre = w/2
    var by = 6;
    var bh = 34;
    var innerW = Math.max(0, Math.min(1, (Number(pct) || 0) / 100)) * (bw - 6);
    var col = batteryColor(pct);
    var label = pct == null || isNaN(pct) ? "—" : Math.round(pct) + "%";

    var bolt =
      o.charging === true
        ? '<path d="M ' +
          (bx + bw - 20) +
          " " +
          (by + 6) +
          " l -11 14 h 7 l -4 11 l 13 -16 h -8 z" +
          '" fill="' +
          COL.text +
          '" stroke="#000" stroke-width="0.5" opacity="0.95">' +
          '<animate attributeName="opacity" values="0.35;1;0.35" dur="1.6s" repeatCount="indefinite"/>' +
          "</path>"
        : "";

    return (
      '<svg class="kiaaccess-battery" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" width="' +
      w +
      '" role="img" aria-label="Battery ' +
      esc(label) +
      '">' +
      '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh +
      '" rx="6" fill="none" stroke="' + COL.outline + '" stroke-width="2"/>' +
      '<rect x="' + (bx + bw + 3) + '" y="' + (by + bh / 2 - 7) +
      '" width="7" height="14" rx="2" fill="' + COL.outline + '"/>' +
      '<rect x="' + (bx + 3) + '" y="' + (by + 3) + '" width="' + innerW + '" height="' + (bh - 6) +
      '" rx="3" fill="' + col + '"/>' +
      '<text x="' + (bx + bw / 2) + '" y="' + (by + bh / 2 + 6) +
      '" text-anchor="middle" font-size="18" font-weight="700" fill="' + COL.text +
      '" style="paint-order:stroke;stroke:#000;stroke-width:3px">' + esc(label) + "</text>" +
      bolt +
      "</svg>"
    );
  }

  // fuel reads amber/gold once known (like a traditional gauge needle
  // sitting in its normal range) rather than green -- distinguishing it
  // from the drive battery's green at a glance is the point, not a
  // charge-style "good/bad" judgement. Still escalates to red when
  // critically low, same threshold as batteryColor().
  function fuelColor(pct) {
    if (pct == null || isNaN(pct)) return COL.dim;
    if (pct <= 15) return COL.bad;
    return COL.warn;
  }

  // simple gas-pump silhouette (body + readout window + nozzle hose),
  // centred on (cx, cy), filled a single colour like a solid icon-font glyph
  function fuelPumpGlyph(cx, cy, col) {
    var x = cx - 8, y = cy - 13;
    return (
      '<g fill="' + col + '">' +
      '<rect x="' + x + '" y="' + (y + 3) + '" width="14" height="21" rx="2.5"/>' +
      '<rect x="' + (x + 2.6) + '" y="' + (y + 6.5) + '" width="8.8" height="5.5" rx="1" fill="#0b0c0d"/>' +
      '<rect x="' + (x - 2) + '" y="' + (y + 24.5) + '" width="18" height="2.4" rx="1.2"/>' +
      '<path d="M ' + (x + 14) + " " + (y + 8) + " C " + (x + 21) + " " + (y + 8) + " " +
      (x + 21) + " " + (y + 1) + " " + (x + 21) + " " + (y - 3) +
      '" fill="none" stroke="' + col + '" stroke-width="2.2" stroke-linecap="round"/>' +
      '<path d="M ' + (x + 17) + " " + (y - 4) + ' l 6.5 -2.6 l 1.6 4 l -6.5 2.6 z"/>' +
      "</g>"
    );
  }

  // battery + bolt silhouette (outline body, terminal nub, filled bolt),
  // centred on (cx, cy) -- the icon is fixed/always-full; the tile's own
  // fill bar underneath is what actually encodes the level
  function batteryBoltGlyph(cx, cy, col) {
    var w = 17, h = 25, x = cx - w / 2, y = cy - h / 2 + 1;
    return (
      '<rect x="' + (cx - 4) + '" y="' + (y - 3.5) + '" width="8" height="3.5" rx="1.4" fill="' + col + '"/>' +
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="4" fill="none" stroke="' +
      col + '" stroke-width="2.2"/>' +
      '<path d="M ' + (cx + 2) + " " + (y + 4) + ' l -6.5 11 h 5.5 l -2.5 9 l 8 -12.5 h -5.5 z" fill="' + col + '"/>'
    );
  }

  /**
   * Icon-tile power widget: a rounded icon frame (gas pump or a battery +
   * bolt glyph) with a horizontal level bar underneath and the percentage
   * in large type beside it -- the standalone alternative to batteryGauge()
   * for a gas tank or (stacked with a battery tile) a hybrid's two energy
   * sources, meant to sit as a caption widget under/beside the car diagram
   * the same way batteryGauge() already does, not inside the diagram's own
   * small car-body silhouette.
   * @param {number} pct 0..100 (null -> unknown)
   * @param {"fuel"|"battery"} kind
   * @param {object} o { width, charging (battery only, pulses the bolt) }
   */
  function powerTile(pct, kind, o) {
    o = o || {};
    var isFuel = kind === "fuel";
    var w = o.width || 210;
    var box = 74;
    var barX = 10, barW = box - 20, barH = 15, barY = box - barH - 9;
    var col = isFuel ? fuelColor(pct) : batteryColor(pct);
    var frac = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
    var fillW = frac * (barW - 4);
    var label = pct == null || isNaN(pct) ? "—" : Math.round(pct) + "%";
    var iconCol = col === COL.dim ? COL.outline : COL.text;
    var icon = isFuel
      ? fuelPumpGlyph(box / 2, box / 2 - 6, iconCol)
      : batteryBoltGlyph(box / 2, box / 2 - 6, iconCol);
    var pulseAnim =
      !isFuel && o.charging === true
        ? '<animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite"/>'
        : "";
    return (
      '<svg class="kiaaccess-powertile" viewBox="0 0 ' + w + " " + box + '" width="' + w +
      '" role="img" aria-label="' +
      (isFuel ? "Fuel " : "Battery ") + esc(label) + '">' +
      '<rect x="0" y="0" width="' + box + '" height="' + box + '" rx="14" fill="none" stroke="' +
      COL.outline + '" stroke-width="2"/>' +
      "<g>" + icon + pulseAnim + "</g>" +
      '<rect x="' + barX + '" y="' + barY + '" width="' + barW + '" height="' + barH + '" rx="' +
      (barH / 2) + '" fill="none" stroke="' + COL.outline + '" stroke-width="1.6"/>' +
      '<rect x="' + (barX + 2) + '" y="' + (barY + 2) + '" width="' + fillW + '" height="' + (barH - 4) +
      '" rx="' + ((barH - 4) / 2) + '" fill="' + col + '"/>' +
      '<text x="' + (box + 18) + '" y="' + (box / 2 + 9) + '" font-size="27" font-weight="700" fill="' +
      COL.text + '">' + esc(label) + "</text>" +
      "</svg>"
    );
  }

  /** Fuel-tank icon tile -- see powerTile(). */
  function fuelTile(pct, o) {
    return powerTile(pct, "fuel", o);
  }

  /** Drive-battery icon tile -- see powerTile(). */
  function batteryTile(pct, o) {
    return powerTile(pct, "battery", o);
  }

  function pulse(attr, a, b, d) {
    return (
      '<animate attributeName="' + attr + '" values="' + a + ";" + b + ";" + a +
      '" dur="' + (d || 1.2) + 's" repeatCount="indefinite"/>'
    );
  }

  // hood (frunk) / liftgate panel: outline shut, red + pulse when open
  function panel(open, x, y, w, h, dxdy) {
    var fill = open === true ? COL.bad : "none";
    var stroke = open === true ? COL.bad : COL.outline;
    var t =
      open === true && dxdy
        ? ' transform="translate(' + dxdy[0] + "," + dxdy[1] + ')"'
        : "";
    var anim =
      open === true
        ? pulse("fill-opacity", "0.15", "0.75") + pulse("stroke-opacity", "0.5", "1")
        : "";
    return (
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
      '" rx="3" fill="' + fill + '" fill-opacity="0.55" stroke="' + stroke +
      '" stroke-width="1.6"' + t + ">" + anim + "</rect>"
    );
  }

  // a door: outline shut; door open -> swings ~50deg about its front-outer
  // hinge + pulse; window open (door shut) -> stays put and pulses red
  function door(open, winOpen, x, y, w, h, hinge, ang) {
    if (open !== true && winOpen !== true) {
      return (
        '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
        '" rx="3" fill="none" stroke="' + COL.outline + '" stroke-width="1.6"/>'
      );
    }
    if (winOpen === true && open !== true) {
      return (
        '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
        '" rx="3" fill="' + COL.bad + '" fill-opacity="0.5" stroke="' + COL.bad +
        '" stroke-width="1.6">' + pulse("fill-opacity", "0.12", "0.7") + "</rect>"
      );
    }
    return (
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
      '" rx="3" fill="' + COL.bad + '" fill-opacity="0.55" stroke="' + COL.bad +
      '" stroke-width="1.6" transform="rotate(' + ang + " " + hinge[0] + " " + hinge[1] +
      ')">' + pulse("fill-opacity", "0.2", "0.8") + "</rect>"
    );
  }

  function wheel(x, y, warn) {
    var c = warn === true ? COL.bad : COL.dim;
    var mark =
      warn === true
        ? '<text x="' + (x + 6) + '" y="' + (y + 20) +
          '" text-anchor="middle" font-size="15" font-weight="700" fill="#fff">!</text>'
        : "";
    return (
      '<rect x="' + x + '" y="' + y + '" width="12" height="30" rx="5" fill="' + c +
      '" stroke="#000" stroke-width="0.5"/>' + mark
    );
  }

  // sunroof panel on the roof, lined up with the front-door windows
  function sunroof(open) {
    var x = 76, y = 120, w = 48, h = 24;
    if (open === true) {
      return (
        '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
        '" rx="6" fill="none" stroke="' + COL.bad + '" stroke-width="2.6">' +
        pulse("stroke-opacity", "0.25", "1") + "</rect>"
      );
    }
    return (
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
      '" rx="6" fill="none" stroke="' + COL.outline + '" stroke-width="1.4"/>'
    );
  }

  // SUV liftgate = rear window + tailgate as one block, clear of the lights
  var LG_X = 62, LG_Y = 250, LG_W = 76, LG_H = 33;
  function liftgate(open) {
    if (open === true) {
      return (
        '<rect x="' + LG_X + '" y="' + (LG_Y + 6) + '" width="' + LG_W + '" height="' + LG_H +
        '" rx="8" fill="' + COL.bad + '" fill-opacity="0.55" stroke="' + COL.bad +
        '" stroke-width="1.8">' + pulse("fill-opacity", "0.15", "0.75") + "</rect>"
      );
    }
    return (
      '<rect x="' + LG_X + '" y="' + LG_Y + '" width="' + LG_W + '" height="' + LG_H +
      '" rx="8" fill="#242628" stroke="' + COL.outline + '" stroke-width="1.6"/>'
    );
  }

  function heatLines(x1, x2, ys, col) {
    return ys
      .map(function (y) {
        return (
          '<line x1="' + x1 + '" y1="' + y + '" x2="' + x2 + '" y2="' + y +
          '" stroke="' + col + '" stroke-width="1.6" stroke-linecap="round">' +
          pulse("opacity", "0.35", "1", 1.6) + "</line>"
        );
      })
      .join("");
  }
  // element lines that taper to follow a glass trapezoid (narrow -> wide edge)
  function heatTrap(xNL, xNR, xWL, xWR, yN, yW, ys, col) {
    return ys
      .map(function (y) {
        var t = (y - yN) / (yW - yN);
        var xl = xNL + (xWL - xNL) * t;
        var xr = xNR + (xWR - xNR) * t;
        return (
          '<line x1="' + xl + '" y1="' + y + '" x2="' + xr + '" y2="' + y +
          '" stroke="' + col + '" stroke-width="1.6" stroke-linecap="round">' +
          pulse("opacity", "0.35", "1", 1.6) + "</line>"
        );
      })
      .join("");
  }
  function frontHeat() {
    return heatTrap(70, 130, 56, 144, 66, 92, [72, 78, 84], COL.heat);
  }
  function rearHeatLines() {
    return heatLines(LG_X + 6, LG_X + LG_W - 6, [LG_Y + 9, LG_Y + 18, LG_Y + 27], COL.heat);
  }

  // short labels for the on-diagram warning badge (kept terse — the right
  // margin is narrow). Falls back to a spaced-out slug for anything unmapped.
  var ALERT_LABELS = {
    tyre_pressure: "Tyre pressure",
    vehicle_fault: "Vehicle fault",
    ev_battery_low: "EV battery low",
    ev_battery_critical: "EV battery critical",
    battery_12v_low: "12V battery low",
    battery_12v_critical: "12V battery critical",
    battery_12v_drain: "12V battery draining",
    unlocked: "Unlocked",
    door_open: "Door open",
    hood_open: "Frunk open",
    liftgate_open: "Boot open",
    window_open: "Window open",
    sunroof_open: "Sunroof open",
    service_due: "Service due",
    not_plugged_home: "Not plugged in",
    otp_expiring: "OTP expiring",
    charge_interrupted: "Charge interrupted",
    unexpected_move: "Moved while parked",
    cant_get_home: "Range too low for home"
  };

  // "door_open" / "evBatteryLow" -> "Door open" / "Ev battery low"
  function humaniseReason(reason) {
    return String(reason || "")
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^./, function (m) { return m.toUpperCase(); });
  }

  /** conditions.evaluate() result -> [{level, label}] for the warning badge:
   *  active warning/critical only, de-duplicated by label, critical first. */
  function alertLabels(conds) {
    if (!Array.isArray(conds)) return [];
    var rank = { critical: 1, warning: 2 };
    var rankOf = function (lvl) { return rank[lvl] || 9; };
    var seen = {};
    var out = [];
    conds.forEach(function (c) {
      if (!c || c.active !== true) return;
      if (c.level !== "warning" && c.level !== "critical") return;
      var label = ALERT_LABELS[c.reason] || humaniseReason(c.reason);
      var key = label.toLowerCase();
      if (seen[key]) {
        if (rankOf(c.level) < rankOf(seen[key].level)) seen[key].level = c.level;
        return;
      }
      seen[key] = { level: c.level, label: label };
      out.push(seen[key]);
    });
    out.sort(function (a, b) { return rankOf(a.level) - rankOf(b.level); });
    return out;
  }

  // right-margin the viewBox needs so the flashing triangle (translate 192 70,
  // reaches x~237 with its outer stroke) isn't clipped by the x232 edge
  function alertExtra(alerts) {
    return alerts && alerts.length ? 10 : 0;
  }

  // warning badge — the triangle in the front-right margin (translate 192 70),
  // flashing, red if anything is critical else amber. No wording: the reasons
  // are listed in the status bar under the header.
  function alertBadge(alerts) {
    var hasCrit = alerts.some(function (a) { return a.level === "critical"; });
    var triCol = hasCrit ? COL.bad : COL.warn;
    return (
      '<g transform="translate(192 70)" class="kiaaccess-critical" ' +
      'style="paint-order:stroke;stroke:#000;stroke-width:3.5px">' +
      '<g>' +
      pulse("opacity", "1", "0.25", hasCrit ? 0.85 : 1.3) +
      '<path d="M 20 1 Q 22 -2 24 1 L 41 32 Q 43 36 38 36 L 6 36 Q 1 36 3 32 Z" ' +
      'fill="' + triCol + '" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<rect x="20.5" y="11" width="3" height="12" rx="1.5" fill="#fff"/>' +
      '<circle cx="22" cy="29" r="2" fill="#fff"/>' +
      "</g></g>"
    );
  }

  // air conditioning: a vent bar at the front + four wavy streams rolling back
  function airWaves(col) {
    var g = '<rect x="70" y="96" width="60" height="4" rx="2" fill="' + col + '" opacity="0.55"/>';
    for (var i = 0; i < 4; i++) {
      var x = 79 + i * 14;
      g +=
        '<path d="M ' + x + ' 104 q 5 11 0 22 q -5 11 0 22" fill="none" stroke="' + col +
        '" stroke-width="2.2" stroke-linecap="round">' +
        '<animate attributeName="opacity" values="0.12;1;0.12" dur="1.9s" begin="' +
        (i * 0.42) + 's" repeatCount="indefinite"/>' +
        '<animate attributeName="transform" attributeType="XML" type="translate" ' +
        'values="0 0; 0 14" dur="1.9s" begin="' + (i * 0.42) +
        's" repeatCount="indefinite" additive="sum"/></path>';
    }
    return g;
  }

  // source icon is 64x62 (see PUMP_ICON_PNG's own comment)
  var PUMP_ICON_ASPECT = 62 / 64;
  // Fixed icon width for BOTH toppers, regardless of the tank's own size --
  // a gas-only diagram's single (large) tank and a hybrid's paired (small)
  // tanks must show the same-size icon, not one scaled up just because its
  // tank happens to be bigger. `small` is accepted for API symmetry with
  // verticalBattery()/verticalFuelTank() but no longer affects icon size.
  var TOPPER_ICON_W = 15;

  /** The user's own gas-pump reference icon (PUMP_ICON_PNG), sized to sit as
   *  a "topper" directly above a vertical tank/cell, its base flush with
   *  the cell's own top edge -- the tank+icon-topper pairing hybrid/gas
   *  diagrams use in place of a battery cell's plain terminal nub. */
  function pumpTopper(cx, by, small) {
    var w = TOPPER_ICON_W;
    var h = w * PUMP_ICON_ASPECT;
    var x = cx - w / 2, y = by - h - 4;
    return (
      '<image x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
      '" href="' + PUMP_ICON_PNG + '" xlink:href="' + PUMP_ICON_PNG +
      '" preserveAspectRatio="xMidYMid meet"/>'
    );
  }

  /** Small battery+bolt icon, same "topper" convention as pumpTopper() --
   *  used in place of the plain terminal nub for a hybrid's drive-battery
   *  cell (so it visually pairs with the fuel tank's pump icon next to it),
   *  never for a pure-EV diagram, which keeps its original plain nub.
   *  Scaled so its OVERALL height (body + terminal nub, 25+3.5=28.5 units
   *  in its own local design) matches pumpTopper()'s height exactly, so the
   *  two toppers read as the same size sitting side by side. */
  function batteryTopper(cx, by, small) {
    var pumpH = TOPPER_ICON_W * PUMP_ICON_ASPECT;
    var k = pumpH / 28.5;
    var w = 17 * k, h = 25 * k;
    var x = cx - w / 2, y = by - h - 4;
    var col = COL.text;
    return (
      '<rect x="' + (cx - 4 * k) + '" y="' + (y - 3.5 * k) + '" width="' + (8 * k) +
      '" height="' + (3.5 * k) + '" rx="' + (1.4 * k) + '" fill="' + col + '"/>' +
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + (4 * k) +
      '" fill="none" stroke="' + col + '" stroke-width="' + (2.2 * k) + '"/>' +
      // the zigzag bolt shape's own bounding box isn't symmetric around
      // its start point (11k wide, offset so x+1k centres it; 20k tall out
      // of the body's 25k height, so a top offset of 2.5k centres it
      // vertically too -- 5.5k, tried earlier, left only a 0k/negative
      // bottom margin and visibly touched the body's bottom edge).
      '<path d="M ' + (cx + 1 * k) + " " + (y + 2.5 * k) + " l " + (-6.5 * k) + " " + (11 * k) +
      " h " + (5.5 * k) + " l " + (-2.5 * k) + " " + (9 * k) + " l " + (8 * k) + " " + (-12.5 * k) +
      " h " + (-5.5 * k) + ' z" fill="' + col + '"/>'
    );
  }

  /** Vertical "AA cell" battery, terminal to the front, filling bottom-up,
   *  sitting toward the rear of the cabin with the % shown underneath.
   *  `cx` (default 100, the diagram's own centre) and `small` (a narrower
   *  cell, for the hybrid layout which draws this alongside a fuel tank)
   *  are optional -- every existing EV-only caller gets the exact same
   *  output as before. `iconTopper` swaps the plain terminal nub for a
   *  small battery+bolt icon (see batteryTopper()) -- only ever passed for
   *  the hybrid layout; a pure-EV diagram never sets it, so it keeps its
   *  original look untouched. */
  function verticalBattery(pct, charging, cx, small, iconTopper) {
    cx = cx == null ? 100 : cx;
    var bw = small ? 19 : 24, bx = cx - bw / 2, by = 168, bh = small ? 50 : 54;
    var ix = bx + 2.5, iw = bw - 5, iy = by + 3, ih = bh - 6;
    var frac = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
    var fh = frac * ih;
    var col = batteryColor(pct);
    var label = pct == null || isNaN(pct) ? "—" : Math.round(pct) + "%";
    var bolt =
      charging === true
        ? '<path d="M ' + (cx + 3) + " " + (by + 12) + " l -8 13 h 6 l -3 11 l 10 -15 h -6 z" +
          '" fill="' + COL.text + '" stroke="#000" stroke-width="0.6">' +
          '<animate attributeName="opacity" values="0.35;1;0.35" dur="1.5s" repeatCount="indefinite"/></path>'
        : "";
    var topper =
      iconTopper === true
        ? batteryTopper(cx, by, small)
        : '<rect x="' + (cx - 5) + '" y="' + (by - 4) + '" width="10" height="5" rx="1.5" fill="' +
          COL.outline + '"/>';
    return (
      topper +
      '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh +
      '" rx="5" fill="#111214" stroke="' + COL.outline + '" stroke-width="2"/>' +
      '<rect x="' + ix + '" y="' + (iy + ih - fh) + '" width="' + iw + '" height="' + fh +
      '" rx="2.5" fill="' + col + '"/>' +
      bolt +
      '<text x="' + cx + '" y="' + (by + bh + 16) + '" text-anchor="middle" font-size="' + (small ? 11 : 13) + '" ' +
      'font-weight="700" fill="' + COL.text + '">' + esc(label) + "</text>"
    );
  }

  /** Vertical fuel tank -- same footprint/fill convention as verticalBattery
   *  (so a hybrid can show both side by side and they read as one family of
   *  gauge) but topped with the small gas-pump icon (pumpTopper()) instead
   *  of a terminal nub, and no lightning bolt (there's no "actively
   *  fuelling" live state to animate). `cx`/`small` match verticalBattery's. */
  function verticalFuelTank(pct, cx, small) {
    cx = cx == null ? 100 : cx;
    var bw = small ? 19 : 24, bx = cx - bw / 2, by = 168, bh = small ? 50 : 54;
    var ix = bx + 2.5, iw = bw - 5, iy = by + 3, ih = bh - 6;
    var frac = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
    var fh = frac * ih;
    var col = batteryColor(pct); // same low/mid/high thresholds as charge %
    var label = pct == null || isNaN(pct) ? "—" : Math.round(pct) + "%";
    return (
      pumpTopper(cx, by, small) +
      '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh +
      '" rx="5" fill="#111214" stroke="' + COL.outline + '" stroke-width="2"/>' +
      '<rect x="' + ix + '" y="' + (iy + ih - fh) + '" width="' + iw + '" height="' + fh +
      '" rx="2.5" fill="' + col + '"/>' +
      '<text x="' + cx + '" y="' + (by + bh + 16) + '" text-anchor="middle" font-size="' + (small ? 11 : 13) + '" ' +
      'font-weight="700" fill="' + COL.text + '">' + esc(label) + "</text>"
    );
  }

  /** Centre powertrain cell(s): an EV's drive battery (unchanged from the
   *  original diagram), a gas car's single pump-topped fuel tank, or
   *  (hybrid) a battery-icon-topped drive-battery cell alongside a
   *  pump-topped fuel tank -- selected by `o.powertrain` ("ev" (default) |
   *  "hybrid" | "gas"). Every car also gets its own 12V accessory battery
   *  regardless of powertrain. */
  function mainPowerCell(s, o) {
    if (o.battery === false) return "";
    var pt = o.powertrain === "hybrid" || o.powertrain === "gas" ? o.powertrain : "ev";
    var cell =
      pt === "gas"
        ? verticalFuelTank(s.fuelPct, 100, false)
        : pt === "hybrid"
        ? verticalBattery(s.batteryPct, s.charging, 84, true, true) +
          verticalFuelTank(s.fuelPct, 117, true)
        : verticalBattery(s.batteryPct, s.charging);
    return cell + battery12v(s.car12vPct);
  }

  /** Small 12V (lead-acid) battery icon tucked in the nose behind the front-left
   *  headlight, with two terminal posts and the charge % shown inside. */
  function battery12v(pct) {
    if (pct == null || isNaN(pct)) return "";
    var x = 48, y = 44, w = 28, h = 16;       // full size, in the front-left
                                              // nose behind the headlight
    var frac = Math.max(0, Math.min(1, Number(pct) / 100));
    var col = batteryColor(pct);
    return (
      '<g class="kiaaccess-12v">' +
      '<rect x="' + (x + 3.5) + '" y="' + (y - 2.6) + '" width="4" height="3" rx="1" fill="' + COL.outline + '"/>' +
      '<rect x="' + (x + w - 7.5) + '" y="' + (y - 2.6) + '" width="4" height="3" rx="1" fill="' + COL.outline + '"/>' +
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
      '" rx="2.5" fill="#111214" stroke="' + COL.outline + '" stroke-width="1.5"/>' +
      '<rect x="' + (x + 1.6) + '" y="' + (y + 1.6) + '" width="' + (frac * (w - 3.2)) + '" height="' + (h - 3.2) +
      '" rx="1.4" fill="' + col + '" opacity="0.9"/>' +
      '<text x="' + (x + w / 2) + '" y="' + (y + h / 2 + 3.2) + '" text-anchor="middle" font-size="8.5" ' +
      'font-weight="700" fill="' + COL.text + '" style="paint-order:stroke;stroke:#000;stroke-width:2.2px">' +
      Math.round(pct) + "%</text>" +
      "</g>"
    );
  }

  /**
   * Top-down SUV status diagram — front at the top (direction of travel = up).
   * The canvas is a FIXED size in every state: the car body is always at the
   * same coordinates and pixel size; only the right-hand strip changes (a
   * charger + animated energy flow appear there when plugged in).
   * @param {object} s state flags (bool|null unless noted):
   *   locked, carOn, headlights;
   *   charging, plugged, v2l, v2x, batteryPct (number|null), car12vPct (number|null),
   *   chargeKw + chargeAmps (numbers, shown under the charger while charging);
   *   doorFL/FR/RL/RR (open), winFL/FR/RL/RR (window open), hood (frunk),
   *   trunk (liftgate), sunroof;
   *   defrost, rearHeat, mirrorHeat, steerHeat, climate ("heat"|"cool"|"on"|null),
   *   airTempC (climate set-point °C), outsideTempC (°C);
   *   tyreFL/FR/RL/RR, tyreAny;
   *   alerts (array of {level:"warning"|"critical", label}) -> warning triangle
   *     in the front-right margin with the reason(s) centred under it (red if any
   *     critical, else amber); the viewBox widens on the right so the text fits
   *     and `width` scales to keep the car the same size. `critical:true` still
   *     works as a shorthand for one unlabelled critical alert;
   *   flashing (bool) -> pulses head + tail lights amber (find-the-car / hazards)
   * @param {object} o { width, battery:false to omit the centre cell(s),
   *   powertrain:"ev" (default) | "hybrid" | "gas" -- selects a drive
   *   battery, a fuel tank, or a smaller pair of both side by side,
   *   tempUnit:"C"|"F" for the two on-diagram temperatures }
   *   gas/hybrid vehicles also read `s.fuelPct` (0..100, null -> unknown),
   *   the same convention as `s.batteryPct`.
   */
  function carDiagram(s, o) {
    s = s || {};
    o = o || {};
    // Canvas centred on the car body (centre x100, viewBox -32..232). Charger
    // strip lives at x 200..228. The warning badge is icon-only (its reasons go
    // in the module status bar); the viewBox only gains a few px on the right so
    // the flashing triangle isn't clipped, and `width` scales with it so the
    // car itself stays the same size.
    var alertsIn = Array.isArray(s.alerts)
      ? s.alerts
      : (s.critical === true ? [{ level: "critical", label: "" }] : []);
    var vbW = 264 + alertExtra(alertsIn);
    var VB = "-32 0 " + vbW + " 330";
    var w = Math.round((o.width || 190) * vbW / 264);

    var tyre = function (which) {
      return s["tyre" + which] === true || s.tyreAny === true;
    };

    var uid = "k" + (++_uidSeq).toString(36);
    var exporting = s.v2l === true || s.v2x === true;
    var plugged = s.charging === true || s.plugged === true || exporting;
    var flow =
      s.charging === true ? COL.ok : exporting ? COL.accent : COL.warn;

    var port =
      s.charging === true
        ? COL.ok
        : exporting
        ? COL.accent
        : s.plugged === true
        ? COL.warn
        : COL.dim;

    var bodyStroke =
      s.locked === true ? COL.ok : s.locked === false ? COL.bad : COL.outline;

    // ---- charger + cable + energy flow (right strip) ----
    var cableD = "M 162 274 C 186 274 190 250 202 252";
    var charger = "";
    if (plugged) {
      var live = s.charging === true || exporting;
      charger =
        '<path id="cbl' + uid + '" d="' + cableD + '" fill="none" stroke="' +
        (live ? flow : COL.dim) +
        '" stroke-width="3" stroke-linecap="round" opacity="0.55"/>' +
        '<rect x="200" y="228" width="28" height="48" rx="5" fill="#17181a" stroke="' +
        COL.outline + '" stroke-width="2"/>' +
        '<rect x="205" y="234" width="17" height="11" rx="2" fill="' + COL.glass + '"/>' +
        '<path d="M 216 249 l -6 9 h 5 l -3 8 l 8 -11 h -5 z" fill="' + COL.text +
        '" opacity="0.85"/>' +
        '<circle cx="205" cy="270" r="3" fill="' + flow + '">' +
        (live
          ? '<animate attributeName="opacity" values="0.3;1;0.3" dur="1.4s" repeatCount="indefinite"/>'
          : "") +
        "</circle>";
      if (live) {
        // charging = flow toward the car (keyPoints 1;0); exporting = away
        var kp = s.charging === true ? '1;0' : '0;1';
        for (var p = 0; p < 3; p++) {
          charger +=
            '<circle r="2.6" fill="' + flow + '"><animateMotion dur="1.4s" begin="' +
            (p * 0.47).toFixed(2) + 's" repeatCount="indefinite" keyPoints="' + kp +
            '" keyTimes="0;1" calcMode="linear"><mpath href="#cbl' + uid +
            '" xlink:href="#cbl' + uid + '"/></animateMotion></circle>';
        }
      }
    }
    var portRing =
      s.charging === true
        ? '<circle cx="155" cy="274" r="5" fill="none" stroke="' + COL.ok +
          '" stroke-width="2"><animate attributeName="r" values="4;13" dur="1.5s" repeatCount="indefinite"/>' +
          '<animate attributeName="opacity" values="0.75;0" dur="1.5s" repeatCount="indefinite"/></circle>'
        : "";

    // live charge readout — only while actually charging: kW drawn + current (A),
    // centred under the wall box (its centre is x214). No space before the unit,
    // and a 3-digit "kW" drops a point of font size, so the widest value still
    // clears the right viewBox edge (x 232) while staying centred.
    var chargeInfo = "";
    if (s.charging === true) {
      var kwNum = Number(s.chargeKw);
      var kwBig = kwNum >= 100;
      var kw = isFinite(kwNum) && kwNum > 0
        ? (kwBig ? Math.round(kwNum) : Math.round(kwNum * 10) / 10) + "kW"
        : null;
      var aNum = Number(s.chargeAmps);
      var amps = isFinite(aNum) && aNum > 0 ? Math.round(aNum) + "A" : null;
      var rows = [];
      if (kw) rows.push([kw, COL.ok, kwBig ? 10 : 11]);
      if (amps) rows.push([amps, COL.text, 11]);
      if (rows.length) {
        chargeInfo =
          '<g transform="translate(214 289)" text-anchor="middle" ' +
          'style="paint-order:stroke;stroke:#000;stroke-width:3px">' +
          rows.map(function (r, i) {
            return '<text x="0" y="' + (i * 12.5) + '" font-size="' + r[2] + '" ' +
              'font-weight="700" fill="' + r[1] + '">' + esc(r[0]) + "</text>";
          }).join("") +
          "</g>";
      }
    }

    // headlights: solid white when on, hollow outline when off/unknown
    var lampFill = s.headlights === true ? COL.text : "none";
    var lampStroke = s.headlights === true ? COL.text : COL.outline;
    var headlight = function (d) {
      return (
        '<path d="' + d + '" fill="' + lampFill + '" stroke="' + lampStroke +
        '" stroke-width="1.4"/>'
      );
    };

    // taillights: red when the car is on / in accessory, outline when off
    var tlFill = s.carOn === true ? COL.bad : "none";
    var tlStroke = s.carOn === true ? COL.bad : COL.outline;
    var taillight = function (x) {
      return (
        '<rect x="' + x + '" y="293" width="30" height="7" rx="2" fill="' + tlFill +
        '" stroke="' + tlStroke + '" stroke-width="1.2" opacity="0.85"/>'
      );
    };

    // climate / heaters
    var climCol =
      s.climate === "heat" ? COL.heat : s.climate === "cool" ? COL.accent : COL.text;
    var mirrorFill = s.mirrorHeat === true ? COL.heat : COL.dim;
    var mirrorAnim = s.mirrorHeat === true ? pulse("opacity", "0.4", "1", 1.4) : "";

    // find-the-car / hazards: amber pulse on all four lamps. 5 flashes then stop
    // (the API has no live "hazards on" state to follow; the caller clears it).
    var HEAD_L = "M 45 31 q 14 -8 25 -2 l -2 8 q -12 -5 -23 2 z";
    var HEAD_R = "M 155 31 q -14 -8 -25 -2 l 2 8 q 12 -5 23 2 z";
    var flashAnim =
      '<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.45;1" ' +
      'dur="0.55s" repeatCount="5"/>';
    var flashLamps =
      s.flashing === true
        ? '<path d="' + HEAD_L + '" fill="' + COL.warn + '" opacity="0">' + flashAnim + "</path>" +
          '<path d="' + HEAD_R + '" fill="' + COL.warn + '" opacity="0">' + flashAnim + "</path>" +
          '<rect x="46" y="293" width="30" height="7" rx="2" fill="' + COL.warn + '" opacity="0">' + flashAnim + "</rect>" +
          '<rect x="124" y="293" width="30" height="7" rx="2" fill="' + COL.warn + '" opacity="0">' + flashAnim + "</rect>"
        : "";

    // temperatures
    var tUnit = o.tempUnit === "F" ? "F" : "C";
    var setT = tempStr(s.airTempC, tUnit);       // shown only while climate is on
    var outT = tempStr(s.outsideTempC, tUnit);   // always shown, outside the body
    var setpointText =
      s.climate && setT
        ? '<text x="100" y="87" text-anchor="middle" font-size="17" font-weight="700" fill="' +
          climCol + '" style="paint-order:stroke;stroke:#000;stroke-width:3.5px">' + setT + "</text>"
        : "";
    // small thermometer glyph + the reading, top-left margin, outside the body
    var outsideText = outT
      ? '<g transform="translate(-27 18) scale(1.28)">' +
        '<path d="M 4 1.5 a 2.4 2.4 0 0 1 2.4 2.4 v 5.4 a 3.5 3.5 0 1 1 -4.8 0 V 3.9 A 2.4 2.4 0 0 1 4 1.5 z" ' +
        'fill="none" stroke="' + COL.dim + '" stroke-width="1.2"/>' +
        '<path d="M 4 5.5 V 12" stroke="' + COL.dim + '" stroke-width="2.2" stroke-linecap="round"/>' +
        '<circle cx="4" cy="12" r="2.4" fill="' + COL.dim + '"/>' +
        '<text x="13" y="11.5" font-size="12.5" font-weight="600" fill="' + COL.text + '">' + outT + "</text>" +
        "</g>"
      : "";

    return (
      '<svg class="kiaaccess-car" xmlns="http://www.w3.org/2000/svg" ' +
      'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="' + VB + '" width="' + w +
      '" role="img" aria-label="Vehicle status, front at top">' +
      // body (front nose rounded, rear squarer)
      '<path d="M 40 58 Q 40 22 74 22 L 126 22 Q 160 22 160 58 L 160 284 ' +
      'Q 160 304 140 304 L 60 304 Q 40 304 40 284 Z" fill="#1b1c1e" stroke="' +
      bodyStroke + '" stroke-width="3"/>' +
      // front grille bar
      '<rect x="78" y="24" width="44" height="7" rx="2" fill="' + COL.dim + '"/>' +
      // headlights (front corners)
      headlight(HEAD_L) +
      headlight(HEAD_R) +
      // taillights (rear)
      taillight(46) +
      taillight(124) +
      // find-the-car amber flash on all four lamps
      flashLamps +
      // SUV liftgate (rear window + tailgate combined), raised off the lights
      liftgate(s.trunk) +
      // raked windscreen
      '<path d="M 56 92 L 144 92 L 130 66 Q 100 58 70 66 Z" fill="' + COL.glass + '"/>' +
      // defrost: front (follows the screen shape) + rear (on the liftgate)
      (s.defrost === true ? frontHeat() + rearHeatLines() : "") +
      (s.rearHeat === true && s.defrost !== true ? rearHeatLines() : "") +
      // roof + roof rails (SUV cue)
      '<rect x="56" y="94" width="88" height="150" rx="12" fill="#242628"/>' +
      '<rect x="58" y="96" width="3.5" height="146" rx="1.75" fill="' + COL.dim + '"/>' +
      '<rect x="138.5" y="96" width="3.5" height="146" rx="1.75" fill="' + COL.dim + '"/>' +
      // sunroof (grey outline shut / red pulse open — same as windows)
      sunroof(s.sunroof) +
      // air conditioning (heat / cool / on) + the set-point above the airflow
      (s.climate ? airWaves(climCol) : "") +
      setpointText +
      // steering-wheel heater — driver (left) side, toward the front
      (s.steerHeat === true
        ? '<circle cx="80" cy="107" r="6" fill="none" stroke="' + COL.heat +
          '" stroke-width="2.4">' + pulse("opacity", "0.35", "1", 1.4) + "</circle>"
        : "") +
      // door mirrors (also the mirror-heater indicator)
      '<path d="M 40 98 l -9 3 l 3 7 l 6 -2 z" fill="' + mirrorFill + '">' + mirrorAnim + "</path>" +
      '<path d="M 160 98 l 9 3 l -3 7 l -6 -2 z" fill="' + mirrorFill + '">' + mirrorAnim + "</path>" +
      // frunk (small — it's tiny on the real car), fixed; recolours when open
      panel(s.hood, 82, 38, 36, 14) +
      // doors — swing ~50deg out when open; window open = shut + pulse
      door(s.doorFL, s.winFL, 34, 112, 14, 42, [34, 112], 50) +
      door(s.doorRL, s.winRL, 34, 162, 14, 46, [34, 162], 50) +
      door(s.doorFR, s.winFR, 152, 112, 14, 42, [166, 112], -50) +
      door(s.doorRR, s.winRR, 152, 162, 14, 46, [166, 162], -50) +
      // wheels — front axle well forward of the doors, larger tyres
      wheel(29, 60, tyre("FL")) +
      wheel(159, 60, tyre("FR")) +
      wheel(29, 230, tyre("RL")) +
      wheel(159, 230, tyre("RR")) +
      // charger + cable + energy flow (right strip; empty when unplugged)
      charger +
      // kW + time-to-target, only while charging
      chargeInfo +
      // charge port — rear, passenger (right) side, between wheel and taillight
      '<rect x="148" y="266" width="14" height="16" rx="2" fill="#2a2c2e" stroke="' +
      COL.dim + '" stroke-width="1"/>' +
      portRing +
      '<circle cx="155" cy="274" r="4.2" fill="' + port + '"/>' +
      // drive battery and/or fuel tank (centre) + 12V battery (beside it) --
      // lock state is the body colour
      mainPowerCell(s, o) +
      // warning triangle (front-right margin) + reason(s) centred under it
      (alertsIn.length ? alertBadge(alertsIn) : "") +
      // outside temperature — always, in the top-left margin
      outsideText +
      "</svg>"
    );
  }

  // ---- row icons (Font Awesome 6, bundled with MagicMirror) ----

  var DEFAULT_ICONS = {
    "vehicle.ev_battery_percentage": "fa-solid fa-battery-half",
    "vehicle.ev_battery_soh_percentage": "fa-solid fa-heart-pulse",
    "vehicle.ev_battery_capacity": "fa-solid fa-car-battery",
    "vehicle.ev_battery_pack_voltage": "fa-solid fa-bolt-lightning",
    "vehicle.car_battery_percentage": "fa-solid fa-car-battery",
    "vehicle.ev_battery_is_plugged_in": "fa-solid fa-plug",
    "vehicle.ev_charge_port_door_is_open": "fa-solid fa-plug-circle-plus",
    "vehicle.ev_charging_power": "fa-solid fa-bolt",
    "vehicle.ev_charging_current": "fa-solid fa-bolt",
    "vehicle.ev_estimated_current_charge_duration": "fa-solid fa-hourglass-half",
    "vehicle.ev_estimated_fast_charge_duration": "fa-solid fa-gauge-high",
    "vehicle.ev_estimated_station_charge_duration": "fa-solid fa-charging-station",
    "vehicle.ev_estimated_portable_charge_duration": "fa-solid fa-suitcase-rolling",
    "vehicle.ev_v2l_status": "fa-solid fa-house-signal",
    "vehicle.ev_v2x_status": "fa-solid fa-plug-circle-bolt",
    "vehicle.ev_driving_range": "fa-solid fa-road",
    "vehicle.total_driving_range": "fa-solid fa-route",
    "vehicle.odometer": "fa-solid fa-gauge",
    "vehicle.next_service_distance": "fa-solid fa-screwdriver-wrench",
    "vehicle.ev_battery_precondition_enabled": "fa-solid fa-temperature-arrow-up",
    "vehicle.valet_mode_active": "fa-solid fa-user-tie",
    "vehicle.is_locked": "fa-solid fa-lock",
    "vehicle.air_control_is_on": "fa-solid fa-fan",
    "vehicle.air_temperature": "fa-solid fa-temperature-half",
    "vehicle.outside_temperature": "fa-solid fa-cloud-sun",
    "vehicle.defrost_is_on": "fa-solid fa-snowflake",
    "vehicle.back_window_heater_is_on": "fa-solid fa-grip-lines",
    "vehicle.steering_wheel_heater_is_on": "fa-solid fa-circle-notch",
    "vehicle.tire_pressure_all_warning_is_on": "fa-solid fa-circle-exclamation",
    "vehicle.battery_auxiliary_fail_warning_is_on": "fa-solid fa-triangle-exclamation",
    "vehicle.smart_key_battery_warning_is_on": "fa-solid fa-key",
    "vehicle.engine_is_running": "fa-solid fa-power-off",
    "vehicle.accessory_on": "fa-solid fa-toggle-on",
    "vehicle.trunk_is_open": "fa-solid fa-car-rear",
    "vehicle.hood_is_open": "fa-solid fa-car",
    "vehicle.last_updated_at": "fa-solid fa-car-on",
    "vehicle.location_last_updated_at": "fa-solid fa-location-dot",
    "vehicle.geocode": "fa-solid fa-map-location-dot",
    "_meta.fetchedAt": "fa-solid fa-arrows-rotate"
  };

  var KEYWORD_ICONS = [
    [/door/, "fa-solid fa-car-side"],
    [/window/, "fa-solid fa-window-maximize"],
    [/tire|tyre/, "fa-solid fa-gauge-simple-high"],
    [/temp/, "fa-solid fa-temperature-half"],
    [/charg/, "fa-solid fa-bolt"],
    [/batter/, "fa-solid fa-battery-half"],
    [/lock/, "fa-solid fa-lock"],
    [/range/, "fa-solid fa-road"],
    [/seat/, "fa-solid fa-chair"],
    [/location|geocode|latitude|longitude/, "fa-solid fa-location-dot"],
    [/warning|fail/, "fa-solid fa-triangle-exclamation"],
    [/time|updated|duration/, "fa-solid fa-clock"]
  ];

  function iconFor(key, overrides) {
    if (overrides && overrides[key]) return overrides[key];
    if (DEFAULT_ICONS[key]) return DEFAULT_ICONS[key];
    var lk = String(key).toLowerCase();
    for (var i = 0; i < KEYWORD_ICONS.length; i++) {
      if (KEYWORD_ICONS[i][0].test(lk)) return KEYWORD_ICONS[i][1];
    }
    return null;
  }

  // ---- optional standalone widgets ----

  /** SoC sparkline. points: [{ t:epoch_ms, v:pct }] (or [{t, ev}]) */
  function sparkline(points, o) {
    o = o || {};
    var w = o.width || 200,
      h = o.height || 40,
      pad = 3;
    var pts = (points || [])
      .map(function (p) {
        return { t: +p.t, v: p.v != null ? +p.v : p.ev != null ? +p.ev : null };
      })
      .filter(function (p) {
        return isFinite(p.t) && p.v != null && isFinite(p.v);
      });
    if (pts.length < 2) return "";
    var t0 = pts[0].t,
      t1 = pts[pts.length - 1].t || t0 + 1;
    var lo = o.min != null ? o.min : Math.min.apply(null, pts.map(function (p) { return p.v; }));
    var hi = o.max != null ? o.max : Math.max.apply(null, pts.map(function (p) { return p.v; }));
    if (hi - lo < 5) {
      hi = lo + 5;
    }
    var sx = function (t) { return pad + ((t - t0) / (t1 - t0)) * (w - 2 * pad); };
    var sy = function (v) { return h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad); };
    var d = pts
      .map(function (p, i) { return (i ? "L" : "M") + sx(p.t).toFixed(1) + " " + sy(p.v).toFixed(1); })
      .join(" ");
    var area = d + " L " + sx(t1).toFixed(1) + " " + (h - pad) + " L " + sx(t0).toFixed(1) + " " + (h - pad) + " Z";
    var col = o.color || COL.accent;
    var last = pts[pts.length - 1];
    return (
      '<svg class="kiaaccess-spark" viewBox="0 0 ' + w + " " + h + '" width="' + w + '">' +
      '<path d="' + area + '" fill="' + col + '" fill-opacity="0.15"/>' +
      '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<circle cx="' + sx(last.t).toFixed(1) + '" cy="' + sy(last.v).toFixed(1) + '" r="2.4" fill="' + col + '"/>' +
      "</svg>"
    );
  }

  /** radial range/charge ring. pct 0..100; centreText e.g. "312 mi" */
  function rangeRing(pct, o) {
    o = o || {};
    var sz = o.size || 132,
      r = sz / 2 - 10,
      cx = sz / 2,
      cy = sz / 2;
    var frac = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
    var C = 2 * Math.PI * r;
    var col = batteryColor(pct);
    var label = pct == null || isNaN(pct) ? "—" : Math.round(pct) + "%";
    return (
      '<svg class="kiaaccess-ring" viewBox="0 0 ' + sz + " " + sz + '" width="' + sz + '">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#2a2c2e" stroke-width="9"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + col +
      '" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + (frac * C).toFixed(1) + " " + C.toFixed(1) +
      '" transform="rotate(-90 ' + cx + " " + cy + ')"/>' +
      (o.charging === true
        ? '<path d="M ' + (cx + 3) + " " + (cy - r - 1) +
          ' l -8 12 h 5 l -3 10 l 9 -14 h -6 z" fill="' + COL.text +
          '" stroke="#000" stroke-width="0.5"><animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite"/></path>'
        : "") +
      '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" font-size="20" font-weight="700" fill="' +
      COL.text + '">' + esc(label) + "</text>" +
      (o.centreText
        ? '<text x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle" font-size="11" fill="' + COL.dim +
          '">' + esc(o.centreText) + "</text>"
        : "") +
      "</svg>"
    );
  }

  /** horizontal charge-progress bar with an ETA caption */
  function chargeBar(pct, targetPct, o) {
    o = o || {};
    var w = o.width || 210,
      h = 20;
    var cur = Math.max(0, Math.min(100, Number(pct) || 0));
    var tgt = targetPct != null ? Math.max(0, Math.min(100, Number(targetPct))) : 100;
    var iw = w - 4;
    return (
      '<svg class="kiaaccess-chargebar" viewBox="0 0 ' + w + " " + h + '" width="' + w + '">' +
      '<rect x="1" y="4" width="' + (w - 2) + '" height="' + (h - 8) + '" rx="4" fill="none" stroke="' + COL.outline + '" stroke-width="1.4"/>' +
      '<rect x="2" y="5" width="' + ((tgt / 100) * iw).toFixed(1) + '" height="' + (h - 10) + '" rx="3" fill="' + COL.dim + '" opacity="0.5"/>' +
      '<rect x="2" y="5" width="' + ((cur / 100) * iw).toFixed(1) + '" height="' + (h - 10) + '" rx="3" fill="' + COL.ok + '"/>' +
      "</svg>"
    );
  }

  return {
    COL: COL,
    batteryGauge: batteryGauge,
    carDiagram: carDiagram,
    verticalBattery: verticalBattery,
    verticalFuelTank: verticalFuelTank,
    powerTile: powerTile,
    fuelTile: fuelTile,
    batteryTile: batteryTile,
    alertLabels: alertLabels,
    sparkline: sparkline,
    rangeRing: rangeRing,
    chargeBar: chargeBar,
    iconFor: iconFor,
    DEFAULT_ICONS: DEFAULT_ICONS
  };
});
