// The Windows CI flake (2026-11-21): two random tests per run failed with "fetch failed", cause
// "read ECONNRESET", after hanging for seconds. Cause: the tests' server runs in the SAME process and
// event loop as the fetch that drives it. When a request is written on a reused keep-alive socket and
// the loop then stalls (a CPU-starved runner) past the server's idle deadline (keepAliveTimeout 5 s +
// keepAliveTimeoutBuffer 1 s on Node 24), the server's timer fires before it has read the request and
// destroys the socket: RST, ECONNRESET. helpers.startApp turns the test server's idle timeout off (the
// client still closes idle sockets itself), so such a stall can only delay a request.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Longer than Node's default idle deadline (5000 ms + 1000 ms buffer). The control below proves it.
const STALL_MS = 6500;
// Blocks the event loop like a starved runner does, without burning a CPU core.
const stall = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const outcome = (p) => p.then((v) => v, (e) => `failed: ${(e.cause && e.cause.code) || e.message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const express = H.TARGET === 'express';
let server;
before(async () => { if (express) ({ server } = await H.startApp()); });
after(async () => { if (express) await H.stopApp(); });

test('a request written just before a long event-loop stall still gets its answer (no keep-alive reset)',
  { skip: !express && 'the phone target has no HTTP server' }, async (t) => {
    // Control: a plain Node server with default keep-alive settings, in the same loop. If the stall does
    // not reset ITS request, this Node no longer has the hazard and the check below would prove nothing.
    const control = http.createServer((q, r) => { r.setHeader('Content-Type', 'application/json'); r.end('{"ok":true}'); });
    await new Promise((r) => control.listen(0, '127.0.0.1', r));
    const cbase = `http://127.0.0.1:${control.address().port}/`;
    let opened = 0;
    const countNew = () => { opened++; };
    try {
      // One answered request on each server leaves an idle keep-alive socket to each.
      assert.deepStrictEqual(await fetch(cbase).then((r) => r.json()), { ok: true });
      assert.strictEqual((await H.req('GET', '/api/health')).status, 200);
      await sleep(100); // both sockets are back in the client's idle pool
      server.on('connection', countNew);
      // Both requests reuse those sockets and are written now; the stall comes before either is read.
      const h = outcome(H.req('GET', '/api/health').then((r) => r.status));
      const c = outcome(fetch(cbase).then((r) => r.json()).then(() => 'answered'));
      await new Promise((r) => setImmediate(() => { stall(STALL_MS); r(); }));
      const [hr, cr] = await Promise.all([h, c]);
      // The bug's state needs both: the default server WAS reset, and our request went on the OLD socket.
      if (cr === 'answered') { t.skip(`vacuous: a default server survived a ${STALL_MS} ms stall on ${process.version}`); return; }
      if (opened > 0) { t.skip(`vacuous: the request opened a new connection (helper: ${hr}), so no idle timer was involved`); return; }
      assert.strictEqual(hr, 200, `the test server reset a request written on its idle socket before a ${STALL_MS} ms `
        + `stall (the control server: ${cr}); helpers.startApp must turn the server's idle timeout off`);
    } finally {
      server.off('connection', countNew);
      control.closeAllConnections();
      await new Promise((r) => control.close(r));
    }
  });
