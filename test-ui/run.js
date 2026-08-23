// Visual suite (npm run test:ui) — invariants that only a real browser can check, kept OUT of the
// default node:test suite because they're slow. Boots the app in-process (isolated temp DB, WhatsApp
// + transport structurally disabled via PLANNR_TEST) and drives Playwright Chromium over real HTTP.
const H = require('../test/helpers');
const { chromium } = require('playwright');

const BIG_PAISE = 123456789;           // ₹12,34,567.89 — the unclipped-render case
const LEDGERS = Array.from({ length: 23 }, (_, i) => (i + 1) + '.0');

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  await H.startApp();
  const base = (await H.startApp()).base;
  // Seed: a logged-in user, 23 ledgers (one debit each) + the big-amount row, a contract + payment, a budget.
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
  check('23 pie legend swatches, all with distinct colours', swatches1.length === 23 && new Set(swatches1).size === 23, `${swatches1.length} swatches, ${new Set(swatches1).size} distinct`);

  // re-render: expand a ledger row, then apply an all-dates range
  await page.locator('.ov-legend-row.expandable').first().click().catch(() => {});
  await page.waitForTimeout(300);
  await page.click('#ovRangeEditBtn').catch(() => {});
  await page.click('#ovRangeAll').catch(() => {});
  await page.waitForTimeout(1000);
  const swatches2 = await page.$$eval('.ov-swatch', (els) => els.map((e) => getComputedStyle(e).backgroundColor));
  check('swatch colours survive a re-render (expand + range apply)', swatches2.length === 23 && new Set(swatches2).size === 23 && swatches2.every((c) => c && c !== 'rgba(0, 0, 0, 0)'), `${new Set(swatches2).size} distinct after re-render`);

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

  await browser.close();
  await H.stopApp();
  console.log(`\n${failures === 0 ? '✓ VISUAL SUITE PASSED' : '✗ VISUAL SUITE FAILED (' + failures + ')'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
