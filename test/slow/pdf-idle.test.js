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
process.env.PLANNR_PDF_IDLE_MS = '1500';
const H = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie;
before(async () => { await H.startApp(); cookie = H.seedLoggedIn().cookie; });
after(async () => { await H.stopApp(); });

test('the app idle-closes the PDF browser on its own after PDF_IDLE_MS of no activity', async () => {
  assert.strictEqual(H.app._pdfBrowserActive(), false, 'no browser before any Overview visit');
  await H.get('/overview', { cookie });                 // warmPdfBrowser() -> ASYNC launch + arm idle timer
  // warmPdfBrowser launches Chromium in the background, so "active" becomes true shortly AFTER the GET
  // returns — poll briefly instead of checking synchronously, which raced under full-suite CPU load.
  // The idle window (1.5s) starts only once it's warm, so it stays active well within this poll.
  for (let i = 0; i < 50 && !H.app._pdfBrowserActive(); i++) await sleep(100);
  assert.strictEqual(H.app._pdfBrowserActive(), true, 'warmed by the Overview visit');
  await sleep(6000);                                    // > PDF_IDLE_MS (1.5s) + launch + close margin
  assert.strictEqual(H.app._pdfBrowserActive(), false, 'the app closed it itself (idle timer), not stopApp');
});
