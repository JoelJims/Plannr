// Field borders as the browser draws them, for the UI suites. WCAG 1.4.11: the border that marks a
// field out needs 3:1 against the colours on both sides of it, the field's own background inside and
// the colour behind the field outside.
//
// test/ws2b-contrast.test.js measures the same thing from the CSS source. That cannot see a rule that
// never matches (a field outside the container its selector names), a later rule that wins, or a
// field left to the browser's own control. This reads the rendered page instead: the computed border
// of every side, the field's computed background and the computed backgrounds behind it.
// The maths is the same as there: sRGB relative luminance, ratio = (L1 + 0.05) / (L2 + 0.05), and a
// translucent colour is laid over what is under it before it is measured.
// Background images are not counted (the page's amber glow, a select's arrow): the source test
// already checks every field border against the brightest point of the glow.

const UI_MIN = 3; // WCAG 2.2 SC 1.4.11 Non-text Contrast: 3:1 for the visual boundary of a control

function parseRgba(s) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not an rgb() / rgba() colour: ${s}`);
  const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}
const over = (top, base) => [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3])).concat(1);
const channel = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function ratio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const sameColour = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < (i === 3 ? 0.01 : 0.5));

// Runs in the page: every rendered element matching `selector`, with what the measurement needs.
// The layers behind an element are its ancestors' background colours, nearest first, up to the first
// opaque one (the body always is).
function readFields(selector) {
  return [...document.querySelectorAll(selector)]
    .filter((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden')
    .map((e) => {
      const cs = getComputedStyle(e);
      const behind = [];
      for (let a = e.parentElement; a; a = a.parentElement) {
        const bg = getComputedStyle(a).backgroundColor;
        if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
        behind.push(bg);
        if (/^rgb\(/.test(bg)) break;
      }
      return {
        name: e.id ? `#${e.id}` : e.classList.length ? `${e.tagName.toLowerCase()}${[...e.classList].map((c) => '.' + c).join('')}`
          : `${e.tagName.toLowerCase()}[aria-label="${e.getAttribute('aria-label') || ''}"]`,
        tag: e.tagName.toLowerCase(),
        type: e.type || '',
        appearance: cs.getPropertyValue('appearance'),
        background: cs.backgroundColor,
        behind,
        sides: ['top', 'right', 'bottom', 'left'].map((side) => ({
          side,
          style: cs.getPropertyValue(`border-${side}-style`),
          width: parseFloat(cs.getPropertyValue(`border-${side}-width`)) || 0,
          color: cs.getPropertyValue(`border-${side}-color`),
        })),
        fieldBorderToken: getComputedStyle(document.documentElement).getPropertyValue('--field-border').trim(),
      };
    });
}

/** The rendered fields matching `selector` on `page` (see readFields). */
const fieldsOn = (page, selector) => page.evaluate(readFields, selector);

/**
 * How well a field's border stands out: the lowest ratio over its four sides, each side measured
 * against the field's own background and against the colour behind it. A side with no border
 * (style none or hidden, or no width) counts as 1:1. `detail` names every number, for the check's label.
 */
function borderContrast(f) {
  if (!f.behind.length || parseRgba(f.behind[f.behind.length - 1])[3] < 1) {
    return { min: 0, detail: `${f.name}: nothing opaque behind it to measure against` };
  }
  const behind = f.behind.map(parseRgba).reverse().reduce((base, layer) => over(layer, base));
  const own = over(parseRgba(f.background), behind);
  let min = Infinity;
  const parts = f.sides.map((s) => {
    if (s.style === 'none' || s.style === 'hidden' || !(s.width > 0)) { min = Math.min(min, 1); return `${s.side}: no border`; }
    const colour = over(parseRgba(s.color), own);
    const inside = ratio(colour, own), outside = ratio(colour, behind);
    min = Math.min(min, inside, outside);
    return `${s.side} ${s.width}px ${inside.toFixed(2)}:1 inside, ${outside.toFixed(2)}:1 outside`;
  });
  return { min, detail: `${f.name}: lowest ${min.toFixed(2)}:1 (${parts.join('; ')})` };
}

/** Whether every side's border colour is the --field-border colour (the shared field border). */
function usesFieldBorder(f) {
  if (!f.fieldBorderToken) return false;
  const token = parseRgba(f.fieldBorderToken);
  return f.sides.every((s) => s.style === 'solid' && s.width >= 1 && sameColour(parseRgba(s.color), token));
}

module.exports = { UI_MIN, parseRgba, over, ratio, fieldsOn, borderContrast, usesFieldBorder, sameColour };
