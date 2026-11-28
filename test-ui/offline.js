// Offline-first (owner's decision, 2026-11-15): Plannr keeps Android's INTERNET permission, but the
// core of the app must never need the network. This suite drives the phone setup in a real browser
// with NO connection:
// - local-server.js serves public/ the way the APK's in-app loader does, and the database is the
//   in-browser one (the same code as on the phone), starting empty like a fresh install;
// - every request that does not go to the app's own origin is blocked and recorded;
// - the page is told it is offline (navigator.onLine is false).
// Then it opens every page; logs, edits and deletes an entry through the real Cash Inflow form;
// downloads both backups from Data Backup; and presses the PDF button. It fails on any request to
// anywhere outside the app, and on any console or page error (all but sqlite-wasm's own fallback
// note: see test-ui/_console-errors.js).
// (The PDF itself is drawn by the phone's print plugin, which a browser does not have; the PDF page's
// HTML is checked for outside references in test/offline.test.js, on the phone code too.)
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');
// Every console/page error except sqlite-wasm's own two-line fallback note (review finding F7).
const { attachErrorCollector } = require('./_console-errors');

const ROOT = path.join(__dirname, '..');
const PORT = 8197;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGES = ['home.html', 'cash-flow.html', 'cash-inflow.html', 'cash-outflow.html', 'loan-details.html',
  'contractor-payments.html', 'contract-details.html', 'overview.html', 'data-backup.html'];

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['local-server.js', String(PORT)], { cwd: ROOT });
    let started = false;
    proc.stdout.on('data', (d) => { if (!started && d.toString().includes('http://127.0.0.1')) { started = true; resolve(proc); } });
    proc.stderr.on('data', (d) => process.stderr.write('[local-server stderr] ' + d));
    proc.on('error', reject);
    setTimeout(() => { if (!started) { started = true; resolve(proc); } }, 1500);
  });
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1400 }, acceptDownloads: true });

  // No connection: only the app's own origin answers. Everything else is recorded and fails the way
  // a request with no network does.
  const outside = [];
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url === BASE || url.startsWith(BASE + '/')) return route.continue();
    outside.push(url);
    return route.abort('internetdisconnected');
  });
  ctx.on('websocket', (ws) => outside.push(ws.url()));
  await ctx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false });
  });

  const page = await ctx.newPage();
  const errors = attachErrorCollector(page);
  page.on('dialog', (d) => d.accept());
  const open = async (p) => { await page.goto(`${BASE}/${p}`, { waitUntil: 'networkidle' }); await page.waitForTimeout(300); };
  const noErrors = (label) => { check(`${label}: no console/page errors`, errors.length === 0, errors.join(' | ')); errors.length = 0; };

  try {
    check('the page sees no connection (navigator.onLine is false)', await (async () => { await open('home.html'); return page.evaluate(() => navigator.onLine === false); })());
    // Self-check: the blocker really catches a request to the outside, so the last check means something.
    const failed = await page.evaluate(() => fetch('https://example.com/offline-self-check').then(() => false, () => true));
    check('self-check: a request to the outside fails and is recorded', failed && outside.length === 1 && outside[0].includes('example.com'), outside.join(' | '));
    outside.length = 0;
    errors.length = 0;

    // ---- every page opens ----
    for (const p of PAGES) {
      await open(p);
      check(`${p} opens`, (await page.title()).length > 0 && page.url().endsWith('/' + p), page.url());
      noErrors(p);
    }

    // ---- logging, editing, deleting: the real Cash Inflow form ----
    const listText = () => page.$eval('#ciList', (el) => el.textContent);
    await open('cash-inflow.html');
    await page.fill('#amount', '1234');
    await page.fill('#reason', 'offline test');
    await page.click('#saveBtn');
    await page.waitForTimeout(500);
    check('an entry is logged with no connection', (await listText()).includes('1,234'), await page.$eval('#ciMsg', (el) => el.textContent));
    await open('cash-inflow.html');
    check('the entry is still there after reopening the page', (await listText()).includes('1,234'));
    await page.click('[data-edit]');
    await page.waitForTimeout(200);
    await page.fill('#amount', '2345');
    await page.click('#saveBtn');
    await page.click('.pl-confirm-backdrop:not([hidden]) [data-plc="ok"]'); // "Save changes?"
    await page.waitForTimeout(500);
    check('the entry is edited with no connection', (await listText()).includes('2,345') && !(await listText()).includes('1,234'), await listText());
    await page.click('[data-del]'); // a native confirm, accepted by the dialog handler above
    await page.waitForTimeout(300);
    const modalOk = await page.$('.pl-confirm-backdrop:not([hidden]) [data-plc="ok"]');
    if (modalOk) await modalOk.click();
    await page.waitForTimeout(500);
    check('the entry is deleted with no connection', !(await listText()).includes('2,345'), await listText());
    noErrors('cash-inflow.html logging/editing/deleting');

    // ---- backups: both downloads from the real Data Backup buttons ----
    await open('data-backup.html');
    const [jsonDl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('#downloadJsonBtn')]);
    check('the JSON backup downloads with no connection', /\.json$/.test(jsonDl.suggestedFilename()), jsonDl.suggestedFilename());
    await page.fill('#encExportPass', 'correct horse battery staple');
    await page.fill('#encExportPass2', 'correct horse battery staple');
    const [encDl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#encExportBtn')]);
    check('the encrypted backup downloads with no connection', /\.enc$/.test(encDl.suggestedFilename()), encDl.suggestedFilename());
    // F14: a normal backup gets no size note. For a large one the page shows the API's note; here the
    // page asks about a 20 MB file (the real one is far smaller), and the phone code answers it.
    const noteShown = (sel) => page.$eval(sel, (el) => el.classList.contains('show'));
    check('F14: a small backup shows no size note', !(await noteShown('#jsonSizeNote')) && !(await noteShown('#encExportSizeNote')));
    await page.evaluate(() => {
      const realFetch = window.fetch;
      window.fetch = (u, init) => realFetch(typeof u === 'string' && u.startsWith('/api/backup/size-note') ? u.replace(/bytes=\d+/, 'bytes=' + 20 * 1024 * 1024) : u, init);
    });
    await page.fill('#encExportPass', 'correct horse battery staple');
    await page.fill('#encExportPass2', 'correct horse battery staple');
    await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#encExportBtn')]);
    const note = await page.$eval('#encExportSizeNote', (el) => (el.classList.contains('show') ? el.textContent : ''));
    check('F14: a large backup shows how big it is, the restore limit and what to do', /^This backup is getting large: 20 MB of the 24 MB that Plannr can restore from an encrypted backup\..*Recycle Bin/.test(note), note || '(no note shown)');
    noErrors('data-backup.html backups');

    // ---- the PDF button answers (the drawing itself is the phone's print plugin) ----
    await open('overview.html');
    await page.click('#ovPdfBtn');
    await page.waitForTimeout(200);
    await page.click('[data-ch="0"]');
    await page.waitForTimeout(500);
    const pdfMsg = await page.$eval('#ovMsg', (el) => el.textContent).catch(() => '');
    check('the PDF button answers with no connection (in a browser: "needs the Android app")', /android app/i.test(pdfMsg), pdfMsg);
    noErrors('overview.html PDF');

    check('no request went anywhere outside the app', outside.length === 0, outside.join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(failures === 0 ? '\n✓ OFFLINE SUITE PASSED' : `\n✗ ${failures} offline check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
