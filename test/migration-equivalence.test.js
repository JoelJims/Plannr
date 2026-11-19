// Step 1.4 B4: the async migration runner does exactly what the old synchronous one did.
//
// test/fixtures/schema-history/ holds one test database for every distinct schema db.js has ever
// built (made by running each historical db.js from git; see make-fixtures.js), with made-up rows,
// and the OLD runner: db.js and ledgers.js exactly as they were at 0e7b70b, before B4.
//
// Every fixture is upgraded two ways, each on its own copy and in its own process: the old init() and
// the new await init(). (Until B17 a third, the transition initSync(), was compared too.) Each runs
// with and without the approvals the destructive one-off steps need. The two must agree on the outcome
// (success, or the same refusal) and leave the same database: the same schema, the same user_version
// and the same checksum for every table. The numbered-step runner itself is compared the same way
// (old runMigrations with synchronous steps, new one with async steps).
//
// Step 1.4 B5: every write each runner makes is recorded (test/_schema-history-child.js), and the
// two must make the same writes in the same order: legacyInit()'s calls, awaited by init(), are the
// old runner's calls one for one.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const L = require('./fixtures/schema-history/lib');
const H = require('./fixtures/schema-history/harness');

const ROOT = path.join(__dirname, '..');
const MAN = L.manifest();
const VARIANTS = [{ name: 'not approved', approve: false }, { name: 'approved', approve: true }];
const RUNNERS = ['old-init', 'init'];
// Rows init() seeds while upgrading get datetime('now'); hide those values, compare every other one.
const START = new Date(Date.now() - 2000).toISOString().replace('T', ' ').slice(0, 19);
const MASK = L.maskSince(START);

let h;
let TMP;
let OLD_DB_JS;
const results = {}; // `${fixture}|${variant}|${runner}` -> { result, db }
const runChild = (modulePath, jobs) => h.runChild(modulePath, jobs);
const { snapshotsBeside } = H;

before(async () => {
  h = H.createHarness('plannr-equivalence-');
  TMP = h.tmp;
  // The old runner runs from a copy in the temp folder (its db.js makes a data/ folder beside itself).
  const oldDir = path.join(TMP, 'old-runner');
  fs.mkdirSync(oldDir);
  for (const f of ['db.js', 'ledgers.js']) fs.copyFileSync(path.join(L.DIR, MAN.oldRunner.dir, f), path.join(oldDir, f));
  OLD_DB_JS = path.join(oldDir, 'db.js');

  const jobs = { 'old-init': [], init: [] };
  for (const f of MAN.fixtures) {
    const base = L.loadFixture(f, path.join(TMP, `${f.commit}.base.db`));
    for (const v of VARIANTS) {
      for (const r of RUNNERS) {
        const dir = path.join(TMP, f.commit, v.approve ? 'approved' : 'plain', r);
        fs.mkdirSync(dir, { recursive: true });
        const db = path.join(dir, 'plannr.db');
        fs.copyFileSync(base, db);
        jobs[r].push({ db, run: r, approve: v.approve, key: `${f.file}|${v.name}|${r}`, fault: { record: true } }); // record every write (none fails)
      }
    }
  }
  const out = await Promise.all(RUNNERS.map((r) => runChild(r === 'old-init' ? OLD_DB_JS : H.DB_JS, jobs[r])));
  RUNNERS.forEach((r, i) => jobs[r].forEach((j, k) => { results[j.key] = { result: out[i][k], db: j.db }; }));
});
after(() => h && h.cleanup());

test('the old runner kept for comparison is exactly db.js and ledgers.js at 0e7b70b', () => {
  for (const [f, blob] of Object.entries(MAN.oldRunner.blobs)) {
    const bytes = fs.readFileSync(path.join(L.DIR, MAN.oldRunner.dir, f));
    const id = require('node:crypto').createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.strictEqual(id, blob, `${f} is the 0e7b70b file byte for byte`);
  }
  // In a git checkout, also against the history itself.
  try { assert.strictEqual(execFileSync('git', ['rev-parse', `${MAN.oldRunner.commit}:db.js`], { cwd: ROOT, encoding: 'utf8' }).trim(), MAN.oldRunner.blobs['db.js']); } catch (e) { if (e.code !== 'ENOENT' && !/not a git repository|unknown revision/i.test(String(e.stderr || e.message))) throw e; }
});

test('there is a fixture for every schema db.js has built, from user_version 1 to today', () => {
  assert.ok(MAN.fixtures.length >= 8, `${MAN.fixtures.length} fixtures`);
  assert.deepStrictEqual([...new Set(MAN.fixtures.map((f) => f.userVersion))].sort(), [1, 2]);
  for (const f of MAN.fixtures) {
    for (const [t, n] of Object.entries(f.tables)) if (t !== 'sqlite_sequence' && t !== 'edit_locks' && t !== 'sessions') assert.ok(n > 0, `${f.file}: ${t} has rows`);
  }
});

for (const f of MAN.fixtures) {
  for (const v of VARIANTS) {
    test(`${f.file} (${v.name}): old init() and await init() leave the same database`, () => {
      const [old, neu] = RUNNERS.map((r) => results[`${f.file}|${v.name}|${r}`]);
      assert.deepStrictEqual({ ok: neu.result.ok, error: neu.result.error }, { ok: old.result.ok, error: old.result.error }, 'await init(): same outcome as the old init()');
      const want = L.fingerprintFile(old.db, { mask: MASK });
      assert.deepStrictEqual(L.fingerprintFile(neu.db, { mask: MASK }), want, 'await init(): same schema, user_version and table checksums');
      assert.deepStrictEqual(L.checks(neu.db), L.checks(old.db));
      // Step 1.4 B5: await init() makes the old runner's writes, in the same order.
      // (The safety snapshot, VACUUM INTO a file named by path and time, is checked further down.)
      const writes = (r) => r.result.log.filter((w) => !/^VACUUM INTO /.test(w));
      assert.ok(writes(neu).length > 0, 'writes were recorded');
      assert.deepStrictEqual(writes(neu), writes(old), 'the same writes as the old init(), in the same order');
      if (v.approve) {
        assert.ok(old.result.ok, `with approval every past database upgrades (${old.result.error || ''})`);
        assert.strictEqual(want.userVersion, 2);
        assert.deepStrictEqual(L.checks(old.db), { integrity: 'ok', foreignKeyViolations: 0 });
      }
      // Safety snapshots: wherever the old runner took one, the new ones did too, and each holds the
      // fixture exactly as it was. (The new one also takes one before the one-off clean-ups on a v2
      // database from an older app, which the old runner skipped; see planMigrations in db.js.)
      const base = L.fingerprintFile(path.join(TMP, `${f.commit}.base.db`));
      if (snapshotsBeside(old.db).length) assert.strictEqual(snapshotsBeside(neu.db).length, 1);
      for (const r of [old, neu]) for (const s of snapshotsBeside(r.db)) assert.deepStrictEqual(L.fingerprintFile(s), base, `${path.basename(s)} is the database before the upgrade`);
    });
  }
}

test('the new runner takes a snapshot before every upgrade that changes something, the old one did not always', () => {
  for (const f of MAN.fixtures) {
    const neu = results[`${f.file}|approved|init`];
    const changed = JSON.stringify(L.fingerprintFile(neu.db, { mask: MASK })) !== JSON.stringify(L.fingerprintFile(path.join(TMP, `${f.commit}.base.db`), { mask: MASK }));
    if (changed) assert.strictEqual(snapshotsBeside(neu.db).length, 1, `${f.file}: the upgrade changed the database, so a snapshot was taken first`);
  }
});

test('numbered steps: the old runMigrations (sync steps) and the new one (async steps) give the same database', async () => {
  const jobs = { old: [], neu: [] };
  for (const f of MAN.fixtures) {
    const start = results[`${f.file}|approved|init`].db; // every fixture, upgraded to v2
    for (const failAt of [null, 4]) {
      for (const side of ['old', 'neu']) {
        const db = path.join(TMP, 'chain', `${f.commit}-${failAt || 'ok'}-${side}.db`);
        fs.mkdirSync(path.dirname(db), { recursive: true });
        fs.copyFileSync(start, db);
        jobs[side].push({ db, run: side === 'old' ? 'old-runMigrations' : 'runMigrations', chain: { failAt }, key: `${f.file}|${failAt}` });
      }
    }
  }
  const [oldOut, neuOut] = await Promise.all([runChild(OLD_DB_JS, jobs.old), runChild(H.DB_JS, jobs.neu)]);
  jobs.old.forEach((o, i) => {
    const n = jobs.neu[i];
    assert.deepStrictEqual(neuOut[i], oldOut[i], `${o.key}: same steps applied (or the same error)`);
    assert.deepStrictEqual(L.fingerprintFile(n.db), L.fingerprintFile(o.db), `${o.key}: same database`);
    const v = L.fingerprintFile(n.db).userVersion;
    assert.strictEqual(v, o.key.endsWith('|4') ? 3 : 5, `${o.key}: user_version`);
  });
  assert.ok(neuOut.every((r, i) => (jobs.neu[i].key.endsWith('|4') ? /v4 .*rolled back; your data is unchanged at v3/.test(r.error) : r.ok)));
});
