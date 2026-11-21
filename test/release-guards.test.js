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
  const tracked = git.stdout.split('\n').filter((f) => /(\.keystore|\.jks|keystore\.properties)$/i.test(f));
  assert.deepStrictEqual(tracked, []);
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
