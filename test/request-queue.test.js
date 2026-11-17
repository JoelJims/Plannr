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

// ---- 3. Wiring (step 1.4 B5): routes registered through queuedRoutes() -----------------------------
//
// A fake route table with the shape both platforms give it (method(path, ...fns)); the tests call the
// handler a platform would call. A do-nothing queue (runs each request at once) is the known positive.

function fakeApp() {
  const routes = [];
  const add = (method) => (p, ...fns) => { routes.push({ method, path: p, fns }); };
  const handler = (method, p) => { const r = routes.find((x) => x.method === method && x.path === p); return r.fns[r.fns.length - 1]; };
  return { routes, handler, get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') };
}
const noQueue = { run: async (fn) => fn() };

async function twoSlowRequests(queue) {
  const { queuedRoutes } = await load('core/request-queue.js');
  const app = fakeApp();
  const api = queuedRoutes(app, queue);
  const log = [];
  const slow = (name) => async () => { log.push(`${name} starts`); await tick(); await tick(); log.push(`${name} ends`); };
  api.post('/api/a', (req, res, next) => next(), slow('a'));
  api.get('/api/b', slow('b'));
  await Promise.all([app.handler('POST', '/api/a')({}, {}), app.handler('GET', '/api/b')({}, {})]);
  return { log, app };
}

test('wiring: routes registered through queuedRoutes run one at a time; earlier functions (auth) are kept', { timeout: 10000 }, async () => {
  const { createRequestQueue, QUEUED } = await load('core/request-queue.js');
  const { log, app } = await twoSlowRequests(createRequestQueue());
  assert.deepStrictEqual(log, ['a starts', 'a ends', 'b starts', 'b ends']);
  assert.strictEqual(app.routes[0].fns.length, 2, 'the auth function before the handler is still there');
  assert.ok(app.routes.every((r) => r.fns[r.fns.length - 1][QUEUED]), 'every handler is marked as queued');
});

test('wiring: known positive - with a do-nothing queue the same two requests interleave', { timeout: 10000 }, async () => {
  const { log } = await twoSlowRequests(noQueue);
  assert.deepStrictEqual(log, ['a starts', 'b starts', 'a ends', 'b ends']);
});

test('wiring: an error reaches Express through next(err); without next (the phone) the promise rejects', { timeout: 10000 }, async () => {
  const { createRequestQueue, queuedRoutes } = await load('core/request-queue.js');
  const app = fakeApp();
  const api = queuedRoutes(app, createRequestQueue());
  api.get('/api/sync-throw', () => { throw new Error('sync boom'); });
  api.get('/api/async-throw', async () => { await tick(); throw new Error('async boom'); });
  for (const p of ['/api/sync-throw', '/api/async-throw']) {
    let passed = null;
    await app.handler('GET', p)({}, {}, (err) => { passed = err; });
    assert.match(String(passed && passed.message), /boom/, `${p}: Express gets the error`);
    await assert.rejects(app.handler('GET', p)({}, {}), /boom/, `${p}: the phone's dispatcher gets a rejection`);
  }
  assert.throws(() => api.get('/api/no-handler'), /has no handler/);
  assert.throws(() => queuedRoutes(app, null), /pass the request queue/);
});

// The Overview PDF: its page is built inside the queue, the render (seconds, no database) outside.
const fakeRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, send(b) { this.body = b; }, status(s) { this.code = s; return this; }, json(j) { this.body = j; } });
async function pdfWithSlowRender(queue, { wrapAnyway = false } = {}) {
  const { queuedRoutes, queuedHandler } = await load('core/request-queue.js');
  const pdfRoute = await load('core/routes/pdf.js');
  const app = fakeApp();
  const api = queuedRoutes(app, queue);
  const log = [];
  let finishRender;
  const rendering = new Promise((r) => { finishRender = r; });
  pdfRoute.register(api, {
    auth: (req, res, next) => next(),
    // Had the whole route been queued, its page would be built where it already holds the queue.
    exclusive: wrapAnyway ? (fn) => fn() : (fn) => queue.run(fn),
    istDateStamp: () => '2026-11-17',
    logError: () => {},
    readPdfQuery: () => ({ part: 'full', theme: 'light', range: {} }),
    overviewPdfHtml: () => { log.push('pdf page built'); return '<html></html>'; },
    host: { pdf: { render: async () => { log.push('render starts'); await rendering; log.push('render ends'); return new Uint8Array([37, 80, 68, 70]); } } },
  });
  api.get('/api/budget', () => { log.push('budget answered'); });
  const res = fakeRes();
  const route = app.handler('GET', '/api/overview/pdf');
  const pdf = wrapAnyway ? queuedHandler(queue, (...a) => route(...a)) : route; // as if the route were not marked
  const p = pdf({ query: {} }, res, () => {});
  for (let i = 0; i < 5; i++) await tick();
  const b = app.handler('GET', '/api/budget')({}, {}, () => {});
  for (let i = 0; i < 5; i++) await tick();
  const answeredDuringRender = log.includes('budget answered');
  finishRender();
  await Promise.all([p, b]);
  return { log, answeredDuringRender, res };
}

test('wiring: the PDF page is built inside the queue, and a request is answered while it renders', { timeout: 10000 }, async () => {
  const { createRequestQueue, OUTSIDE_QUEUE } = await load('core/request-queue.js');
  const { log, answeredDuringRender, res } = await pdfWithSlowRender(createRequestQueue());
  assert.ok(answeredDuringRender, `the budget request waited for the render: ${log.join(' > ')}`);
  assert.deepStrictEqual(log, ['pdf page built', 'render starts', 'budget answered', 'render ends']);
  assert.strictEqual(res.headers['Content-Type'], 'application/pdf');
  const app = fakeApp();
  (await load('core/routes/pdf.js')).register(app, { auth: () => {}, exclusive: () => {}, host: {} });
  assert.ok(app.handler('GET', '/api/overview/pdf')[OUTSIDE_QUEUE], 'the PDF route is the one marked outside the queue');
});

test('wiring: known positive - had the whole PDF route been queued, the request waits for the render', { timeout: 10000 }, async () => {
  const { createRequestQueue } = await load('core/request-queue.js');
  const { log, answeredDuringRender } = await pdfWithSlowRender(createRequestQueue(), { wrapAnyway: true });
  assert.strictEqual(answeredDuringRender, false);
  assert.deepStrictEqual(log, ['pdf page built', 'render starts', 'render ends', 'budget answered']);
});

test('wiring: the PDF page waits for a request ahead of it in the queue; the route needs ctx.exclusive', { timeout: 10000 }, async () => {
  const { createRequestQueue, queuedRoutes } = await load('core/request-queue.js');
  const pdfRoute = await load('core/routes/pdf.js');
  const queue = createRequestQueue();
  const app = fakeApp();
  const log = [];
  pdfRoute.register(queuedRoutes(app, queue), {
    auth: (req, res, next) => next(), exclusive: (fn) => queue.run(fn), istDateStamp: () => 'd', logError: () => {},
    readPdfQuery: () => ({ part: 'full', theme: 'light', range: {} }),
    overviewPdfHtml: () => { log.push('pdf page built'); return ''; },
    host: { pdf: { render: async () => new Uint8Array(1) } },
  });
  const ahead = queue.run(async () => { log.push('write starts'); await tick(); await tick(); log.push('write ends'); });
  await Promise.all([ahead, app.handler('GET', '/api/overview/pdf')({ query: {} }, fakeRes(), () => {})]);
  assert.deepStrictEqual(log, ['write starts', 'write ends', 'pdf page built']);
  assert.throws(() => pdfRoute.register(fakeApp(), { auth: () => {}, host: {} }), /ctx\.exclusive/);
});
