// Contract Details layout (Phase C) — structure and phone-width behaviour.
//
// Phase A added seven optional fields to a form that already had ten. Everything still worked, and
// on a 390px screen the two fields the contractor's dues are computed from had been pushed below a
// screen and a half of boxes that compute nothing. This suite pins the restructure that fixed it:
// the core stays above the fold, the optional metadata is collapsed but never hidden from someone
// who has used it, and the allowance table does not render as an empty ten-column grid on a
// contract that has no allowances.
//
// Run: node test-ui/contract-details-layout.js
const H = require('../test/helpers');
const { chromium } = require('playwright');

// The main ledger is chosen through the searchable browser now, not a <select>. Search for the code,
// then click the result — which is what a user does, and what a selectOption() call stopped testing
// the moment the picker changed.
async function pickLedger(page, triggerSel, code) {
  await page.click(triggerSel);
  await page.waitForSelector('.lb-backdrop:not([hidden]) .lb-search', { timeout: 5000 });
  await page.fill('.lb-search', code);
  await page.waitForTimeout(120);
  await page.click(`.lb-row[data-act="main"][data-code="${code}"]`);
  await page.waitForSelector('.lb-backdrop', { state: 'hidden', timeout: 5000 });
}


const PHONE = { width: 390, height: 844 };   // iPhone 14-ish, the narrow case that matters
const DESK = { width: 1400, height: 1800 };

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

// Fields that decide money, and must be reachable without hunting.
const CORE = ['#cContractor', '#cArea', '#cLedgerSelect', '#cRate', '#cAreaSqft', '#cStated'];
// Fields that decide nothing, and belong behind the fold.
const OPTIONAL = ['#hasSignedDate', '#hasEndDate', '#cMonths', '#cSupervision', '#cAmount', '#cBrands', '#cExcluded', '#cObligations'];

(async () => {
  const base = (await H.startApp()).base;
  const { cookie } = H.seedLoggedIn();
  const token = cookie.split('=')[1];

  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: PHONE });
  await ctx.addCookies([{ name: 'plannr_session', value: token, domain: new URL(base).hostname, path: '/' }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(base + '/contract-details', { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  console.log('── new contract, 390px ───────────────────────────────────────────');

  // 1. The optional block starts collapsed, and everything in it really is inside it.
  check('the optional block is collapsed on a new contract', (await page.getAttribute('#cdOptional', 'open')) === null);
  const containment = await page.evaluate((sels) => {
    const det = document.getElementById('cdOptional');
    return sels.map((s) => ({ s, inside: det.contains(document.querySelector(s)) }));
  }, OPTIONAL);
  const stray = containment.filter((x) => !x.inside);
  check('every optional field is inside the collapsible', stray.length === 0, stray.map((x) => x.s).join(', '));

  const coreOutside = await page.evaluate((sels) => {
    const det = document.getElementById('cdOptional');
    return sels.filter((s) => det.contains(document.querySelector(s)));
  }, CORE);
  check('no core field got swept in with them', coreOutside.length === 0, coreOutside.join(', '));

  // 2. The point of the exercise: the pricing fields are reachable on a phone without hunting.
  const yOf = (sel) => page.$eval(sel, (e) => e.getBoundingClientRect().top + window.scrollY);
  const statedY = await yOf('#cStated');
  const docH = await page.evaluate(() => document.documentElement.scrollHeight);
  check('the total contract value sits within the first two phone screens', statedY < PHONE.height * 2, `${Math.round(statedY)}px (viewport ${PHONE.height})`);
  check('the whole form is shorter than it was before the split', docH < 4200, `document height ${docH}px`);

  // 3. Collapsed does not mean lost: opening it reveals the fields, and they still submit.
  await page.click('#cdOptional > summary');
  await page.waitForTimeout(200);
  check('opening the summary reveals the optional fields', await page.isVisible('#cSupervision'));
  const summaryFocusable = await page.evaluate(() => {
    const sum = document.querySelector('#cdOptional > summary');
    sum.focus();
    return document.activeElement === sum;
  });
  check('the summary is keyboard-focusable (native <details>, no JS)', summaryFocusable);

  console.log('\n── the count, and auto-opening ───────────────────────────────────');
  check('the summary says "all optional" while nothing is filled', (await page.textContent('#cdOptionalCount')).trim() === 'all optional');
  await page.fill('#cSupervision', '12.5');
  await page.fill('#cBrands', 'As specified');
  await page.waitForTimeout(150);
  check('...and counts the fields as they are filled', (await page.textContent('#cdOptionalCount')).trim() === '2 set', await page.textContent('#cdOptionalCount'));

  // Save, reload, and confirm the block opens itself rather than hiding data behind a summary.
  await page.fill('#cContractor', 'Ramesh & Co');
  await page.fill('#cArea', 'Structural');
  await pickLedger(page, '#cLedgerTrigger', '5.0');
  await page.fill('#cRate', '1850');
  await page.click('#contractSaveBtn');
  await page.waitForTimeout(700);
  check('a contract with optional data re-opens the block on load', (await page.getAttribute('#cdOptional', 'open')) !== null);
  check('and the count reflects what was saved', (await page.textContent('#cdOptionalCount')).trim() === '2 set', await page.textContent('#cdOptionalCount'));

  console.log('\n── allowances: hidden when empty ─────────────────────────────────');
  check('the allowances section is present', await page.isVisible('#allowancesSection'));
  check('the table is hidden when there are none', !(await page.isVisible('#allowancesList')));
  check('so is the add form', !(await page.isVisible('#allowanceForm')));
  check('a prompt is shown instead', await page.isVisible('#allowancesEmpty'));
  check('with the one way in', await page.isVisible('#alwAddOneBtn'));
  check('and no button that installs a default set of caps', (await page.$('#alwSeedBtn')) === null);

  await page.click('#alwAddOneBtn');
  await page.waitForTimeout(200);
  check('"add an allowance" reveals the form', await page.isVisible('#allowanceForm'));

  // One hand-entered cap is what makes the table appear now that nothing seeds a set, so the
  // phone-width row checks below still have a row to measure.
  await page.fill('#alwName', 'Sanitaryware');
  await page.fill('#alwCap', '18000');
  await page.click('#alwAddBtn');
  await page.waitForTimeout(700);
  check('a typed cap shows the table and retires the prompt', await page.isVisible('#allowancesList') && !(await page.isVisible('#allowancesEmpty')));

  console.log('\n── phone width: the allowance rows ───────────────────────────────');
  // At 390px each row is a single column. Six unlabelled boxes in a stack is a guessing game, so the
  // per-field labels turn on below 800px.
  const labelsShown = await page.$$eval('.cd-alw-row:first-child .cd-alw-fieldlabel', (els) => els.map((e) => getComputedStyle(e).display));
  check('per-field labels are visible at 390px', labelsShown.length > 0 && labelsShown.every((d) => d !== 'none'), `${labelsShown.length} labels, displays: ${[...new Set(labelsShown)].join('/')}`);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('nothing overflows horizontally at 390px', overflow <= 0, `${overflow}px of horizontal scroll`);

  const rowCols = await page.$eval('.cd-alw-row .cd-alw-grid', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  check('the allowance grid collapses to one column at 390px', rowCols === 1, `${rowCols} columns`);

  // Tap targets: buttons in a stacked row should be comfortably hittable, not 20px slivers.
  const btnH = await page.$$eval('.cd-alw-row:first-child .cd-btn-sm', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  check('row buttons are at least 32px tall', btnH.length > 0 && Math.min(...btnH) >= 32, `heights ${btnH.join('/')}`);

  console.log('\n── desk width: the row reads as a table again ────────────────────');
  await page.setViewportSize(DESK);
  await page.waitForTimeout(250);
  const deskCols = await page.$eval('.cd-alw-row .cd-alw-grid', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  check('the allowance grid is multi-column at 1400px', deskCols >= 5, `${deskCols} columns`);
  const deskLabels = await page.$$eval('.cd-alw-row:first-child .cd-alw-fieldlabel', (els) => els.map((e) => getComputedStyle(e).display));
  check('per-field labels are suppressed at desk width', deskLabels.every((d) => d === 'none'));

  check('no console or page errors throughout', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  await H.stopApp();
  console.log(failures === 0 ? '\n✓ CONTRACT DETAILS LAYOUT PASSED' : `\n✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
