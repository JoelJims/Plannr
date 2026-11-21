// Phase 2, Step 5; step 1.4 C12 — Android Auto Backup: kept on, and limited to exactly the data: the
// database file (with its journal) and the marker since step 1.4, and the WebView's localStorage (the
// database before the move, the old copy after it while it is kept). Safety snapshots stay on the
// phone (decision D2). The 25 MB budget itself is measured in a browser: test-ui/storage-limit.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const PATHS = [
  'database:plannrSQLite.db',                // the database file (step 1.4)
  'database:plannrSQLite.db-journal',        // its rollback journal, if a write was in progress
  'file:plannr-storage.json',                // the marker: which storage is in use
  'root:app_webview/Default/Local Storage/', // localStorage (kvvfs), current WebView
  'root:app_webview/Local Storage/',         // localStorage (kvvfs), older WebView
];
// Every <include>/<exclude> in a block of rules XML, as "domain:path".
const rules = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}\\s+domain="([^"]+)"\\s+path="([^"]+)"\\s*/>`, 'g'))].map((m) => `${m[1]}:${m[2]}`);
const block = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); assert.ok(m, `<${name}> present`); return m[1]; };
const noComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');
const allIncludes = () => ['backup_rules.xml', 'data_extraction_rules.xml'].flatMap((f) => rules(noComments(read(`android/app/src/main/res/xml/${f}`)), 'include'));

test('the manifest keeps Auto Backup on and points at both rules files', () => {
  const m = noComments(read(MANIFEST));
  assert.match(m, /android:allowBackup="true"/);
  assert.match(m, /android:fullBackupContent="@xml\/backup_rules"/);
  assert.match(m, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
});

test('Android 6-11 rules (fullBackupContent) back up exactly the database file, its journal, the marker and localStorage', () => {
  const xml = noComments(read('android/app/src/main/res/xml/backup_rules.xml'));
  assert.deepStrictEqual(rules(block(xml, 'full-backup-content'), 'include'), PATHS);
  assert.deepStrictEqual(rules(xml, 'exclude'), []);
});

test('Android 12+ rules (dataExtractionRules) list the same paths, for cloud backup and device transfer', () => {
  const xml = noComments(read('android/app/src/main/res/xml/data_extraction_rules.xml'));
  for (const section of ['cloud-backup', 'device-transfer']) assert.deepStrictEqual(rules(block(xml, section), 'include'), PATHS, section);
  assert.deepStrictEqual(rules(xml, 'exclude'), []);
});

test('nothing from a cache folder is included', () => {
  const inc = allIncludes();
  assert.ok(!inc.some((r) => /cache/i.test(r)), inc.join(', '));
});

test('left out: the safety snapshots (decision D2), the candidate of a move, files set aside', () => {
  const inc = allIncludes();
  assert.ok(!inc.some((r) => /safety-snapshots|moving|setaside/.test(r)), inc.join(', '));
  // Every database rule names one file exactly (no folder, which would take the candidate and the
  // files set aside with it).
  for (const r of inc.filter((x) => x.startsWith('database:'))) assert.match(r, /^database:plannrSQLite\.db(?:-journal)?$/);
});

test('the names in the rules are the files the app uses (public/storage-native.js)', () => {
  const src = read('public/storage-native.js');
  const main = src.match(/export const MAIN_NAME = '([^']+)';/)[1];
  const marker = src.match(/export const MARKER_FILE = '([^']+)';/)[1];
  assert.ok(PATHS.includes(`database:${main}SQLite.db`), `the plugin's file for "${main}"`);
  assert.ok(PATHS.includes(`database:${main}SQLite.db-journal`));
  assert.ok(PATHS.includes(`file:${marker}`));
  // The places those names live: the plugin's databases folder and the app's files folder.
  assert.match(src, /main: `\$\{databases\}\/\$\{MAIN_NAME\}SQLite\.db`/);
  assert.match(src, /marker: `\$\{files\}\/\$\{MARKER_FILE\}`/);
});

test('README states the privacy position exactly', () => {
  assert.ok(read('README.md').includes("Plannr works fully offline and your data stays on your device. Optional features use the internet only when you use them. Android's own Auto Backup may save a copy to your Google account."));
});
