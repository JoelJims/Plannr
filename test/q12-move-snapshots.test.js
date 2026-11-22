// Q12: a storage-move snapshot (plannr-pre-move-*.db.gz and the other move kinds) is not one of the
// regular rotation's snapshots, so writing one must not cut the rotation to KEEP_SNAPSHOTS - 1.
// Before the fix snapshotsToDelete() always counted the file just written as one of the kept three.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
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
