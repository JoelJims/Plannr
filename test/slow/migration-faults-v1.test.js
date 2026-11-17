// Step 1.4 B4: the baseline failure matrix (see test/migration-faults.test.js, part B) for the
// schema-history fixtures at user_version 1: databases made before 2026-08-23, which still carry the
// tenant_id columns that legacyInit()'s `userVersion < 2` block takes off. About 120 failure points
// each; about a minute in all, so it runs with `npm run test:slow`.
//
// What holds at EVERY failure point: init() reports the failure; user_version is not raised; the
// safety snapshot holds the database exactly as it was; no row the finished upgrade keeps is
// missing; no value is anything but its old or its new value; the file is not damaged.
//
// KNOWN BUG (found by B4, in legacyInit() code older than B4; the old and the new runner behave
// exactly the same, see test/migration-equivalence.test.js). That block is several transactions and
// is not safe to run again on a database it has partly changed. After a failure past its first
// committed rebuild (the last 52 failure points of each fixture, up to and including the final
// version stamp):
//   - the next start refuses (a foreign_key_check or "no such column" error), every time;
//   - and before refusing, it DROPS contract_services with all its rows: the old-shape check near the
//     top of legacyInit() ("user_version < 2 and no tenant_id column") mistakes the already-rebuilt
//     table for the pre-Phase-5 one.
// The safety snapshot taken before the upgrade still holds every row (asserted below), so the data
// can be recovered by restoring it; but each refused start adds a snapshot, and after three more the
// keep-newest-3 rule rotates the good one out. Only databases made before 2026-08-23 (user_version 1)
// can reach this, and only if their upgrade fails part-way. The fix needs a decision (see
// docs/step-1.4-storage-plan.md, B4); this test pins today's behaviour exactly, so it fails, and says
// so, the moment that behaviour changes for better or worse.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const L = require('../fixtures/schema-history/lib');
const H = require('../fixtures/schema-history/harness');

const MAN = L.manifest();
const START = new Date(Date.now() - 2000).toISOString().replace('T', ' ').slice(0, 19);
const MASK = L.maskSince(START);
// Per fixture: failure points after which the next start refuses, and how many of those lose rows
// (see KNOWN BUG above). Each such loss is exactly every contract_services row, nothing else.
const KNOWN_REFUSALS = { '01-7cfcf89.sql': 52, '02-2ebaf69.sql': 52, '03-42ff006.sql': 52 };
const KNOWN_LOSSES = { '01-7cfcf89.sql': 52, '02-2ebaf69.sql': 52, '03-42ff006.sql': 52 };

let h;
before(() => { h = H.createHarness('plannr-faults-v1-'); });
after(() => h && h.cleanup());

test('historic baseline, user_version 1 fixtures: a failed write at every step keeps the data and the snapshot; the KNOWN BUG on the next start is exactly as pinned', async () => {
  const fixtures = MAN.fixtures.filter((f) => f.userVersion === 1);
  assert.deepStrictEqual(fixtures.map((f) => f.file), Object.keys(KNOWN_REFUSALS));
  const cases = await H.baselineFaults(h, fixtures, MASK);
  const base = new Map(fixtures.map((f) => [f.commit, H.baseInfo(h, f, MASK)]));
  const refused = {};
  const lost = {};
  for (const c of cases) {
    const label = `${c.f.file}, write ${c.at} of ${c.writes} fails (${c.sql.slice(0, 70)})`;
    const b = base.get(c.f.commit);
    assert.deepStrictEqual(H.duringFailureProblems(c, b), [], label);
    if (c.restart.ok) {
      assert.deepStrictEqual(c.after.fp, c.final.fp, `${label}: a next start that finishes gives exactly the uninterrupted upgrade`);
      assert.deepStrictEqual(c.after.checks, { integrity: 'ok', foreignKeyViolations: 0 }, `${label}: ...and a sound file`);
    } else {
      refused[c.f.file] = (refused[c.f.file] || 0) + 1;
      const problems = H.dataProblems(b.rows, c.final.rows, c.after.rows);
      if (problems.length) {
        lost[c.f.file] = (lost[c.f.file] || 0) + 1;
        // KNOWN BUG: the refused start dropped contract_services. Nothing else may be lost.
        const services = [...b.rows.contract_services.keys()].filter((k) => c.final.rows.contract_services.has(k));
        assert.deepStrictEqual(problems, services.map((k) => `contract_services row ${k} is missing`), `${label}: the refused start loses contract_services (KNOWN BUG) and nothing else`);
      }
      assert.strictEqual(c.after.checks.integrity, 'ok', `${label}: after the refused start, the file is not damaged`);
      assert.strictEqual(c.after.fp.userVersion, 1, `${label}: after the refused start, user_version is not raised`);
      // The way back: the snapshot from before the upgrade is still there, with every row.
      assert.ok(c.after.snapshots.length >= 1 && c.after.snapshots.length <= 3, `${label}: ${c.after.snapshots.length} snapshots`);
      assert.deepStrictEqual(L.fingerprintFile(c.after.snapshots[0]), b.fp, `${label}: the snapshot before the upgrade is still there`);
    }
  }
  assert.deepStrictEqual(refused, KNOWN_REFUSALS, 'the failure points after which the next start refuses (KNOWN BUG): if this changed, find out why before updating KNOWN_REFUSALS');
  assert.deepStrictEqual(lost, KNOWN_LOSSES, 'the refused starts that drop contract_services (KNOWN BUG): if this changed, find out why before updating KNOWN_LOSSES');
});
