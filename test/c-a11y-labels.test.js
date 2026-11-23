// Workstream C accessibility: every form control has a name a screen reader can say.
// A control is named by a <label for="its id">, a <label> around it, or aria-label / aria-labelledby.
// The checks read the files as text; they do not start the server or open a database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const CONTROL = /<(input|select|textarea)\b([^>]*)>/g;
const SKIP_TYPES = /\btype="(hidden|submit|button)"/;
const hasAria = (attrs) => /\baria-label(ledby)?=/.test(attrs);

test('public/plannr-ui.js: every control it builds has an aria-label', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'plannr-ui.js'), 'utf8')
    .split(/\r?\n/).filter((line) => !/^\s*\/\//.test(line)).join('\n'); // comments may name a tag
  const unnamed = [...src.matchAll(CONTROL)]
    .filter((m) => !SKIP_TYPES.test(m[2]) && !hasAria(m[2]))
    .map((m) => (m[2].match(/data-f="([^"]+)"/) || [, m[0].slice(0, 60)])[1]);
  assert.deepStrictEqual(unnamed, [], `controls without a name: ${unnamed.join(', ')}`);
});

// The static markup of the pages (not overview.html and data-backup.html, which other work owns;
// not <script> blocks, whose text may mention a tag). This passed before the change too: it pins it.
const PAGES = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html') && f !== 'overview.html' && f !== 'data-backup.html');
for (const page of PAGES) {
  test(`public/${page}: every control in the markup has a label`, () => {
    const src = fs.readFileSync(path.join(PUBLIC, page), 'utf8').replace(/<script\b[\s\S]*?<\/script>/g, '');
    const labelled = new Set([...src.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
    const unnamed = [];
    for (const m of src.matchAll(CONTROL)) {
      const attrs = m[2];
      if (SKIP_TYPES.test(attrs) || hasAria(attrs)) continue;
      const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
      if (id && labelled.has(id)) continue;
      const before = src.slice(0, m.index);
      if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue; // inside a <label>
      unnamed.push(id || m[0].slice(0, 60));
    }
    assert.deepStrictEqual(unnamed, [], `controls without a label: ${unnamed.join(', ')}`);
  });
}
