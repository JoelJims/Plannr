// One request at a time (step 1.4 B3; docs/step-1.4-storage-plan.md §1.1).
//
// Once the database calls are async (stage B5 onwards), two requests could interleave: request B's
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
// Not wired into server.js or local-api.js yet: while every database call is synchronous, a request
// cannot be interrupted between two of them. It is wired in with the first async database call.

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
