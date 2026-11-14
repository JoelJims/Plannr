// Phase 2, Step 1 (M4) — the phone's backups rebuild the app exactly (npm run test:backup-roundtrip).
//
// Runs the PHONE code path: local-server.js serves public/ with no API, so every /api call goes through
// public/local-api.js and the sqlite-wasm database in localStorage, exactly as inside the Android app.
// For each format: fill the database with the fixture (test/fixtures/full-dataset.js) -> back up ->
// wipe (localStorage.clear() + reload = a brand-new install) -> restore -> every table, the
// AUTOINCREMENT counters and PRAGMA user_version match the original row by row.
// Needs `npm run sync:public-modules` to have been run (public/db.js, public/backup-format.js, ...).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const F = require('../test/fixtures/full-dataset');

const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
function sameDb(name, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); check(name, true); }
  catch (e) { check(name, false, e.message.split('\n').slice(0, 12).join('\n')); }
}

(async () => {
  const server = spawn(process.execPath, ['local-server.js', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true }); // the restore's safety snapshot is a download in a plain browser
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Open the Data page and wait until local-bootstrap.js has opened the database and installed the shim.
  const openFresh = async () => {
    await page.goto(`${BASE}/data-backup.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => import('/local-bootstrap.js'));
  };
  const wipe = async () => { await page.evaluate(() => localStorage.clear()); await openFresh(); };
  const dump = () => page.evaluate(async (src) => { const { db } = await import('/db.js'); return new Function('return ' + src)()(db); }, F.dumpAll.toString());
  const seed = () => page.evaluate(async ([seedSrc, data]) => { const { db } = await import('/db.js'); new Function('return ' + seedSrc)()(db, data); }, [F.seedInto.toString(), F.DATA]);
  const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, json: await r.json() };
  }, [method, url, body]);

  try {
    await openFresh();
    check('the shim is installed (local-only mode, like the phone)', (await api('GET', '/api/ledgers')).status === 200);

    // ---- JSON backup (v2) ----
    await seed();
    const original = await dump();
    const empty = Object.entries(original.tables).filter(([, rows]) => rows.length === 0).map(([t]) => t);
    check('the fixture fills every table', empty.length === 0, empty.join(', '));

    const exp = await api('GET', '/api/backup/export');
    check('JSON export is format v2', exp.status === 200 && exp.json.schemaVersion === 2, `status ${exp.status}, v${exp.json.schemaVersion}`);
    await wipe();
    const fresh = await dump();
    check('the wipe gives a brand-new install (no entries, default categories)', fresh.tables.cash_out.length === 0 && !fresh.tables.ledger_mains.some((m) => m.code === '90'));
    const imp = await api('POST', '/api/backup/import', exp.json);
    check('JSON restore succeeds on the new install', imp.status === 200, JSON.stringify(imp.json).slice(0, 300));
    sameDb('JSON restore: every table, counter and the schema version match the original', await dump(), original);
    const ledgers = await api('GET', '/api/ledgers');
    const list = ledgers.json.ledgers || ledgers.json;
    check('restored categories are live without a restart (90 Garden & Landscaping is listed)', Array.isArray(list) && list.some((l) => l.code === '90'));

    // ---- Encrypted backup ----
    const beforeEnc = await dump();
    const pass = 'roundtrip-passphrase-123';
    const dataBase64 = await page.evaluate(async (passphrase) => {
      const r = await fetch('/api/backup/export-encrypted', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase }) });
      if (!r.ok) return null;
      const buf = new Uint8Array(await (await r.blob()).arrayBuffer());
      let binary = '';
      for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(binary);
    }, pass);
    check('encrypted export succeeds', !!dataBase64);
    await wipe();
    const encImp = await api('POST', '/api/backup/import-encrypted', { passphrase: pass, dataBase64 });
    check('encrypted restore succeeds on the new install', encImp.status === 200, JSON.stringify(encImp.json).slice(0, 300));
    sameDb('encrypted restore: every table, counter and the schema version match the original', await dump(), beforeEnc);

    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('suite ran to completion', false, e.stack);
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `✗ BACKUP ROUND-TRIP FAILED (${failures})` : '✓ BACKUP ROUND-TRIP PASSED');
  process.exit(failures ? 1 : 0);
})();
