// Phase 7 — browser-side backup-crypto suite (npm run test:backup-crypto). Kept OUT of the default
// node:test suite for the same reason test-ui/run.js is: it needs a real browser (Web Crypto,
// scrypt-js) and is slow. Boots local-server.js (no Express, no API — the local-only path) and drives
// Playwright Chromium over it.
//
// Covers, per Phase 7's requirements:
//   1) browser-side equivalents of test/backup-crypto.test.js's four cases (round trip, wrong
//      passphrase, tampered ciphertext, empty passphrase).
//   2) cross-compatibility in both directions — Node encrypts/browser decrypts, and vice versa.
//   3) the full encrypted export/import routes wired into local-api.js, round-tripped against a
//      live, already-current-schema kvvfs database.
//   4) the PRAGMA user_version carry-over: restoring a genuinely pre-tenancy snapshot (same shape as
//      test/_tenancy-migrate-fixture.js) through the browser's import-encrypted route, encrypted by
//      Node, and confirming init() migrates it up to the current schema afterward — the exact gap
//      Phase 4b found and this phase exists to close.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), crypto = require('crypto'), fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const nodeBackupCrypto = require('../backup-crypto');

const PORT = 8092;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

function buildPreTenancyFixture() {
  // Same shape as test/_tenancy-migrate-fixture.js — a genuinely pre-tenancy, pre-Services-phase
  // database, built by hand, with an inflated sqlite_sequence simulating past deletes.
  const dbPath = path.join(os.tmpdir(), `plannr-p7-oldshape-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
  const d = new DatabaseSync(dbPath);
  d.exec('PRAGMA foreign_keys = ON');
  d.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE contract(id INTEGER PRIMARY KEY AUTOINCREMENT, contractor_name TEXT, area_of_work TEXT, ledger_code TEXT, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, amount_paise INTEGER, price_of_contract_paise INTEGER, contract_end_date TEXT, date_signed TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
    CREATE TABLE contract_payment_dates(id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE, pay_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE contractor_payments(id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL REFERENCES contract(id), pay_date TEXT NOT NULL, amount_paise INTEGER NOT NULL, ledger_code TEXT, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, phase INTEGER, subpart TEXT, remarks TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
    CREATE TABLE cash_in(id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER NOT NULL, tx_date TEXT, by_type TEXT NOT NULL, by_user_id INTEGER REFERENCES users(id), by_label TEXT, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
    CREATE TABLE cash_out(id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER NOT NULL, tx_date TEXT, by_type TEXT NOT NULL, by_user_id INTEGER REFERENCES users(id), by_label TEXT, ledger_code TEXT NOT NULL, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, reason TEXT, contract_scope TEXT NOT NULL, contract_stated_paise INTEGER, phase INTEGER, subpart TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
    CREATE TABLE loans(id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER, bank_name TEXT, interest_rate REAL, tenure TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_cash_out_ledger_code ON cash_out(ledger_code);
    CREATE UNIQUE INDEX idx_contract_single_live ON contract((deleted_at IS NULL)) WHERE deleted_at IS NULL;
  `);
  d.prepare('INSERT INTO users(id,username,display_name,password_hash) VALUES (1,?,?,?)').run('owner', 'Owner', 'h');
  for (let i = 0; i < 3; i++) d.prepare("INSERT INTO cash_out(amount_paise,tx_date,by_type,by_user_id,ledger_code,contract_scope) VALUES (?,?,?,?,?,?)").run(1000 * (i + 1), '2025-03-0' + (i + 1), 'user', 1, '4.0', 'extra');
  d.exec("UPDATE sqlite_sequence SET seq=17 WHERE name='cash_out'");
  d.prepare("INSERT INTO settings(key,value) VALUES ('budget_paise', ?)").run('4200000');
  d.exec('PRAGMA journal_mode = DELETE'); // Phase 4a: WASM builds can't open a WAL-stamped file
  d.close();
  const bytes = fs.readFileSync(dbPath);
  fs.unlinkSync(dbPath);
  return bytes;
}

(async () => {
  const server = spawn(process.execPath, ['local-server.js', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 500));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  try {
    await page.goto(`${BASE}/data-backup.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!(window.scrypt && window.scrypt.scrypt), { timeout: 10000 });

    // ---- 1. Browser-side equivalents of test/backup-crypto.test.js's four cases ----
    const self = await page.evaluate(async () => {
      const mod = await import('/backup-crypto.js');
      const plain = new TextEncoder().encode('a plausible backup payload, repeated. '.repeat(50));
      const enc = await mod.encrypt(plain, 'a-correct-backup-passphrase-123');
      const dec = await mod.decrypt(enc, 'a-correct-backup-passphrase-123');
      const roundTripOk = dec.length === plain.length && dec.every((b, i) => b === plain[i]);
      let wrongPassThrew = false;
      try { await mod.decrypt(enc, 'the-wrong-passphrase'); } catch { wrongPassThrew = true; }
      const tampered = new Uint8Array(enc); tampered[tampered.length - 1] ^= 0xff;
      let tamperThrew = false;
      try { await mod.decrypt(tampered, 'a-correct-backup-passphrase-123'); } catch { tamperThrew = true; }
      let emptyPassThrew = false;
      try { await mod.encrypt(plain, ''); } catch { emptyPassThrew = true; }
      return { roundTripOk, wrongPassThrew, tamperThrew, emptyPassThrew };
    });
    check('round trip: encrypt then decrypt reproduces the input', self.roundTripOk);
    check('wrong passphrase fails loudly (never returns garbage)', self.wrongPassThrew);
    check('a tampered ciphertext fails the auth tag', self.tamperThrew);
    check('an empty passphrase is refused (no key derived from nothing)', self.emptyPassThrew);

    // ---- 2. Cross-compatibility, both directions ----
    const PASS = 'cross-compat-passphrase-456';
    const plainText = 'SQLite format 3\0' + 'x'.repeat(2000);
    const plainBuf = Buffer.from(plainText, 'binary');
    const nodeEnc = nodeBackupCrypto.encrypt(plainBuf, PASS);
    const browserDecryptedNode = await page.evaluate(async ({ encArray, pass }) => {
      const mod = await import('/backup-crypto.js');
      const dec = await mod.decrypt(new Uint8Array(encArray), pass);
      return { text: new TextDecoder('latin1').decode(dec), looksLikeSqlite: mod.looksLikeSqlite(dec) };
    }, { encArray: Array.from(nodeEnc), pass: PASS });
    check('cross-compat: a file encrypted by Node decrypts in the browser', browserDecryptedNode.text === plainText);
    check('cross-compat: the browser recognizes it as SQLite-shaped', browserDecryptedNode.looksLikeSqlite);

    const browserEncArray = await page.evaluate(async ({ text, pass }) => {
      const mod = await import('/backup-crypto.js');
      const enc = await mod.encrypt(new TextEncoder().encode(text), pass);
      return Array.from(enc);
    }, { text: plainText, pass: PASS });
    const nodeDecryptedBrowser = nodeBackupCrypto.decrypt(Buffer.from(browserEncArray), PASS).toString('binary');
    check('cross-compat: a file encrypted by the browser decrypts in Node (vice versa)', nodeDecryptedBrowser === plainText);
    let nodeRejectsWrongPassOnBrowserFile = false;
    try { nodeBackupCrypto.decrypt(Buffer.from(browserEncArray), 'wrong-one'); } catch { nodeRejectsWrongPassOnBrowserFile = true; }
    check('cross-compat: Node rejects a wrong passphrase on a browser-encrypted file', nodeRejectsWrongPassOnBrowserFile);

    // ---- Seed the fixed local owner (same as the Phase 5 gate) so the app's own bootstrap works ----
    await page.evaluate(async () => {
      const dbMod = await import('/db.js');
      if (dbMod.db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
        dbMod.db.prepare("INSERT INTO users (username, display_name, password_hash) VALUES ('demo','Demo Owner','x')").run();
      }
    });

    // ---- 3. Full route wiring: export-encrypted -> import-encrypted round trip on a LIVE db ----
    const EXPORT_PASS = 'export-import-roundtrip-pass';
    const roundTrip = await page.evaluate(async (passphrase) => {
      // A real row, so the round trip has something to verify.
      const before = await (await fetch('/api/cash-in', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountRupees: '500', txDate: '2026-01-01', byType: 'user', byUserId: 1, reason: 'route-wiring check' }),
      })).json();

      const exportRes = await fetch('/api/backup/export-encrypted', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase }),
      });
      if (!exportRes.ok) return { ok: false, stage: 'export', error: (await exportRes.json()).error };
      const blob = await exportRes.blob();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let binary = ''; const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
      const dataBase64 = btoa(binary);

      const importRes = await fetch('/api/backup/import-encrypted', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase, dataBase64 }),
      });
      const importBody = await importRes.json();
      if (!importRes.ok) return { ok: false, stage: 'import', error: importBody.error };

      const dbMod = await import('/db.js');
      const row = dbMod.db.prepare('SELECT amount_paise, reason FROM cash_in WHERE id = ?').get(before.entry.id);
      const userVersion = dbMod.db.prepare('PRAGMA user_version').get().user_version;
      return { ok: true, exportedLength: buf.length, row, userVersion };
    }, EXPORT_PASS);
    check('encrypted export/import routes round-trip a live database', roundTrip.ok, JSON.stringify(roundTrip));
    if (roundTrip.ok) {
      check('  ...the seeded row survives the round trip', roundTrip.row && roundTrip.row.amount_paise === 50000 && roundTrip.row.reason === 'route-wiring check');
      check('  ...user_version is unchanged for an already-current snapshot', roundTrip.userVersion === 2, `got ${roundTrip.userVersion}`);
    }

    // ---- 4. The crux: PRAGMA user_version travels through a real migration on restore ----
    const oldShapeBytes = buildPreTenancyFixture();
    const oldShapeEnc = nodeBackupCrypto.encrypt(Buffer.from(oldShapeBytes), PASS);
    const migrationResult = await page.evaluate(async ({ encArray, passphrase }) => {
      // Chunked, not String.fromCharCode(...encArray) — this fixture is tens of KB, enough to risk a
      // call-stack overflow spreading that many arguments (the same reason data-backup.html's real
      // upload handler chunks it too).
      const bytes = new Uint8Array(encArray);
      let binary = ''; const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      const res = await fetch('/api/backup/import-encrypted', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase, dataBase64: btoa(binary) }),
      });
      const body = await res.json();
      if (!res.ok) return { ok: false, error: body.error };
      const dbMod = await import('/db.js');
      const userVersion = dbMod.db.prepare('PRAGMA user_version').get().user_version;
      const hasTenantId = dbMod.db.prepare("PRAGMA table_info(cash_out)").all().some((c) => c.name === 'tenant_id');
      const cashOut = dbMod.db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount_paise),0) s FROM cash_out').get();
      const seq = dbMod.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='cash_out'").get();
      const info = dbMod.db.prepare("INSERT INTO cash_out (amount_paise, tx_date, by_type, ledger_code, contract_scope) VALUES (1,'2026-01-01','user','4.0','extra')").run();
      const fkCheck = dbMod.db.prepare('PRAGMA foreign_key_check').all();
      return { ok: true, userVersion, hasTenantId, cashOut, seq, newRowId: info.lastInsertRowid, fkCheck };
    }, { encArray: Array.from(oldShapeEnc), passphrase: PASS });
    check('restoring a genuinely pre-tenancy snapshot succeeds', migrationResult.ok, JSON.stringify(migrationResult));
    if (migrationResult.ok) {
      check('  ...PRAGMA user_version travels and init() migrates it to current (2)', migrationResult.userVersion === 2, `got ${migrationResult.userVersion}`);
      check('  ...tenant_id was never left behind (Step 2a still runs correctly)', migrationResult.hasTenantId === false);
      check('  ...cash_out data survived the migration (3 rows, 6000 paise)', migrationResult.cashOut.n === 3 && migrationResult.cashOut.s === 6000, JSON.stringify(migrationResult.cashOut));
      check('  ...sqlite_sequence high-water mark preserved (no id reuse)', migrationResult.newRowId > 17, `new id=${migrationResult.newRowId}, old seq=17`);
      check('  ...foreign_key_check clean after restore + migration', migrationResult.fkCheck.length === 0, JSON.stringify(migrationResult.fkCheck));
    }
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${failures === 0 ? '✓ BACKUP-CRYPTO SUITE PASSED' : '✗ BACKUP-CRYPTO SUITE FAILED (' + failures + ')'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
