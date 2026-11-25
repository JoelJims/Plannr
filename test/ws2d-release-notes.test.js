// The 1.0.0 release notes for users, and the README's Install section that points to them.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the 1.0.0 release notes cover privacy, backup first, install and the Play Protect warning', () => {
  const notes = read('docs/release-notes-1.0.0.md');
  // The same privacy sentence as the README, word for word.
  assert.ok(notes.includes("Plannr works fully offline and your data stays on your device. Optional features use the internet only when you use them. Android's own Auto Backup may save a copy to your Google account."));
  assert.match(notes, /back up first/i);
  assert.match(notes, /Never uninstall Plannr/);
  assert.match(notes, /Play Protect/);
  assert.match(notes, /## How to install/);
});

test('README Install still says the download is coming soon and links the release notes', () => {
  const readme = read('README.md');
  const install = readme.slice(readme.indexOf('## Install'), readme.indexOf('## Built with'));
  assert.ok(install.includes('**Download coming soon.**'));
  assert.ok(install.includes('(docs/release-notes-1.0.0.md)'), 'Install links the release notes');
});
