// Phase 2, Step 6 — the phone/desktop switch, driven in a real browser for each mode
// (npm run test:runtime-mode). public/runtime-mode.js decides who answers /api:
//   · inside the Capacitor app: ALWAYS the in-app database, and no probe request at all — even if the
//     page somehow came from the desktop dev server;
//   · in a plain browser: server.js only when its X-Plannr-Dev-Server marker is on the page;
//     local-server.js (how the app sees public/) gets the in-app database.
// "Inside the app" is simulated with window.CapacitorCustomPlatform = { name: 'android' }: Capacitor
// then reports a native platform (isNativePlatform() === true) while using its web plugin code.
const H = require('../test/helpers');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const LOCAL_PORT = 8101;
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  const serverBase = (await H.startApp()).base;
  const localBase = `http://127.0.0.1:${LOCAL_PORT}`;
  const local = spawn(process.execPath, ['local-server.js', String(LOCAL_PORT)], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch();
  const allErrors = [];

  // Open the Data page in a fresh browser profile and report the mode, the requests that actually
  // reached the network, and whether /api answered.
  async function run(base, { app }) {
    const context = await browser.newContext();
    if (app) await context.addInitScript(() => { window.CapacitorCustomPlatform = { name: 'android', plugins: {} }; });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', (e) => { errors.push(e.message); allErrors.push(`${base}${app ? ' (app)' : ''}: ${e.message}`); });
    page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
    await page.goto(`${base}/data-backup.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => import('/local-bootstrap.js'));
    const result = await page.evaluate(async () => {
      const { Capacitor } = await import('@capacitor/core');
      const r = await fetch('/api/ledgers');
      const body = await r.json();
      return { mode: window.__plannrMode, native: Capacitor.isNativePlatform(), status: r.status, ledgers: (body.ledgers || []).length };
    });
    await context.close();
    return { ...result, errors, probes: requests.filter((r) => r.startsWith('HEAD ')), apiOverNetwork: requests.filter((r) => / \/api\//.test(r)) };
  }

  try {
    let r = await run(serverBase, { app: false });
    check('browser + desktop dev server (server.js): mode is "server"', r.mode === 'server' && !r.native, JSON.stringify(r));
    check('…and /api goes to server.js over the network', r.status === 200 && r.apiOverNetwork.length > 0 && r.ledgers > 0, r.apiOverNetwork.join(', '));

    r = await run(localBase, { app: false });
    check('browser + local-server.js (how the app sees public/): mode is "local"', r.mode === 'local' && !r.native, JSON.stringify(r));
    check('…one HEAD probe for the page, and /api never touches the network', r.probes.length === 1 && r.apiOverNetwork.length === 0 && r.status === 200 && r.ledgers > 0, `probes: ${r.probes.join(', ')}; api: ${r.apiOverNetwork.join(', ')}`);

    r = await run(serverBase, { app: true });
    check('inside the app, even if the page came from server.js: mode is "local"', r.mode === 'local' && r.native, JSON.stringify(r));
    check('…no probe request at all, and /api never touches the network', r.probes.length === 0 && r.apiOverNetwork.length === 0 && r.status === 200 && r.ledgers > 0, `probes: ${r.probes.join(', ')}; api: ${r.apiOverNetwork.join(', ')}`);

    r = await run(localBase, { app: true });
    check('inside the app (local files): mode is "local", no probe', r.mode === 'local' && r.native && r.probes.length === 0 && r.apiOverNetwork.length === 0, JSON.stringify(r));

    // F2 (review 2026-11-21): inside the app, "Download CSV (for Excel)" writes every file and opens
    // ONE share sheet holding all of them. It used to click one <a download> link per file, which do
    // nothing in Android's WebView, and say "Downloading 5 CSV files". On this empty ledger there are
    // five files (the allowances file is only made when a contract has allowances). Filesystem is Capacitor's own web code
    // (IndexedDB); only Share is replaced, with a fake that records what it was asked to share.
    {
      const context = await browser.newContext();
      await context.addInitScript(() => { window.CapacitorCustomPlatform = { name: 'android', plugins: {} }; });
      await context.route('**/node_modules/@capacitor/share/dist/esm/index.js', (route) => route.fulfill({
        contentType: 'application/javascript',
        body: 'export const Share = { async share(o) { (window.__shareCalls = window.__shareCalls || []).push(o); return {}; } };',
      }));
      const page = await context.newPage();
      page.on('pageerror', (e) => allErrors.push(`csv export (app): ${e.message}`));
      const anchorDownloads = [];
      await page.exposeFunction('__plannrAnchorDownload', (name) => anchorDownloads.push(name));
      await page.addInitScript(() => {
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () { if (this.download) window.__plannrAnchorDownload(this.download); return click.call(this); };
      });
      await page.goto(`${localBase}/data-backup.html`, { waitUntil: 'networkidle' });
      await page.click('#downloadCsvBtn');
      await page.waitForFunction(() => /share sheet invoked|✗|Could not/.test(document.getElementById('csvMsg').textContent), null, { timeout: 30000 }).catch(() => {});
      const out = await page.evaluate(async () => {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        const calls = window.__shareCalls || [];
        const files = calls[0] ? calls[0].files : [];
        const sizes = [];
        for (const uri of files) {
          const name = uri.split('/').pop();
          try { sizes.push((await Filesystem.stat({ path: name, directory: Directory.Cache })).size); } catch { sizes.push(-1); }
        }
        return { calls: calls.length, files, url: calls[0] && calls[0].url, sizes, msg: document.getElementById('csvMsg').textContent };
      });
      await context.close();
      const names = out.files.map((u) => u.split('/').pop());
      const expected = ['cash-inflow', 'cash-outflow', 'loans', 'contracts', 'contractor-payments'];
      const kinds = names.map((n) => (/^plannr-([a-z-]+)-\d{4}-\d{2}-\d{2}\.csv$/.exec(n) || [])[1]);
      check('CSV export inside the app: one share sheet, holding all five CSV files', out.calls === 1 && JSON.stringify(kinds) === JSON.stringify(expected) && out.url === undefined,
        `share calls ${out.calls}; files ${names.join(', ')}; url ${out.url}; anchor downloads ${anchorDownloads.length}`);
      check('…every file was written before the sheet opened (each one has a size)', out.sizes.length === expected.length && out.sizes.every((n) => n > 0), out.sizes.join(', '));
      check('…no <a download> click (a dead end in the WebView), and the message says the sheet opened', anchorDownloads.length === 0 && /share sheet invoked with 5 files/.test(out.msg), out.msg.split('\n').slice(-1)[0]);
    }
    check('no page errors in any mode', allErrors.length === 0, allErrors.join(' | '));
  } catch (e) {
    check('suite ran to completion', false, e.stack);
  } finally {
    await browser.close();
    local.kill();
    await H.stopApp();
  }
  console.log(failures ? `✗ RUNTIME MODE SUITE FAILED (${failures})` : '✓ RUNTIME MODE SUITE PASSED');
  process.exit(failures ? 1 : 0);
})();
