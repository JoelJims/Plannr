// Phase 2, Step 6 — the phone/desktop switch (public/runtime-mode.js) and the desktop server being a
// dev-only tool. Inside the Capacitor app the mode is ALWAYS local with no probe; in a browser it is
// 'server' only when the page carries server.js's X-Plannr-Dev-Server marker. The same switch is
// driven in a real browser for each mode in test-ui/runtime-mode.js.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const load = () => import('../public/runtime-mode.js');
const headers = (obj) => new Headers(obj);

let base;
before(async () => { ({ base } = await H.startApp()); });
after(async () => { await H.stopApp(); });

test('decideMode: inside the app it is always local, whatever the page says', async () => {
  const { decideMode } = await load();
  assert.strictEqual(decideMode({ isNative: true, probeHeaders: headers({ 'X-Plannr-Dev-Server': '1', ETag: 'W/"1"' }) }), 'local');
  assert.strictEqual(decideMode({ isNative: true }), 'local');
});

test('decideMode: in a browser it is the dev server only with the explicit marker', async () => {
  const { decideMode } = await load();
  assert.strictEqual(decideMode({ isNative: false, probeHeaders: headers({ 'X-Plannr-Dev-Server': '1' }) }), 'server');
  assert.strictEqual(decideMode({ isNative: false, probeHeaders: headers({ ETag: 'W/"abc"' }) }), 'local', 'an ETag alone (the old switch) no longer means "server"');
  assert.strictEqual(decideMode({ isNative: false, probeHeaders: headers({ 'X-Plannr-Dev-Server': '0' }) }), 'local');
  assert.strictEqual(decideMode({ isNative: false, probeHeaders: null }), 'local', 'a failed probe means local');
});

test('detectMode: no request at all inside the app; one HEAD for the page in a browser', async () => {
  const { detectMode } = await load();
  const calls = [];
  const fetchImpl = async (p, opts) => { calls.push([p, opts.method]); return { headers: headers({ 'X-Plannr-Dev-Server': '1' }) }; };
  assert.strictEqual(await detectMode({ isNative: true, path: '/home.html', fetchImpl }), 'local');
  assert.deepStrictEqual(calls, [], 'no probe inside the app');
  assert.strictEqual(await detectMode({ isNative: false, path: '/home.html', fetchImpl }), 'server');
  assert.deepStrictEqual(calls, [['/home.html', 'HEAD']]);
  assert.strictEqual(await detectMode({ isNative: false, path: '/x', fetchImpl: async () => { throw new Error('offline'); } }), 'local');
});

test('server.js marks its pages and API answers as the dev server', async () => {
  for (const p of ['/data-backup.html', '/api/ledgers']) {
    const r = await fetch(base + p, { method: p.endsWith('.html') ? 'HEAD' : 'GET' });
    assert.strictEqual(r.headers.get('x-plannr-dev-server'), '1', p);
  }
});

// 60 s: a GitHub Windows runner took over 20 s to start server.js while the other test files ran.
function waitFor(proc, re, ms = 60000) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${re}; output so far:\n${out}`)), ms);
    proc.stdout.on('data', (d) => { out += d; if (re.test(out)) { clearTimeout(timer); resolve(out); } });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited early (${code}):\n${out}`)); });
  });
}

test('local-server.js (how the app sees public/) does not send the marker', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [path.join(ROOT, 'local-server.js'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitFor(proc, new RegExp(`:${port}`));
    const marker = await new Promise((resolve, reject) => {
      http.request({ host: '127.0.0.1', port, path: '/data-backup.html', method: 'HEAD' }, (res) => { res.resume(); resolve(res.headers['x-plannr-dev-server']); }).on('error', reject).end();
    });
    assert.strictEqual(marker, undefined);
  } finally {
    proc.removeAllListeners('exit'); proc.kill();
  }
});

test('starting server.js prints the DEV MODE banner', async () => {
  const dbPath = path.join(os.tmpdir(), `plannr-banner-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PLANNR_DB: dbPath, PLANNR_TEST: '1', PORT: String(port) },
  });
  try {
    const out = await waitFor(proc, /running at/);
    assert.match(out, /^DEV MODE – not used by the phone app$/m);
  } finally {
    proc.removeAllListeners('exit');
    const exited = proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
    proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    // Windows can keep the file locked for a moment after the process ends (EPERM/EBUSY): retry.
    for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(dbPath + s, { force: true, maxRetries: 10, retryDelay: 100 });
  }
});
