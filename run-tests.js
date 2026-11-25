// `npm test` entrypoint: run the node:test suite AND enforce the whole-run safety invariant that the
// live data/plannr.db is never opened — record its mtime before and after and assert it's unchanged.
// (Uses Node's built-in runner; no test framework dependency.)
//
// Two passes:
// 1. Every test file, against server.js (the dev server) — as before.
// 2. Cross-platform plan, step 1.1: the test files that go through test/helpers.js, again, against
//    the PHONE's API code (public/local-api.js) — PLANNR_TEST_TARGET=shim. Known, explained
//    differences are listed in test/phone-code-differences.json. Pass 2 fails on any OTHER failure,
//    and also when a listed test starts passing or no longer exists (so the list stays true).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const LIVE = path.join(__dirname, 'data', 'plannr.db');
const stamp = () => (fs.existsSync(LIVE) ? fs.statSync(LIVE).mtimeMs : null);

// `npm test` runs main(); requiring this file (test/ws2a-run-tests.test.js) only loads its functions.
if (require.main === module) main();

function main() {
  const before = stamp();
  console.log(`[run-tests] data/plannr.db mtime BEFORE: ${before === null ? '(absent)' : new Date(before).toISOString()}`);

  const files = fs.readdirSync(path.join(__dirname, 'test'))
    .filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));

  // --- pass 1: server.js -----------------------------------------------------------------------------
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: __dirname });
  const pass1 = r.status == null ? 1 : r.status;

  // --- pass 2: the phone's API code --------------------------------------------------------------------
  const pass2 = runPhonePass(files);

  const after = stamp();
  console.log(`[run-tests] data/plannr.db mtime AFTER:  ${after === null ? '(absent)' : new Date(after).toISOString()}`);

  if (before !== after) {
    console.error('[run-tests] ✖ FAIL: data/plannr.db was modified during the run — the suite must NEVER open the live database.');
    process.exit(1);
  }
  console.log('[run-tests] ✓ data/plannr.db mtime unchanged — the live database was never opened.');
  process.exit(pass1 || pass2);
}

// F10: a test file goes through test/helpers.js when it requires './helpers': any quote style, with
// or without '.js', spaces allowed inside the parentheses.
function usesHelpers(source) {
  return /\brequire\(\s*(['"`])\.\/helpers(?:\.js)?\1\s*\)/.test(source);
}

function runPhonePass(files) {
  const helperFiles = files.filter((f) => usesHelpers(fs.readFileSync(path.join(__dirname, f), 'utf8')));
  const listFile = path.join(__dirname, 'test', 'phone-code-differences.json');
  const known = JSON.parse(fs.readFileSync(listFile, 'utf8')).differences;
  const keyOf = (file, test) => `${file} :: ${test}`;
  const knownKeys = new Set(known.map((d) => keyOf(d.file, d.test)));

  const xml = path.join(os.tmpdir(), `plannr-phone-pass-${process.pid}-${crypto.randomBytes(4).toString('hex')}.xml`);
  console.log(`\n[run-tests] phone code: running ${helperFiles.length} test files against public/local-api.js ...`);
  const p = spawnSync(process.execPath, ['--test', '--test-reporter=junit', `--test-reporter-destination=${xml}`, ...helperFiles], {
    cwd: __dirname, env: { ...process.env, PLANNR_TEST_TARGET: 'shim' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  let report = '';
  try { report = fs.readFileSync(xml, 'utf8'); } catch { /* handled below */ }
  fs.rmSync(xml, { force: true });
  const cases = parseJunit(report);
  if (!cases.length) {
    console.error('[run-tests] ✖ phone code: the run produced no test results. Its output:');
    console.error(`${p.stdout || ''}${p.stderr || ''}`.slice(-4000));
    return 1;
  }

  const seen = new Set();
  const newFailures = [], nowPassing = [];
  for (const c of cases) {
    const k = keyOf(c.file, c.name);
    seen.add(k);
    if (c.failed && !knownKeys.has(k)) newFailures.push(c);
    if (!c.failed && knownKeys.has(k)) nowPassing.push(k);
  }
  const missing = known.map((d) => keyOf(d.file, d.test)).filter((k) => !seen.has(k));
  const failed = cases.filter((c) => c.failed).length;
  console.log(`[run-tests] phone code: ${cases.length - failed} of ${cases.length} tests pass; ${failed} fail, ${failed - newFailures.length} of them known differences (test/phone-code-differences.json).`);

  for (const c of newFailures) console.error(`[run-tests] ✖ phone code: NEW failure — ${keyOf(c.file, c.name)}\n    ${c.message.split('\n').slice(0, 6).join('\n    ')}`);
  for (const k of nowPassing) console.error(`[run-tests] ✖ phone code: listed as a known difference but now PASSES — remove it from the list: ${k}`);
  for (const k of missing) console.error(`[run-tests] ✖ phone code: listed as a known difference but no such test ran — update the list: ${k}`);
  if (newFailures.length || nowPassing.length || missing.length) return 1;
  console.log('[run-tests] ✓ phone code: no failures beyond the known differences.');
  return 0;
}

// Node's JUnit reporter: one <testcase name=".." file=".."> per test, with a <failure> child when it
// failed. Attribute values may contain a raw ">" (e.g. "back up -> restore"), so attributes are read
// one by one rather than with a [^>]* shortcut.
function parseJunit(text) {
  const out = [];
  const unxml = (s) => s.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (_, e) => (
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : e === 'amp' ? '&'
      : String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));
  const re = /<testcase((?:\s+[\w:-]+="[^"]*")*)\s*(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(text))) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = unxml(a[2]);
    const body = m[3] || '';
    const failure = body.match(/<failure\b((?:\s+[\w:-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/failure>)/);
    out.push({
      name: attrs.name,
      file: path.basename(attrs.file || ''),
      failed: !!failure,
      message: failure ? unxml(((failure[1].match(/message="([^"]*)"/) || [])[1] || '') + '\n' + (failure[2] || '')).trim() : '',
    });
  }
  return out;
}

module.exports = { usesHelpers, parseJunit };
