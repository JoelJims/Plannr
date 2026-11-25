// Q5 (docs/security-quality-review-2026-11-21.md): two faults together (the marker file is there but
// cannot be read, and the localStorage key is lost after a kill) made startup think no move had
// finished, so a move record led it to DELETE the database file, which may hold the only live data.
// Now an unreadable marker file is a fact of its own, and startup then sets the file aside instead.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

test('Q5: with an unreadable marker file, startup never deletes the database file', async () => {
  const { decideAtStartup } = await load('core/storage-move.js');
  const d = await decideAtStartup({ marker: null, markerUnreadable: true, candidate: true, main: true, mainOk: async () => true, moveInProgress: true });
  assert.strictEqual(d.use, 'localstorage');
  assert.ok(!d.remove.includes('main'), `main must not be removed: ${JSON.stringify(d)}`);
  assert.deepStrictEqual(d.setAside, ['main']);
  assert.deepStrictEqual(d.remove, ['candidate']);
});

test('Q5: a missing marker with a move record still removes the half-made file (unchanged)', async () => {
  const { decideAtStartup } = await load('core/storage-move.js');
  const d = await decideAtStartup({ marker: null, markerUnreadable: false, candidate: true, main: true, mainOk: async () => true, moveInProgress: true });
  assert.deepStrictEqual(d.remove, ['candidate', 'main']);
  assert.deepStrictEqual(d.setAside, []);
});

test('Q5: the phone startup facts say when the marker file is there but unreadable', async () => {
  const { startupFacts } = await load('public/storage-native.js');
  const host = (file, key) => ({
    marker: { read: async () => file, exists: async () => true },
    markerKey: { read: async () => key },
    candidate: { exists: async () => false },
    main: { exists: async () => true, quickCheckOk: async () => true },
    progress: { read: async () => ({ step: 3 }) },
  });
  assert.strictEqual((await startupFacts(host(null, null))).markerUnreadable, true);
  assert.strictEqual((await startupFacts(host({ storage: 'native-v1' }, null))).markerUnreadable, false);
  const absent = host(null, null);
  absent.marker.exists = async () => false;
  assert.strictEqual((await startupFacts(absent)).markerUnreadable, false);
});
