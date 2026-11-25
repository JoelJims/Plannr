// F15 (docs/security-quality-review-2026-11-21.md): the phone's fetch shim (public/local-api.js)
// read the address only from a string or input.url, and only when it started with "/api/". A URL
// object crashed it, and an absolute address on the page's own origin went to the network instead.
// Phone code only (run-tests.js pass 2).
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const phone = H.TARGET === 'shim';
before(async () => { if (phone) await H.startApp(); });
after(() => { if (phone) H.stopApp(); });

test('F15: the fetch shim takes a URL object and an absolute same-origin address', { skip: !phone && 'phone code only (pass 2)' }, async () => {
  const origin = globalThis.window.location.origin;
  const byUrl = await globalThis.window.fetch(new URL('/api/storage', origin));
  assert.strictEqual(byUrl.status, 200);
  const absolute = await globalThis.window.fetch(`${origin}/api/storage`);
  assert.strictEqual(absolute.status, 200);
  await assert.rejects(globalThis.window.fetch('https://example.invalid/api/storage'), /not an \/api request/);
});
