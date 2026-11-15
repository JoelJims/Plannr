// Offline-first (owner's decision, 2026-11-15): Plannr keeps Android's INTERNET permission, but
// logging, editing, backups and PDF creation must never need the network. run-tests.js runs this
// file against server.js AND against the phone's public/local-api.js.
// - The app's own files make no request to anywhere outside the app.
// - The PDF page needs nothing from outside (inline styles and drawings only).
// - The core actions work with NO connection: a tripwire refuses every connection to a host that is
//   not this computer, and records it; on the phone target, anything the phone code sends past its
//   /api router (which on a phone would go to the network) is recorded too.
// The same is checked in a real browser, page by page, by test-ui/offline.js. Rule for any future
// online feature: CONTRIBUTING.md, "Offline first".
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { FILES: SHARED_MODULES } = require('../sync-public-modules');

const ROOT = path.join(__dirname, '..');

// ---- the tripwire: no connection to anywhere but this computer ----
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/i;
const attempts = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = first && typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  const host = opts.path ? null : (opts.host || 'localhost');
  if (host && !LOOPBACK.test(host)) {
    attempts.push(`${host}:${opts.port}`);
    process.nextTick(() => this.destroy(new Error(`no connection (offline test): ${host}`)));
    return this;
  }
  return realConnect.apply(this, args);
};
const outside = () => [...attempts, ...H.outsideRequests()];

before(async () => { await H.startApp(); H.seedLoggedIn(); });
after(async () => { net.Socket.prototype.connect = realConnect; await H.stopApp(); });

test('self-check: the tripwire refuses and records a connection to the outside', async () => {
  await assert.rejects(fetch('http://example.com/offline-self-check'));
  assert.deepStrictEqual(attempts, ['example.com:80']);
  attempts.length = 0;
});

// ---- the app's own files ----
// Request-making references only: a URL in a comment or an SVG namespace is not a request.
const REQUESTS = [
  [/\b(?:src|href|action|poster)\s*=\s*["']https?:\/\/(?!localhost[/:"'])/i, 'src/href to an outside URL'],
  [/url\(\s*["']?https?:\/\//i, 'CSS url() to an outside URL'],
  [/@import\s+(?:url\()?\s*["']?https?:\/\//i, 'CSS @import from outside'],
  [/\bfetch\(\s*["'`]https?:\/\//i, 'fetch() of an outside URL'],
  [/\bimport\s*\(\s*["'`]https?:\/\/|\bfrom\s+["'`]https?:\/\//i, 'a module imported from outside'],
  [/"imports"\s*:\s*\{[^}]*https?:\/\//, 'an import map entry pointing outside'],
  [/\bnew\s+(?:WebSocket|EventSource)\s*\(|\bsendBeacon\s*\(|\bXMLHttpRequest\b/, 'a socket, beacon or XMLHttpRequest'],
];

test('no app file makes a request to anywhere outside the app', () => {
  // Every tracked page, script and style in public/ (the third-party three.js in public/vendor/ only
  // loads what pixelblast.js asks it to), plus the shared modules copied into public/ at build time.
  const tracked = execFileSync('git', ['ls-files', 'public'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter((f) => /\.(html|js|mjs|css)$/.test(f) && !f.startsWith('public/vendor/'));
  const files = [...tracked, ...SHARED_MODULES];
  assert.ok(files.length >= 20, `expected the app's files, found ${files.length}`);
  const bad = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const [re, what] of REQUESTS) if (re.test(text)) bad.push(`${f}: ${what}`);
  }
  assert.deepStrictEqual(bad, []);
});

test('the PDF page needs nothing from outside (every part, both themes)', async () => {
  H.seedCashOut({ txDate: '2026-07-12', amountPaise: 111100 });
  for (const part of ['full', 'pie', 'table', 'ledger']) {
    for (const theme of ['light', 'dark']) {
      const html = (await H.pdfHtml({ part, theme })).replace(/xmlns(?::\w+)?="http:\/\/www\.w3\.org\/[^"]*"/g, '');
      const found = [/https?:\/\/[^\s"'<>)]+/gi, /<link\b/gi, /<script\b/gi, /<img\b/gi, /@import\b/gi, /url\(\s*(?!["']?(?:data:|#))/gi]
        .flatMap((re) => html.match(re) || []);
      assert.deepStrictEqual(found, [], `${part}/${theme}`);
    }
  }
});

// ---- the core actions, with no connection ----
test('logging, editing, deleting, backups and the PDF all work with no connection', async () => {
  attempts.length = 0;
  const added = await H.post('/api/cash-in', { amountRupees: '1234', txDate: '2026-07-01', byType: 'relative', byLabel: 'Father', reason: 'offline' });
  assert.strictEqual(added.status, 201, JSON.stringify(added.json));
  const id = added.json.id ?? added.json.entry?.id;
  assert.ok(Number.isInteger(id), JSON.stringify(added.json));
  const edited = await H.put(`/api/cash-in/${id}`, { amountRupees: '2345', txDate: '2026-07-01', byType: 'relative', byLabel: 'Father', reason: 'offline' });
  assert.strictEqual(edited.status, 200, JSON.stringify(edited.json));
  const out = await H.post('/api/cash-out', { amountRupees: '500', txDate: '2026-07-02', byType: 'custom', byLabel: 'Shop', ledgerCode: '1.0', contractScope: 'extra' });
  assert.strictEqual(out.status, 201, JSON.stringify(out.json));
  assert.strictEqual((await H.del(`/api/cash-in/${id}`)).status, 200);
  assert.strictEqual((await H.get('/api/overview')).status, 200);

  const backup = await H.get('/api/backup/export');
  assert.strictEqual(backup.status, 200);
  const restored = await H.post('/api/backup/import', backup.json);
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
  if (restored.json.snapshot) fs.rmSync(path.join(ROOT, restored.json.snapshot), { force: true });
  const enc = await H.raw('POST', '/api/backup/export-encrypted', { passphrase: 'offline-passphrase' });
  assert.strictEqual(enc.status, 200);
  assert.ok((await enc.bytes()).length > 0);
  assert.match(await H.pdfHtml({ part: 'full' }), /<h2>Transactions<\/h2>/);

  assert.deepStrictEqual(outside(), [], 'nothing may try to reach the network');
});
