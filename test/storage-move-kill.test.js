// Step 1.4 C6: the storage move stopped at every step (plan §2.2, §5.1).
//   - A forced failure (a thrown error) at every checkpoint: the localStorage copy is unchanged, no
//     candidate is left, and the app is back where it was before (it still uses localStorage).
//   - A real process kill at 20 points spread over steps 2-6 (test/_storage-move-child.js): a fresh
//     process then reads the facts, the startup table decides, "Continue" finishes, and the final
//     checks pass. No run may end with both copies unusable, or with both claiming to be in use.
// Every file is in a fresh temp folder. Nothing opens data/plannr.db.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { makeHost, startupFacts, load, ROOT } = require('./_storage-move-host.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-storage-kill-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const FIXTURE = fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'schema-history')).filter((f) => f.endsWith('.sql')).sort().pop();
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

let n = 0;
function newPhone() {
  const dir = fs.mkdtempSync(path.join(DIR, `phone-${++n}-`));
  const d = new DatabaseSync(path.join(dir, 'local.db'));
  d.exec(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'schema-history', FIXTURE), 'utf8'));
  d.exec(`PRAGMA user_version = 2; WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 300)
    INSERT INTO settings (key, value) SELECT 'bulk_' || i, 'value ' || i FROM k`);
  d.close();
  return dir;
}

/** What a fresh start does: decide from the facts, then delete or set aside what the table says. */
async function start(host) {
  const { decideAtStartup } = await load('core/storage-move.js');
  const d = await decideAtStartup(await startupFacts(host));
  for (const w of d.remove) await (w === 'candidate' ? host.candidate.remove() : host.main.remove());
  for (const w of d.setAside) if (w === 'main') await host.main.setAside('test');
  return d;
}

/** The copy the app would use opens and holds exactly the original data. */
async function assertUsable(dir, host, use, originalSha) {
  const { openNodeSqliteAdapter } = await load('db-adapter-node.js');
  const { fingerprint, compareFingerprints } = await load('core/storage-check.js');
  assert.strictEqual(sha(path.join(dir, 'local.db')), originalSha, 'the localStorage copy is never written');
  if (use === 'native') {
    const a = openNodeSqliteAdapter(path.join(dir, 'local.db'), { readOnly: true });
    const b = openNodeSqliteAdapter(host.files.main, { readOnly: true });
    try { assert.deepStrictEqual(compareFingerprints(await fingerprint(a), await fingerprint(b)), [], 'the file holds the data'); } finally { await a.close(); await b.close(); }
  } else {
    assert.strictEqual(use, 'localstorage');
  }
}

// ---- A forced failure at every checkpoint ------------------------------------------------------------

const POINTS = ['before-space', 'before-backup', 'backup', 'before-snapshot', 'snapshot-written',
  'before-write', 'write-start', 'write-synced', 'after-write', 'before-check', 'after-check', 'before-place', 'place',
  'after-place', 'before-switch', 'marker-write'];
for (const point of POINTS) {
  test(`a failure at "${point}": localStorage unchanged, no candidate, the app still on localStorage`, async () => {
    const { moveToFile, decideAtStartup } = await load('core/storage-move.js');
    const dir = newPhone();
    const original = sha(path.join(dir, 'local.db'));
    const host = await makeHost(dir, { checkpoint: (name) => { if (name === point) throw new Error(`forced failure at ${point}`); } });
    await assert.rejects(moveToFile(host), new RegExp(`forced failure at ${point}`));
    await host.source.close();
    assert.strictEqual(sha(path.join(dir, 'local.db')), original);
    assert.ok(!fs.existsSync(host.files.candidate), 'no candidate');
    assert.ok(!fs.existsSync(host.files.main), 'no database file either: the move undid its own rename');
    assert.ok(!fs.existsSync(host.files.marker), 'not switched');
    const d = await decideAtStartup(await startupFacts(host));
    assert.strictEqual(d.use, 'localstorage');
    // And "Continue" finishes from there.
    const again = await makeHost(dir);
    await moveToFile(again);
    await again.source.close();
    await assertUsable(dir, again, (await decideAtStartup(await startupFacts(again))).use, original);
  });
}

test('a failure after the marker file is written is not a failure: the move has switched', async () => {
  const { moveToFile, decideAtStartup } = await load('core/storage-move.js');
  for (const point of ['after-marker', 'marker-key']) {
    const dir = newPhone();
    const original = sha(path.join(dir, 'local.db'));
    const host = await makeHost(dir, { checkpoint: (name) => { if (name === point) throw new Error(`forced failure at ${point}`); } });
    const res = await moveToFile(host).catch((e) => e);
    await host.source.close();
    if (point === 'after-marker') {
      assert.match(String(res && res.message), /forced failure/);
      // The marker says native-v1, so the file is in use and must be kept.
      assert.ok(fs.existsSync(host.files.main), 'the file in use is kept');
    } else {
      assert.ok(res && res.summary, 'a lost localStorage key does not undo the switch');
    }
    const d = await decideAtStartup(await startupFacts(host));
    assert.strictEqual(d.use, 'native');
    await assertUsable(dir, host, 'native', original);
  }
});

test('the candidate write runs out of space half-way: the partial file is removed', async () => {
  const { moveToFile } = await load('core/storage-move.js');
  const dir = newPhone();
  const host = await makeHost(dir, { failWrite: true });
  const err = await moveToFile(host).catch((e) => e);
  await host.source.close();
  assert.strictEqual(err.step, 'write');
  assert.match(err.message, /ENOSPC/);
  assert.ok(!fs.existsSync(host.files.candidate));
});

// ---- Real kills at 20 points over steps 2-6 ---------------------------------------------------------

const KILLS = [
  ['before-snapshot', 1], ['snapshot-half', 1], ['snapshot-written', 1], ['progress-write', 2],
  ['before-write', 1], ['write-start', 1], ['write-chunk-1', 1], ['write-chunk-2', 1], ['write-chunk-3', 1],
  ['write-synced', 1], ['after-write', 1], ['before-check', 1], ['after-check', 1], ['before-place', 1],
  ['place', 1], ['after-place', 1], ['before-switch', 1], ['marker-write', 1], ['after-marker', 1], ['marker-key', 1],
];
test('there are 20 kill points, spread over steps 2-6', () => {
  assert.strictEqual(KILLS.length, 20);
  assert.strictEqual(new Set(KILLS.map(([p, k]) => `${p}#${k}`)).size, 20);
});
for (const [point, nth] of KILLS) {
  test(`killed at "${point}"${nth > 1 ? ` (#${nth})` : ''}: the next start decides correctly, "Continue" finishes`, async () => {
    const { moveToFile } = await load('core/storage-move.js');
    const dir = newPhone();
    const original = sha(path.join(dir, 'local.db'));
    const r = spawnSync(process.execPath, [path.join(__dirname, '_storage-move-child.js'), dir, point, String(nth)], { encoding: 'utf8', timeout: 60000 });
    assert.ok(!/FINISHED/.test(r.stdout), `the child reached "${point}" and was killed (status ${r.status}, signal ${r.signal}): ${r.stderr}`);
    assert.ok(r.status !== 0, 'killed, not a normal exit');
    const host = await makeHost(dir);
    const d = await start(host);
    assert.ok(['localstorage', 'native'].includes(d.use), `a usable copy is chosen (${JSON.stringify(d)})`);
    await assertUsable(dir, host, d.use, original);
    if (d.use === 'localstorage') {
      assert.ok(!fs.existsSync(host.files.candidate) && !fs.existsSync(host.files.main), 'nothing half-moved is left');
      await moveToFile(host); // "Continue"
      await host.source.close();
      const h2 = await makeHost(dir);
      const d2 = await start(h2);
      assert.strictEqual(d2.use, 'native');
      await assertUsable(dir, h2, 'native', original);
      await h2.source.close();
    } else {
      await host.source.close();
    }
  });
}
