// Visual suite (npm run test:ui) — invariants that only a real browser can check, kept OUT of the
// default node:test suite because they're slow. Boots the app in-process (isolated temp DB, WhatsApp
// + transport structurally disabled via PLANNR_TEST) and drives Playwright Chromium over real HTTP.
const H = require('../test/helpers');
const { chromium } = require('playwright');

const BIG_PAISE = 123456789;           // ₹12,34,567.89 — the unclipped-render case
const LEDGERS = Array.from({ length: 24 }, (_, i) => (i + 1) + '.0');

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  await H.startApp();
  const base = (await H.startApp()).base;
  // Seed: a logged-in user, 24 ledgers (one debit each) + the big-amount row, a contract + payment, a budget.
  const { user, cookie } = H.seedLoggedIn();
  const token = cookie.split('=')[1];
  for (const code of LEDGERS) H.seedCashOut({ amountPaise: 250000 + (code.length * 1234) % 90000, byUserId: user.id, ledgerCode: code });
  H.seedCashOut({ amountPaise: BIG_PAISE, byUserId: user.id, ledgerCode: '1.0' }); // merges into ledger 1.0
  H.db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise','2000000') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();

  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1700 } });
  const host = new URL(base).hostname;
  await ctx.addCookies([{ name: 'plannr_session', value: token, domain: host, path: '/' }]);

  const page = await ctx.newPage();

  // ---- Overview: swatches, re-render, table width, unclipped amount ----
  await page.goto(base + '/overview', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const swatches1 = await page.$$eval('.ov-swatch', (els) => els.map((e) => getComputedStyle(e).backgroundColor));
  // Swatch COUNT and "nothing rendered blank" only. Whether the 24 colours are actually
  // distinguishable is a perceptual question this assertion cannot answer — it once passed with
  // two pale greens ΔE00 6.30 apart in the legend, because they were distinct STRINGS. That
  // claim now lives in test-ui/palette-distinctness.js, which measures CIEDE2000 over all 276
  // pairs of the rendered chart.
  check('24 pie legend swatches, none blank', swatches1.length === 24 && swatches1.every((c) => c && c !== 'rgba(0, 0, 0, 0)'), `${swatches1.length} swatches`);

  // re-render: expand a ledger row, then apply an all-dates range
  await page.locator('.ov-legend-row.expandable').first().click().catch(() => {});
  await page.waitForTimeout(300);
  await page.click('#ovRangeEditBtn').catch(() => {});
  await page.click('#ovRangeAll').catch(() => {});
  await page.waitForTimeout(1000);
  const swatches2 = await page.$$eval('.ov-swatch', (els) => els.map((e) => getComputedStyle(e).backgroundColor));
  check('swatch colours survive a re-render (expand + range apply)', swatches2.length === 24 && new Set(swatches2).size === 24 && swatches2.every((c) => c && c !== 'rgba(0, 0, 0, 0)'), `${new Set(swatches2).size} distinct after re-render`);

  // table width == container, gap 0 — read mode
  const widthCheck = () => page.$eval('.tx-table', (t) => { const wrap = t.closest('.tx-scroll') || t.parentElement; return { table: Math.round(t.getBoundingClientRect().width), cont: Math.round(wrap.clientWidth), collapse: getComputedStyle(t).borderCollapse }; });
  const read = await widthCheck();
  check('table width equals its container (read mode), gap 0 (border-collapse)', Math.abs(read.table - read.cont) <= 2 && read.collapse === 'collapse', `table ${read.table}px vs container ${read.cont}px, border-collapse ${read.collapse}`);

  // ₹12,34,567.89 renders unclipped (read mode)
  const unclipped = await page.evaluate(() => {
    const cell = [...document.querySelectorAll('.tx-table td.tx-amount, .tx-table td')].find((td) => /12,34,567\.89/.test(td.textContent));
    if (!cell) return { found: false };
    return { found: true, clipped: cell.scrollWidth > cell.clientWidth + 1, text: cell.textContent.trim() };
  });
  check('₹12,34,567.89 renders unclipped in read mode', unclipped.found && !unclipped.clipped, unclipped.found ? `"${unclipped.text}"${unclipped.clipped ? ' CLIPPED' : ''}` : 'amount cell not found');

  // table width == container — edit mode
  await page.click('#ovEditBtn').catch(() => {});
  await page.waitForTimeout(800);
  const edit = await widthCheck();
  check('table width equals its container (edit mode), gap 0 (border-collapse)', Math.abs(edit.table - edit.cont) <= 2 && edit.collapse === 'collapse', `table ${edit.table}px vs container ${edit.cont}px, border-collapse ${edit.collapse}`);

  // ---- The By dropdown renders and shows the row's stored attribution (single-owner: Phase 1.6
  // removed login, so there is no second editor identity left to contrast "owner" against) ----
  H.clearLedger();
  H.seedCashOut({ amountPaise: 50000, byUserId: user.id, tenantId: user.id, ledgerCode: '1.0' });
  const ctxB = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
  await ctxB.addCookies([{ name: 'plannr_session', value: cookie.split('=')[1], domain: host, path: '/' }]);
  const pB = await ctxB.newPage();
  await pB.goto(base + '/overview', { waitUntil: 'networkidle' }); await pB.waitForTimeout(700);
  await pB.click('#ovEditBtn'); await pB.waitForTimeout(800);
  const by = await pB.$eval('select[data-f="by"]', (s) => ({ value: s.value, text: (s.options[s.selectedIndex] || {}).textContent || '' }));
  check('By select renders and shows the row\'s stored attribution', by.value === 'user:' + user.id && new RegExp(user.displayName).test(by.text), `By select value=${by.value} text="${by.text}"`);
  await ctxB.close();

  // ---- Dirty-check revert: change-then-revert saves nothing; a real change does save ----
  H.clearLedger();
  const editor = H.seedLoggedIn({ username: 'editor_v', displayName: 'Editor Vee' });
  const rowId = H.seedCashOut({ amountPaise: 12300, byUserId: editor.user.id, ledgerCode: '1.0' }); // ₹123.00
  H.seedCashOut({ amountPaise: 45600, byUserId: editor.user.id, ledgerCode: '2.0' });
  const ctxE = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
  await ctxE.addCookies([{ name: 'plannr_session', value: editor.cookie.split('=')[1], domain: host, path: '/' }]);
  const pE = await ctxE.newPage();
  let batchReqs = 0;
  pE.on('request', (req) => { if (req.method() === 'POST' && /\/api\/cash-out\/batch/.test(req.url())) batchReqs++; });
  await pE.goto(base + '/overview', { waitUntil: 'networkidle' }); await pE.waitForTimeout(700);
  await pE.click('#ovEditBtn'); await pE.waitForTimeout(800);
  const amt = pE.locator('input[data-f="amount"]').first();
  const orig = await amt.inputValue();
  await amt.fill('999.99'); await pE.waitForTimeout(150);
  await amt.fill(orig); await pE.waitForTimeout(150);            // reverted to the original value
  const reqsBeforeRevertSave = batchReqs;
  await pE.click('#ovSaveAllBtn'); await pE.waitForTimeout(600);  // no confirm modal appears when nothing changed
  const msg = await pE.$eval('#ovEditMsg', (e) => e.textContent);
  check('change-then-revert: Save All reports no changes and issues ZERO requests',
    /No changes to save/i.test(msg) && batchReqs === reqsBeforeRevertSave, `msg="${msg.trim()}", batch requests=${batchReqs - reqsBeforeRevertSave}`);

  await amt.fill('777.77'); await pE.waitForTimeout(150);         // a real, uncancelled change
  await pE.click('#ovSaveAllBtn'); await pE.waitForTimeout(400);
  await pE.click('[data-plc="ok"]').catch(() => {});             // confirm the Save All modal
  await pE.waitForTimeout(900);
  const stored = H.db.prepare('SELECT amount_paise FROM cash_out WHERE id=?').get(rowId).amount_paise;
  check('a real change: Save All issues a request and persists', batchReqs > reqsBeforeRevertSave && stored === 77777, `batch requests=${batchReqs - reqsBeforeRevertSave}, stored=${stored} paise`);
  await ctxE.close();

  // ---- F3 (review 2026-11-21): while the Overview loads, and when its load fails, the figures do not
  // say ₹0.00 (which reads as "nothing spent"); a failed load says so in a message the user can see.
  {
    const ctxF = await browser.newContext({ viewport: { width: 1500, height: 1700 } });
    const pF = await ctxF.newPage();
    const figs = () => pF.evaluate(() => ['figC', 'figB', 'figD'].map((id) => document.getElementById(id).textContent.trim()).concat(document.getElementById('ovBarSpent').textContent.trim()));
    // While loading: hold the first answer back until the page has been read.
    let release;
    const held = new Promise((r) => { release = r; });
    await pF.route('**/api/overview*', async (route) => { await held; await route.continue(); });
    await pF.goto(base + '/overview', { waitUntil: 'domcontentloaded' });
    await pF.waitForFunction(() => document.getElementById('figC'));
    const loading = await figs();
    release();
    await pF.waitForFunction(() => /\d/.test(document.getElementById('figC').textContent), null, { timeout: 15000 }).catch(() => {});
    const loaded = await figs();
    check('Overview while loading: no figure says ₹0.00', loading.every((t) => !/₹0\.00/.test(t)), loading.join(' | '));
    check('…and the real figures replace them once loaded', loaded.slice(0, 3).every((t) => /₹[\d,]+\.\d\d/.test(t)) && !loaded.some((t) => t.includes('…')), loaded.join(' | '));
    // A failed load: the app answers 500.
    await pF.unroute('**/api/overview*');
    await pF.route('**/api/overview*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'test: the database could not be read' }) }));
    await pF.reload({ waitUntil: 'networkidle' });
    const failed = await figs();
    const msg = await pF.$eval('#ovMsg', (el) => { const r = el.getBoundingClientRect(); return { text: el.textContent.trim(), shown: getComputedStyle(el).display !== 'none' && r.height > 0 && r.width > 0 }; });
    check('Overview load fails: no figure says ₹0.00', failed.every((t) => !/₹0\.00/.test(t)), failed.join(' | '));
    check('…and a visible message says the figures could not be loaded, with the reason', msg.shown && /could not be loaded/.test(msg.text) && /database could not be read/.test(msg.text), `shown=${msg.shown} "${msg.text}"`);
    await ctxF.close();
  }

  // ---- F5 (review 2026-11-21): Home said "First login — welcome." on every start, left from the
  // removed login (nothing has sent a last login since). The rendered page no longer says it.
  {
    const ctxH = await browser.newContext({ viewport: { width: 1500, height: 1700 } });
    const pH = await ctxH.newPage();
    await pH.goto(base + '/home.html', { waitUntil: 'networkidle' });
    await pH.waitForFunction(() => document.getElementById('name').textContent.trim() !== '…', null, { timeout: 15000 }).catch(() => {});
    const home = await pH.evaluate(() => ({ name: document.getElementById('name').textContent.trim(), text: document.body.innerText }));
    check('Home: the welcome shows the name, and no "First login" or "Last login" line', home.name && home.name !== '…' && !/First login|Last login/i.test(home.text),
      `name "${home.name}"; ${(home.text.match(/(First|Last) login[^\n]*/i) || ['no login line'])[0]}`);
    await ctxH.close();
  }

  // ---- F4 option (b) (review 2026-11-21; decided by the owner 2026-11-22): with a date range set,
  // "left" compared the spend in the range with the whole-project budget. Now the whole budget block
  // uses the whole project's spend: the label ("₹X left of total budget" / "₹X over total budget"),
  // the bar's fill and its amber "over" colour, the budget marker, and the caption, which says
  // "Spent ₹X in total" while a range is set. The range's own figures stay in the cards (D here).
  // Every check reads the RENDERED bar: box widths, the class list and the computed colour.
  {
    H.clearLedger();
    const cid = H.seedContract({ pricePaise: 10000000 });
    H.seedPayment({ contractId: cid, payDate: '2026-07-10', amountPaise: 200000 }); // July: ₹2,000 paid
    H.seedCashOut({ txDate: '2026-07-12', amountPaise: 500000, byUserId: user.id });  // July: ₹5,000 spent
    H.seedCashOut({ txDate: '2026-08-20', amountPaise: 800000, byUserId: user.id });  // August: ₹8,000
    const WHOLE = 1500000;              // ₹15,000: the whole project's spend
    const AMBER = 'rgb(255, 176, 32)';  // #ffb020, only in .ov-bar-fill.over (the normal fill ends in --accent #f59e0b)
    const setBudget = (p) => H.db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(p));
    setBudget(2000000); // ₹20,000: whole project ₹15,000 -> ₹5,000 left (the old figure: ₹13,000)
    const ctxR = await browser.newContext({ viewport: { width: 1500, height: 1700 } });
    const pR = await ctxR.newPage();
    // Wait for the page to show the expected answer, not for a fixed time. Card D and the label's
    // "Budget ₹Y" are written in the same render as the bar, so once both show the expected values
    // the bar is up to date. On a timeout the checks below still run and report what they saw.
    const settled = (figD, budget) => pR.waitForFunction(([d, b]) => document.getElementById('figD').textContent.trim() === d
      && document.getElementById('ovBarBudget').textContent.includes('Budget ' + b), [figD, budget], { timeout: 15000 }).catch(() => {});
    const applyJuly = async () => {
      await pR.click('#ovRangeEditBtn');
      for (const side of ['Start', 'End']) {
        await pR.selectOption(`#ov${side}Year`, '2026');
        await pR.selectOption(`#ov${side}Month`, '7');
        await pR.selectOption(`#ov${side}Day`, side === 'Start' ? '1' : '31');
      }
      await pR.click('#ovRangeApply');
    };
    const bar = () => pR.evaluate(() => {
      const $ = (id) => document.getElementById(id);
      const track = $('ovBar'), fill = $('ovBarFill'), marker = $('ovBarMarker');
      // The fill and the marker are absolutely positioned in the track, so their % is of the track's
      // inner box: clientWidth wide, starting clientLeft (the border) in from its left edge.
      const innerLeft = track.getBoundingClientRect().left + track.clientLeft, w = track.clientWidth;
      return {
        figD: $('figD').textContent.trim(),
        spent: $('ovBarSpent').textContent.trim(),
        label: $('ovBarBudget').textContent.trim(),
        fill: fill.getBoundingClientRect().width / w,
        marker: marker.hidden ? null : (marker.getBoundingClientRect().left - innerLeft) / w,
        overClass: fill.classList.contains('over'),
        colour: getComputedStyle(fill).backgroundImage,
      };
    });
    // The bar agrees with the label: the fill is whole / max(whole, budget) (within 1%), the budget
    // marker sits at budget / max(whole, budget), and the fill is amber exactly when the label says "over".
    const agrees = (b, budget) => {
      const scale = Math.max(WHOLE, budget), saysOver = /over total budget/.test(b.label);
      return Math.abs(b.fill - WHOLE / scale) <= 0.01 && b.marker != null && Math.abs(b.marker - budget / scale) <= 0.01
        && b.overClass === saysOver && b.colour.includes(AMBER) === saysOver;
    };
    const show = (b) => `fill ${(b.fill * 100).toFixed(1)}%, marker ${b.marker == null ? 'hidden' : (b.marker * 100).toFixed(1) + '%'}, `
      + `over class ${b.overClass}, amber ${b.colour.includes(AMBER)} | "${b.spent}" | "${b.label}" | card D ${b.figD}`;

    await pR.goto(base + '/overview', { waitUntil: 'networkidle' });
    await settled('₹15,000.00', '₹20,000.00');
    const none = await bar();
    check('F4 (b), no range, under budget: the bar is as before (75% full, not amber, "Spent ₹15,000.00", "₹5,000.00 left of total budget")',
      agrees(none, 2000000) && !none.overClass && none.spent === 'Spent ₹15,000.00' && none.label === '₹5,000.00 left of total budget · Budget ₹20,000.00', show(none));

    await applyJuly();
    await settled('₹7,000.00', '₹20,000.00');
    const left = await bar();
    check('F4 (b), July range, whole project under budget: the bar agrees with "₹5,000.00 left of total budget" (75% full, not amber)',
      agrees(left, 2000000) && !left.overClass && /^₹5,000\.00 left of total budget/.test(left.label), show(left));
    check('…and its caption shows the whole project\'s spend, "Spent ₹15,000.00 in total"; card D keeps the range\'s ₹7,000.00',
      left.spent === 'Spent ₹15,000.00 in total' && left.figD === '₹7,000.00', show(left));

    setBudget(1000000); // ₹10,000: the range (₹7,000) is under it, the whole project (₹15,000) is ₹5,000 over
    await applyJuly();
    await settled('₹7,000.00', '₹10,000.00');
    const over = await bar();
    check('F4 (b), July range, whole project over budget: the bar agrees with "₹5,000.00 over total budget" (full and amber), though the range alone is under',
      agrees(over, 1000000) && over.overClass && /^₹5,000\.00 over total budget/.test(over.label), show(over));
    check('…and its caption says "Spent ₹15,000.00 in total"; card D keeps the range\'s ₹7,000.00',
      over.spent === 'Spent ₹15,000.00 in total' && over.figD === '₹7,000.00', show(over));

    await pR.click('#ovRangeEditBtn');
    await pR.click('#ovRangeAll');
    await settled('₹15,000.00', '₹10,000.00');
    const all = await bar();
    check('F4 (b), no range, over budget: the bar is as before (full, amber, "Spent ₹15,000.00", "₹5,000.00 over total budget")',
      agrees(all, 1000000) && all.overClass && all.spent === 'Spent ₹15,000.00' && all.label === '₹5,000.00 over total budget · Budget ₹10,000.00', show(all));
    await ctxR.close();
  }

  await browser.close();
  await H.stopApp();
  console.log(`\n${failures === 0 ? '✓ VISUAL SUITE PASSED' : '✗ VISUAL SUITE FAILED (' + failures + ')'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
