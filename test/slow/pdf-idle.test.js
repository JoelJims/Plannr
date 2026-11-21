// Phase 10A #2 — the PDF browser must idle-close ITSELF (its own timer), not only via stopApp.
// Set a low idle window BEFORE the app loads, warm the browser via /overview, wait past the window,
// and assert the app closed it on its own. (Launches a real Playwright Chromium — allowed; not WhatsApp.)
//
// SLOW SUITE (Security pass, Part D2): this is a wall-clock TIMING test — it warms a real Chromium and
// waits out an idle window. In the fast `npm test` (node --test runs files in PARALLEL) it contended
// with the other browser tests and flaked intermittently; a flaky test in the suite that GUARDS TENANCY
// (the isolation harness) is corrosive — a spurious red trains people to ignore a red that might be a
// real cross-tenant leak. It is not weakened, just relocated: run SERIALLY via `npm run test:slow` it
// passes reliably (the behaviour is unchanged — the timing dependency simply belongs where nothing
// else is competing for the CPU/Chromium at the same moment).
//
// The idle timer is armed when the Overview visit starts the launch, not when Chromium is ready. With
// a 1.5 s window, a slow start under load could close the browser before the test looked (seen once in
// a full run, 2026-11-19). The window is 5 s now, and the test waits for the close instead of sleeping.
const IDLE_MS = 5000;
process.env.PLANNR_PDF_IDLE_MS = String(IDLE_MS);
const H = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie;
before(async () => { await H.startApp(); cookie = H.seedLoggedIn().cookie; });
after(async () => { await H.stopApp(); });

test('the app idle-closes the PDF browser on its own after PDF_IDLE_MS of no activity', async () => {
  assert.strictEqual(H.app._pdfBrowserActive(), false, 'no browser before any Overview visit');
  const visited = Date.now();
  await H.get('/overview', { cookie });                 // warmPdfBrowser(): starts the launch, arms the idle timer
  // The launch starts during the visit, so the browser counts as active once the GET returns; poll
  // briefly anyway. This is well inside the 5 s window, so it cannot race the close.
  for (let i = 0; i < 20 && !H.app._pdfBrowserActive(); i++) await sleep(100);
  assert.strictEqual(H.app._pdfBrowserActive(), true, 'warmed by the Overview visit');
  // Then wait (up to 30 s) for the app to close it by itself, and check it waited out the window.
  while (H.app._pdfBrowserActive() && Date.now() - visited < 30000) await sleep(100);
  const closedAfter = Date.now() - visited;
  assert.strictEqual(H.app._pdfBrowserActive(), false, 'the app closed it itself (idle timer), not stopApp');
  assert.ok(closedAfter >= IDLE_MS - 100, `closed by the idle timer, not before it (after ${closedAfter} ms)`);
});
