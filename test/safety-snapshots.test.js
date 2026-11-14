// Phase 2, Steps 4-5 — the phone keeps only the newest 3 safety snapshots in
// Directory.Data/safety-snapshots/. Older ones are deleted only AFTER the new one is written and
// checked, and the one just written is never deleted. Runs the real public/safety-snapshots.js with
// an in-memory stand-in for Capacitor's Filesystem plugin (same calls, same result shapes).
// Since Step 5 snapshots are gzip-compressed (<name>.gz) to keep Android Auto Backup under 25 MB.
const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/safety-snapshots.js');

// A tiny Capacitor Filesystem: files in a Map, a clock for mtimes, and a log of every call.
function fakeFs({ badStat = false, deleteFails = false, writeFails = false } = {}) {
  const files = new Map();
  const log = [];
  let clock = Date.UTC(2026, 0, 1);
  const name = (p) => p.replace(/^safety-snapshots\//, '');
  const Filesystem = {
    async writeFile({ path, data, encoding }) {
      log.push(`write ${name(path)}`);
      if (writeFails) throw new Error('disk full');
      const bytes = encoding ? Buffer.from(data, 'utf8') : Buffer.from(data, 'base64');
      files.set(name(path), { bytes, size: bytes.length, mtime: (clock += 1000) });
    },
    async stat({ path }) {
      log.push(`stat ${name(path)}`);
      const f = files.get(name(path));
      if (!f) throw new Error('File does not exist');
      return { type: 'file', size: badStat ? 0 : f.size, mtime: f.mtime, uri: `file:///data/${path}` };
    },
    async readdir() {
      log.push('readdir');
      return { files: [...files].map(([n, f]) => ({ name: n, type: 'file', size: f.size, mtime: f.mtime, uri: `file:///data/safety-snapshots/${n}` })) };
    },
    async deleteFile({ path }) {
      log.push(`delete ${name(path)}`);
      if (deleteFails) throw new Error('permission denied');
      files.delete(name(path));
    },
  };
  // Pre-existing files, oldest first.
  const seed = (...names) => { for (const n of names) files.set(n, { size: 10, mtime: (clock += 1000) }); };
  return { fsApi: { Filesystem, Directory: { Data: 'DATA' }, Encoding: { UTF8: 'utf8' } }, files, log, seed };
}
const enc = (text) => new TextEncoder().encode(text);
const quietly = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

test('snapshotsToDelete keeps the new one plus the 2 newest others, oldest go', async () => {
  const { snapshotsToDelete } = await load();
  const e = (name, mtime) => ({ name, mtime, type: 'file' });
  const entries = [
    e('plannr-safety-snapshot-a.json', 1), e('plannr-pre-restore-b.db', 2), e('plannr-pre-migration-v2-to-v3-c.db', 3),
    e('plannr-safety-snapshot-d.json', 4), e('plannr-pre-restore-new.db', 5),
  ];
  assert.deepStrictEqual(snapshotsToDelete(entries, 'plannr-pre-restore-new.db'), ['plannr-pre-restore-b.db', 'plannr-safety-snapshot-a.json']);
});

test('snapshotsToDelete never deletes the snapshot just written, even if the clock went backwards', async () => {
  const { snapshotsToDelete } = await load();
  const entries = [
    { name: 'plannr-safety-snapshot-new.json', mtime: 1 }, // oldest timestamp, but it is the new one
    { name: 'plannr-safety-snapshot-x.json', mtime: 50 }, { name: 'plannr-safety-snapshot-y.json', mtime: 60 }, { name: 'plannr-safety-snapshot-z.json', mtime: 70 },
  ];
  const del = snapshotsToDelete(entries, 'plannr-safety-snapshot-new.json');
  assert.ok(!del.includes('plannr-safety-snapshot-new.json'));
  assert.deepStrictEqual(del, ['plannr-safety-snapshot-x.json']);
});

test('snapshotsToDelete leaves other files and folders alone, and deletes nothing at 3 or fewer', async () => {
  const { snapshotsToDelete } = await load();
  const entries = [
    { name: 'notes.txt', mtime: 1 }, { name: 'plannr-safety-snapshot-old', mtime: 2 }, { name: 'plannr-pre-restore-dir.db', mtime: 3, type: 'directory' },
    { name: 'plannr-safety-snapshot-a.json', mtime: 4 }, { name: 'plannr-safety-snapshot-new.json', mtime: 9 },
  ];
  assert.deepStrictEqual(snapshotsToDelete(entries, 'plannr-safety-snapshot-new.json'), []);
});

test('saveSnapshot writes, checks, THEN removes the oldest: 3 left, the new one among them', async () => {
  const { saveSnapshot } = await load();
  const fs = fakeFs();
  // Older uncompressed snapshots (from before Step 5) count too, so they get cleaned up.
  fs.seed('plannr-pre-migration-v2-to-v3-1.db', 'notes.txt', 'plannr-safety-snapshot-2.json.gz', 'plannr-pre-restore-3.db');
  const path = await saveSnapshot('plannr-pre-restore-4.db', enc('SQLite format 3 ...'), fs.fsApi);
  assert.strictEqual(path, 'safety-snapshots/plannr-pre-restore-4.db.gz');
  assert.deepStrictEqual([...fs.files.keys()].sort(), ['notes.txt', 'plannr-pre-restore-3.db', 'plannr-pre-restore-4.db.gz', 'plannr-safety-snapshot-2.json.gz']);
  assert.deepStrictEqual(fs.log, ['write plannr-pre-restore-4.db.gz', 'stat plannr-pre-restore-4.db.gz', 'readdir', 'delete plannr-pre-migration-v2-to-v3-1.db'],
    'nothing is deleted before the new snapshot is written and checked');
});

test('every save keeps the count at 3 (ten restores in a row)', async () => {
  const { saveSnapshot } = await load();
  const fs = fakeFs();
  for (let i = 0; i < 10; i++) {
    const n = `plannr-safety-snapshot-${String(i).padStart(2, '0')}.json`;
    await saveSnapshot(n, enc('{"x":1}'), fs.fsApi);
    assert.ok(fs.files.has(`${n}.gz`), `snapshot ${i} kept right after it was written`);
    assert.ok(fs.files.size <= 3);
  }
  assert.deepStrictEqual([...fs.files.keys()].sort(), ['plannr-safety-snapshot-07.json.gz', 'plannr-safety-snapshot-08.json.gz', 'plannr-safety-snapshot-09.json.gz']);
});

test('if the new snapshot cannot be verified, nothing old is deleted and the caller is stopped', async () => {
  const { saveSnapshot } = await load();
  const fs = fakeFs({ badStat: true });
  fs.seed('plannr-safety-snapshot-1.json', 'plannr-safety-snapshot-2.json', 'plannr-safety-snapshot-3.json');
  await assert.rejects(saveSnapshot('plannr-safety-snapshot-4.json', enc('{"a":1}'), fs.fsApi), /not verified/);
  assert.ok(!fs.log.some((l) => l.startsWith('delete')), 'no deletes');
  for (const n of ['plannr-safety-snapshot-1.json', 'plannr-safety-snapshot-2.json', 'plannr-safety-snapshot-3.json']) assert.ok(fs.files.has(n));
});

test('if writing fails, nothing old is deleted and the caller is stopped', async () => {
  const { saveSnapshot } = await load();
  const fs = fakeFs({ writeFails: true });
  fs.seed('plannr-safety-snapshot-1.json', 'plannr-safety-snapshot-2.json', 'plannr-safety-snapshot-3.json');
  await assert.rejects(saveSnapshot('plannr-safety-snapshot-4.json', enc('{}'), fs.fsApi), /disk full/);
  assert.strictEqual(fs.files.size, 3);
  assert.deepStrictEqual(fs.log, ['write plannr-safety-snapshot-4.json.gz']);
});

test('a failed clean-up does not fail the save (the new snapshot is safe)', async () => {
  const { saveSnapshot } = await load();
  const fs = fakeFs({ deleteFails: true });
  fs.seed('plannr-safety-snapshot-1.json', 'plannr-safety-snapshot-2.json', 'plannr-safety-snapshot-3.json');
  const path = await quietly(() => saveSnapshot('plannr-safety-snapshot-4.json', enc('{}'), fs.fsApi));
  assert.strictEqual(path, 'safety-snapshots/plannr-safety-snapshot-4.json.gz');
  assert.ok(fs.files.has('plannr-safety-snapshot-4.json.gz'));
});

test('pruneSnapshots deletes nothing if the new snapshot is not actually in the folder', async () => {
  const { pruneSnapshots } = await load();
  const fs = fakeFs();
  fs.seed('plannr-safety-snapshot-1.json', 'plannr-safety-snapshot-2.json', 'plannr-safety-snapshot-3.json', 'plannr-safety-snapshot-4.json');
  const deleted = await quietly(() => pruneSnapshots('plannr-safety-snapshot-missing.json', fs.fsApi));
  assert.deepStrictEqual(deleted, []);
  assert.strictEqual(fs.files.size, 4);
});

test('a saved snapshot is gzip: it decompresses to exactly the original, and is much smaller', async () => {
  const { saveSnapshot } = await load();
  const zlib = require('node:zlib');
  const fs = fakeFs();
  // A backup-shaped JSON with many similar rows, like a real ledger.
  const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, amount_paise: 100000 + i, tx_date: '2026-03-04', reason: 'Cement bags x' + (i % 50) + ' — site delivery', ledger_code: '22.0' }));
  const original = enc(JSON.stringify({ app: 'plannr', tables: { cash_out: rows } }));
  await saveSnapshot('plannr-safety-snapshot-big.json', original, fs.fsApi);
  const stored = fs.files.get('plannr-safety-snapshot-big.json.gz').bytes;
  assert.deepStrictEqual(new Uint8Array(zlib.gunzipSync(stored)), original, 'gunzip gives back the exact bytes');
  assert.ok(stored.length * 5 < original.length, `compressed ${stored.length} vs ${original.length} bytes`);
});
