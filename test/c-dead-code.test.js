// Workstream C clean-up: no top-level helper in the two backends' entry files is defined and then
// never used. A name that appears only once in its file (its own definition) is dead code.
// The check reads the files as text; it does not start the server or open a database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = ['server.js', 'local-server.js', 'public/local-api.js'];

for (const file of FILES) {
  test(`${file}: every top-level function is used somewhere in the file`, () => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const names = [...src.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)\(|^const ([A-Za-z0-9_$]+) = (?:async )?\(/gm)].map((m) => m[1] || m[2]);
    assert.ok(names.length > 0, 'found the top-level functions');
    const uses = (n) => src.split(/[^A-Za-z0-9_$]+/).filter((word) => word === n).length;
    const unused = names.filter((n) => uses(n) < 2);
    assert.deepStrictEqual(unused, [], `defined but never used: ${unused.join(', ')}`);
  });
}
