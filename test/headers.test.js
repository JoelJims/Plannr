// Response-header invariants (Phase 7D cache policy + Phase 8C CSP). Report-only mode yields zero CSP
// violations too, so asserting the ENFORCING header name here is what the visual "0 violations" check
// can't distinguish.
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

test('CSP: enforcing header (not report-only) on HTML + clean-URL; none on /api/*', async () => {
  const html = await H.get('/login.html');
  assert.ok(html.headers.get('content-security-policy'), '/login.html must carry Content-Security-Policy');
  assert.strictEqual(html.headers.get('content-security-policy-report-only'), null, '/login.html must NOT be report-only');

  const clean = await H.get('/overview', { cookie });
  assert.ok(clean.headers.get('content-security-policy'), '/overview must carry Content-Security-Policy');
  assert.strictEqual(clean.headers.get('content-security-policy-report-only'), null, '/overview must NOT be report-only');

  const api = await H.get('/api/overview', { cookie });
  assert.strictEqual(api.headers.get('content-security-policy'), null, '/api/* must carry no CSP');
  assert.strictEqual(api.headers.get('content-security-policy-report-only'), null, '/api/* must carry no CSP-report-only');
});
