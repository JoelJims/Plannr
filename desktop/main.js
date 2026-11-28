// The desktop trial's main process (docs/cross-platform-plan.md §4.4 and §5). See desktop/README.md.
//
// Pages come from public/ through a privileged app://plannr scheme; /api/* is answered in this
// process by the shared core (core-api.js) on userData/plannr.db. No HTTP server, no open port, no
// file:// pages, and every request that is not app://plannr/ is cancelled.
import { app, BrowserWindow, protocol, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePublicFile } from './paths.js';
import { windowOptions, allowRequest, lockDownContents, denyPermissions } from './security.js';
import { createDesktopApi } from './core-api.js';
import { parseSelfTest, selfTestRefusal, runSelfTest, selfTestLine } from './self-test.js';

const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');
const PRELOAD = path.join(import.meta.dirname, 'preload.cjs');

// --self-test=write|verify (self-test.js): the app drives its own window, prints one JSON line and
// quits. It is refused (before any window or database) without a test folder in PLANNR_DESKTOP_USERDATA.
const selfTestArg = parseSelfTest(process.argv);
const selfTest = selfTestArg.mode || null;
const refusal = selfTestArg.error || selfTestRefusal({ mode: selfTest, env: process.env });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};
const COMMON_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // The pages use inline scripts and an import map (as on the dev server), so script-src needs
  // 'unsafe-inline'. Nothing may load from anywhere but app://plannr.
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  // public/runtime-mode.js: this marker tells the pages to leave /api to the host, as with server.js.
  'x-plannr-dev-server': '1',
};

function servePage(request) {
  const url = new URL(request.url);
  const file = resolvePublicFile(PUBLIC_DIR, url.pathname === '/' ? '/' : url.pathname);
  let target = file;
  if (target && !path.extname(target) && fs.existsSync(`${target}.html`)) target = `${target}.html`;
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return new Response('Not found', { status: 404, headers: { ...COMMON_HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
  }
  const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const body = request.method === 'HEAD' ? null : fs.readFileSync(target);
  return new Response(body, { status: 200, headers: { ...COMMON_HEADERS, 'content-type': type } });
}

async function start() {
  const api = await createDesktopApi({ userData: app.getPath('userData') });
  app.on('will-quit', () => api.close());

  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowRequest(details.url) }));
  denyPermissions(ses);

  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'plannr') return new Response('Not found', { status: 404 });
    if (url.pathname.startsWith('/api/')) {
      const body = ['GET', 'HEAD'].includes(request.method) ? '' : await request.text();
      const a = await api.handle({ method: request.method, url: url.pathname + url.search, body });
      return new Response(request.method === 'HEAD' ? null : a.body, { status: a.status, headers: { ...COMMON_HEADERS, ...a.headers } });
    }
    return servePage(request);
  });

  // The link rules (security.js linkAction): own pages open in this window, http(s) links in the
  // system browser, everything else is blocked.
  const openExternal = (url) => shell.openExternal(url);
  app.on('web-contents-created', (_event, contents) => lockDownContents(contents, { openExternal }));

  const win = new BrowserWindow(windowOptions(PRELOAD));
  win.once('ready-to-show', () => win.show());
  await win.loadURL('app://plannr/home.html');

  if (selfTest) {
    const result = await runSelfTest({ mode: selfTest, win, userData: app.getPath('userData') });
    process.stdout.write(selfTestLine(result));
    api.close();
    app.exit(result.ok ? 0 : 1);
  }
}

if (refusal) {
  process.stdout.write(selfTestLine({ selfTest, ok: false, steps: [{ name: 'start', ok: false, detail: refusal }] }));
  app.exit(1);
} else {
  // Tests and trials run on a folder of their own, never the real userData.
  if (process.env.PLANNR_DESKTOP_USERDATA) app.setPath('userData', path.resolve(process.env.PLANNR_DESKTOP_USERDATA));

  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);

  if (!app.requestSingleInstanceLock()) {
    if (selfTest) process.stdout.write(selfTestLine({ selfTest, ok: false, steps: [{ name: 'start', ok: false, detail: 'Another copy of the app is open on this folder.' }] }));
    app.quit(); // two windows never open the same database file
  } else {
    app.on('second-instance', () => {
      const [win] = BrowserWindow.getAllWindows();
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    });
    app.on('window-all-closed', () => app.quit());
    app.whenReady().then(start).catch((e) => {
      console.error('Plannr desktop trial could not start:', e);
      if (selfTest) process.stdout.write(selfTestLine({ selfTest, ok: false, steps: [{ name: 'start', ok: false, detail: String(e && e.message) }] }));
      app.exit(1);
    });
  }
}
