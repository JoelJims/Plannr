// Phase 1 safety — the desktop server has no login, so it must not be reachable from other machines
// by accident. Covers: the Host-header allow-list (DNS rebinding), the LAN token gate, the hardening
// headers, and the refusal to start in LAN mode without a long enough PLANNR_TOKEN.
const H = require('./helpers');
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let port;
before(async () => { const { server } = await H.startApp(); port = server.address().port; });
after(async () => { await H.stopApp(); });
afterEach(() => { delete process.env.PLANNR_HOST; delete process.env.PLANNR_TOKEN; });

// fetch() won't let us forge the Host header, so use http.request directly.
function rawGet(urlPath, hostHeader) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: hostHeader } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    r.on('error', reject);
    r.end();
  });
}

test('default mode: loopback Host names are accepted', async () => {
  for (const h of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
    assert.strictEqual((await rawGet('/styles.css', h)).statusCode, 200, h);
  }
});

test('default mode: any other Host is refused with 403 (DNS rebinding)', async () => {
  for (const h of ['evil.example', `evil.example:${port}`, `192.168.1.19:${port}`, `localhost.evil.example:${port}`]) {
    assert.strictEqual((await rawGet('/api/overview', h)).statusCode, 403, h);
  }
});

test('LAN mode: a bare IPv4 Host is accepted, a domain name still is not', async () => {
  process.env.PLANNR_HOST = '0.0.0.0';
  process.env.PLANNR_TOKEN = 'x'.repeat(32);
  // These requests come from 127.0.0.1, so no token is needed — only the Host rule is exercised.
  assert.strictEqual((await rawGet('/styles.css', `192.168.1.19:${port}`)).statusCode, 200);
  assert.strictEqual((await rawGet('/styles.css', `evil.example:${port}`)).statusCode, 403);
});

test('hardening headers are on every response', async () => {
  const res = await rawGet('/styles.css', `localhost:${port}`);
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(res.headers['x-frame-options'], 'DENY');
  assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
});

// --- the token gate, driven with fake request/response objects so we can pose as another machine ---
const TOKEN = 'correct-horse-battery-staple-42';
function runGate({ remote = '192.168.1.50', host = '192.168.1.10:3000', urlPath = '/', query = {}, headers = {} } = {}) {
  process.env.PLANNR_HOST = '0.0.0.0';
  process.env.PLANNR_TOKEN = TOKEN;
  const req = { headers: { host, ...headers }, socket: { remoteAddress: remote }, query, path: urlPath };
  const out = { status: null, headers: {}, nextCalled: false, location: null };
  const res = {
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    status(c) { out.status = c; return this; },
    type() { return this; },
    send() { return this; },
    redirect(c, loc) { out.status = c; out.location = loc; },
  };
  H.app._accessGate(req, res, () => { out.nextCalled = true; });
  return out;
}

test('LAN mode: another machine without the token gets 401', () => {
  const r = runGate();
  assert.strictEqual(r.nextCalled, false);
  assert.strictEqual(r.status, 401);
});

test('LAN mode: a wrong token (Bearer, cookie or query) gets 401', () => {
  assert.strictEqual(runGate({ headers: { authorization: 'Bearer nope' } }).status, 401);
  assert.strictEqual(runGate({ headers: { cookie: 'plannr_token=nope' } }).status, 401);
  assert.strictEqual(runGate({ query: { token: TOKEN.slice(0, -1) } }).status, 401);
});

test('LAN mode: the right token by Bearer header or cookie lets the request through', () => {
  assert.strictEqual(runGate({ headers: { authorization: `Bearer ${TOKEN}` } }).nextCalled, true);
  assert.strictEqual(runGate({ headers: { cookie: `theme=dark; plannr_token=${TOKEN}` } }).nextCalled, true);
});

test('LAN mode: ?token= sets an HttpOnly SameSite=Strict cookie and redirects the token out of the URL', () => {
  const r = runGate({ urlPath: '/overview', query: { token: TOKEN } });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.location, '/overview');
  assert.match(r.headers['set-cookie'], /^plannr_token=/);
  assert.match(r.headers['set-cookie'], /HttpOnly/);
  assert.match(r.headers['set-cookie'], /SameSite=Strict/);
  // '//evil.example' as a redirect target would leave the site; it must collapse to '/'.
  assert.strictEqual(runGate({ urlPath: '//evil.example', query: { token: TOKEN } }).location, '/');
});

test('LAN mode: requests from this PC itself never need the token', () => {
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.strictEqual(runGate({ remote, host: 'localhost:3000' }).nextCalled, true, remote);
  }
});

test('accessConfig: loopback hosts are not LAN mode; anything else is', () => {
  const cfg = H.app._accessConfig;
  assert.strictEqual(cfg({}).host, '127.0.0.1');
  assert.strictEqual(cfg({}).lan, false);
  assert.strictEqual(cfg({ PLANNR_HOST: 'localhost' }).lan, false);
  assert.strictEqual(cfg({ PLANNR_HOST: '0.0.0.0' }).lan, true);
  assert.strictEqual(cfg({ PLANNR_HOST: '192.168.1.10' }).lan, true);
});

test('startup: LAN mode without a long enough PLANNR_TOKEN refuses to start', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PLANNR_HOST: '0.0.0.0', PLANNR_TOKEN: 'short', PORT: '0' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /PLANNR_TOKEN/);
});
