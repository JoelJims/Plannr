// Workstream C clean-up: helpers that the dev server (server.js) and the phone (public/local-api.js)
// used to copy line for line now live once, in core/. These checks keep it that way and pin what the
// shared helpers do.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('istDateStamp lives once, in core/ist-date.js, and gives the IST date', () => {
  const { istDateStamp, IST_TZ } = require('../core/ist-date.js');
  assert.strictEqual(IST_TZ, 'Asia/Kolkata');
  // 20:00 UTC on 21 November is 01:30 IST on 22 November: the IST date, not the UTC one.
  assert.strictEqual(istDateStamp(new Date('2026-11-21T20:00:00Z')), '2026-11-22');
  assert.strictEqual(istDateStamp(new Date('2026-11-21T18:29:59Z')), '2026-11-21');
  for (const file of ['server.js', 'public/local-api.js']) {
    assert.doesNotMatch(read(file), /function istDateStamp\(/, `${file} must use core/ist-date.js, not its own copy`);
  }
});

test('the owner queries live once, in core/owner.js', async () => {
  const { createOwnerQueries } = require('../core/owner.js');
  const calls = [];
  let adapterCalls = 0;
  const adapter = { get: async (sql, params) => { calls.push([sql, params]); return /FROM users WHERE id/.test(sql) ? (params[0] === 1 ? { 1: 1 } : undefined) : { id: 1, username: 'owner', displayName: 'Owner' }; } };
  const { getOwner, userExists, requireApiAuth } = createOwnerQueries(() => { adapterCalls++; return adapter; });
  assert.deepStrictEqual(await getOwner(), { id: 1, username: 'owner', displayName: 'Owner' });
  assert.strictEqual(await userExists(1), true);
  assert.strictEqual(await userExists(2), false);
  assert.strictEqual(await userExists('1'), false, 'only an integer id is checked');
  assert.strictEqual(calls.length, 3, 'a non-integer id never reaches the database');
  assert.strictEqual(adapterCalls, 3, 'the adapter is looked up on every query, never captured once');
  const req = {};
  let nextArg = 'not called';
  await requireApiAuth(req, {}, (e) => { nextArg = e; });
  assert.strictEqual(nextArg, undefined);
  assert.deepStrictEqual(req.user, { id: 1, username: 'owner', displayName: 'Owner' });
  const failing = createOwnerQueries(() => ({ get: async () => { throw new Error('boom'); } }));
  await failing.requireApiAuth({}, {}, (e) => { nextArg = e; });
  assert.strictEqual(nextArg.message, 'boom', 'a database error goes to next(err)');
  for (const file of ['server.js', 'public/local-api.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /const getOwner = \(\) =>/, `${file} must use core/owner.js, not its own getOwner`);
    assert.doesNotMatch(src, /const userExists = async/, `${file} must use core/owner.js, not its own userExists`);
  }
});

test('the start-up jobs helper lives once, in core/request-queue.js', async () => {
  const { createRequestQueue, createStartJobs } = await import('../core/request-queue.js');
  const queue = createRequestQueue();
  const order = [];
  const start = createStartJobs(queue);
  start.atStart(async () => { await new Promise((r) => setTimeout(r, 20)); order.push('first'); });
  const request = queue.run(async () => { order.push('request'); });
  start.atStart(() => { order.push('second'); });
  await start.whenDone();
  await request;
  assert.deepStrictEqual(order, ['first', 'request', 'second'], 'start-up jobs run in the request queue, in order');

  const failing = createStartJobs(createRequestQueue());
  failing.atStart(() => { throw new Error('start failed'); }); // no unhandled rejection: reported by whenDone()
  failing.atStart(() => 'ok');
  await assert.rejects(failing.whenDone(), /start failed/);

  for (const file of ['server.js', 'public/local-api.js']) {
    assert.doesNotMatch(read(file), /const startJobs = \[\];/, `${file} must use createStartJobs, not its own copy`);
  }
});
