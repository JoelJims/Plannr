// Phase 2, Step 9 follow-up — the Android share sheet is never put on a timer, and closing it is
// not reported as an error. @capacitor/share's Share.share() resolves only after the user has
// picked where the file goes (or rejects with "Share canceled" when they close the sheet). A 20 s
// timeout around it reported "✗ … timed out after 20s" while the sheet was still open (seen on the
// emulator), so a backup saved after that was never marked as exported.
// These pages are plain HTML with inline scripts, so the checks read the source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

for (const page of ['data-backup.html', 'overview.html']) {
  test(`${page}: Share.share() is not wrapped in withTimeout`, () => {
    const src = read(page);
    const calls = (src.match(/^.*Share\.share\(.*$/gm) || []).filter((l) => !l.trim().startsWith('//'));
    assert.strictEqual(calls.length, 1, 'one share call per page');
    assert.doesNotMatch(calls[0], /withTimeout/);
    assert.match(calls[0], /await Share\.share\(/);
  });

  test(`${page}: a closed share sheet gets its own plain message, not the error path`, () => {
    const src = read(page);
    const after = src.slice(src.indexOf('await Share.share('));
    assert.match(after.slice(0, 900), /\/cancel\/i\.test\(errText\(err\)\)/);
  });
}

test('data-backup.html: a cancelled save is not marked as exported and stops the CSV import', () => {
  const src = read('data-backup.html');
  const body = src.slice(src.indexOf('async function saveFile('), src.indexOf('const today = () =>'));
  // The cancel branch throws before the code that marks the backup as exported.
  const cancel = body.indexOf('e.cancelled = true;');
  const thrown = body.indexOf('throw e;', cancel);
  const marked = body.lastIndexOf('await markBackupExported()');
  assert.ok(cancel > 0 && thrown > cancel && marked > thrown, 'cancel throws before markBackupExported');
  // The CSV import's safety backup: cancelling means nothing is imported, said plainly.
  assert.match(src, /if \(err\.cancelled\) ledgerCsvMsg\.show\('Import stopped: the safety backup was not saved, so nothing was imported\./);
});
