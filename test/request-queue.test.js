// Step 1.4 B3: the request queue (core/request-queue.js).
//
// 1. The queue itself: one at a time, in order, results and errors passed back, an error never
//    stops the requests after it.
// 2. Two writes at once where one fails, on a real node-sqlite database (a temp file): with the
//    queue the failed request rolls back only its own rows and the other request's rows are kept.
//    Without the queue (the known positive) the same two requests go wrong in both ways the queue
//    is there to prevent.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-queue-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const tick = () => new Promise((r) => setImmediate(r));

// ---- 1. The queue ------------------------------------------------------------------------------------

test('queue: one request at a time, in the order they came', async () => {
  const { createRequestQueue } = await load('core/request-queue.js');
  const q = createRequestQueue();
  const log = [];
  let running = 0;
  const req = (name, steps) => q.run(async () => {
    running++;
    assert.strictEqual(running, 1, `${name} runs alone`);
    for (let i = 0; i < steps; i++) { log.push(`${name}${i}`); await tick(); }
    running--;
    return name;
  });
  const results = await Promise.all([req('a', 3), req('b', 1), req('c', 2)]);
  assert.deepStrictEqual(results, ['a', 'b', 'c']);
  assert.deepStrictEqual(log, ['a0', 'a1', 'a2', 'b0', 'c0', 'c1']);
  assert.strictEqual(q.size, 0);
});

test('queue: a failing request passes its error back and the next one still runs', async () => {
  const { createRequestQueue } = await load('core/request-queue.js');
  const q = createRequestQueue();
  const a = q.run(async () => { await tick(); throw new Error('a failed'); });
  const b = q.run(() => { throw new Error('b failed at once'); }); // a synchronous throw
  const c = q.run(async () => 'c ran');
  await assert.rejects(a, /a failed/);
  await assert.rejects(b, /b failed at once/);
  assert.strictEqual(await c, 'c ran');
  await assert.rejects(q.run('not a function'), /pass a function/);
});

test('queue: size counts the requests waiting or running', async () => {
  const { createRequestQueue } = await load('core/request-queue.js');
  const q = createRequestQueue();
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = q.run(() => gate);
  const b = q.run(async () => {});
  assert.strictEqual(q.size, 2);
  release();
  await Promise.all([a, b]);
  await tick();
  assert.strictEqual(q.size, 0);
});

// ---- 2. Two writes at once, one failing ------------------------------------------------------------

let n = 0;
async function freshDb() {
  const { openNodeSqliteAdapter } = await load('db-adapter-node.js');
  const db = openNodeSqliteAdapter(path.join(DIR, `two-writes-${++n}.db`));
  await db.exec('CREATE TABLE entry (id INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT NOT NULL, paise INTEGER NOT NULL)');
  return db;
}
// Request A saves two entries in a transaction, waiting between them (as an async database does),
// then fails. Request B saves one entry: either on its own, or in its own transaction.
const requestA = (db) => db.transaction(async (tx) => {
  await tx.run('INSERT INTO entry (who, paise) VALUES (?, ?)', ['A', 100]);
  await tick(); await tick();
  await tx.run('INSERT INTO entry (who, paise) VALUES (?, ?)', ['A', 200]);
  throw new Error('A: the second half of the save failed');
});
const requestBPlain = (db) => (async () => { await tick(); await db.run('INSERT INTO entry (who, paise) VALUES (?, ?)', ['B', 300]); })();
const requestBInTransaction = (db) => (async () => { await tick(); return db.transaction(async (tx) => { await tx.run('INSERT INTO entry (who, paise) VALUES (?, ?)', ['B', 300]); }); })();
const whoIsSaved = async (db) => (await db.all('SELECT who, paise FROM entry ORDER BY id')).map((r) => `${r.who}:${r.paise}`);

test('two writes at once, one failing: through the queue, only the failed request is rolled back', async () => {
  const { createRequestQueue } = await load('core/request-queue.js');
  for (const requestB of [requestBPlain, requestBInTransaction]) {
    const db = await freshDb();
    const q = createRequestQueue();
    const [a, b] = await Promise.allSettled([q.run(() => requestA(db)), q.run(() => requestB(db))]);
    assert.strictEqual(a.status, 'rejected');
    assert.match(a.reason.message, /second half of the save failed/);
    assert.strictEqual(b.status, 'fulfilled', `B succeeds (${requestB === requestBPlain ? 'plain write' : 'own transaction'})`);
    assert.deepStrictEqual(await whoIsSaved(db), ['B:300']);
    assert.strictEqual(db.inTransaction, false);
    await db.close();
  }
});

test('two writes at once, one failing: WITHOUT the queue, B is lost or refused (why the queue exists)', async () => {
  // B's plain write lands inside A's open transaction and is rolled back with it.
  let db = await freshDb();
  let [a, b] = await Promise.allSettled([requestA(db), requestBPlain(db)]);
  assert.strictEqual(a.status, 'rejected');
  assert.strictEqual(b.status, 'fulfilled', 'B was told its write succeeded...');
  assert.deepStrictEqual(await whoIsSaved(db), [], '...but it was rolled back with A');
  await db.close();
  // B's own transaction finds A's still open and is refused.
  db = await freshDb();
  [a, b] = await Promise.allSettled([requestA(db), requestBInTransaction(db)]);
  assert.strictEqual(b.status, 'rejected');
  assert.match(b.reason.message, /a transaction is already open/);
  assert.deepStrictEqual(await whoIsSaved(db), []);
  await db.close();
});
