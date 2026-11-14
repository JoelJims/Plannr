// Phase 2, Step 3 (M8) — the phone's storage limit (npm run test:storage-limit).
//
// The phone keeps its database in the WebView's localStorage (sqlite-wasm kvvfs). This suite runs that
// exact code path in Playwright's Chromium (local-server.js: no API server, so every /api call goes
// through public/local-api.js) and:
//   1) MEASURES Chromium's localStorage limit and checks the meter's constant matches it;
//   2) prints what the database costs in localStorage (fresh install, fixture, per entry);
//   3) checks the storage meter on the Data Backup page: the numbers, the 70% warning, the 90% one;
//   4) fills storage to the limit and checks a single add / edit / delete answers "Storage is full"
//      (not "Something went wrong"), with the data intact and saving working again once there is room;
//   5) fills the database with real entries until it is full and checks Android Auto Backup's
//      budget: the ledger plus three gzipped safety snapshots stay well under the 25 MB limit.
// Android's System WebView is Chromium, so the phone is expected to behave the same; that part is an
// estimate until checked on a device (docs/PHONE-TEST-CHECKLIST.md).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const F = require('../test/fixtures/full-dataset');

const PORT = 8098;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
const MB = (chars) => (chars * 2 / 1048576).toFixed(2) + ' MB';

(async () => {
  const server = spawn(process.execPath, ['local-server.js', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage(); // the restore's safety snapshot is a download in a plain browser
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const openFresh = async () => {
    await page.goto(`${BASE}/data-backup.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => import('/local-bootstrap.js'));
  };
  const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, json: await r.json() };
  }, [method, url, body]);
  const dump = () => page.evaluate(async (src) => { const { db } = await import('/db.js'); return new Function('return ' + src)()(db); }, F.dumpAll.toString());
  const dbStats = () => page.evaluate(async () => {
    const { db } = await import('/db.js');
    let chars = 0;
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('kvvfs-local')) chars += k.length + localStorage.getItem(k).length; }
    const pages = db.prepare('PRAGMA page_count').get().page_count;
    const pageSize = Object.values(db.prepare('PRAGMA page_size').get())[0];
    return { chars, dbBytes: pages * Number(pageSize), rows: db.prepare('SELECT COUNT(*) n FROM cash_out').get().n };
  });
  // Fill localStorage with filler entries until it refuses even one more character (chunks shrink so
  // the remaining room ends up ~0). Returns the total characters stored when full.
  const fillToLimit = () => page.evaluate(() => {
    let n = 0;
    for (const size of [1 << 20, 1 << 16, 1 << 12, 1 << 8, 16, 1]) {
      const chunk = 'x'.repeat(size);
      for (;;) { try { localStorage.setItem('filler-' + (n++), chunk); } catch { break; } }
    }
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); total += k.length + localStorage.getItem(k).length; }
    return total;
  });
  const removeFiller = () => page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('filler-')) localStorage.removeItem(k); });
  // Filler that brings total use to `fraction` of the meter's limit.
  const fillTo = (fraction) => page.evaluate(async (f) => {
    const { LOCALSTORAGE_LIMIT_CHARS } = await import('/local-api.js');
    let used = 0;
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); used += k.length + localStorage.getItem(k).length; }
    const want = Math.floor(LOCALSTORAGE_LIMIT_CHARS * f) - used - 'filler-0'.length;
    if (want > 0) localStorage.setItem('filler-0', 'x'.repeat(want));
  }, fraction);
  const meter = async () => {
    await openFresh();
    await page.waitForFunction(() => !document.getElementById('storageSection').hidden);
    return page.evaluate(() => ({
      text: document.getElementById('storageText').textContent,
      msg: document.getElementById('storageMsg').textContent,
      shown: document.getElementById('storageMsg').classList.contains('show'),
      now: document.getElementById('storageBar').getAttribute('aria-valuenow'),
    }));
  };

  try {
    await page.goto(`${BASE}/data-backup.html`);
    await page.evaluate(() => localStorage.clear());
    await openFresh();

    // ---- 1) Chromium's localStorage limit, measured ----
    const quota = await page.evaluate(() => {
      let n = 0, total = 0;
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); total += k.length + localStorage.getItem(k).length; }
      for (const size of [1 << 20, 1 << 16, 1 << 12, 1 << 8, 16, 1]) {
        const chunk = 'x'.repeat(size);
        for (;;) { const k = 'probe-' + n; try { localStorage.setItem(k, chunk); n++; total += k.length + size; } catch { break; } }
      }
      for (let i = 0; i < n; i++) localStorage.removeItem('probe-' + i);
      return total;
    });
    const LIMIT = await page.evaluate(async () => (await import('/local-api.js')).LOCALSTORAGE_LIMIT_CHARS);
    console.log(`  · measured: Chromium's localStorage limit is ${quota.toLocaleString('en')} characters (${MB(quota)} as Chromium counts it, 2 bytes per character)`);
    check('the meter\'s limit matches the measured one (within 0.1%)', Math.abs(quota - LIMIT) / LIMIT < 0.001, `meter ${LIMIT}, measured ${quota}`);

    // ---- 2) What the database costs ----
    const fresh = await dbStats();
    await page.evaluate(async ([src, data]) => { const { db } = await import('/db.js'); new Function('return ' + src)()(db, data); }, [F.seedInto.toString(), F.DATA]);
    const seeded = await dbStats();
    await page.evaluate(async () => {
      const { db } = await import('/db.js');
      const st = db.prepare("INSERT INTO cash_out (amount_paise, tx_date, by_type, by_user_id, ledger_code, subledger_code, reason, contract_scope) VALUES (?, '2026-03-04', 'user', 1, '22.0', '22.5', ?, 'extra')");
      db.exec('BEGIN'); for (let i = 0; i < 1000; i++) st.run(100000 + i, 'Cement bags x' + (i % 50) + ' — site delivery, paid in cash'); db.exec('COMMIT');
    });
    const thousand = await dbStats();
    const perRow = (thousand.chars - seeded.chars) / 1000;
    console.log(`  · measured: fresh install = ${(fresh.dbBytes / 1024).toFixed(0)} KB database, ${MB(fresh.chars)} of localStorage (${(100 * fresh.chars / LIMIT).toFixed(1)}%)`);
    console.log(`  · measured: + test fixture = ${(seeded.dbBytes / 1024).toFixed(0)} KB, ${MB(seeded.chars)}; + 1000 typical entries = ${(thousand.dbBytes / 1024).toFixed(0)} KB, ${MB(thousand.chars)}`);
    console.log(`  · estimated: about ${Math.round(perRow)} characters per typical entry, so room for roughly ${Math.round((LIMIT - fresh.chars) / perRow).toLocaleString('en')} entries on an empty install`);
    check('a fresh install uses under 5% of the limit', fresh.chars / LIMIT < 0.05, `${(100 * fresh.chars / LIMIT).toFixed(1)}%`);

    // ---- 3) The meter ----
    const st = await api('GET', '/api/storage');
    check('/api/storage reports phone storage against the limit', st.status === 200 && st.json.mode === 'phone' && st.json.limitBytes === LIMIT * 2 && st.json.level === 'ok', JSON.stringify(st.json));
    let m = await meter();
    check('the meter shows "Used X MB of about 10 MB" with no warning', /^Used [\d.]+ MB of about 10 MB \(\d+%\)\.$/.test(m.text) && !m.shown, `${m.text} | ${m.msg}`);
    await fillTo(0.75);
    m = await meter();
    check('at 75% it warns that storage is getting full', m.shown && /getting full \(75%\)/.test(m.msg) && m.now === '75', `${m.text} | ${m.msg}`);
    await removeFiller();
    await fillTo(0.92);
    m = await meter();
    check('at 92% it strongly tells the user to export a backup now', m.shown && /almost full \(92%\)\. Export a backup now/.test(m.msg), `${m.text} | ${m.msg}`);
    await removeFiller();

    // ---- 4) Storage full: single add / edit / delete ----
    // Measured: with localStorage completely full, small writes still succeed while they fit in the
    // database's existing 8 KB pages (kvvfs rewrites those entries in place). The error comes when the
    // database needs a NEW page. So: fill storage, then add entries until one really fails.
    await openFresh();
    const body = { amountRupees: '100.00', txDate: '2026-03-05', byType: 'user', byUserId: 1, reason: 'Storage-full test — a typical entry with a short note' };
    const total = await fillToLimit();
    console.log(`  · storage filled to ${total.toLocaleString('en')} characters`);
    let saved = 0, add;
    for (let i = 0; i < 400; i++) { add = await api('POST', '/api/cash-in', body); if (add.status !== 201) break; saved++; }
    console.log(`  · measured: ${saved} more entries fitted into the database's existing pages before a save failed`);
    const FULL = /^Storage is full — this change was not saved\. Your saved data is safe\./;
    check('a single add that hits the real limit says "Storage is full" (not "Something went wrong")', add.status === 500 && FULL.test(add.json.error || ''), `${add.status} ${JSON.stringify(add.json)}`);

    // Edit and delete: make every storage write fail the way the browser does when there is no room
    // left at all (QuotaExceededError from localStorage.setItem, which kvvfs turns into SQLITE_IOERR).
    const target = (await api('GET', '/api/cash-in')).json.entries.find((e) => !e.deletedAt);
    const exported = await api('GET', '/api/backup/export');
    const before = await dump();
    await page.evaluate(() => {
      window.__realSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function () { throw new DOMException("Failed to execute 'setItem' on 'Storage': exceeded the quota.", 'QuotaExceededError'); };
    });
    const edit = await api('PUT', `/api/cash-in/${target.id}`, { ...body, reason: 'edited' });
    const del = await api('DELETE', `/api/cash-in/${target.id}`);
    const add2 = await api('POST', '/api/cash-in', body);
    // A JSON restore onto a full phone. SQLite has already rolled back by the time the import's own
    // ROLLBACK runs; before db.js's rollbackQuietly() that second ROLLBACK threw "no transaction is
    // active" and the user got a generic failure instead of "Storage is full".
    const restore = await api('POST', '/api/backup/import', exported.json);
    await page.evaluate(() => { Storage.prototype.setItem = window.__realSetItem; });
    check('a JSON restore onto a full phone says "Storage is full", data unchanged', restore.status === 500 && /^Storage is full — the import did not go through\./.test(restore.json.error || ''), `${restore.status} ${JSON.stringify(restore.json).slice(0, 300)}`);
    for (const [name, r] of [['edit', edit], ['delete', del], ['add', add2]]) {
      check(`a single ${name} with no room at all says "Storage is full"`, r.status === 500 && FULL.test(r.json.error || ''), `${r.status} ${JSON.stringify(r.json)}`);
    }
    try { assert.deepStrictEqual(await dump(), before); check('nothing was half-saved: the data is exactly as before', true); } catch (e) { check('nothing was half-saved: the data is exactly as before', false, e.message.split('\n').slice(0, 8).join('\n')); }
    await removeFiller();
    const integrity = await page.evaluate(async () => { const { db } = await import('/db.js'); return Object.values(db.prepare('PRAGMA integrity_check').get())[0]; });
    check('the database is intact (integrity_check ok)', integrity === 'ok', integrity);
    const again = await api('POST', '/api/cash-in', body);
    check('once there is room again, saving works', again.status === 201, `${again.status} ${JSON.stringify(again.json).slice(0, 200)}`);

    // ---- 5) Android Auto Backup budget (Step 5) ----
    // Auto Backup copies the ledger (localStorage) and safety-snapshots/ (up to 3 files), and skips
    // the whole backup above 25 MB. Fill the database with typical entries until it is full, then size
    // the biggest snapshot the app could write (a JSON export or a whole-database copy, gzipped).
    await page.evaluate(() => localStorage.clear());
    await openFresh();
    const entries = await page.evaluate(async () => {
      const { db } = await import('/db.js');
      const st = db.prepare("INSERT INTO cash_out (amount_paise, tx_date, by_type, by_user_id, ledger_code, subledger_code, reason, contract_scope) VALUES (?, '2026-03-04', 'user', 1, '22.0', '22.5', ?, 'extra')");
      let i = 0;
      for (const batch of [500, 100, 10, 1]) {
        for (;;) {
          try { db.exec('BEGIN'); for (let j = 0; j < batch; j++, i++) st.run(100000 + i * 7, 'Cement bags x' + (i % 50) + ' — site delivery, paid in cash #' + i); db.exec('COMMIT'); }
          catch { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } break; }
        }
      }
      return db.prepare('SELECT COUNT(*) n FROM cash_out').get().n;
    });
    const sizes = await page.evaluate(async () => {
      const { exportSnapshotBytes } = await import('/local-snapshot.js');
      const { gzip } = await import('/safety-snapshots.js');
      const json = new TextEncoder().encode(JSON.stringify(await (await fetch('/api/backup/export?includeContacts=1')).json()));
      const dbBytes = exportSnapshotBytes();
      let chars = 0;
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); chars += k.length + localStorage.getItem(k).length; }
      return { chars, json: json.length, jsonGz: (await gzip(json)).length, db: dbBytes.length, dbGz: (await gzip(dbBytes)).length };
    });
    const MiB = (b) => (b / 1048576).toFixed(2) + ' MB';
    const ledgerMax = LIMIT * 2; // upper bound: every character stored as 2 bytes
    const snapshotMax = Math.max(sizes.jsonGz, sizes.dbGz);
    const budget = ledgerMax + 3 * snapshotMax;
    console.log(`  · measured with storage full (${entries.toLocaleString('en')} entries): JSON snapshot ${MiB(sizes.json)} -> ${MiB(sizes.jsonGz)} gzipped; database snapshot ${MiB(sizes.db)} -> ${MiB(sizes.dbGz)} gzipped`);
    console.log(`  · Auto Backup worst case: ledger ≤ ${MiB(ledgerMax)} (estimated upper bound) + 3 snapshots ≤ ${MiB(3 * snapshotMax)} = ${MiB(budget)} (limit 25 MB); without gzip it would be ${MiB(ledgerMax + 3 * Math.max(sizes.json, sizes.db))}`);
    check('Auto Backup stays well under 25 MB with storage full (worst case ≤ 15 MB)', budget <= 15 * 1048576, MiB(budget));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('suite ran to completion', false, e.stack);
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `✗ STORAGE LIMIT SUITE FAILED (${failures})` : '✓ STORAGE LIMIT SUITE PASSED');
  process.exit(failures ? 1 : 0);
})();
