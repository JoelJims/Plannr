// Phase 2, Step 5 — Android Auto Backup: kept on, and limited to exactly the ledger (the WebView's
// localStorage, where the sqlite-wasm database lives) and the safety snapshots. The 25 MB budget
// itself is measured in a browser with storage full: test-ui/storage-limit.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const PATHS = [
  'root:app_webview/Default/Local Storage/', // the ledger, current WebView
  'root:app_webview/Local Storage/',         // the ledger, older WebView
  'file:safety-snapshots/',                  // Directory.Data/safety-snapshots/
];
// Every <include>/<exclude> in a block of rules XML, as "domain:path".
const rules = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}\\s+domain="([^"]+)"\\s+path="([^"]+)"\\s*/>`, 'g'))].map((m) => `${m[1]}:${m[2]}`);
const block = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); assert.ok(m, `<${name}> present`); return m[1]; };
const noComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');

test('the manifest keeps Auto Backup on and points at both rules files', () => {
  const m = noComments(read(MANIFEST));
  assert.match(m, /android:allowBackup="true"/);
  assert.match(m, /android:fullBackupContent="@xml\/backup_rules"/);
  assert.match(m, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
});

test('Android 6-11 rules (fullBackupContent) back up exactly the ledger and the snapshots', () => {
  const xml = noComments(read('android/app/src/main/res/xml/backup_rules.xml'));
  assert.deepStrictEqual(rules(block(xml, 'full-backup-content'), 'include'), PATHS);
});

test('Android 12+ rules (dataExtractionRules) list the same paths, for cloud backup and device transfer', () => {
  const xml = noComments(read('android/app/src/main/res/xml/data_extraction_rules.xml'));
  for (const section of ['cloud-backup', 'device-transfer']) assert.deepStrictEqual(rules(block(xml, section), 'include'), PATHS, section);
});

test('nothing from a cache folder is included', () => {
  for (const f of ['backup_rules.xml', 'data_extraction_rules.xml']) {
    const inc = rules(noComments(read(`android/app/src/main/res/xml/${f}`)), 'include');
    assert.ok(!inc.some((r) => /cache/i.test(r)), `${f}: ${inc.join(', ')}`);
  }
});

test('the snapshot folder in the rules is the one the app writes to', () => {
  const src = read('public/safety-snapshots.js');
  assert.match(src, /export const DIR = 'safety-snapshots';/);
  assert.match(src, /directory: Directory\.Data/);
});

test('README states the privacy position exactly', () => {
  assert.ok(read('README.md').includes("Plannr makes no network requests. Android's own Auto Backup may copy the app's data to your Google account; you can turn this off in Android settings."));
});
