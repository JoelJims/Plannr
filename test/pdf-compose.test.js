// PDF dark-theme + range composition — via H.pdfHtml, the exact HTML each target turns into the PDF:
// server.js's builder (H.app._overviewPdfHtml, the page page.pdf() rasterizes), or on the phone target
// the page public/local-api.js's PDF route hands to the PDF plugin. No Chromium is launched, so this is
// deterministic and offline. Theme colours and the range label are
// read straight from source: dark bg #15161a / light bg #ffffff; label "Date range: <b>…</b>" where …
// is "dd/mm/yy to dd/mm/yy" for a real range vs "All transactions" for none.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

before(async () => { await H.startApp(); H.seedLoggedIn(); });
after(async () => { await H.stopApp(); });
beforeEach(() => { H.clearLedger(); });

test("theme:'dark' uses the dark background #15161a; light does not", async () => {
  H.seedCashOut({ txDate: '2026-07-12', amountPaise: 111100 });
  const dark = await H.pdfHtml({ theme: 'dark' });
  const light = await H.pdfHtml({ theme: 'light' });
  assert.ok(dark.includes('#15161a'), 'dark output must carry the dark background hex #15161a');
  assert.ok(!light.includes('#15161a'), 'light output must NOT carry the dark background hex');
  assert.ok(light.includes('#ffffff'), 'light output carries the white background');
});

test("a real range excludes out-of-range rows and shows the 'Date range' label (not 'All transactions')", async () => {
  H.seedCashOut({ txDate: '2026-07-12', amountPaise: 111100 }); // in range
  H.seedCashOut({ txDate: '2026-07-25', amountPaise: 222200 }); // out of range (after end)
  const html = await H.pdfHtml({ part: 'full', range: { start: '2026-07-01', end: '2026-07-20' } });

  assert.ok(html.includes('12/07/26'), 'the in-range transaction date must appear in the table');
  assert.ok(!html.includes('25/07/26'), 'the out-of-range transaction date must be omitted');
  assert.ok(html.includes('Date range: <b>01/07/26 to 20/07/26</b>'), 'the range label must show the formatted start/end');
  assert.ok(!html.includes('All transactions'), 'a bounded range must NOT use the all-transactions label');
});

test("no range shows the 'All transactions' label and includes every seeded date", async () => {
  H.seedCashOut({ txDate: '2026-07-12', amountPaise: 111100 });
  H.seedCashOut({ txDate: '2026-07-25', amountPaise: 222200 });
  const html = await H.pdfHtml({ part: 'full' });
  assert.ok(html.includes('Date range: <b>All transactions</b>'), 'no range -> all-transactions label');
  assert.ok(html.includes('12/07/26') && html.includes('25/07/26'), 'both dates present when unbounded');
});

test('every PDF table with a total row: the total row spans exactly the header\'s columns', async () => {
  const cid = H.seedContract({ pricePaise: 2500000 });
  H.seedPayment({ contractId: cid, amountPaise: 400000 });
  H.seedCashOut({ txDate: '2026-07-12', amountPaise: 111100 });
  H.seedCashOut({ txDate: '2026-07-14', amountPaise: 50000, ledgerCode: '4.0', subledgerCode: '4.2' });
  const html = await H.pdfHtml({ part: 'full' });
  const width = (row) => [...row.matchAll(/<t[hd]\b([^>]*)>/g)].reduce((n, m) => n + Number((m[1].match(/colspan="(\d+)"/) || [0, 1])[1]), 0);
  let checked = 0;
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) || []) {
    const head = (table.match(/<thead>([\s\S]*?)<\/thead>/) || [])[1];
    const foot = (table.match(/<tfoot>([\s\S]*?)<\/tfoot>/) || [])[1];
    if (!head || !foot) continue;
    const title = (foot.match(/<td[^>]*>([^<]*)/) || [])[1];
    assert.strictEqual(width(foot), width(head), `"${title}" row is ${width(foot)} columns wide; the header has ${width(head)}`);
    checked++;
  }
  assert.ok(checked >= 2, `expected the Transactions and owed tables to have total rows; checked ${checked}`);
});
