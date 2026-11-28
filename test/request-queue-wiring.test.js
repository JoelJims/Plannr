// Step 1.4 B5: the request queue (core/request-queue.js) is switched on, on the dev server and in the
// phone's code. run-tests.js runs this file against both (server.js, then public/local-api.js through
// test/shim-target.js); each check uses the queue and route table of the code under test.
//
// 1. Every /api route runs through the queue, except the Overview PDF (its page is built inside the
//    queue, the render outside it).
// 2. A request waits while the queue is held and is answered once it is released (on the dev server,
//    a page is still answered meanwhile: the known positive that the test can see a request go
//    through).
// 3. An error inside a queued route still gets the error handler's answer (a failed save: "Couldn't
//    save – try again.", Q11).
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const shimTarget = H.TARGET === 'shim' ? require('./shim-target') : null;
let QUEUED, OUTSIDE_QUEUE;

before(async () => {
  await H.startApp();
  ({ QUEUED, OUTSIDE_QUEUE } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'request-queue.js')).href));
});
after(() => H.stopApp());

const requestQueue = () => (shimTarget ? shimTarget.wiring().requestQueue : H.app._requestQueue);
// Every /api route of the code under test: "METHOD /path" and its handler (the last function).
function apiRoutes() {
  if (shimTarget) return shimTarget.wiring().routes.map((r) => ({ name: `${r.method} ${r.path}`, handler: r.handler }));
  return H.app._router.stack.filter((l) => l.route).flatMap((l) => [].concat(l.route.path)
    .filter((p) => typeof p === 'string' && p.startsWith('/api/'))
    .flatMap((p) => Object.keys(l.route.methods).map((m) => ({ name: `${m.toUpperCase()} ${p}`, handler: l.route.stack[l.route.stack.length - 1].handle }))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('every /api route runs through the request queue; only the Overview PDF is outside it', { timeout: 10000 }, () => {
  const routes = apiRoutes();
  assert.ok(routes.length >= 40, `found only ${routes.length} /api routes`);
  const outside = routes.filter((r) => r.handler[OUTSIDE_QUEUE]).map((r) => r.name);
  const neither = routes.filter((r) => !r.handler[QUEUED] && !r.handler[OUTSIDE_QUEUE]).map((r) => r.name);
  assert.deepStrictEqual(neither, [], 'routes that skip the queue');
  assert.deepStrictEqual(outside, ['GET /api/overview/pdf']);
});

test('a request waits while the request queue is held, and is answered once it is released', { timeout: 10000 }, async () => {
  let release;
  const held = requestQueue().run(() => new Promise((r) => { release = r; }));
  let answered = false;
  const pending = H.get('/api/budget').then((r) => { answered = true; return r; });
  if (!shimTarget) {
    const page = await H.req('GET', '/home.html');
    assert.strictEqual(page.status, 200, 'a page (no database) is answered while the queue is held');
  }
  await sleep(150);
  assert.strictEqual(answered, false, '/api/budget was answered while the queue was held');
  release();
  await held;
  const r = await pending;
  assert.strictEqual(r.status, 200);
  assert.ok(r.json && 'budgetPaise' in r.json);
});

test('an error inside a queued route gets the error handler\'s answer ("Couldn\'t save – try again.")', { timeout: 10000 }, async () => {
  // A refused write on the shared connection: setting the budget then throws inside its handler.
  H.db.exec("CREATE TEMP TRIGGER b5_refuse_settings BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
  const quiet = console.error;
  console.error = () => {}; // the server logs the error; the answer is what is checked here
  try {
    const r = await H.put('/api/budget', { budgetRupees: '1000' });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.json && r.json.error, "Couldn't save – try again."); // Q11: a failed save (the dev server adds a detail)
  } finally {
    console.error = quiet;
    H.db.exec('DROP TRIGGER b5_refuse_settings');
  }
  const next = await H.get('/api/budget');
  assert.strictEqual(next.status, 200, 'the next request still runs');
});
