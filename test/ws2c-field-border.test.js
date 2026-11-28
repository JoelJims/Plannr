// The "Sending PDFs" fields on Home: their resting border is the only thing that marks them out, so
// it needs 3:1 against the panel behind it (WCAG 1.4.11), like every other text field and select.
// --accent-line (the amber line) measures about 2.7:1 there. The colour is read from home.html and
// public/styles.css, not copied here. --field-border comes from the field-border change in its own
// pull request; until that is merged the rule's fallback colour is the one drawn.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const ROOT = {};
for (const m of /:root\s*\{([^}]*)\}/.exec(read('styles.css'))[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) ROOT[m[1]] = m[2].trim();

// var(--x) or var(--x, fallback): the defined value, else the fallback.
function resolve(v) {
  v = v.trim();
  const m = /^var\((--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(v);
  if (!m) return v;
  if (ROOT[m[1]]) return resolve(ROOT[m[1]]);
  assert.ok(m[2], `${m[1]} is defined in :root or has a fallback`);
  return resolve(m[2]);
}
function parseColour(s) {
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  assert.ok(m, `a colour: ${s}`);
  return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
}
const over = (top, base) => [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3])).concat(1);
const channel = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

test('Home "Sending PDFs" fields: resting border >= 3:1 against the panel', () => {
  const rule = /#shareSettings select, #shareSettings input\[type="text"\]\s*\{([^}]*)\}/.exec(read('home.html'));
  assert.ok(rule, 'the #shareSettings field rule exists');
  const border = /(?:^|;|\s)border\s*:\s*\S+\s+\S+\s+([^;]+)/.exec(rule[1]);
  assert.ok(border, 'the rule sets a border');
  const panel = parseColour(resolve('var(--panel)'));
  const r = ratio(over(parseColour(resolve(border[1])), panel), panel);
  assert.ok(r >= 3, `border ${border[1].trim()} against the panel: measured ${r.toFixed(2)}:1, needs 3:1`);
});
