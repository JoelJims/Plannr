// One request at a time (step 1.4 B3; docs/step-1.4-storage-plan.md §1.1).
//
// Once the database calls are async (from stage B5 on), two requests could interleave: request B's
// write could land inside request A's open transaction and be rolled back with it, or B could find A's
// transaction open and be refused. The core runs each request through this queue, so a request
// starts only when the one before it has finished, whether that one succeeded or failed.
//
//   const queue = createRequestQueue();
//   await queue.run(async () => { ... one request ... });
//
// run(fn) returns what fn returns (or its error). An error never stops the requests after it.
// Plannr has one user, so waiting costs nothing that matters. Work that takes seconds and needs no
// database (rendering a PDF from finished HTML) should happen outside the queue, so it does not hold
// up the next request.
//
// Wired in since step 1.4 B5 (the first awaited database calls): server.js and public/local-api.js
// each make one queue and register every /api route through queuedRoutes() below, so no route can
// skip it by accident.

export function createRequestQueue() {
  let tail = Promise.resolve();
  let waiting = 0;
  return {
    run(fn) {
      if (typeof fn !== 'function') return Promise.reject(new TypeError('queue.run: pass a function.'));
      waiting++;
      const result = tail.then(() => fn()); // a synchronous throw in fn becomes a rejection here
      const settled = result.then(() => {}, () => {});
      tail = settled;
      settled.then(() => { waiting--; });
      return result;
    },
    // Requests queued or running.
    get size() { return waiting; },
  };
}

// ---- Wiring (step 1.4 B5) ------------------------------------------------------------------------------
//
//   const api = queuedRoutes(app, queue);          // app: Express, or the phone's route table
//   api.get('/api/x', auth, (req, res) => { ... }) // the handler runs inside queue.run()
//
// queuedRoutes() wraps each route's handler (its last function); anything before it (auth) runs as
// before. A handler marked with outsideQueue() is registered unwrapped: it must run its database part
// through the queue itself (ctx.exclusive(fn), which is queue.run) and do only database-free work
// outside it. Only the Overview PDF does that: its page is built inside the queue, the render outside.
// Never call ctx.exclusive() from a queued handler: it would wait for the queue that handler holds.
export const QUEUED = Symbol.for('plannr.request-queue.queued');
export const OUTSIDE_QUEUE = Symbol.for('plannr.request-queue.outside');

export function outsideQueue(handler) {
  if (typeof handler !== 'function') throw new TypeError('outsideQueue: pass the route handler.');
  handler[OUTSIDE_QUEUE] = true;
  return handler;
}

export function queuedHandler(queue, handler) {
  if (typeof handler !== 'function') throw new TypeError('queuedHandler: pass the route handler.');
  if (handler[OUTSIDE_QUEUE]) return handler;
  const queued = (req, res, next) => {
    const done = queue.run(() => handler(req, res, next));
    // Express 4 does not catch a rejected promise, so pass the error to its error handler (a throw
    // that Express used to catch itself now arrives here). The phone's dispatcher passes no next and
    // awaits the promise itself.
    return typeof next === 'function' ? done.catch(next) : done;
  };
  queued[QUEUED] = true;
  return queued;
}

export function queuedRoutes(app, queue) {
  if (!queue || typeof queue.run !== 'function') throw new TypeError('queuedRoutes: pass the request queue.');
  const routes = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    routes[method] = (path, ...fns) => {
      if (!fns.length) throw new TypeError(`queuedRoutes: ${method}(${JSON.stringify(path)}) has no handler.`);
      return app[method](path, ...fns.slice(0, -1), queuedHandler(queue, fns[fns.length - 1]));
    };
  }
  return routes;
}
