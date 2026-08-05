// PDF dark-theme + range composition — via the authoritative composition seam H.app._overviewPdfHtml
// (server.js ~1729-1834), which returns the exact HTML page.pdf() rasterizes. No Chromium is launched
// (we never call page.pdf), so this is deterministic and offline. Theme colours and the range label are
// read straight from source: dark bg #15161a / light bg #ffffff; label "Date range: <b>…</b>" where …
// is "dd/mm/yy to dd/mm/yy" for a real range vs "All transactions" for none.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let tenantId;
before(async () => { await H.startApp(); tenantId = H.seedLoggedIn().user.id; });
after(async () => { await H.stopApp(); });
beforeEach(() => { H.clearLedger(); });

test("theme:'dark' uses the dark background #15161a; light does not", () => {
  H.seedCashOut({ tenantId, txDate: '2026-07-12', amountPaise: 111100 });
  const dark = H.app._overviewPdfHtml({ tenantId, theme: 'dark' });
  const light = H.app._overviewPdfHtml({ tenantId, theme: 'light' });
  assert.ok(dark.includes('#15161a'), 'dark output must carry the dark background hex #15161a');
  assert.ok(!light.includes('#15161a'), 'light output must NOT carry the dark background hex');
  assert.ok(light.includes('#ffffff'), 'light output carries the white background');
});

test("a real range excludes out-of-range rows and shows the 'Date range' label (not 'All transactions')", () => {
  H.seedCashOut({ tenantId, txDate: '2026-07-12', amountPaise: 111100 }); // in range
  H.seedCashOut({ tenantId, txDate: '2026-07-25', amountPaise: 222200 }); // out of range (after end)
  const html = H.app._overviewPdfHtml({ tenantId, part: 'full', range: { start: '2026-07-01', end: '2026-07-20' } });

  assert.ok(html.includes('12/07/26'), 'the in-range transaction date must appear in the table');
  assert.ok(!html.includes('25/07/26'), 'the out-of-range transaction date must be omitted');
  assert.ok(html.includes('Date range: <b>01/07/26 to 20/07/26</b>'), 'the range label must show the formatted start/end');
  assert.ok(!html.includes('All transactions'), 'a bounded range must NOT use the all-transactions label');
});

test("no range shows the 'All transactions' label and includes every seeded date", () => {
  H.seedCashOut({ tenantId, txDate: '2026-07-12', amountPaise: 111100 });
  H.seedCashOut({ tenantId, txDate: '2026-07-25', amountPaise: 222200 });
  const html = H.app._overviewPdfHtml({ tenantId, part: 'full' });
  assert.ok(html.includes('Date range: <b>All transactions</b>'), 'no range -> all-transactions label');
  assert.ok(html.includes('12/07/26') && html.includes('25/07/26'), 'both dates present when unbounded');
});
