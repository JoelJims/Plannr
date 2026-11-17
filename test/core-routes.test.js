// Cross-platform plan, step 1.3: route groups move into core/routes/, the one copy both backends run.
// These checks keep each moved group moved: both copies register it, neither still defines its
// routes itself, and the phone's copy in public/core/ is the same file.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { FILES, CORE_FILES } = require('../sync-public-modules');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ROUTE_FILES = CORE_FILES.filter((f) => f.startsWith('core/routes/'));
const SERVER = read('server.js');
const PHONE = read('public/local-api.js');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "GET /api/x" for every app.<method>('/api/x' ...) in a file, plus the four routes makeLedgerCrud
// (core/ledger-crud.js) builds from each `basePath: '/api/x'`.
const routesIn = (src, obj) => [
  ...[...src.matchAll(new RegExp(`\\b${obj}\\.(get|post|put|delete)\\(\\s*['\`](/api/[^'\`]+)['\`]`, 'g'))]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`),
  ...[...src.matchAll(/\bbasePath:\s*'(\/api\/[^']+)'/g)]
    .flatMap(([, p]) => [`GET ${p}`, `POST ${p}`, `PUT ${p}/:id`, `DELETE ${p}/:id`]),
];

test('there is at least one moved route group', () => {
  assert.ok(ROUTE_FILES.length > 0, 'core/routes/ is empty');
});

for (const f of ROUTE_FILES) {
  test(`${f}: both copies register it`, () => {
    // register(api, coreContext), or register(api, { ...coreContext, more }) when a group needs more.
    // (api: server.js's route table through the request queue, step 1.4 B5.)
    assert.match(SERVER, new RegExp(`require\\('\\./${esc(f)}'\\)\\.register\\(api, [^\\n]*coreContext`), 'server.js');
    const imp = PHONE.match(new RegExp(`import \\* as (\\w+) from '\\./${esc(f)}';`));
    assert.ok(imp, 'public/local-api.js imports it');
    assert.match(PHONE, new RegExp(`\\b${imp[1]}\\.register\\(localApp, [^\\n]*coreContext`), 'public/local-api.js registers it');
  });

  test(`${f}: neither copy still defines its routes`, () => {
    const moved = routesIn(read(f), 'app');
    assert.ok(moved.length > 0, 'no routes found in the core file');
    assert.deepStrictEqual([...routesIn(SERVER, 'app'), ...routesIn(SERVER, 'api')].filter((r) => moved.includes(r)), [], 'server.js');
    assert.deepStrictEqual(routesIn(PHONE, 'localApp').filter((r) => moved.includes(r)), [], 'public/local-api.js');
  });
}

for (const f of CORE_FILES) {
  test(`${f}: the functions and constants it defines are defined nowhere else`, () => {
    const src = read(f);
    const names = [
      ...[...src.matchAll(/\bfunction\s+(\w+)\s*\(/g)].map((m) => m[1]),
      ...[...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]),
    ].filter((n) => n !== 'register');
    for (const n of names) {
      const defined = new RegExp(`\\bfunction\\s+${n}\\s*\\(|\\b(?:const|let|var)\\s+${n}\\s*=`);
      assert.ok(!defined.test(SERVER), `server.js still defines ${n}`);
      assert.ok(!defined.test(PHONE), `public/local-api.js still defines ${n}`);
    }
  });

  test(`${f}: imports only shared modules, by relative path`, () => {
    for (const [, spec] of read(f).matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.match(spec, /^\.\.?\//, `${spec} is not a relative path`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      assert.ok(FILES.includes(target), `${spec} -> ${target} is not copied to public/`);
    }
  });

  test(`${f}: public/${f} is the same file (run "npm run sync:public-modules" if not)`, () => {
    assert.ok(fs.readFileSync(path.join(ROOT, 'public', f)).equals(fs.readFileSync(path.join(ROOT, f))));
  });
}
