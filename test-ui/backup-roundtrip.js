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
const fs = require('fs');
const assert = require('assert');
const F = require('../test/fixtures/full-dataset');

// The desktop's own upgrade of an old database, for comparison: build the file from the fixture's SQL,
// run db.js's init() on it in a child process (never this process: it must not bind db.js), count rows.
function desktopUpgradeCounts(sql, approve) {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-old-backup-'));
  const file = path.join(dir, 'old.db');
  const d = new DatabaseSync(file);
  d.exec(sql);
  d.exec(approve);
  d.close();
  const script = `
    const db = require(${JSON.stringify(path.join(__dirname, '..', 'db.js'))});
    db.init().then(() => {
      const t = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
      process.stdout.write(JSON.stringify(Object.fromEntries(t.map((n) => [n, db.db.prepare('SELECT COUNT(*) AS n FROM ' + n).get().n]))));
      db.db.close();
    }, (e) => { console.error(e.message); process.exit(1); });`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, PLANNR_DB: file, PLANNR_TEST: '1' } });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  if (r.status !== 0) throw new Error('desktop upgrade failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}

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
  const exportEncrypted = (passphrase) => page.evaluate(async (pp) => {
    const r = await fetch('/api/backup/export-encrypted', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: pp }) });
    if (!r.ok) return null;
    const buf = new Uint8Array(await (await r.blob()).arrayBuffer());
    let binary = '';
    for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(binary);
  }, passphrase);
  const setVersion = (v) => page.evaluate(async (n) => { const { db } = await import('/db.js'); db.exec(`PRAGMA user_version = ${n}`); }, v);
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
    check('the wipe gives a brand-new install (no entries, default categories)', fresh.tables.cash_out.length === 0 && !fresh.tables.ledger_mains.some((m) => m.code === '90.0'));
    const imp = await api('POST', '/api/backup/import', exp.json);
    check('JSON restore succeeds on the new install', imp.status === 200, JSON.stringify(imp.json).slice(0, 300));
    sameDb('JSON restore: every table, counter and the schema version match the original', await dump(), original);
    const ledgers = await api('GET', '/api/ledgers');
    const list = ledgers.json.ledgers || ledgers.json;
    check('restored categories are live without a restart (90 Garden & Landscaping is listed)', Array.isArray(list) && list.some((l) => l.code === '90.0'));

    // ---- Q10: a JSON backup with amounts over the limits is refused on the page, nothing changed ----
    // The refusal names each bad row on a line of its own: the message box keeps line breaks
    // (styles.css .msg white-space: pre-line), so every line starts at the left edge, one below another.
    const limits = await page.evaluate(async () => { const p = await import('/core/parsers.js'); return { entry: p.MAX_AMOUNT_PAISE, total: p.MAX_TOTAL_PAISE }; });
    const overLimit = JSON.parse(JSON.stringify(exp.json));
    overLimit.tables.cash_out[0].amount_paise = limits.entry + 1;
    overLimit.tables.cash_in[0].amount_paise = limits.entry + 1;
    overLimit.tables.loans[0].amount_paise = limits.total + 1;
    const beforeOver = await dump();
    page.once('dialog', (d) => d.accept()); // "This REPLACES all current data…"
    await page.setInputFiles('#importFile', { name: 'over-limit-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(overLimit)) });
    await page.click('#importBtn');
    await page.waitForSelector('#importMsg.show');
    const shownOver = await page.evaluate(() => {
      const el = document.getElementById('importMsg');
      const node = el.firstChild;
      const text = node ? node.data : '';
      const starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
      const at = starts.map((s) => { const r = document.createRange(); r.setStart(node, s); r.setEnd(node, s + 1); const b = r.getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top) }; });
      return { text, isError: el.classList.contains('error'), at, whiteSpace: getComputedStyle(el).whiteSpace };
    });
    const overLines = shownOver.text.split('\n');
    check('Q10: an over-limit JSON backup is refused on the page, naming each bad row', shownOver.isError
      && /^This backup was not imported: 3 amounts in it are over Plannr's limits\. Nothing was changed\.$/.test(overLines[0])
      && overLines.filter((l) => l.startsWith('• ')).length === 3 && /^• Cash Inflow \(cash_in row 1, id \d+\)/.test(overLines[1]), shownOver.text);
    check('…each row on a line of its own (line breaks kept, every line starts at the left edge, below the last)',
      overLines.length >= 5 && shownOver.at.length === overLines.length && shownOver.at.every((p, i) => p.left === shownOver.at[0].left && (i === 0 || p.top > shownOver.at[i - 1].top)),
      `${shownOver.whiteSpace} ${JSON.stringify(shownOver.at)}`);
    sameDb('…and nothing changed', await dump(), beforeOver);

    // ---- Recycle Bin shows the restored deleted rows (it used to throw for any deleted row and say
    // "Network error loading the Recycle Bin." — found on the emulator, Phase 2 Step 9) ----
    const binTables = ['cash_out', 'cash_in', 'loans', 'contract', 'contractor_payments'];
    const deletedRows = binTables.flatMap((t) => (F.DATA.rows[t] || []).filter((r) => r.deleted_at));
    await openFresh();
    await page.waitForSelector('#trashBody .rb-item, #trashBody .rb-empty');
    const bin = await page.evaluate(() => ({ items: document.querySelectorAll('#trashBody .rb-item').length, text: document.getElementById('trashBody').innerText }));
    check('the fixture has deleted rows to show', deletedRows.length >= 2, String(deletedRows.length));
    check('the Recycle Bin lists every deleted row, with its IST date', bin.items === deletedRows.length && /deleted \d\d\/\d\d\/\d\d IST/.test(bin.text), `${bin.items} of ${deletedRows.length}: ${bin.text.slice(0, 160)}`);

    // ---- Encrypted backup ----
    const beforeEnc = await dump();
    const pass = 'roundtrip-passphrase-123';
    const dataBase64 = await exportEncrypted(pass);
    check('encrypted export succeeds', !!dataBase64);
    await wipe();
    const encImp = await api('POST', '/api/backup/import-encrypted', { passphrase: pass, dataBase64 });
    check('encrypted restore succeeds on the new install', encImp.status === 200, JSON.stringify(encImp.json).slice(0, 300));
    sameDb('encrypted restore: every table, counter and the schema version match the original', await dump(), beforeEnc);

    // ---- One request at a time (step 1.4 B5): a write sent while an encrypted restore is running ----
    // The restore decrypts, replaces the database and awaits init(). Without the request queue the
    // write ran in between, was answered "saved", and was then wiped by the restore.
    const during = await page.evaluate(async ([pp, data]) => {
      const order = [];
      const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      const restore = post('/api/backup/import-encrypted', { passphrase: pp, dataBase64: data }).then((r) => { order.push('restore'); return r.status; });
      const write = post('/api/cash-in', { amountRupees: '4321', txDate: '2026-11-17', byType: 'relative', byLabel: 'Queue test', reason: 'sent during a restore' })
        .then((r) => { order.push('write'); return r.status; });
      const [restoreStatus, writeStatus] = await Promise.all([restore, write]);
      return { order: order.join(' then '), restoreStatus, writeStatus };
    }, [pass, dataBase64]);
    check('a write sent during an encrypted restore waits for it to finish', during.restoreStatus === 200 && during.writeStatus === 201 && during.order === 'restore then write', JSON.stringify(during));
    const afterBoth = await dump();
    check('…and is kept (the restore did not wipe it)', afterBoth.tables.cash_in.filter((r) => r.reason === 'sent during a restore').length === 1);

    // ---- A restore that fails half-way leaves the data exactly as it was (step 1.4 B17) ----
    // The restore rebuilds every table inside one transaction. Make its last write fail: everything
    // before it is rolled back, foreign keys are switched back on, and the database is intact.
    const beforeFailed = await dump();
    await page.evaluate(async () => {
      const { db } = await import('/db.js');
      const exec = db.exec;
      db.exec = function (sql, ...rest) {
        if (typeof sql === 'string' && sql.startsWith('DELETE FROM sqlite_sequence')) throw new Error('injected failure half-way through the restore');
        return exec.call(this, sql, ...rest);
      };
      window.__plannrUnpatchExec = () => { db.exec = exec; };
    });
    const failed = await api('POST', '/api/backup/import-encrypted', { passphrase: pass, dataBase64 });
    await page.evaluate(() => window.__plannrUnpatchExec());
    check('an encrypted restore that fails half-way reports an error', failed.status >= 400, `${failed.status} ${JSON.stringify(failed.json).slice(0, 200)}`);
    sameDb('…and the data is exactly as before (the whole rebuild was rolled back)', await dump(), beforeFailed);
    const afterFailed = await page.evaluate(async () => {
      const { db } = await import('/db.js');
      return { fk: db.prepare('PRAGMA foreign_keys').get().foreign_keys, integrity: db.prepare('PRAGMA integrity_check').get().integrity_check };
    });
    check('…foreign keys are on again and the database is intact', afterFailed.fk === 1 && afterFailed.integrity === 'ok', JSON.stringify(afterFailed));

    // ---- A backup that copies in but fails the foreign-key check after it is undone (S3/Q6) ----
    // The rebuild above commits; the checks run after it. A failure there used to leave the backup's
    // data live behind an error. Now the data from just before the restore is put back.
    const fkBackup = await page.evaluate(async (pp) => {
      const { getSqlite3 } = await import('/db-engine.js');
      const { encrypt } = await import('/backup-crypto.js');
      const { exportSnapshotBytes } = await import('/local-snapshot.js');
      const sqlite3 = getSqlite3();
      const bytes = await exportSnapshotBytes();
      const d = new sqlite3.oo1.DB(':memory:', 'c');
      const p = sqlite3.wasm.allocFromTypedArray(bytes);
      sqlite3.capi.sqlite3_deserialize(d.pointer, 'main', p, bytes.length, bytes.length,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
      try {
        d.exec('PRAGMA foreign_keys = OFF');
        d.exec("INSERT INTO cash_in (amount_paise, tx_date, by_type, by_label, reason) VALUES (100, '2026-11-20', 'relative', 'D1', 'only in the bad backup')");
        d.exec("INSERT INTO contract_payment_dates (contract_id, pay_date) VALUES (999999, '2026-12-01')"); // no such contract
        const enc = await encrypt(sqlite3.capi.sqlite3_js_db_export(d.pointer), pp);
        let binary = '';
        for (let i = 0; i < enc.length; i += 0x8000) binary += String.fromCharCode.apply(null, enc.subarray(i, i + 0x8000));
        return btoa(binary);
      } finally { d.close(); }
    }, pass);
    await api('POST', '/api/cash-in', { amountRupees: '5.00', txDate: '2026-11-20', byType: 'relative', byLabel: 'D1', reason: 'made before the bad restore' });
    const beforeFk = await dump();
    const fkRestore = await api('POST', '/api/backup/import-encrypted', { passphrase: pass, dataBase64: fkBackup });
    sameDb('a backup that fails its foreign-key check after it is copied in is undone: the data is exactly as before', await dump(), beforeFk);
    check('…and the answer says nothing was changed, and why', fkRestore.status === 500
      && /^This backup could not be restored\. Nothing was changed: your data is as it was before\. Reason: .*foreign_key_check/.test(fkRestore.json.error || ''),
    `${fkRestore.status} ${JSON.stringify(fkRestore.json).slice(0, 300)}`);
    const afterFk = await page.evaluate(async () => {
      const { db } = await import('/db.js');
      return { fk: db.prepare('PRAGMA foreign_keys').get().foreign_keys, violations: db.prepare('PRAGMA foreign_key_check').all().length, integrity: db.prepare('PRAGMA integrity_check').get().integrity_check };
    });
    check('…foreign keys on, no violations, the database intact', afterFk.fk === 1 && afterFk.violations === 0 && afterFk.integrity === 'ok', JSON.stringify(afterFk));

    // ---- An encrypted backup made by an OLD Plannr (schema v1) comes back upgraded (step 1.4 B17) ----
    // The restore copies the backup's PRAGMA user_version (it is not in any table), so init() sees v1
    // and runs the old upgrade steps: here, dropping the per-household tenant_id columns. Without the
    // carry-over the database would keep the live v2 stamp and the old shape. The database is the
    // schema-history fixture from commit 42ff006, with the two in-database approvals its destructive
    // one-off steps ask for. The result must be what the desktop's own init() makes of the same file.
    const OLD_SQL = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'schema-history', '03-42ff006.sql'), 'utf8');
    const APPROVE = "INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (1, '_service_price_drop_approved', '1'), (1, '_taxonomy_wipe_approved', '1')";
    const desktop = desktopUpgradeCounts(OLD_SQL, APPROVE);
    const oldBackup = await page.evaluate(async ([sql, approve, pp]) => {
      const { getSqlite3 } = await import('/db-engine.js');
      const { encrypt } = await import('/backup-crypto.js');
      const sqlite3 = getSqlite3();
      const d = new sqlite3.oo1.DB(':memory:', 'c');
      try {
        d.exec(sql);
        d.exec(approve);
        const before = { version: d.selectValue('PRAGMA user_version'), tenantCols: d.selectValue("SELECT COUNT(*) FROM pragma_table_info('cash_out') WHERE name = 'tenant_id'") };
        const enc = await encrypt(sqlite3.capi.sqlite3_js_db_export(d.pointer), pp);
        let binary = '';
        for (let i = 0; i < enc.length; i += 0x8000) binary += String.fromCharCode.apply(null, enc.subarray(i, i + 0x8000));
        return { before, data: btoa(binary) };
      } finally { d.close(); }
    }, [OLD_SQL, APPROVE, pass]);
    check('the old backup really is schema v1 with tenant_id columns', oldBackup.before.version === 1 && oldBackup.before.tenantCols === 1, JSON.stringify(oldBackup.before));
    const oldRestore = await api('POST', '/api/backup/import-encrypted', { passphrase: pass, dataBase64: oldBackup.data });
    check('an encrypted backup from an older Plannr restores', oldRestore.status === 200, `${oldRestore.status} ${JSON.stringify(oldRestore.json).slice(0, 300)}`);
    const upgraded = await page.evaluate(async () => {
      const { db, SCHEMA_VERSION } = await import('/db.js');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
      const withTenant = tables.filter((t) => db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${t}') WHERE name = 'tenant_id'`).get().n > 0);
      return {
        version: db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, withTenant,
        counts: Object.fromEntries(tables.sort().map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])),
        fkViolations: db.prepare('PRAGMA foreign_key_check').all().length,
        integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      };
    });
    check('…and comes back upgraded: the current schema version, no tenant_id left, intact',
      upgraded.version === upgraded.SCHEMA_VERSION && upgraded.withTenant.length === 0 && upgraded.fkViolations === 0 && upgraded.integrity === 'ok',
      JSON.stringify(upgraded));
    check('…with the same tables and row counts as the desktop\'s upgrade of the same database', JSON.stringify(upgraded.counts) === JSON.stringify(desktop),
      `phone ${JSON.stringify(upgraded.counts)} | desktop ${JSON.stringify(desktop)}`);

    // ---- Schema version guards (Step 2): data from a NEWER Plannr is refused, never half-read ----
    const SCHEMA_VERSION = await page.evaluate(async () => (await import('/db.js')).SCHEMA_VERSION);
    const beforeNewer = await dump();
    await setVersion(SCHEMA_VERSION + 1);
    const newerBackup = await exportEncrypted(pass);
    await setVersion(SCHEMA_VERSION);
    const refused = await api('POST', '/api/backup/import-encrypted', { passphrase: pass, dataBase64: newerBackup });
    check('an encrypted backup from a newer Plannr is refused (400) before anything changes', refused.status === 400 && /newer version of Plannr/.test(refused.json.error || ''), JSON.stringify(refused.json).slice(0, 300));
    sameDb('…and the data is unchanged', await dump(), beforeNewer);

    // An older app opened over a newer database (e.g. an old APK installed over a newer one).
    await setVersion(SCHEMA_VERSION + 1);
    const newerDb = await dump();
    await page.goto(`${BASE}/data-backup.html`, { waitUntil: 'networkidle' });
    const bootError = await page.evaluate(() => import('/local-bootstrap.js').then(() => null, (e) => e.message));
    check('start-up refuses a database from a newer Plannr', /newer version of the app/.test(bootError || ''), String(bootError));
    const shown = await page.getByRole('alert').filter({ hasText: 'could not open your data' }).count();
    check('…and says so on screen instead of a blank page', shown === 1, `${shown} alert(s)`);
    sameDb('…and leaves the data untouched', await dump(), newerDb);
    await setVersion(SCHEMA_VERSION);
    await openFresh();
    check('the same data opens again once the versions match', (await api('GET', '/api/ledgers')).status === 200);
    // That refusal is meant to surface as an uncaught error on the page (the page's own import of
    // local-bootstrap.js rejects); it is not a failure of this suite.
    for (let i = errors.length - 1; i >= 0; i--) if (/newer version of the app/.test(errors[i])) errors.splice(i, 1);

    // Q13: if reading the database to plan the upgrade throws (here: a damaged database), the page
    // says why instead of staying blank. Before the fix planMigrations() ran outside the try.
    const saved = await page.evaluate(() => {
      const keep = {};
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('kvvfs-local')) keep[k] = localStorage.getItem(k); }
      for (const k of Object.keys(keep)) if (/^kvvfs-local-\d+$/.test(k)) localStorage.setItem(k, 'not a database page '.repeat(40));
      return keep;
    });
    await page.goto(`${BASE}/data-backup.html`, { waitUntil: 'networkidle' });
    const damagedError = await page.evaluate(() => import('/local-bootstrap.js').then(() => null, (e) => e.message));
    const damagedShown = await page.getByRole('alert').filter({ hasText: 'could not open your data' }).count();
    check('Q13: a database that cannot be read at start-up is said on screen, not a blank page', damagedError !== null && damagedShown === 1, `${damagedShown} alert(s); error: ${damagedError}`);
    await page.evaluate((keep) => { for (const [k, v] of Object.entries(keep)) localStorage.setItem(k, v); }, saved);
    if (damagedError) for (let i = errors.length - 1; i >= 0; i--) if (errors[i] === damagedError) errors.splice(i, 1);
    await openFresh();
    check('…and the data opens again once it is readable', (await api('GET', '/api/ledgers')).status === 200);

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
