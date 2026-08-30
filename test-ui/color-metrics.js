// Perceptual colour metrics — sRGB → CIELAB → CIEDE2000.
//
// Why this exists: the visual suite used to assert `new Set(swatches).size === 24`, i.e. that the 24
// pie colours are 24 distinct STRINGS. That proves nothing about whether two slices look alike —
// '#3cb44b' and '#3cb44c' are distinct strings and the same colour to any eye. Distinctness of a
// categorical palette is a perceptual property, so it needs a perceptual metric.
//
// CIEDE2000 (CIE 142-2001) is the standard one. Rough reading of ΔE00 for this use:
//   < 1      indistinguishable even side by side
//   1 – 2.3  a "just noticeable difference" under ideal conditions
//   < 5      too close for two categories in a legend
//   ≥ 10     comfortably separable at a glance, non-adjacent, on a small screen
// The pie is read on a phone, in a dark panel, with slices that may be thin slivers, so the bar here
// is the ≥ 10 end rather than the JND end.
//
// No dependency: the project runs on playwright + node:sqlite and nothing else, so the transform and
// the ΔE00 formula are implemented directly. Both are pinned by self-checks in
// test-ui/palette-distinctness.js against published reference values.

// ---- parsing ---------------------------------------------------------------------------------
// Accepts '#rgb', '#rrggbb', 'rgb(r, g, b)' and 'hsl(h, s%, l%)' — every form the app's own colour
// paths can produce (the fixed palette is hex, extraLedgerColor() emits hsl(), and a browser's
// getComputedStyle hands back rgb()).
function parseColor(input) {
  const s = String(input).trim().toLowerCase();

  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));

  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));

  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
  if (m) return [1, 2, 3].map((i) => Math.round(Number(m[i])));

  m = /^hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%/.exec(s);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);

  throw new Error(`Unrecognised colour: ${JSON.stringify(input)}`);
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r1 + m, g1 + m, b1 + m].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
}

const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// ---- sRGB → CIELAB (D65) ----------------------------------------------------------------------
function rgbToLab(rgb) {
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const [r, g, b] = lin;
  const X = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const Z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
  // D65 reference white
  const [Xn, Yn, Zn] = [0.95047, 1.00000, 1.08883];
  const d = 6 / 29;
  const f = (t) => (t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29);
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const labOf = (color) => rgbToLab(parseColor(color));

// CIELAB (D65) -> sRGB. `inGamut` is false when the colour needed clamping, i.e. the Lab value has
// no sRGB representation — the palette search below rejects those rather than silently clamping,
// because a clamped colour is not the colour whose deltaE was just measured.
function labToRgb(lab) {
  const [L, a, b] = lab;
  const [Xn, Yn, Zn] = [0.95047, 1.00000, 1.08883];
  const d = 6 / 29;
  const finv = (t) => (t > d ? t * t * t : 3 * d * d * (t - 4 / 29));
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = Xn * finv(fx), Y = Yn * finv(fy), Z = Zn * finv(fz);
  const lin = [
    X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314,
    X * -0.9692660 + Y * 1.8760108 + Z * 0.0415560,
    X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252,
  ];
  let inGamut = true;
  const rgb = lin.map((v) => {
    if (v < -0.0001 || v > 1.0001) inGamut = false;
    const c = Math.min(1, Math.max(0, v));
    const srgb = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
  });
  return { rgb, inGamut };
}

// Lab <-> LCh(ab): searching in polar coordinates lets a proposal say "same hue, a bit lighter"
// or "rotate the hue slightly", which is how a palette stays recognisable while moving apart.
const labToLch = ([L, a, b]) => [L, Math.hypot(a, b), (Math.atan2(b, a) * 180 / Math.PI + 360) % 360];
const lchToLab = ([L, C, h]) => [L, C * Math.cos(h * Math.PI / 180), C * Math.sin(h * Math.PI / 180)];

// ---- CIEDE2000 ---------------------------------------------------------------------------------
// Straight transcription of CIE 142-2001 with kL = kC = kH = 1.
function ciede2000(lab1, lab2) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;

  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));

  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = (a1p === 0 && b1 === 0) ? 0 : (deg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = (a2p === 0 && b2 === 0) ? 0 : (deg(Math.atan2(b2, a2p)) + 360) % 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let Hbarp;
  if (C1p * C2p === 0) Hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) Hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) Hbarp = (h1p + h2p + 360) / 2;
  else Hbarp = (h1p + h2p - 360) / 2;

  const T = 1
    - 0.17 * Math.cos(rad(Hbarp - 30))
    + 0.24 * Math.cos(rad(2 * Hbarp))
    + 0.32 * Math.cos(rad(3 * Hbarp + 6))
    - 0.20 * Math.cos(rad(4 * Hbarp - 63));

  const dTheta = 30 * Math.exp(-Math.pow((Hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;

  return Math.sqrt(
    Math.pow(dLp / SL, 2)
    + Math.pow(dCp / SC, 2)
    + Math.pow(dHp / SH, 2)
    + RT * (dCp / SC) * (dHp / SH),
  );
}

const deltaE = (c1, c2) => ciede2000(labOf(c1), labOf(c2));

// Every unordered pair, worst (closest) first. n colours -> n(n-1)/2 entries.
function pairwise(colors) {
  const labs = colors.map((c) => labOf(c.color !== undefined ? c.color : c));
  const out = [];
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      out.push({ i, j, a: colors[i], b: colors[j], dE: ciede2000(labs[i], labs[j]) });
    }
  }
  return out.sort((x, y) => x.dE - y.dE);
}

// Contrast against the panel the swatches sit on — a colour can be distinct from its 23 peers and
// still be unreadable on the background, which is a different failure.
function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(parseColor(c1)), l2 = relativeLuminance(parseColor(c2));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

module.exports = { parseColor, hslToRgb, toHex, rgbToLab, labOf, labToRgb, labToLch, lchToLab, ciede2000, deltaE, pairwise, relativeLuminance, contrastRatio };
