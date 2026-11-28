// The desktop trial (desktop/, docs/cross-platform-plan.md §4.4 and §5). These tests run WITHOUT
// Electron: the main-process parts are plain modules, and the preload runs in a vm with a fake
// `electron`. What they check: the database file survives a restart, the protocol path check, the
// preload surface, the window's security options, the request and navigation blocks, and that the
// main process has no way to reach the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const importDesktop = (name) => import(require('node:url').pathToFileURL(path.join(DESKTOP, name)).href);

// One child process = one app run: it opens the database through the desktop's in-process API,
// runs the requests and prints the answers. Two runs on the same folder = a restart.
function runApi(userData, requests) {
  const script = `
    const { createDesktopApi } = await import(${JSON.stringify(require('node:url').pathToFileURL(path.join(DESKTOP, 'core-api.js')).href)});
    const api = await createDesktopApi({ userData: process.env.T_USERDATA });
    const out = [];
    for (const r of JSON.parse(process.env.T_REQUESTS)) {
      const a = await api.handle(r);
      out.push({ status: a.status, body: JSON.parse(Buffer.from(a.body).toString('utf8')) });
    }
    api.close();
    process.stdout.write(JSON.stringify(out));
  `;
  const env = { ...process.env, T_USERDATA: userData, T_REQUESTS: JSON.stringify(requests), PLANNR_TEST: '1' };
  delete env.PLANNR_DB;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('desktop database: a file in userData; an entry written in one run is read back after a restart', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-desktop-'));
  try {
    const entry = { amountRupees: '1250', bankName: 'desktop trial bank', interestRate: '8.5', tenure: '12 months' };
    const first = runApi(userData, [
      { method: 'POST', url: '/api/loans', body: JSON.stringify(entry) },
      { method: 'GET', url: '/api/loans' },
    ]);
    assert.ok(first[0].status >= 200 && first[0].status < 300, JSON.stringify(first[0]));
    assert.ok(fs.existsSync(path.join(userData, 'plannr.db')), 'the database file is userData/plannr.db');
    const second = runApi(userData, [{ method: 'GET', url: '/api/loans' }]);
    assert.equal(second[0].status, 200);
    assert.deepEqual(second[0].body, first[1].body, 'the list after a restart equals the list before it');
    assert.match(JSON.stringify(second[0].body), /desktop trial/);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('desktop api: an unknown route answers 404 as JSON, a bad body 400, nothing throws', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-desktop-'));
  try {
    const [missing, bad] = runApi(userData, [
      { method: 'GET', url: '/api/no-such-route' },
      { method: 'POST', url: '/api/loans', body: '"not an object"' },
    ]);
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /Not found/);
    assert.equal(bad.status, 400);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('protocol path check: serves files inside public/ only', async () => {
  const { resolvePublicFile } = await importDesktop('paths.js');
  const pub = path.join(ROOT, 'public');
  assert.equal(resolvePublicFile(pub, '/'), path.join(pub, 'home.html'));
  assert.equal(resolvePublicFile(pub, '/styles.css'), path.join(pub, 'styles.css'));
  assert.equal(resolvePublicFile(pub, '/cash-flow.html'), path.join(pub, 'cash-flow.html'));
  for (const bad of ['/../package.json', '/%2e%2e/package.json', '/a/../../db.js', '/..%2fdb.js', '/..\\db.js',
    '//server/share/x', '/C:/Windows/win.ini', '/c:\\x', '/%00', '/a%5c..%5c..%5cdb.js', '/%E0%A4%A']) {
    assert.equal(resolvePublicFile(pub, bad), null, `refused: ${bad}`);
  }
});

test('preload: exposes exactly one object, window.plannrDesktop, with only the allowed keys', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'preload.cjs'), 'utf8');
  const exposed = [];
  const fakeElectron = { contextBridge: { exposeInMainWorld: (name, value) => exposed.push([name, value]) } };
  const sandboxRequire = (m) => { if (m === 'electron') return fakeElectron; throw new Error(`preload may not require ${m}`); };
  vm.runInNewContext(src, { require: sandboxRequire, module: { exports: {} }, exports: {} });
  assert.equal(exposed.length, 1);
  assert.equal(exposed[0][0], 'plannrDesktop');
  assert.deepEqual(Object.keys(exposed[0][1]).sort(), ['runtime']);
  assert.equal(exposed[0][1].runtime, 'desktop');
  assert.ok(Object.isFrozen(exposed[0][1]));
  assert.doesNotMatch(src, /ipcRenderer|require\((?!'electron')/, 'no IPC and no other module in the trial preload');
});

test('window: the security options are set explicitly', async () => {
  const { windowOptions } = await importDesktop('security.js');
  const o = windowOptions('/x/preload.cjs');
  assert.deepEqual(
    { ...o.webPreferences },
    { preload: '/x/preload.cjs', contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, allowRunningInsecureContent: false },
  );
});

test('requests and navigation: only app: loads, outside navigation and new windows are refused, permissions denied', async () => {
  const { allowRequest, lockDownContents, denyPermissions } = await importDesktop('security.js');
  for (const url of ['app://plannr/home.html', 'app://plannr/api/cash-in']) assert.equal(allowRequest(url), true, url);
  for (const url of ['http://127.0.0.1:3000/', 'https://example.com/', 'file:///C:/x', 'ws://x', 'data:text/html,x', 'devtools://x', 'blob:app://plannr/1', 'appx://plannr/']) {
    assert.equal(allowRequest(url), false, url);
  }
  // The link rules in full are in test/desktop-links.test.js.
  const handlers = {};
  let openHandler;
  lockDownContents({ on: (ev, fn) => { handlers[ev] = fn; }, setWindowOpenHandler: (fn) => { openHandler = fn; } }, { openExternal: () => {} });
  let prevented = false;
  handlers['will-navigate']({ url: 'https://example.com/', preventDefault: () => { prevented = true; } }, 'https://example.com/');
  assert.ok(prevented, 'will-navigate to an outside address is stopped');
  assert.deepEqual(openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  let permissionAnswer;
  let checkAnswer;
  denyPermissions({
    setPermissionRequestHandler: (fn) => fn(null, 'media', (ok) => { permissionAnswer = ok; }),
    setPermissionCheckHandler: (fn) => { checkAnswer = fn(null, 'geolocation'); },
  });
  assert.equal(permissionAnswer, false);
  assert.equal(checkAnswer, false);
});

test('main process: no network code and no open port (source check)', () => {
  const files = ['main.js', 'core-api.js', 'paths.js', 'security.js', 'preload.cjs'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(DESKTOP, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]/, `${f} imports a network module`);
    assert.doesNotMatch(src, /\bfetch\s*\(/, `${f} calls fetch`);
    assert.doesNotMatch(src, /\blisten\s*\(/, `${f} opens a port`);
    assert.doesNotMatch(src, /\bnet\s*[,}]|\bnet\.request|file:\/\/|loadFile\s*\(/, `${f} uses Electron's net or file://`);
  }
  const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  assert.match(main, /registerSchemesAsPrivileged/);
  assert.match(main, /protocol\.handle\(\s*['"]app['"]/);
  assert.match(main, /onBeforeRequest/);
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /PLANNR_DESKTOP_USERDATA/);
  assert.match(main, /loadURL\(\s*['"]app:\/\/plannr\//);
});
