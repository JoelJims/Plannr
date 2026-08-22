// Response-header invariants (Phase 7D cache policy).
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let cookie;
before(async () => { await H.startApp(); cookie = H.seedLoggedIn().cookie; });
after(async () => { await H.stopApp(); });
const cc = async (p, o) => (await H.get(p, o)).headers.get('cache-control');

test('Cache-Control: app JS/CSS revalidate and are NEVER immutable', async () => {
  for (const p of ['/plannr-ui.js', '/styles.css']) {
    const v = await cc(p);
    assert.match(v, /max-age=0/, `${p} must revalidate: ${v}`);
    assert.doesNotMatch(v, /immutable/, `${p} must NOT be immutable: ${v}`);
  }
});

test('Cache-Control: HTML file and clean-URL route are no-cache', async () => {
  assert.strictEqual(await cc('/overview.html', { cookie }), 'no-cache', '/overview.html (static HTML)');
  assert.strictEqual(await cc('/overview', { cookie }), 'no-cache', '/overview (clean-URL route)');
});

test('Cache-Control: only vendor/** and fonts/*.woff2 are immutable', async () => {
  for (const p of ['/vendor/three/three.module.js', '/fonts/rajdhani-600.woff2']) {
    const v = await cc(p);
    assert.match(v, /immutable/, `${p} must be immutable: ${v}`);
    assert.match(v, /max-age=31536000/, `${p} must be long-lived: ${v}`);
  }
});

test('Cache-Control: /api/* carries no Cache-Control at all', async () => {
  assert.strictEqual(await cc('/api/overview', { cookie }), null, '/api/overview must have no Cache-Control');
});
