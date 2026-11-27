// Phase 2, Step 7 — safe-update guards. An update installed over the old app keeps the user's data
// ONLY if all of this stays the same:
//   · the application id (com.plannr.app) — a different id is a different app, with empty storage;
//   · the WebView origin, https://localhost — the database lives in that origin's localStorage, so a
//     different scheme (androidScheme) or host (server.hostname) opens an EMPTY database;
//   · the signing key — Android refuses to install an update signed with a different key.
// These tests fail if any of the first two change, and check the release key can never be committed.
// They are about the user's data, not style: do not "fix" one by editing the expected value.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP_ID = 'com.plannr.app';

test('capacitor.config.json: the app id is unchanged', () => {
  assert.strictEqual(JSON.parse(read('capacitor.config.json')).appId, APP_ID);
});

test('capacitor.config.json: the WebView origin stays https://localhost (where the data lives)', () => {
  const cfg = JSON.parse(read('capacitor.config.json'));
  const server = cfg.server || {};
  // Unset means Capacitor's default (checked against Capacitor itself in the next test).
  assert.strictEqual(server.androidScheme ?? 'https', 'https', 'server.androidScheme must stay "https" (or unset)');
  assert.strictEqual(server.hostname ?? 'localhost', 'localhost', 'server.hostname must stay "localhost" (or unset)');
  assert.strictEqual(cfg.android && cfg.android.androidScheme, undefined, 'no android.androidScheme override');
  assert.strictEqual(server.url, undefined, 'server.url would load the app from somewhere else entirely');
});

test('Capacitor\'s own defaults are still https + localhost (an upgrade that changed them would empty the app)', () => {
  const capConfig = read('node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/CapConfig.java');
  const bridge = read('node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/Bridge.java');
  assert.match(capConfig, /private String hostname = "localhost";/);
  assert.match(capConfig, /private String androidScheme = CAPACITOR_HTTPS_SCHEME;/);
  assert.match(bridge, /CAPACITOR_HTTPS_SCHEME = "https";/);
});

test('the Android project uses the same app id everywhere', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /namespace = "com\.plannr\.app"/);
  assert.match(gradle, /applicationId "com\.plannr\.app"/);
  const strings = read('android/app/src/main/res/values/strings.xml');
  assert.match(strings, /<string name="package_name">com\.plannr\.app<\/string>/);
});

test('the release key and its passwords are git-ignored and not tracked', () => {
  const ignore = read('.gitignore').split(/\r?\n/);
  assert.ok(ignore.includes('*.keystore'), '.gitignore lists *.keystore');
  assert.ok(ignore.includes('keystore.properties'), '.gitignore lists keystore.properties');
  const git = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  if (git.status !== 0) return; // not a git checkout (e.g. a downloaded zip): nothing can be committed
  // Every key and certificate file type .gitignore blocks (SETUP.md section 2), not only the keystore.
  const tracked = git.stdout.split('\n').filter((f) => /(\.keystore|\.jks|\.p12|\.pem|keystore\.properties)$/i.test(f));
  assert.deepStrictEqual(tracked, []);
  // And git really ignores the key and its properties file (a later "!" line could undo the rule).
  const samples = ['plannr-release.keystore', 'keystore.properties'];
  const ignored = spawnSync('git', ['check-ignore', '--no-index', ...samples], { cwd: ROOT, encoding: 'utf8' });
  assert.deepStrictEqual(ignored.stdout.split(/\r?\n/).filter(Boolean).sort(), [...samples].sort());
});

// Review S9: other key and certificate files, per-environment .env files, and what the app exports or
// a phone pull brings back (they hold ledger data) are git-ignored too, and git really ignores them.
test('other keys, .env variants and exported data files are git-ignored', () => {
  const ignore = read('.gitignore').split(/\r?\n/);
  for (const p of ['*.jks', '*.p12', '*.pem', '.env.*', 'plannr-backup-*.json', 'plannr-*.csv', 'plannr-overview-*.pdf', '*.db.gz', 'auto-snapshot-before-import-*.json']) {
    assert.ok(ignore.includes(p), `.gitignore lists ${p}`);
  }
  const samples = ['upload.jks', 'cert.p12', 'key.pem', '.env.local', 'plannr-backup-2026-11-21.json', 'plannr-cash-outflow-2026-11-21.csv',
    'plannr-overview-full-2026-11-21.pdf', 'pulled.db.gz', 'auto-snapshot-before-import-2026-11-21T10-00-00.json'];
  const git = spawnSync('git', ['check-ignore', '--no-index', ...samples], { cwd: ROOT, encoding: 'utf8' });
  if (git.status !== 0 && git.status !== 1) return; // no git or not a checkout: the list check above still ran
  assert.deepStrictEqual(git.stdout.split(/\r?\n/).filter(Boolean).sort(), [...samples].sort());
  const keep = spawnSync('git', ['check-ignore', '--no-index', '.env.example'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(keep.status, 1, '.env.example stays committable');
});

// Key BACKUPS and copies are as secret as the key itself (a zipped or renamed keystore still signs
// updates): git ignores them too, while ordinary .zip/.bak files the repo might need stay committable.
const KEY_BACKUP_SAMPLES = ['plannr-release.keystore.bak', 'plannr-release.keystore.zip', 'plannr-release.keystore.old',
  'key-backup.zip', 'plannr-key-backup.7z', 'release-key-backup', 'plannr-keystore-backup.zip', 'plannr-release-keystore.zip',
  'keystore.properties.bak', 'keystore - Copy.properties', 'upload.jks.bak', 'cert.p12.zip', 'key.pem.old', 'upload.pfx',
  'keys/plannr-release.keystore.bak'];
const KEY_BACKUP_NAME = /(\.keystore\.|\.jks\.|\.p12\.|\.pem\.|\.pfx$|key-backup|keystore-backup|keystore[^/]*\.(zip|7z)$|(^|\/)keystore[^/]*\.properties|keystore\.properties\.)/i;

test('key backups and copies are git-ignored, and no tracked file is a key or a key backup', () => {
  for (const name of KEY_BACKUP_SAMPLES) assert.match(name, KEY_BACKUP_NAME, `the name check covers ${name}`);
  const git = spawnSync('git', ['check-ignore', '--no-index', ...KEY_BACKUP_SAMPLES], { cwd: ROOT, encoding: 'utf8' });
  if (git.status !== 0 && git.status !== 1) return; // not a git checkout: nothing can be committed
  assert.deepStrictEqual(git.stdout.split(/\r?\n/).filter(Boolean).sort(), [...KEY_BACKUP_SAMPLES].sort(),
    'git check-ignore must list every key-backup name');
  // Ordinary archives and backups the repo may need are NOT swept up by the key rules.
  for (const keep of ['docs/screenshots.zip', 'test/fixtures/sample.zip', 'notes.bak', 'backup-db.js', 'core/backup-crypto.js', 'monkey.zip']) {
    const one = spawnSync('git', ['check-ignore', '--no-index', keep], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(one.status, 1, `${keep} stays committable`);
  }
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const keyish = tracked.filter((f) => KEY_BACKUP_NAME.test(f) || /(\.keystore|\.jks|\.p12|\.pem|\.pfx|keystore\.properties)$/i.test(f));
  assert.deepStrictEqual(keyish, [], 'no tracked file is a key or a key backup');
});
