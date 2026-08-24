// Phase 8d — a real browser driving local-server.js (spawned as an actual child process, plain
// static file serving, no Express, no seeded data) instead of server.js in-process. This is the same
// static-only hosting model Capacitor's WebView uses, and it starts from a genuinely EMPTY database —
// exactly what a fresh device install looks like — unlike every other test-ui/*.js file, which boots
// server.js in-process via test/helpers.js and always seeds a logged-in user first.
//
// Two whole classes of bug only show up under this combination (static-only host + empty DB) and
// neither test-ui/run.js nor tap-count.js nor the 91 node:test cases can catch them:
//   1. Clean/extensionless nav links (server.js maps /cash-flow -> cash-flow.html itself; a plain
//      static host has no such route table, so the link silently fails to navigate). Phase 8c.
//   2. Anything that assumes a users row already exists (getOwner()/the roster) — server.js's own
//      live database has always had one seeded (out of band, long before this migration), so this
//      never surfaces there; a brand-new local database has none. Phase 8d.
// This suite clicks through the real nav (not page.goto to a hardcoded path) so a reintroduced clean
// URL fails exactly the way a tap would, and asserts zero console/page errors on every page.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;

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

// Load a page (by clicking a nav element, not page.goto — a reintroduced clean URL must fail the
// way a real tap would) and collect every console/page error seen up to the next call.
function attachErrorCollector(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return errors;
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1400 } });
  const page = await ctx.newPage();
  const errors = attachErrorCollector(page);

  const afterNav = async (label) => {
    await page.waitForTimeout(500);
    check(`${label}: no console/page errors`, errors.length === 0, errors.join(' | '));
    errors.length = 0;
  };

  try {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await afterNav('home.html');

    const topNav = [
      ['[data-target="flow"]', 'cash-flow.html'],
      ['[data-target="overview"]', 'overview.html'],
      ['[data-target="contract"]', 'contract-details.html'],
      ['[data-target="data"]', 'data-backup.html'],
    ];
    for (const [selector, expectedPage] of topNav) {
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      errors.length = 0;
      await page.click(selector);
      await page.waitForLoadState('networkidle');
      check(`home -> ${selector} lands on ${expectedPage}`, page.url().endsWith('/' + expectedPage), page.url());
      await afterNav(expectedPage);
    }

    const subNav = [
      ['[data-href="/cash-inflow.html"]', 'cash-inflow.html'],
      ['[data-href="/cash-outflow.html"]', 'cash-outflow.html'],
      ['[data-href="/loan-details.html"]', 'loan-details.html'],
      ['[data-href="/contractor-payments.html"]', 'contractor-payments.html'],
    ];
    for (const [selector, expectedPage] of subNav) {
      await page.goto(BASE + '/cash-flow.html', { waitUntil: 'networkidle' });
      errors.length = 0;
      await page.click(selector);
      await page.waitForLoadState('networkidle');
      check(`cash-flow -> ${selector} lands on ${expectedPage}`, page.url().endsWith('/' + expectedPage), page.url());
      await afterNav(expectedPage);

      // Back-link on the sub-page must return to cash-flow.html (Phase 8c fixed these too).
      errors.length = 0;
      await page.click('a[class$="-back"]');
      await page.waitForLoadState('networkidle');
      check(`${expectedPage} back-link returns to cash-flow.html`, page.url().endsWith('/cash-flow.html'), page.url());
      await afterNav(`${expectedPage} back-link`);
    }

    // The "By" dropdown specifically (Phase 8d) — must be populated, not just error-free.
    for (const p of ['cash-inflow.html', 'cash-outflow.html']) {
      await page.goto(BASE + '/' + p, { waitUntil: 'networkidle' });
      errors.length = 0;
      await page.waitForTimeout(500);
      const optionCount = await page.$eval('#bySelect', (el) => el.options.length).catch(() => -1);
      check(`${p}: #bySelect has entries`, optionCount > 0, `optionCount=${optionCount}`);
      check(`${p}: no console/page errors`, errors.length === 0, errors.join(' | '));
    }

    // Notification settings UI (Phase 6b) — renders, times save through /api/notification-times and
    // reload correctly, no console/page errors. The actual notification firing is native-only and
    // can't be tested off-device (Capacitor.isNativePlatform() is false under local-server.js) —
    // that's out of scope here by design; this only proves the settings screen itself works.
    const notifTimes = () => page.$$eval('#notifList li .notif-time', (els) => els.map((e) => e.textContent));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    errors.length = 0;
    await page.waitForTimeout(300);
    check('home.html: notification settings render empty', (await page.$eval('#notifList', (el) => el.textContent)).includes('No reminders set'), '');

    await page.fill('#notifTimeInput', '07:30');
    await page.click('#notifAddBtn');
    await page.waitForTimeout(300);
    await page.fill('#notifTimeInput', '20:00');
    await page.click('#notifAddBtn');
    await page.waitForTimeout(300);
    check('home.html: two added times both render', (await notifTimes()).length === 2, JSON.stringify(await notifTimes()));

    await page.goto(BASE + '/', { waitUntil: 'networkidle' }); // fresh navigation — proves server-side persistence, not just page memory
    await page.waitForTimeout(500);
    check('home.html: times reload after navigating away and back', (await notifTimes()).length === 2, JSON.stringify(await notifTimes()));

    await page.click('.notif-del');
    await page.waitForTimeout(300);
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    check('home.html: removal also persists after reload', (await notifTimes()).length === 1, JSON.stringify(await notifTimes()));

    check('home.html notification settings: no console/page errors', errors.length === 0, errors.join(' | '));

    // Overview PDF export (Phase 6a) — the native print-adapter render itself can't be exercised
    // off-device (Capacitor.isNativePlatform() is false under local-server.js), but the route's
    // validation and its "not native" degrade-gracefully path both can be, driven through the real
    // UI (theme modal -> fetch -> on-screen message), not just a raw fetch.
    await page.goto(BASE + '/overview.html', { waitUntil: 'networkidle' });
    errors.length = 0;
    await page.waitForTimeout(300);
    await page.click('#ovPdfBtn');
    await page.waitForTimeout(200);
    await page.click('[data-ch="0"]'); // theme choice modal: "Light" (first option)
    await page.waitForTimeout(500);
    const pdfMsg = await page.$eval('#ovMsg', (el) => el.textContent).catch(() => '');
    check('overview.html: PDF export degrades gracefully (non-native) with a clear message', /android app/i.test(pdfMsg), pdfMsg);
    check('overview.html: PDF export path: no console/page errors', errors.length === 0, errors.join(' | '));

    const badStart = await page.evaluate(async () => {
      const r = await fetch('/api/overview/pdf?start=not-a-date');
      return { status: r.status, body: await r.json() };
    });
    check('/api/overview/pdf: bad start date is rejected before any native check', badStart.status === 400 && /start date/i.test(JSON.stringify(badStart.body)), JSON.stringify(badStart));

    const badRange = await page.evaluate(() => fetch('/api/overview/pdf?start=2026-06-01&end=2026-01-01').then((r) => r.json()));
    check('/api/overview/pdf: start-after-end range is rejected', /on or before/i.test(badRange.error || ''), JSON.stringify(badRange));

    // ---------------------------------------------------------------------------------------------
    // Ledger List CSV (Phase 10b) — export (via the real button), edit+re-import (rename preserving
    // spend), addition, and every rejection case from the spec. The rejection/rename/addition cases
    // go straight through fetch() to /api/ledgers/csv — the exact same route the real Import button
    // calls — since juggling file-input + confirm-dialog + passphrase-derived encryption for every
    // one of these would test Playwright's plumbing more than the app's validation logic.
    // ---------------------------------------------------------------------------------------------
    await page.goto(BASE + '/data-backup.html', { waitUntil: 'networkidle' });
    errors.length = 0;
    await page.waitForTimeout(300);

    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#downloadLedgerCsvBtn')]);
    const exportedCsv = fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '');
    check('Ledger List export: correct header', exportedCsv.split(/\r?\n/)[0] === 'Code,Main ledger,Sub-code,Sub-ledger', exportedCsv.slice(0, 60));
    check('Ledger List export: contains a known ledger', exportedCsv.includes('6.0,MATERIALS — STRUCTURAL'), '');
    check('Ledger List export path: no console/page errors', errors.length === 0, errors.join(' | '));

    const toLedgerCsv = (rows) => ['Code,Main ledger,Sub-code,Sub-ledger', ...rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(','))].join('\n');
    const fetchLedgerRows = () => page.evaluate(async () => {
      const { ledgers } = await (await fetch('/api/ledgers')).json();
      const rows = [];
      for (const L of ledgers) {
        rows.push([L.code, L.name, '', '']);
        for (const s of L.subLedgers) rows.push([L.code, L.name, s.code, s.name]);
      }
      return rows;
    });
    const postLedgerCsv = (csv) => page.evaluate(
      (csvText) => fetch('/api/ledgers/csv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: csvText }) })
        .then(async (r) => ({ status: r.status, body: await r.json() })),
      csv
    );
    const seedDebit = (uid, ledgerCode, subledgerCode) => page.evaluate(
      ({ uid, ledgerCode, subledgerCode }) => fetch('/api/cash-out', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountRupees: '500.00', txDate: '2026-01-01', byType: 'user', byUserId: uid, ledgerCode, subledgerCode, contractScope: 'extra' }),
      }).then(async (r) => ({ status: r.status, body: await r.json() })),
      { uid, ledgerCode, subledgerCode }
    );
    const ownerId = await page.evaluate(() => fetch('/api/me').then((r) => r.json()).then((d) => d.user.id));

    // ---- Rename (same code, new name) — historical spend stays attached to the CODE, not the name ----
    const seed1 = await seedDebit(ownerId, '6.0', '6.1');
    check('Ledger List test setup: seeded a debit against 6.1 (Cement)', seed1.status === 201, JSON.stringify(seed1.body));

    let rows = await fetchLedgerRows();
    rows = rows.map((r) => (r[2] === '6.1' ? [r[0], r[1], r[2], 'Cement (OPC 53 Grade)'] : r));
    const renameRes = await postLedgerCsv(toLedgerCsv(rows));
    check('Ledger List import: rename accepted', renameRes.status === 200, JSON.stringify(renameRes.body));

    const afterRename = await page.evaluate(() => fetch('/api/cash-out').then((r) => r.json()));
    const renamedRow = (afterRename.entries || []).find((e) => e.subledgerCode === '6.1');
    check('Ledger List rename: the seeded debit still resolves to 6.1 under the NEW name', !!renamedRow && renamedRow.ledger.includes('Cement (OPC 53 Grade)'), JSON.stringify(renamedRow));

    // ---- Addition — a brand-new main ledger + its Misc sub ----
    rows = await fetchLedgerRows();
    rows.push(['25.0', 'TEST ADDITION', '', ''], ['25.0', 'TEST ADDITION', '25.99', 'Misc']);
    const addRes = await postLedgerCsv(toLedgerCsv(rows));
    check('Ledger List import: addition accepted', addRes.status === 200, JSON.stringify(addRes.body));
    const afterAdd = await page.evaluate(() => fetch('/api/ledgers').then((r) => r.json()));
    check('Ledger List addition: new main appears', afterAdd.ledgers.some((l) => l.code === '25.0' && l.name === 'TEST ADDITION'), '');

    // ---- Rejections: each must reject the WHOLE file with a clear reason, changing nothing ----
    const dupRes = await postLedgerCsv(toLedgerCsv([['1.0', 'A', '', ''], ['1.0', 'A', '', '']]));
    check('Ledger List import: duplicate code rejected', dupRes.status === 400 && /duplicated/i.test(JSON.stringify(dupRes.body)), JSON.stringify(dupRes.body));

    const malformedRes = await postLedgerCsv(toLedgerCsv([['1.X', 'A', '', '']]));
    check('Ledger List import: malformed main code rejected', malformedRes.status === 400 && /malformed/i.test(JSON.stringify(malformedRes.body)), JSON.stringify(malformedRes.body));

    // 9.1 declares its parent as 9.0 (matches its own Code column) — but 9.0 is never declared as a
    // main row anywhere in this file.
    const orphanSubRes = await postLedgerCsv(toLedgerCsv([['1.0', 'A', '', ''], ['9.0', 'Electrical', '9.1', 'Wires']]));
    check('Ledger List import: sub referencing an undeclared main rejected', orphanSubRes.status === 400 && /not present in this file/i.test(JSON.stringify(orphanSubRes.body)), JSON.stringify(orphanSubRes.body));

    // The critical check: a code with real spend against it can never go missing from the file.
    const seed2 = await seedDebit(ownerId, '1.0', '1.1');
    check('Ledger List test setup: seeded a debit against 1.1', seed2.status === 201, JSON.stringify(seed2.body));
    const removedRes = await postLedgerCsv(toLedgerCsv([['2.0', 'B', '', '']])); // a valid file that simply omits 1.0/1.1
    const flags1p1 = (removedRes.body.rowErrors || []).some((e) => e.message.includes('"1.1"'));
    check('Ledger List import: removing a code still in use is rejected', removedRes.status === 400 && flags1p1 && /still used/i.test(removedRes.body.error || ''), JSON.stringify(removedRes.body));

    // None of the rejected imports actually changed anything.
    const finalLedgers = await page.evaluate(() => fetch('/api/ledgers').then((r) => r.json()));
    check('Ledger List: rejected imports left the taxonomy untouched (25.0 still present)', finalLedgers.ledgers.some((l) => l.code === '25.0'), '');
    check('Ledger List section: no console/page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(failures === 0 ? '\n✓ all static-hosting checks passed' : `\n✗ ${failures} static-hosting check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
