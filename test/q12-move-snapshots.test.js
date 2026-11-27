// Q12: a storage-move snapshot (plannr-pre-move-*.db.gz and the other move kinds) is not one of the
// regular rotation's snapshots, so writing one must not cut the rotation to KEEP_SNAPSHOTS - 1.
// Before the fix snapshotsToDelete() always counted the file just written as one of the kept three.
//
// The owner's rule (Q12, the rest): keep the newest 3 snapshots, but keep the storage move's safety
// copy until the move is confirmed in the app. Before the confirmation no move snapshot is deleted
// (and none takes one of the 3 places); after it, every snapshot is in one rotation and the newest 3
// in total remain. The snapshot just written is never deleted. Runs the real public/safety-snapshots.js
// with an in-memory Filesystem, and the real core/storage-move.js on a Node host for the moves.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { makeHost, load: loadRel, ROOT } = require('./_storage-move-host.js');
const load = () => import('../public/safety-snapshots.js');

const regular = [
  { name: 'plannr-safety-snapshot-2026-11-01T10-00-00Z.json.gz', mtime: 1 },
  { name: 'plannr-pre-restore-2026-11-02T10-00-00Z.db.gz', mtime: 2 },
  { name: 'plannr-pre-migration-2026-11-03T10-00-00Z.db.gz', mtime: 3 },
];

test('Q12: writing a move snapshot keeps all three regular snapshots', async () => {
  const { snapshotsToDelete, KEEP_SNAPSHOTS } = await load();
  assert.strictEqual(KEEP_SNAPSHOTS, 3);
  for (const kind of ['pre-move', 'pre-move-back', 'old-copy']) {
    const moved = `plannr-${kind}-2026-11-04T10-00-00Z.db.gz`;
    const del = snapshotsToDelete([...regular, { name: moved, mtime: 4 }], moved);
    assert.deepStrictEqual(del, [], `${kind}: the move snapshot cut the rotation (deleted ${del.join(', ')})`);
  }
});

test('Q12: a regular snapshot still keeps the newest three, and never touches a move snapshot', async () => {
  const { snapshotsToDelete } = await load();
  const moved = { name: 'plannr-pre-move-2026-11-04T10-00-00Z.db.gz', mtime: 4 };
  const fresh = { name: 'plannr-safety-snapshot-2026-11-05T10-00-00Z.json.gz', mtime: 5 };
  assert.deepStrictEqual(snapshotsToDelete([...regular, moved, fresh], fresh.name), [regular[0].name]);
});

// ---- Q12, the rest: the move's safety copy is kept until the move is confirmed -----------------------

// A tiny Capacitor Filesystem (as in test/safety-snapshots.test.js): files in a Map, a clock for mtimes.
function memFs() {
  const files = new Map();
  let clock = Date.UTC(2026, 10, 1);
  const name = (p) => p.replace(/^safety-snapshots\//, '');
  const Filesystem = {
    async writeFile({ path: p, data, encoding }) {
      const bytes = encoding ? Buffer.from(data, 'utf8') : Buffer.from(data, 'base64');
      files.set(name(p), { bytes, size: bytes.length, mtime: (clock += 1000) });
    },
    async readFile({ path: p, encoding }) {
      const f = files.get(name(p));
      if (!f) throw new Error('File does not exist');
      return { data: encoding ? f.bytes.toString('utf8') : f.bytes.toString('base64') };
    },
    async stat({ path: p }) {
      const f = files.get(name(p));
      if (!f) throw new Error('File does not exist');
      return { type: 'file', size: f.size, mtime: f.mtime };
    },
    async readdir() { return { files: [...files].map(([n, f]) => ({ name: n, type: 'file', size: f.size, mtime: f.mtime })) }; },
    async deleteFile({ path: p }) { files.delete(name(p)); },
  };
  return {
    fsApi: { Filesystem, Directory: { Data: 'DATA' }, Encoding: { UTF8: 'utf8' } },
    // Oldest first.
    list: () => [...files].sort((a, b) => a[1].mtime - b[1].mtime).map(([n]) => n),
    has: (p) => files.has(name(p)),
  };
}
const enc = (text) => new TextEncoder().encode(text);
let seq = 0;
const stamp = () => `2026-11-20T10-00-${String(++seq).padStart(4, '0')}-000Z`;
const MOVE_KINDS = ['pre-move', 'old-copy', 'pre-move-back'];
const unconfirmed = { moveConfirmed: async () => false };
const confirmed = { moveConfirmed: async () => true };
const quietly = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

test('Q12 (a): before the move is confirmed, no number of pruning runs deletes the safety copy', async () => {
  const { saveSnapshot } = await load();
  const mem = memFs();
  const copy = await saveSnapshot(`plannr-pre-move-${stamp()}.db`, enc('the safety copy from before the move'), mem.fsApi, unconfirmed);
  for (let i = 0; i < 12; i++) {
    const kind = ['safety-snapshot', 'pre-restore', 'pre-migration-v2-to-v3'][i % 3];
    await saveSnapshot(`plannr-${kind}-${stamp()}.${kind === 'safety-snapshot' ? 'json' : 'db'}`, enc(`regular ${i}`), mem.fsApi, unconfirmed);
    assert.ok(mem.has(copy), `pruning run ${i + 1} deleted the safety copy`);
  }
  assert.strictEqual(mem.list().length, 4, 'the safety copy, plus the newest 3 regular snapshots: ' + mem.list().join(', '));
  // Other move snapshots (a move back writes two) do not push it out, and are kept too.
  for (const kind of ['old-copy', 'pre-move-back']) await saveSnapshot(`plannr-${kind}-${stamp()}.db`, enc(kind), mem.fsApi, unconfirmed);
  await saveSnapshot(`plannr-safety-snapshot-${stamp()}.json`, enc('one more'), mem.fsApi, unconfirmed);
  assert.ok(mem.has(copy));
  assert.strictEqual(mem.list().filter((n) => /^plannr-(pre-move|old-copy|pre-move-back)-/.test(n)).length, 3);
  // If the move's record cannot be read, it counts as not confirmed: the copy stays.
  const unreadable = { moveConfirmed: async () => { throw new Error('the marker could not be read'); } };
  for (let i = 0; i < 4; i++) await quietly(() => saveSnapshot(`plannr-pre-restore-${stamp()}.db`, enc(`r${i}`), mem.fsApi, unreadable));
  assert.ok(mem.has(copy), 'an unreadable record deleted the safety copy');
});

test('Q12 (b): the snapshot just written is never deleted, before or after the confirmation', async () => {
  const { snapshotsToDelete, saveSnapshot } = await load();
  const newer = [5, 6, 7, 8].map((t, i) => ({ name: `plannr-${['safety-snapshot', 'pre-restore', 'pre-move', 'old-copy'][i]}-x${t}.${i ? 'db' : 'json'}.gz`, mtime: t * 100 }));
  for (const moveConfirmed of [false, true]) {
    for (const kind of ['safety-snapshot', 'pre-restore', 'pre-migration-v1-to-v2', ...MOVE_KINDS]) {
      // Its clock went backwards: it is the oldest file in the folder, but it was just written.
      const just = `plannr-${kind}-new.db.gz`;
      const entries = [{ name: just, mtime: 1 }, ...newer];
      for (const pinned of [null, newer[1].name]) {
        const del = snapshotsToDelete(entries, just, 3, pinned, moveConfirmed);
        assert.ok(!del.includes(just), `${kind}, confirmed ${moveConfirmed}, pinned ${pinned}: deleted the one just written`);
      }
    }
  }
  // Through saveSnapshot: confirmed, a move snapshot written into a full folder is kept.
  const mem = memFs();
  for (let i = 0; i < 3; i++) await saveSnapshot(`plannr-safety-snapshot-${stamp()}.json`, enc(`r${i}`), mem.fsApi, confirmed);
  for (const kind of MOVE_KINDS) {
    const p = await saveSnapshot(`plannr-${kind}-${stamp()}.db`, enc(kind), mem.fsApi, confirmed);
    assert.ok(mem.has(p), `${kind}: the snapshot just written was deleted`);
    assert.strictEqual(mem.list().length, 3);
  }
});

test('Q12 (c): after the confirmation only the newest 3 snapshots remain, the move snapshots counted in', async () => {
  const { saveSnapshot, snapshotsToDelete } = await load();
  const mem = memFs();
  const written = [];
  for (const kind of ['safety-snapshot', 'pre-restore', 'pre-move', 'pre-migration-v2-to-v3', 'old-copy', 'pre-move-back', 'safety-snapshot']) {
    written.push(await saveSnapshot(`plannr-${kind}-${stamp()}.${kind === 'safety-snapshot' ? 'json' : 'db'}`, enc(kind), mem.fsApi, unconfirmed));
  }
  assert.strictEqual(mem.list().length, 6, 'before the confirmation: 3 regular and the 3 move snapshots');
  const fresh = await saveSnapshot(`plannr-pre-restore-${stamp()}.db`, enc('after the confirmation'), mem.fsApi, confirmed);
  const names = [...written, fresh].map((p) => p.replace(/^safety-snapshots\//, ''));
  assert.deepStrictEqual(mem.list(), names.slice(-3), 'only the newest 3 in total');
  // A move snapshot written after the confirmation counts as one of the 3 as well.
  const move = await saveSnapshot(`plannr-pre-move-back-${stamp()}.db`, enc('move back'), mem.fsApi, confirmed);
  assert.deepStrictEqual(mem.list(), [...names.slice(-2), move.replace(/^safety-snapshots\//, '')]);
  // An unfinished upgrade's snapshot is still kept, and still counts as one of the 3.
  const e = (name, mtime) => ({ name, mtime });
  const pinned = 'plannr-pre-migration-v3-to-v4-a.db.gz';
  const entries = [e(pinned, 1), e('plannr-pre-move-b.db.gz', 2), e('plannr-old-copy-c.db.gz', 3), e('plannr-safety-snapshot-d.json.gz', 4), e('plannr-pre-restore-new.db.gz', 5)];
  assert.deepStrictEqual(snapshotsToDelete(entries, 'plannr-pre-restore-new.db.gz', 3, pinned, true), ['plannr-old-copy-c.db.gz', 'plannr-pre-move-b.db.gz']);
});

// ---- (d) and the whole way round, with the real moves (core/storage-move.js) ---------------------------

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-q12-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const FIXTURE = fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'schema-history')).filter((f) => f.endsWith('.sql')).sort().pop();
let n = 0;
function newPhone() {
  const dir = fs.mkdtempSync(path.join(DIR, `phone-${++n}-`));
  const d = new DatabaseSync(path.join(dir, 'local.db'));
  d.exec(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'schema-history', FIXTURE), 'utf8'));
  d.exec('PRAGMA user_version = 2');
  d.close();
  return dir;
}
// A Node host whose snapshots go through the real saveSnapshot, asking the host's own marker file
// whether the move is confirmed (as public/storage-native.js does on the phone).
async function hostWithSnapshots(dir, mem) {
  const { saveSnapshot } = await load();
  const { moveConfirmed } = await loadRel('core/storage-move.js');
  const host = await makeHost(dir);
  host.snapshot = async (bytes, kind = 'pre-move') => saveSnapshot(`plannr-${kind}-${stamp()}.db`, bytes, mem.fsApi,
    { moveConfirmed: async () => moveConfirmed(await host.marker.read()) });
  host.regular = async (i) => saveSnapshot(`plannr-pre-restore-${stamp()}.db`, enc(`regular ${i}`), mem.fsApi,
    { moveConfirmed: async () => moveConfirmed(await host.marker.read()) });
  return host;
}

test('Q12 (d): a move back before the confirmation keeps the safety copy; after the next move is confirmed, the newest 3 remain', async () => {
  const { moveToFile, moveBack, confirmMove } = await loadRel('core/storage-move.js');
  const mem = memFs();
  const dir = newPhone();
  const h1 = await hostWithSnapshots(dir, mem);
  for (let i = 0; i < 3; i++) await h1.regular(i);
  await moveToFile(h1);
  await h1.source.close();
  const copy = (await h1.marker.read()).safetyCopy.snapshot;
  assert.match(copy, /^safety-snapshots\/plannr-pre-move-.+\.db\.gz$/);
  for (let i = 0; i < 5; i++) await h1.regular(i);
  assert.ok(mem.has(copy), 'regular snapshots after the move deleted the safety copy');

  // Move back, not confirmed: its two snapshots are written, the safety copy stays, and stays after more.
  const h2 = await hostWithSnapshots(dir, mem);
  await h2.source.close();
  await h2.openFile();
  await moveBack(h2, { confirmed: true });
  await h2.file.close();
  for (let i = 0; i < 5; i++) await h2.regular(i);
  assert.ok(mem.has(copy), 'the move back (before the confirmation) lost the safety copy');
  const moveSnaps = mem.list().filter((x) => /^plannr-(pre-move|old-copy|pre-move-back)-/.test(x));
  assert.strictEqual(moveSnaps.length, 3, moveSnaps.join(', '));

  // The move again; then confirmed. The next snapshot leaves only the newest 3 in total.
  const h3 = await hostWithSnapshots(dir, mem);
  await moveToFile(h3);
  await h3.source.close();
  const copy2 = (await h3.marker.read()).safetyCopy.snapshot;
  await h3.regular('before the confirmation');
  assert.ok(mem.has(copy) && mem.has(copy2), 'not confirmed yet: both safety copies stay');
  await confirmMove(h3, { confirmed: true });
  assert.ok(mem.has(copy2), 'confirming deletes nothing by itself');
  const last = await h3.regular('after the confirmation');
  assert.strictEqual(mem.list().length, 3, mem.list().join(', '));
  assert.ok(mem.has(last));
  assert.ok(!mem.has(copy), 'the first safety copy rotated out once the move was confirmed');
});

test('Q12: on the phone the clean-up reads the marker file through the storage plugin (storage-native.js moveIsConfirmed)', async () => {
  const { makeFakePlugins } = require('./_fake-capacitor-sqlite.js');
  const { moveIsConfirmed, makePhoneHost, MARKER_FILE } = await loadRel('public/storage-native.js');
  const plugins = makeFakePlugins(path.join(fs.mkdtempSync(path.join(DIR, 'plugins-')), 'app'));
  const ls = { getItem: () => null, setItem() {}, removeItem() {}, length: 0, key: () => null };
  assert.strictEqual(await moveIsConfirmed({ plugins: null, localStorage: ls }), false, 'no plugins');
  assert.strictEqual(await moveIsConfirmed({ plugins, localStorage: ls }), false, 'no marker');
  const host = await makePhoneHost({ plugins, localStorage: ls });
  const marker = { storage: 'native-v1', movedAt: '2026-11-19T10:00:00.000Z', safetyCopy: { snapshot: 'safety-snapshots/plannr-pre-move-a.db.gz', confirmed: false } };
  await host.marker.write(marker);
  assert.strictEqual(await moveIsConfirmed({ plugins, localStorage: ls }), false, 'not confirmed yet');
  await host.marker.write({ ...marker, safetyCopy: { ...marker.safetyCopy, confirmed: true } });
  assert.strictEqual(await moveIsConfirmed({ plugins, localStorage: ls }), true, 'confirmed');
  await host.marker.write({ storage: 'localstorage-v1', movedBackAt: '2026-11-20T10:00:00.000Z' });
  assert.strictEqual(await moveIsConfirmed({ plugins, localStorage: ls }), false, 'moved back');
  fs.writeFileSync(path.join(plugins.filesDir, MARKER_FILE), '{ not json');
  assert.strictEqual(await moveIsConfirmed({ plugins, localStorage: ls }), false, 'a marker that cannot be read');
});
