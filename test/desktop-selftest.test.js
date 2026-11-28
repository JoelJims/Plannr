// The desktop trial's self-test mode (desktop/self-test.js, desktop/main.js; see desktop/README.md).
// These tests run WITHOUT Electron. main.js runs in a child process with a fake `electron` module
// (a module hook points the bare specifier 'electron' at a recording stand-in), so the tests see
// what main.js really does: whether it refuses, which window options it uses, which handlers it
// sets. The real window is checked by `node desktop/smoke.js`, not here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const importDesktop = (name) => import(pathToFileURL(path.join(DESKTOP, name)).href);

// The fake `electron`: records the calls main.js makes into the file named by T_RECORD.
// executeJavaScript answers undefined, so a self-test under it fails at its first page step.
// Like Electron, a new window's contents go to the app's 'web-contents-created' handlers. With
// T_LINK set, the page "clicks" a link to T_LINK once the first page has loaded: the stand-in calls
// the will-navigate handlers and records whether the navigation was stopped, and shell.openExternal
// records what it was asked to open.
const FAKE_ELECTRON = `
import fs from 'node:fs';
const rec = { setPath: [], windows: [], loaded: [], executed: 0, handlers: [], commandLine: [], exitCode: null,
  navigations: [], shellOpened: [] };
const save = () => fs.writeFileSync(process.env.T_RECORD, JSON.stringify(rec));
let userData = process.env.T_DEFAULT_USERDATA;
const appHandlers = {};
save();
export const shell = {
  async openExternal(url) { rec.shellOpened.push(url); save(); },
};
export const app = {
  setPath(k, v) { rec.setPath.push([k, v]); if (k === 'userData') userData = v; save(); },
  getPath() { return userData; },
  requestSingleInstanceLock() { return true; },
  on(event, fn) { (appHandlers[event] = appHandlers[event] || []).push(fn); },
  whenReady() { return Promise.resolve(); },
  quit() { rec.quit = true; save(); },
  exit(code) { rec.exitCode = code; save(); process.exit(code); },
  commandLine: { appendSwitch(...a) { rec.commandLine.push(a); save(); }, appendArgument(...a) { rec.commandLine.push(a); save(); } },
};
export const protocol = {
  registerSchemesAsPrivileged(s) { rec.schemes = s; save(); },
  handle(scheme) { rec.handlers.push('protocol.handle:' + scheme); save(); },
};
export const session = { defaultSession: {
  webRequest: { onBeforeRequest() { rec.handlers.push('onBeforeRequest'); save(); } },
  setPermissionRequestHandler() { rec.handlers.push('permissionRequest'); save(); },
  setPermissionCheckHandler() { rec.handlers.push('permissionCheck'); save(); },
} };
export class BrowserWindow {
  constructor(options) {
    rec.windows.push(options); save();
    const contentsHandlers = {};
    this.webContents = {
      executeJavaScript: async () => { rec.executed += 1; save(); return undefined; },
      loadURL: async (u) => { rec.loaded.push(u); save(); },
      getLastWebPreferences: () => options.webPreferences,
      on(event, fn) { (contentsHandlers[event] = contentsHandlers[event] || []).push(fn); },
      once() {}, setWindowOpenHandler() {},
    };
    this.contentsHandlers = contentsHandlers;
    for (const fn of appHandlers['web-contents-created'] || []) fn({}, this.webContents);
  }
  once() {} show() {} isMinimized() { return false; } focus() {} restore() {}
  async loadURL(u) {
    rec.loaded.push(u); save();
    if (process.env.T_LINK && rec.navigations.length === 0) {
      const url = process.env.T_LINK;
      const event = { url, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
      for (const fn of this.contentsHandlers['will-navigate'] || []) fn(event, url);
      await new Promise((resolve) => setImmediate(resolve));
      rec.navigations.push({ url, prevented: event.defaultPrevented }); save();
    }
  }
  static getAllWindows() { return []; }
}
export default { app, protocol, session, BrowserWindow, shell };
`;

function hookFiles(dir) {
  const fake = path.join(dir, 'fake-electron.mjs');
  fs.writeFileSync(fake, FAKE_ELECTRON);
  const register = path.join(dir, 'register.mjs');
  fs.writeFileSync(register, `
import { registerHooks } from 'node:module';
const FAKE = ${JSON.stringify(pathToFileURL(fake).href)};
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: FAKE, shortCircuit: true };
  return next(specifier, context);
} });
`);
  return register;
}

// One main.js run under the fake electron. `userData` = PLANNR_DESKTOP_USERDATA (undefined = unset).
// `link`: a link the page follows once the first page has loaded (see FAKE_ELECTRON).
function runMain({ args = [], userData, link } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-desktop-main-'));
  const register = hookFiles(dir);
  const record = path.join(dir, 'record.json');
  const defaultUserData = path.join(dir, 'default-userdata');
  const env = { ...process.env, T_RECORD: record, T_DEFAULT_USERDATA: defaultUserData, PLANNR_TEST: '1' };
  delete env.PLANNR_DB;
  delete env.PLANNR_DESKTOP_USERDATA;
  delete env.T_LINK;
  if (userData !== undefined) env.PLANNR_DESKTOP_USERDATA = userData;
  if (link !== undefined) env.T_LINK = link;
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(register).href, path.join(DESKTOP, 'main.js'), ...args],
    { env, encoding: 'utf8', cwd: ROOT, timeout: 60000 });
  const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('{"selfTest"'));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, rec, lines, dir, defaultUserData };
}

test('self-test arguments: --self-test=write and --self-test=verify; nothing else is a self-test', async () => {
  const { parseSelfTest } = await importDesktop('self-test.js');
  const exe = 'C:/x/electron.exe';
  assert.deepEqual(parseSelfTest([exe, 'D:/app/desktop']), { mode: null });
  assert.deepEqual(parseSelfTest([]), { mode: null });
  assert.deepEqual(parseSelfTest([exe, 'D:/app/desktop', '--self-test=write']), { mode: 'write' });
  assert.deepEqual(parseSelfTest([exe, '--self-test=verify', 'D:/app/desktop']), { mode: 'verify' });
  assert.deepEqual(parseSelfTest([exe, '--self-testing=write']), { mode: null }, 'another switch is not the self-test');
  for (const bad of [['--self-test'], ['--self-test='], ['--self-test=Write'], ['--self-test=both'], ['--self-test=write', '--self-test=verify'], ['--self-test=write', '--self-test=write']]) {
    const r = parseSelfTest([exe, ...bad]);
    assert.equal(r.mode, undefined, JSON.stringify(bad));
    assert.match(r.error, /--self-test=write or --self-test=verify/, JSON.stringify(bad));
  }
});

test('self-test refusal: only with PLANNR_DESKTOP_USERDATA set to an absolute test folder', async () => {
  const { selfTestRefusal, SELF_TEST_MARKER } = await importDesktop('self-test.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-desktop-refuse-'));
  try {
    for (const env of [{}, { PLANNR_DESKTOP_USERDATA: '' }, { PLANNR_DESKTOP_USERDATA: 'relative/folder' }]) {
      assert.match(selfTestRefusal({ mode: 'write', env }), /PLANNR_DESKTOP_USERDATA/, JSON.stringify(env));
      assert.match(selfTestRefusal({ mode: 'verify', env }), /PLANNR_DESKTOP_USERDATA/, JSON.stringify(env));
    }
    assert.equal(selfTestRefusal({ mode: null, env: {} }), null, 'a normal start is never refused here');
    // write: only a new or empty folder, so a self-test never adds an entry to real data.
    const empty = path.join(dir, 'empty');
    assert.equal(selfTestRefusal({ mode: 'write', env: { PLANNR_DESKTOP_USERDATA: empty } }), null, 'a folder that does not exist yet');
    fs.mkdirSync(empty);
    assert.equal(selfTestRefusal({ mode: 'write', env: { PLANNR_DESKTOP_USERDATA: empty } }), null, 'an empty folder');
    const used = path.join(dir, 'used');
    fs.mkdirSync(used);
    fs.writeFileSync(path.join(used, 'plannr.db'), 'x');
    assert.match(selfTestRefusal({ mode: 'write', env: { PLANNR_DESKTOP_USERDATA: used } }), /empty/);
    // verify: only a folder a write run made (it leaves the marker file).
    assert.match(selfTestRefusal({ mode: 'verify', env: { PLANNR_DESKTOP_USERDATA: used } }), /--self-test=write/);
    fs.writeFileSync(path.join(used, SELF_TEST_MARKER), '{}');
    assert.equal(selfTestRefusal({ mode: 'verify', env: { PLANNR_DESKTOP_USERDATA: used } }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main.js: --self-test without PLANNR_DESKTOP_USERDATA is refused before any window or database', () => {
  const run = runMain({ args: ['--self-test=write'] });
  try {
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.equal(run.lines.length, 1, `one JSON line: ${run.stdout}`);
    const out = JSON.parse(run.lines[0]);
    assert.equal(out.selfTest, 'write');
    assert.equal(out.ok, false);
    assert.ok(Array.isArray(out.steps) && out.steps.length >= 1);
    assert.match(JSON.stringify(out.steps), /PLANNR_DESKTOP_USERDATA/);
    assert.equal(run.rec.windows.length, 0, 'no window was opened');
    assert.deepEqual(run.rec.setPath, [], 'userData was not changed');
    assert.equal(fs.existsSync(path.join(run.defaultUserData, 'plannr.db')), false, 'no database was opened');
  } finally {
    fs.rmSync(run.dir, { recursive: true, force: true });
  }
});

test('main.js: a bad --self-test value is refused with one JSON line', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-desktop-ud-'));
  const run = runMain({ args: ['--self-test=both'], userData: path.join(tmp, 'ud') });
  try {
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.equal(run.lines.length, 1, run.stdout);
    const out = JSON.parse(run.lines[0]);
    assert.equal(out.ok, false);
    assert.match(JSON.stringify(out.steps), /--self-test=write or --self-test=verify/);
    assert.equal(run.rec.windows.length, 0);
  } finally {
    fs.rmSync(run.dir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('main.js: the self-test opens the same window with the same security options and handlers', async () => {
  const { windowOptions } = await importDesktop('security.js');
  const expected = JSON.parse(JSON.stringify(windowOptions(path.join(DESKTOP, 'preload.cjs'))));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-desktop-ud-'));
  const normal = runMain({ userData: path.join(tmp, 'normal') });
  const self = runMain({ args: ['--self-test=write'], userData: path.join(tmp, 'self') });
  try {
    assert.equal(normal.lines.length, 0, 'a normal start prints no self-test line');
    // The self-test really ran (and failed at its first page step: the fake page answers nothing).
    assert.equal(self.lines.length, 1, `the self-test printed one JSON line: ${self.stdout} ${self.stderr}`);
    const out = JSON.parse(self.lines[0]);
    assert.equal(out.selfTest, 'write');
    assert.equal(out.ok, false);
    assert.equal(self.status, 1);
    assert.ok(self.rec.executed >= 1, 'the self-test drove the page with executeJavaScript');

    assert.equal(normal.rec.windows.length, 1);
    assert.equal(self.rec.windows.length, 1, 'the self-test opens one window, the normal one');
    assert.deepEqual(normal.rec.windows[0], expected);
    assert.deepEqual(self.rec.windows[0], expected, 'the self-test window has exactly the normal security options');
    assert.deepEqual(self.rec.handlers, normal.rec.handlers, 'the same request filter, permission blocks and app: handler');
    assert.ok(self.rec.handlers.includes('onBeforeRequest'));
    assert.deepEqual(self.rec.schemes, normal.rec.schemes);
    assert.deepEqual(self.rec.commandLine, [], 'no command-line switch (no remote debugging port)');
    assert.equal(self.rec.loaded[0], 'app://plannr/home.html', 'the self-test starts on the normal first page');
  } finally {
    fs.rmSync(normal.dir, { recursive: true, force: true });
    fs.rmSync(self.dir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('main.js: an https link goes to the system browser (shell.openExternal); an own page opens in the app', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-desktop-ud-'));
  const outside = runMain({ userData: path.join(tmp, 'outside'), link: 'https://example.com/help' });
  const own = runMain({ userData: path.join(tmp, 'own'), link: 'app://plannr/cash-flow.html' });
  const blocked = runMain({ userData: path.join(tmp, 'blocked'), link: 'mailto:someone@example.com' });
  try {
    assert.deepEqual(outside.rec.navigations, [{ url: 'https://example.com/help', prevented: true }], 'the https link does not load in the window');
    assert.deepEqual(outside.rec.shellOpened, ['https://example.com/help'], 'shell.openExternal opens it in the system browser');
    assert.deepEqual(own.rec.navigations, [{ url: 'app://plannr/cash-flow.html', prevented: false }], 'the own page opens in the window');
    assert.deepEqual(own.rec.shellOpened, []);
    assert.deepEqual(blocked.rec.navigations, [{ url: 'mailto:someone@example.com', prevented: true }]);
    assert.deepEqual(blocked.rec.shellOpened, [], 'a mailto: link is blocked, not handed to the system');
  } finally {
    for (const r of [outside, own, blocked]) fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('main process: no remote debugging, no inspector, no open port, no network module (source check)', () => {
  const mainProcess = fs.readdirSync(DESKTOP)
    .filter((f) => /\.(c|m)?js$/.test(f) && f !== 'smoke.js' && f !== 'self-test-page.js');
  for (const f of ['main.js', 'self-test.js', 'security.js', 'core-api.js', 'paths.js', 'preload.cjs']) {
    assert.ok(mainProcess.includes(f), `${f} is checked`);
  }
  for (const f of mainProcess) {
    const src = fs.readFileSync(path.join(DESKTOP, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /remote-debugging|--inspect|inspector|devtools|openDevTools|\.debugger\b/i, `${f}: no remote debugging or inspector`);
    assert.doesNotMatch(src, /\blisten\s*\(/, `${f} opens a port`);
    assert.doesNotMatch(src, /['"](node:)?(http|https|http2|net|tls|dgram|dns|child_process|worker_threads)['"]/, `${f} imports a network or process module`);
    assert.doesNotMatch(src, /\bfetch\s*\(|\bnet\.request|ipcMain|appendSwitch|appendArgument/, `${f}: no fetch, net, IPC or switches`);
  }
  const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  assert.match(main, /from '\.\/self-test\.js'/, 'main.js uses the self-test module');
  assert.match(main, /new BrowserWindow\(windowOptions\(PRELOAD\)\)/, 'one window, built from windowOptions()');
  assert.equal((main.match(/new BrowserWindow\(/g) || []).length, 1, 'main.js opens exactly one window');
  const preload = fs.readFileSync(path.join(DESKTOP, 'preload.cjs'), 'utf8');
  assert.doesNotMatch(preload, /self-test|selfTest/i, 'the preload knows nothing about the self-test');
});

test('self-test page code: only same-origin /api requests and the .invalid address', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'self-test-page.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const urls = [...src.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(urls.length >= 2, `found the page's fetch calls: ${urls}`);
  for (const u of urls) assert.match(u, /^'\/api\/|^OUTSIDE$/, `fetch(${u})`);
  assert.match(src, /const OUTSIDE = 'https:\/\/plannr-selftest\.invalid\/'/);
  assert.equal((src.match(/https?:\/\//g) || []).length, 1, 'the only absolute address is the .invalid one');
  const selfTest = fs.readFileSync(path.join(DESKTOP, 'self-test.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const m of selfTest.matchAll(/https?:\/\/[^'"`\s]*/g)) assert.equal(m[0], 'https://plannr-selftest.invalid/', `self-test.js address ${m[0]}`);
});
