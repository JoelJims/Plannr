// The old copy's size on the Data Backup page (owner's decision, 2026-11-28: "one source, the same
// rounding"). After the move to the new storage, the storage meter and the storage-move section showed
// the same old copy as 0.2 MB and 0.3 MB. Two causes:
//   - two byte counts: the meter took what the old copy holds in localStorage now (GET /api/storage,
//     as backupBytes - databaseBytes); the move section took the database's size on the day of the
//     move (marker.oldCopy.bytes in the marker file);
//   - two roundings: the meter's mb() rounded to the nearest 0.1 MB, the move section's mbText() up.
// Now there is one byte count, the oldCopyBytes of the /api/storage answer (what localStorage holds,
// which is what Android's Google backup counts and what deleting the old copy frees), and one
// formatter, core/size-text.js mbText(), which rounds up so a size never reads smaller than it is.
// The rendered page is checked in test-ui/storage-move-ui.js (scenario 3: the two numbers agree).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const MB = 1024 * 1024;

test('mbText: 0.21 MB reads 0.3 MB (rounded up), the same for every caller', async () => {
  const { mbText } = await load('core/size-text.js');
  assert.strictEqual(mbText(Math.round(0.21 * MB)), '0.3 MB');
  assert.strictEqual(mbText(236544), '0.3 MB', 'the old copy in the storage-move UI suite: 0.2256 MB');
  assert.strictEqual(mbText(311296), '0.3 MB', 'its database on the day of the move: 0.2969 MB');
});

test('mbText: "under 0.1 MB" below 0.1 MB; at and above it, up to the next 0.1 MB', async () => {
  const { mbText } = await load('core/size-text.js');
  for (const [bytes, text] of [
    [0, 'under 0.1 MB'], [1, 'under 0.1 MB'], [104857, 'under 0.1 MB'], // 0.1 MB is 104,857.6 bytes
    [104858, '0.2 MB'], [0.5 * MB, '0.5 MB'], [0.5 * MB + 1, '0.6 MB'],
    [MB, '1.0 MB'], [MB + 1, '1.1 MB'], [25 * MB, '25.0 MB'], [25 * MB - 1, '25.0 MB'],
  ]) assert.strictEqual(mbText(bytes), text, `${bytes} bytes`);
  assert.strictEqual(mbText(null), 'under 0.1 MB', 'no number is not a size: nothing above zero is claimed');
});

test('mbText never shows a size smaller than it is, nor 0.1 MB or more larger', async () => {
  const { mbText } = await load('core/size-text.js');
  for (let bytes = Math.ceil(MB / 10); bytes <= 30 * MB; bytes += 997) {
    const shown = Number(/^([\d.]+) MB$/.exec(mbText(bytes))[1]);
    const real = bytes / MB;
    assert.ok(shown >= real && shown - real < 0.1, `${bytes} bytes = ${real} MB shown as ${shown} MB`);
  }
});

test('one byte count: the /api/storage answer says how big the old copy is', async () => {
  const { storageAnswer } = await load('core/routes/storage.js');
  const a = storageAnswer({ kind: 'file', databaseBytes: 311296, oldCopyBytes: 236544, freeBytes: 8e9 });
  assert.strictEqual(a.oldCopyBytes, 236544);
  assert.strictEqual(a.backupBytes, 311296 + 236544, 'the Google backup estimate counts the same bytes');
  assert.strictEqual(storageAnswer({ kind: 'file', databaseBytes: 311296, freeBytes: 8e9 }).oldCopyBytes, 0, 'no old copy reported: none');
  assert.strictEqual(storageAnswer({ kind: 'localstorage', usedBytes: 1, limitBytes: 2 }).oldCopyBytes, null, 'before the move there is no old copy');
  assert.strictEqual(storageAnswer({ kind: 'desktop', databaseBytes: 1 }).oldCopyBytes, null);
});

// The two displays are browser code (an inline page script and a page module that imports the
// phone's plugins), so what they use is read from their source.
test('the storage meter takes the old copy from the answer and writes it with the shared mbText', () => {
  const page = read('public/data-backup.html');
  assert.match(page, /\{ mbText \} = await import\('\/core\/size-text\.js'\)/, 'data-backup.html imports mbText from core/size-text.js');
  const sentence = /if \(s\.kind === 'file'\) \{[\s\S]*?\n {8}\}/.exec(page);
  assert.ok(sentence, 'the meter has its "file" branch');
  assert.match(sentence[0], /const oldCopy = Number\(s\.oldCopyBytes\) \|\| 0;/, 'the old copy is the answer\'s oldCopyBytes');
  assert.doesNotMatch(sentence[0], /backupBytes - s\.databaseBytes/, 'not worked out from the backup estimate');
  assert.match(sentence[0], /With the old copy \(\$\{mbText\(oldCopy\)\}\)/, 'the old copy is written with mbText');
  assert.doesNotMatch(sentence[0], /\$\{mb\(oldCopy\)\}/, 'not with the meter\'s own mb() (nearest 0.1 MB)');
});

test('the storage-move section takes the old copy from the same answer and writes it with the same mbText', () => {
  const ui = read('public/storage-move-ui.js');
  assert.match(ui, /import \{ mbText \} from '\.\/core\/size-text\.js';/, 'storage-move-ui.js imports mbText from core/size-text.js');
  assert.doesNotMatch(ui, /const mbText\s*=/, 'and has no size formatter of its own');
  assert.doesNotMatch(ui, /oldCopy\.bytes/, 'the size shown is not the marker\'s size from the day of the move');
  assert.match(ui, /fetch\('\/api\/storage'\)/, 'it asks GET /api/storage');
  assert.match(ui, /\.oldCopyBytes/, 'and reads the old copy\'s bytes from the answer');
});
