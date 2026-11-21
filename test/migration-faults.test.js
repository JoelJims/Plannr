// Step 1.4 B4: a failure at any point of an upgrade, on the schema-history fixtures (see
// test/migration-equivalence.test.js and test/fixtures/schema-history/).
//
// A. The numbered steps (a made-up chain v3..v5, through the new await init()), every fixture: each
//    step in turn fails after doing its writes. The database must be exactly as before that step (the
//    earlier steps kept, user_version on the last good step), the safety snapshot must exist and hold
//    the database as it was before the upgrade, and the next start must finish the upgrade.
//
// B. The historic baseline (legacyInit()), fixtures already at user_version 2: a write fails, as on a
//    crash or a full disk, at the first time each distinct statement runs and at every BEGIN and
//    COMMIT. legacyInit() is a series of separate steps, not one transaction, so an interrupted
//    upgrade can be part done. What must hold: init() reports the failure; user_version is not raised;
//    the safety snapshot was written before anything changed and holds the database exactly as it was
//    (if the snapshot itself fails, nothing changed at all); no row the finished upgrade keeps is
//    missing and no value is anything but its old or its new value; and the next start finishes with
//    exactly the database an uninterrupted upgrade gives.
//    The user_version 1 fixtures (databases from before 2026-08-23) take longer and have known limits;
//    they are in test/slow/migration-faults-v1.test.js (npm run test:slow).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const L = require('./fixtures/schema-history/lib');
const H = require('./fixtures/schema-history/harness');

const MAN = L.manifest();
const START = new Date(Date.now() - 2000).toISOString().replace('T', ' ').slice(0, 19);
const MASK = L.maskSince(START);

let h;
before(() => { h = H.createHarness('plannr-faults-'); });
after(() => h && h.cleanup());

test('A. numbered steps: a failing step leaves the database exactly as before that step; the snapshot exists; the next start finishes', async () => {
  const groups = [];
  const cases = [];
  for (const f of MAN.fixtures) {
    const refs = {};
    for (const upTo of [2, 3, 4, 5]) { refs[upTo] = h.fresh(f, `ref-${upTo}`); groups.push([{ db: refs[upTo], run: 'init', approve: true, chain: { upTo } }]); }
    for (const failAt of [3, 4, 5]) {
      const db = h.fresh(f, `fail-${failAt}`);
      groups.push([{ db, run: 'init', approve: true, chain: { failAt } }]);
      cases.push({ f, failAt, db, refs, group: groups.length - 1 });
    }
  }
  const out = await h.runGroups(groups);
  for (const g of groups) if (g[0].chain.upTo) assert.ok(out[groups.indexOf(g)][0].ok, `reference run: ${out[groups.indexOf(g)][0].error || ''}`);
  // Right after the failure.
  const restarts = [];
  for (const c of cases) {
    const { f, failAt, db, refs } = c;
    const label = `${f.file}, v${failAt} fails`;
    const r = out[c.group][0];
    assert.strictEqual(r.ok, false, `${label}: init() rejects`);
    assert.match(r.error, new RegExp(`upgrade to schema v${failAt} .*failed and was rolled back; your data is unchanged at v${failAt - 1}\\. Cause: test step v${failAt} failed on purpose`), label);
    const got = L.fingerprintFile(db, { mask: MASK });
    assert.strictEqual(got.userVersion, failAt - 1, `${label}: user_version stays on the last good step`);
    assert.deepStrictEqual(got, L.fingerprintFile(refs[failAt - 1], { mask: MASK }), `${label}: schema and every table exactly as before the failed step`);
    const snaps = H.snapshotsBeside(db);
    assert.strictEqual(snaps.length, 1, `${label}: one safety snapshot`);
    assert.deepStrictEqual(L.fingerprintFile(snaps[0]), L.fingerprintFile(h.baseFile(f)), `${label}: it holds the database before the upgrade`);
    assert.deepStrictEqual(L.checks(db), { integrity: 'ok', foreignKeyViolations: 0 }, `${label}: the file is sound`);
    restarts.push([{ db, run: 'init', approve: true, chain: {} }]);
  }
  // The next start (the fixed app) finishes the upgrade.
  const again = await h.runGroups(restarts);
  cases.forEach((c, i) => {
    const label = `${c.f.file}, v${c.failAt} failed`;
    assert.ok(again[i][0].ok, `${label}: the next start finishes (${again[i][0].error || ''})`);
    assert.deepStrictEqual(L.fingerprintFile(c.db, { mask: MASK }), L.fingerprintFile(c.refs[5], { mask: MASK }), `${label}: ...with exactly the uninterrupted upgrade`);
    assert.deepStrictEqual(L.fingerprintFile(H.snapshotsBeside(c.db)[0]), L.fingerprintFile(h.baseFile(c.f)), `${label}: the first snapshot is still the database before the upgrade`);
  });
});

test('B. historic baseline, user_version 2 fixtures: a failed write at every step keeps the data and the snapshot, and the next start finishes', async () => {
  const fixtures = MAN.fixtures.filter((f) => f.userVersion === 2);
  const cases = await H.baselineFaults(h, fixtures, MASK);
  const base = new Map(fixtures.map((f) => [f.commit, H.baseInfo(h, f, MASK)]));
  for (const c of cases) {
    const label = `${c.f.file}, write ${c.at} of ${c.writes} fails (${c.sql.slice(0, 70)})`;
    assert.deepStrictEqual(H.duringFailureProblems(c, base.get(c.f.commit)), [], label);
    assert.ok(c.restart.ok, `${label}: the next start finishes (${c.restart.error || ''})`);
    assert.deepStrictEqual(c.after.fp, c.final.fp, `${label}: the next start gives exactly the uninterrupted upgrade`);
    assert.deepStrictEqual(c.after.checks, { integrity: 'ok', foreignKeyViolations: 0 }, `${label}: after the next start, the file is sound`);
  }
  assert.ok(cases.length >= 90, `${cases.length} failure points checked`);
});
