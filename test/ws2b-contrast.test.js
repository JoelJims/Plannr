// WCAG 2.2 AA colour contrast for the text and backgrounds the app actually uses.
//
// The colours are read from the shipped CSS (public/styles.css and the inline <style> of the pages
// listed below), not copied into this file, so a colour change there is measured here.
// Bars: 4.5:1 for normal text, 3:1 for large text and for the parts of a control you need to see
// (WCAG 1.4.3 and 1.4.11). Ratio = (L1 + 0.05) / (L2 + 0.05) with the sRGB relative luminance.
// A translucent background is laid over the surface it sits on before it is measured.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const CSS = read('styles.css');

// ---- colour maths -------------------------------------------------------------------------------
function parseColour(s) {
  s = s.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(`not a colour: ${s}`);
}
const over = (top, base) => [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3])).concat(1);
const channel = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function ratio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ---- reading the CSS ----------------------------------------------------------------------------
const ROOT = {};
for (const m of /:root\s*\{([^}]*)\}/.exec(CSS)[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) ROOT[m[1]] = m[2].trim();

function resolve(value) {
  const v = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!v) return value.trim();
  assert.ok(ROOT[v[1]], `${v[1]} is defined in :root`);
  return resolve(ROOT[v[1]]);
}
// The value of `prop` in the rule whose selector is exactly `selector` (the last such rule wins).
function decl(source, selector, prop) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [...source.matchAll(new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.ok(rules.length, `rule "${selector}" exists`);
  let found;
  for (const r of rules) {
    const d = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(r[1]);
    if (d) found = d[1];
  }
  assert.ok(found, `"${selector}" sets ${prop}`);
  return resolve(found);
}
const c = (value) => parseColour(resolve(value));

const BG = c('var(--bg)');
const PANEL = c('var(--panel)');
const PANEL2 = c('var(--panel-2)');
const ACCENT_SOFT_ON_PANEL = over(c('var(--accent-soft)'), PANEL);

// [what, foreground, background, minimum]
const TEXT = 4.5, LARGE = 3, UI = 3;
const PAIRS = [
  ['body text on the page', c(decl(CSS, 'body', 'color')), BG, TEXT],
  ['body text on a panel', c('var(--text)'), PANEL, TEXT],
  ['dim text on a panel', c('var(--text-dim)'), PANEL, TEXT],
  ['dim text in a field', c('var(--text-dim)'), PANEL2, TEXT],
  ['faint text on the page', c('var(--text-faint)'), BG, TEXT],
  ['faint text on a panel', c('var(--text-faint)'), PANEL, TEXT],
  ['placeholder text in a field', c(decl(CSS, 'input::placeholder, textarea::placeholder', 'color')), PANEL2, TEXT],
  ['amber text on a panel', c('var(--accent)'), PANEL, TEXT],
  ['primary button text', c(decl(CSS, '.btn.primary', 'color')), c(decl(CSS, '.btn.primary', 'background')), LARGE],
  ['primary button text, hovered', c(decl(CSS, '.btn.primary', 'color')), c(decl(CSS, '.btn.primary:hover', 'background')), LARGE],
  ['ghost button text', c(decl(CSS, '.btn.ghost', 'color')), c(decl(CSS, '.btn.ghost', 'background')), LARGE],
  ['ghost button text, hovered', c(decl(CSS, '.btn.ghost:hover', 'color')), c(decl(CSS, '.btn.ghost:hover', 'background')), LARGE],
  ['error message text', c(decl(CSS, '.msg.error', 'color')), over(c(decl(CSS, '.msg.error', 'background')), PANEL), TEXT],
  ['success message text', c(decl(CSS, '.msg.success', 'color')), over(c(decl(CSS, '.msg.success', 'background')), PANEL), TEXT],
  ['row error text', c(decl(CSS, '.tx-rowmsg', 'color')), over(c(decl(CSS, '.tx-table tr.tx-err td', 'background')), PANEL), TEXT],
  ['filter chip text', c(decl(CSS, '.plf-chip', 'color')), over(c(decl(CSS, '.plf-chip', 'background')), PANEL), TEXT],
  ['dropdown option text', c('var(--text)'), c(decl(CSS, '.plf-sel option', 'background')), TEXT],
  ['overdue payment text', c(decl(CSS, '.ov-up-overdue .ov-up-when', 'color')), ACCENT_SOFT_ON_PANEL, TEXT],
  // .av-ua (the device line, 12px) sits inside .av-item.av-current, whose background is --accent-soft.
  ['device line on the current sign-in', c(decl(CSS, '.av-ua', 'color')), over(c(decl(CSS, '.av-item.av-current', 'background')), PANEL), TEXT],
  ['focused field outline', c(decl(CSS, 'input:focus,\ntextarea:focus', 'border-color')), PANEL2, UI],
];

// The PDF / share buttons on the ledger pages: dark text on the amber button.
for (const [page, sel] of [['contract-details.html', '.cd-pdf'], ['cash-outflow.html', '.co-pdf'], ['contractor-payments.html', '.cp-pdf']]) {
  const src = read(page);
  PAIRS.push([`${page} ${sel} text`, c(decl(src, sel, 'color')), c(decl(src, sel, 'background')), TEXT]);
}
// Amber hover text on the soft amber hover background of the small row buttons.
for (const [page, sel] of [['cash-inflow.html', '.ci-btn-sm'], ['cash-outflow.html', '.co-btn-sm'], ['contractor-payments.html', '.cp-btn-sm'], ['loan-details.html', '.ld-btn-sm']]) {
  const src = read(page);
  PAIRS.push([`${page} ${sel}:hover text`, c(decl(src, `${sel}:hover`, 'color')), over(c('var(--accent-soft)'), PANEL2), TEXT]);
  PAIRS.push([`${page} ${sel}.${sel.slice(1, 3)}-del:hover text`, c(decl(src, `${sel}.${sel.slice(1, 3)}-del:hover`, 'color')), over(c('var(--accent-soft)'), PANEL2), TEXT]);
}

for (const [what, fg, bg, min] of PAIRS) {
  test(`contrast: ${what} >= ${min}:1`, () => {
    const r = ratio(fg, bg);
    assert.ok(r >= min, `${what}: measured ${r.toFixed(2)}:1, needs ${min}:1`);
  });
}

// The resting border of a text field is the only thing that marks the field out (WCAG 1.4.11 asks
// 3:1 against the colours on both sides of it). Owner's decision: a field border colour of its own
// that meets 3:1; --line-strong (panel and card borders) stays as it is.
// The border is drawn over the field's own background, so it is laid over that first.
// Surfaces fields sit on: their own background; a panel, card or dialog (--panel), which is also
// lighter than the plain --bg page (no field sits on the page itself: every form is in a card);
// the Overview card, which is translucent, over the brightest point of the page behind it
// (the amber glow with the grid lines crossing on top); and an edit-table row marked with an error.
// Every field is checked against every one of them, so a field that moves is still covered.
const PAGE_BRIGHTEST = [...decl(CSS, 'body', 'background-image').matchAll(/rgba?\([^)]*\)/g)]
  .map((m) => parseColour(m[0])).reverse().reduce((base, layer) => over(layer, base), BG);
const OV_CARD = over(c(decl(read('overview.html'), '.ov-card', 'background')), PAGE_BRIGHTEST);
const ERROR_ROW = c(decl(CSS, '.tx-table tr.tx-err td', 'background'));
const FIELDS = [
  ['text field and textarea', 'input[type="text"],\ninput[type="password"],\ntextarea'],
  ['edit-table field', '.tx-in, .tx-sel'],
  ['filter-bar field', '.plf-in, .plf-sel'],
  ['ledger picker search box', '.lb-search'],
  ['ledger picker button (it stands in for the ledger <select>)', '.lb-trigger'],
];
for (const [what, sel] of FIELDS) {
  const own = c(decl(CSS, sel, 'background'));
  const surfaces = [
    ["the field's own background", own],
    ['a panel, card or dialog', PANEL],
    ['the Overview card over the brightest page', OV_CARD],
    ['an error row on a card', over(ERROR_ROW, PANEL)],
    ['an error row on the Overview card', over(ERROR_ROW, OV_CARD)],
  ];
  for (const [where, surface] of surfaces) {
    test(`contrast: resting ${what} border against ${where} >= ${UI}:1`, () => {
      const border = over(c(decl(CSS, sel, 'border').split(' ').slice(2).join(' ')), own);
      const r = ratio(border, surface);
      assert.ok(r >= UI, `${what} border against ${where}: measured ${r.toFixed(2)}:1, needs ${UI}:1`);
    });
  }
}

test('ratio maths matches known WCAG values', () => {
  assert.strictEqual(ratio([0, 0, 0], [255, 255, 255]).toFixed(2), '21.00');
  assert.strictEqual(ratio([119, 119, 119], [255, 255, 255]).toFixed(2), '4.48');
});

// The pages' own <style> blocks style some fields too (a textarea, number inputs, selects, a time
// input). Every resting field border there must meet the same 3:1 as the shared field rules above,
// against the field's own background, a panel and the Overview card. Read from every page, so a
// field rule added later is checked as well. A selector counts as a field when it names input,
// select or textarea, or a class the page puts on one of them. :focus, :hover, :disabled and option
// rules are not resting borders; checkboxes and radios are not text fields.
const FIELD_SEL = /(^|[\s>+~(])(input|select|textarea)(?![\w-])/;
const NOT_RESTING = /:focus|:hover|:active|:disabled|::|\boption\b|type="(checkbox|radio)"/;
const COLOUR = /var\(--[\w-]+\)|rgba?\([^)]*\)|#[0-9a-f]{3,6}\b/i;
const fieldClasses = (html) => new Set([...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
const lastCompound = (sel) => sel.split(/[\s>+~]+/).pop();
const PAGE_FIELD_RULES = [];
for (const page of fs.readdirSync(path.join(__dirname, '..', 'public')).filter((f) => f.endsWith('.html')).sort()) {
  const html = read(page);
  const classes = fieldClasses(html);
  const isField = (s) => FIELD_SEL.test(s) || [...lastCompound(s).matchAll(/\.([\w-]+)/g)].some((m) => classes.has(m[1]));
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selText, body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const fieldSels = selText.split(',').map((s) => s.trim()).filter((s) => isField(s) && !NOT_RESTING.test(s));
    if (!fieldSels.length) continue;
    for (const [, prop, value] of body.matchAll(/(?:^|;|\s)(border|border-color)\s*:\s*([^;]+)/g)) {
      const colour = COLOUR.exec(value);
      if (!colour) continue;
      const bgDecl = /(?:^|;|\s)background(?:-color)?\s*:\s*(var\(--[\w-]+\)|rgba?\([^)]*\)|#[0-9a-f]{3,6})/i.exec(body);
      PAGE_FIELD_RULES.push({ page, sel: fieldSels.join(', '), prop, colour: colour[0], own: bgDecl ? c(bgDecl[1]) : PANEL2 });
    }
  }
}
test('page field rules are found (the scan is not empty)', () => {
  assert.ok(PAGE_FIELD_RULES.length >= 10, `found ${PAGE_FIELD_RULES.length} page field border rules`);
});
for (const { page, sel, prop, colour, own } of PAGE_FIELD_RULES) {
  for (const [where, surface] of [["the field's own background", own], ['a panel, card or dialog', PANEL], ['the Overview card over the brightest page', OV_CARD]]) {
    test(`contrast: ${page} "${sel}" resting ${prop} against ${where} >= ${UI}:1`, () => {
      const r = ratio(over(c(colour), own), surface);
      assert.ok(r >= UI, `${page} "${sel}" ${prop} ${colour} against ${where}: measured ${r.toFixed(2)}:1, needs ${UI}:1`);
    });
  }
}
