// Workstream C clean-up: no top-level helper in the two backends' entry files is defined and then
// never used. A name that appears only once in its file (its own definition) is dead code.
// The check reads the files as text; it does not start the server or open a database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = ['server.js', 'local-server.js', 'public/local-api.js'];
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
// The private top-level helpers (an export is used by other files, so it is not counted).
const topLevelFunctions = (src) => [...src.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)\(|^const ([A-Za-z0-9_$]+) = (?:async )?\(/gm)].map((m) => m[1] || m[2]);

// The pattern still finds them (server.js has many). A file may have none: public/local-api.js has
// had no private helper since its storage-full text became the shared one (request-rules.js, Q11).
test('the check finds the top-level functions', () => {
  assert.ok(topLevelFunctions(read('server.js')).length > 0, 'found the top-level functions in server.js');
});

for (const file of FILES) {
  test(`${file}: every top-level function is used somewhere in the file`, () => {
    const src = read(file);
    const names = topLevelFunctions(src);
    const uses = (n) => src.split(/[^A-Za-z0-9_$]+/).filter((word) => word === n).length;
    const unused = names.filter((n) => uses(n) < 2);
    assert.deepStrictEqual(unused, [], `defined but never used: ${unused.join(', ')}`);
  });
}
