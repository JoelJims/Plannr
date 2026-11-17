// Step 1.4 B4: the baseline failure matrix (see test/migration-faults.test.js, part B) for the
// schema-history fixtures at user_version 1: databases made before 2026-08-23, which still carry the
// tenant_id columns that legacyInit()'s `userVersion < 2` block takes off. About 115 failure points
// each; about a minute in all, so it runs with `npm run test:slow`.
//
// What holds at EVERY failure point: init() reports the failure; user_version is not raised; the
// safety snapshot holds the database exactly as it was; no row the finished upgrade keeps is
// missing; no value is anything but its old or its new value; the file is not damaged. Then the next
// start either finishes with exactly the uninterrupted upgrade, or refuses without losing anything.
//
// This test found two bugs, fixed in B4 (test/upgrade-retry.test.js covers each directly): the next
// start dropped contract_services with every row (52 failure points per fixture), and each refused
// start's snapshot could rotate the one from before the upgrade out.
//
// KNOWN LIMIT (older code, not changed in B4): the v1 block is several transactions and not every
// part of it can run again on a database it has partly changed. After a failure in its last steps
// (10 failure points per fixture, the last of them the version stamp itself) the next start refuses
// once ("no such column: contract_allowance_id"); the start after that finishes, with exactly the
// uninterrupted upgrade. Nothing is lost on the way, and the snapshot from before the upgrade is
// there throughout. Making those steps restartable is option 3 in docs/step-1.4-storage-plan.md
// (B4). This test pins both numbers, so a change either way shows.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../fixtures/schema-history/lib');
const H = require('../fixtures/schema-history/harness');

const MAN = L.manifest();
const START = new Date(Date.now() - 2000).toISOString().replace('T', ' ').slice(0, 19);
const MASK = L.maskSince(START);
// Per fixture: failure points after which the next start refuses (see KNOWN LIMIT above).
const KNOWN_REFUSALS = { '01-7cfcf89.sql': 10, '02-2ebaf69.sql': 10, '03-42ff006.sql': 10 };
const MORE_STARTS = 3;

let h;
before(() => { h = H.createHarness('plannr-faults-v1-'); });
after(() => h && h.cleanup());

test('historic baseline, user_version 1 fixtures: a failed write at every step keeps the data and the snapshot, and the next starts lose nothing', async () => {
  const fixtures = MAN.fixtures.filter((f) => f.userVersion === 1);
  assert.deepStrictEqual(fixtures.map((f) => f.file), Object.keys(KNOWN_REFUSALS));
  const cases = await H.baselineFaults(h, fixtures, MASK);
  const base = new Map(fixtures.map((f) => [f.commit, H.baseInfo(h, f, MASK)]));
  const label = (c) => `${c.f.file}, write ${c.at} of ${c.writes} fails (${c.sql.slice(0, 70)})`;
  const refused = {};
  const refusing = [];
  for (const c of cases) {
    const b = base.get(c.f.commit);
    assert.deepStrictEqual(H.duringFailureProblems(c, b), [], label(c));
    assert.deepStrictEqual(H.dataProblems(b.rows, c.final.rows, c.after.rows), [], `${label(c)}: after the next start, no data lost`);
    assert.strictEqual(c.after.checks.integrity, 'ok', `${label(c)}: after the next start, the file is not damaged`);
    if (c.restart.ok) {
      assert.deepStrictEqual(c.after.fp, c.final.fp, `${label(c)}: a next start that finishes gives exactly the uninterrupted upgrade`);
      assert.deepStrictEqual(c.after.checks, { integrity: 'ok', foreignKeyViolations: 0 }, `${label(c)}: ...and a sound file`);
    } else {
      refused[c.f.file] = (refused[c.f.file] || 0) + 1;
      refusing.push(c);
      assert.match(c.restart.error, /no such column: contract_allowance_id/, `${label(c)}: the KNOWN LIMIT, not something new`);
      assert.strictEqual(c.after.fp.userVersion, 1, `${label(c)}: after the refused start, user_version is not raised`);
    }
  }
  assert.deepStrictEqual(refused, KNOWN_REFUSALS, 'the failure points after which the next start refuses (KNOWN LIMIT): if this changed, find out why before updating KNOWN_REFUSALS');

  // Where the next start refused: start again until one finishes (at most MORE_STARTS more). At every
  // step nothing may be lost and the snapshot from before the upgrade must be there; the one that
  // finishes gives exactly the uninterrupted upgrade, and clears the record of the unfinished one.
  const refusals = new Map(refusing.map((c) => [c, 1]));
  let open = refusing;
  for (let k = 1; k <= MORE_STARTS && open.length; k++) {
    const out = await h.runGroups(open.map((c) => [{ db: c.db, run: 'init', approve: true }]));
    open.forEach((c, i) => {
      const b = base.get(c.f.commit);
      const where = `${label(c)}, start ${k + 2}`;
      const snaps = H.snapshotsBeside(c.db);
      assert.ok(snaps.length <= 3, `${where}: ${snaps.length} snapshots`);
      assert.deepStrictEqual(L.fingerprintFile(snaps[0]), b.fp, `${where}: the snapshot from before the upgrade is there`);
      assert.deepStrictEqual(H.dataProblems(b.rows, c.final.rows, L.rowsByKey(c.db, { mask: MASK })), [], `${where}: no data lost`);
      const pending = fs.existsSync(path.join(path.dirname(c.db), 'safety-snapshots', 'plannr-upgrade-pending.json'));
      if (out[i][0].ok) {
        assert.deepStrictEqual(L.fingerprintFile(c.db, { mask: MASK }), c.final.fp, `${where}: finishes with exactly the uninterrupted upgrade`);
        assert.deepStrictEqual(L.checks(c.db), { integrity: 'ok', foreignKeyViolations: 0 }, `${where}: ...and a sound file`);
        assert.ok(!pending, `${where}: the record of the unfinished upgrade is cleared`);
      } else {
        refusals.set(c, refusals.get(c) + 1);
        assert.ok(pending, `${where}: refused, so the upgrade is still recorded as unfinished`);
      }
    });
    open = open.filter((c, i) => !out[i][0].ok);
  }
  assert.deepStrictEqual(open.map(label), [], `every database finishes within ${MORE_STARTS + 2} starts`);
  assert.deepStrictEqual([...new Set(refusals.values())], [1], 'KNOWN LIMIT: each refuses exactly once, then the next start finishes');
});
