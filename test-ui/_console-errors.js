// The console/page error collector shared by the UI suites that load pages from local-server.js
// (static-hosting.js and offline.js). Each of those suites fails a check if the page logs any error.
//
// sqlite-wasm's own fallback (review finding F7). If its first way of loading sqlite3.wasm
// (WebAssembly.instantiateStreaming) fails, sqlite-wasm logs these two lines with console.error,
// one right after the other, and then loads the file a second way. In these suites the first way
// fails with "Failed to fetch" when a suite leaves a page while its .wasm is still downloading:
// cash-flow.html can look idle to 'networkidle' for seconds before it asks for the file. That made
// static-hosting.js fail on 2026-11-20 and on CI on 2026-11-22 (on a branch that changed only docs).
// offline.js leaves cash-flow.html the same way.
// Only this pair, in this order, is ignored. Everything else still fails the check: any other
// error, either line on its own, and the second way failing too (sqlite-wasm then logs "failed to
// asynchronously prepare wasm"). A wrong Content-Type for sqlite3.wasm also makes the first way
// fail, so static-hosting.js checks that header on its own.
const WASM_STREAMING_FAILED = 'wasm streaming compile failed: ';
const WASM_FALLING_BACK = 'falling back to ArrayBuffer instantiation';

// Collect every console error and page error the page reports, as '[console.error] ...' and
// '[pageerror] ...' strings. The caller reads the array and empties it (errors.length = 0).
function attachErrorCollector(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const prev = errors[errors.length - 1];
    if (text.startsWith(WASM_FALLING_BACK) && prev && prev.startsWith(`[console.error] ${WASM_STREAMING_FAILED}`)) {
      errors.pop(); // the streaming line logged just before it: the pair goes, nothing else does
      return;
    }
    errors.push(`[console.error] ${text}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return errors;
}

module.exports = { attachErrorCollector };
