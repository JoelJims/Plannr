// Step 1.4 A3: the desktop backup scripts after the switch to core/backup-crypto.js.
//
// backup-db.js (what backup-db.cmd runs) and decrypt-db.js are run as real child processes, but
// ONLY on a throwaway test database in the OS temp folder: PLANNR_DB, PLANNR_BACKUP_DIR and the
// output path all point there, and PLANNR_BACKUP_PASSPHRASE is set, so neither script reads .env.
// run-tests.js separately checks that data/plannr.db was never touched.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), `plannr-backup-cli-${process.pid}-`));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));

const TEST_PASS = 'test-only-cli-passphrase-123';
const run = (script, args, env) => spawnSync(process.execPath, [script, ...args], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env },
});

function makeTestDb(file) {
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = DELETE');
  d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT, amount_paise INTEGER)');
  const ins = d.prepare('INSERT INTO t (label, amount_paise) VALUES (?, ?)');
  for (let i = 1; i <= 25; i++) ins.run(`row ${i}\r\nwith a line break`, i * 100);
  d.close();
}

test('backup-db.js writes an encrypted snapshot of a test database, and decrypt-db.js restores it', () => {
  const src = path.join(WORK, 'source.db');
  const backups = path.join(WORK, 'backups');
  makeTestDb(src);
  const before = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');

  const b = run('backup-db.js', [], { PLANNR_DB: src, PLANNR_BACKUP_DIR: backups, PLANNR_BACKUP_PASSPHRASE: TEST_PASS, PLANNR_BACKUP_KEEP: '14' });
  assert.strictEqual(b.status, 0, b.stderr + b.stdout);
  assert.match(b.stdout, /ENCRYPTED aes-256-gcm; verified decryptable/);
  const files = fs.readdirSync(backups).filter((f) => f.endsWith('.db.enc'));
  assert.strictEqual(files.length, 1);
  const enc = fs.readFileSync(path.join(backups, files[0]));
  assert.strictEqual(enc.subarray(0, 4).toString('latin1'), 'PLBK');
  assert.ok(!b.stdout.includes(TEST_PASS) && !b.stderr.includes(TEST_PASS), 'the passphrase is never printed');
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex'), before, 'the source is never changed');

  const out = path.join(WORK, 'restored.db');
  const d = run('decrypt-db.js', [path.join(backups, files[0]), out], { PLANNR_BACKUP_PASSPHRASE: TEST_PASS });
  assert.strictEqual(d.status, 0, d.stderr + d.stdout);
  assert.match(d.stdout, /decrypted, looks like SQLite/);
  const r = new DatabaseSync(out, { readOnly: true });
  try {
    const row = r.prepare('SELECT COUNT(*) n, SUM(amount_paise) s FROM t').get();
    assert.deepStrictEqual({ ...row }, { n: 25, s: 32500 });
    assert.strictEqual(r.prepare('SELECT label FROM t WHERE id = 3').get().label, 'row 3\r\nwith a line break');
  } finally { r.close(); }
});

test('decrypt-db.js refuses a wrong passphrase, prints no passphrase, and writes nothing', () => {
  const backups = path.join(WORK, 'backups');
  const file = fs.readdirSync(backups).find((f) => f.endsWith('.db.enc'));
  assert.ok(file, 'the previous test made a backup');
  const out = path.join(WORK, 'should-not-exist.db');
  const wrong = 'test-only-wrong-passphrase-456';
  const d = run('decrypt-db.js', [path.join(backups, file), out], { PLANNR_BACKUP_PASSPHRASE: wrong });
  assert.strictEqual(d.status, 1);
  assert.match(d.stderr, /wrong passphrase/);
  assert.ok(!d.stdout.includes(wrong) && !d.stderr.includes(wrong));
  assert.ok(!fs.existsSync(out));
});

test('decrypt-db.js opens both golden files (made by the pre-1.4 desktop and phone code)', () => {
  const dir = path.join(__dirname, 'fixtures', 'backup-kat');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  // The golden plaintext is test bytes that start like SQLite, not a real database; decrypt-db.js
  // only checks that header, so it writes them out and the bytes must match exactly.
  for (const f of manifest.files) {
    const out = path.join(WORK, `golden-${f.file}.out`);
    const d = run('decrypt-db.js', [path.join(dir, f.file), out], { PLANNR_BACKUP_PASSPHRASE: manifest.passphrase });
    assert.strictEqual(d.status, 0, d.stderr + d.stdout);
    assert.ok(fs.readFileSync(out).equals(fs.readFileSync(path.join(dir, manifest.plaintext.file))), f.file);
  }
});
