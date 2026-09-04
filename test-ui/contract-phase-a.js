// Contract Phase A — browser smoke suite for the Contract Details page and the debit form.
//
// The Phase A UI is a lot of new DOM that node:test cannot see: a derived-total readout that must
// appear and disable the typed field, a scope list with no price input left on it, an allowance list
// whose over/under wording differs by cap kind, and an allowance picker on the debit form. This
// drives all of it through a real browser against a real server on an isolated temp DB, and fails on
// any console error along the way.
//
// Run: node test-ui/contract-phase-a.js
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


// Every allowance is now entered by hand - the ten-row default set lifted from one agreement is
// gone, so the suite drives the same add form an owner uses.
async function addAllowance(page, { name, kind, cap }) {
  await page.fill('#alwName', name);
  await page.selectOption('#alwKind', kind);
  await page.fill('#alwCap', cap);
  await page.click('#alwAddBtn');
  await page.waitForTimeout(600);
}

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  const base = (await H.startApp()).base;
  const { cookie } = H.seedLoggedIn();
  const token = cookie.split('=')[1];

  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1800 } });
  await ctx.addCookies([{ name: 'plannr_session', value: token, domain: new URL(base).hostname, path: '/' }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // ---- create a rate-priced contract -------------------------------------------------------------
  await page.goto(base + '/contract-details', { waitUntil: 'networkidle' });
  await page.fill('#cContractor', 'ACME Builders');
  await page.fill('#cArea', 'Structural & RCC');
  await pickLedger(page, '#cLedgerTrigger', '5.0');

  // the derived readout stays quiet until BOTH halves are present
  await page.fill('#cRate', '1850');
  check('one half of a rate price shows the "not yet a price" note, not a total',
    await page.isVisible('#cComputed') && (await page.textContent('#cComputed')).includes('together set the total'));
  check('the typed total stays editable while the rate price is incomplete', !(await page.isDisabled('#cStated')));

  await page.fill('#cAreaSqft', '1240.5');
  const computed = (await page.textContent('#cComputed')).trim();
  check('rate + area shows the derived total', computed.includes('22,94,925'), computed);
  check('and disables the typed total so an ignored number cannot sit in an enabled box', await page.isDisabled('#cStated'));
  check('with a note saying where the figure came from', await page.isVisible('#cStatedDerivedNote'));

  // optional metadata, including the derived expected completion date. Phase C moved all of this
  // behind a collapsed <details> — open it first, exactly as a user would.
  await page.click('#cdOptional > summary');
  await page.waitForTimeout(150);
  await page.check('#hasSignedDate');
  // Month and year FIRST: attachDatePicker builds the day list for the currently selected month, so
  // picking the 31st before switching to January only works in a 31-day month. Written in August,
  // this passed; run it in September (30 days) and '31' is not an option yet. Order, not timing.
  await page.selectOption('#dsMonth', '1');
  await page.selectOption('#dsYear', '2026');
  await page.selectOption('#dsDay', '31');
  await page.fill('#cMonths', '1');
  const expected = (await page.textContent('#cExpected')).trim();
  check('expected completion is derived and clamps to the month end (31 Jan + 1 month)', expected.includes('28/02/26'), expected);
  await page.fill('#cSupervision', '12.5');
  await page.fill('#cBrands', 'Cement: as specified');
  await page.fill('#cExcluded', 'Compound wall');
  await page.fill('#cObligations', 'Water at site');

  await page.click('#contractSaveBtn');
  await page.waitForTimeout(600);
  const saved = (await page.evaluate(() => fetch('/api/contracts').then((r) => r.json()))).contracts[0];
  check('the contract saved with the DERIVED total in the stated column', saved.statedAmountPaise === 229492500, String(saved.statedAmountPaise));
  check('pricingMode reports how the total was arrived at', saved.pricingMode === 'rate', saved.pricingMode);
  check('metadata round-tripped through the form', saved.supervisionRatePct === 12.5 && saved.specifiedBrands === 'Cement: as specified' && saved.completionPeriodMonths === 1);
  check('the optional block auto-opens for a contract that uses it', await page.getAttribute('#cdOptional', 'open') !== null);
  check('the form reloads in edit mode with the rate and area repopulated',
    (await page.inputValue('#cRate')) === '1850.00' && (await page.inputValue('#cAreaSqft')) === '1240.5',
    `${await page.inputValue('#cRate')} / ${await page.inputValue('#cAreaSqft')}`);

  // ---- the typed total must survive a trip through rate pricing -----------------------------------
  // Filling in a rate and an area takes over the total box. Clearing either one has to hand the box
  // back with what the OWNER typed, not with the computed figure left sitting there looking typed.
  await page.fill('#cAreaSqft', '');
  await page.waitForTimeout(150);
  check('clearing the area hands the total box back, empty (this contract never had a typed total)',
    !(await page.isDisabled('#cStated')) && (await page.inputValue('#cStated')) === '',
    JSON.stringify(await page.inputValue('#cStated')));
  await page.fill('#cStated', '2500000');
  await page.fill('#cAreaSqft', '1240.5');
  await page.waitForTimeout(150);
  check('...and a typed total is taken over, not destroyed', (await page.inputValue('#cStated')) === '2294925.00');
  await page.fill('#cRate', '');
  await page.waitForTimeout(150);
  check('...it comes back verbatim when the rate price is broken up', (await page.inputValue('#cStated')) === '2500000',
    await page.inputValue('#cStated'));
  await page.fill('#cRate', '1850');
  await page.waitForTimeout(150);

  // ---- scope list: names only --------------------------------------------------------------------
  check('the scope section appears once a contract exists', await page.isVisible('#scopeSection'));
  check('the allowances section is its own section', await page.isVisible('#allowancesSection'));
  check('there is no service price input anywhere on the page', (await page.$$('.cd-svc-price')).length === 0 && (await page.$('#svcPrice')) === null);
  check('and no remainder line', (await page.$('#remainderLine')) === null);
  await page.fill('#svcName', 'Electrical rough-in');
  await page.click('#svcAddBtn');
  await page.waitForTimeout(500);
  check('a scope item can be added', (await page.$$('.cd-svc-row')).length === 1);

  // ---- allowances: entered by hand, because there is no seeded set ------------------------------
  check('the empty state is a prompt, not a table', await page.isVisible('#allowancesEmpty') && !(await page.isVisible('#allowancesList')) && !(await page.isVisible('#allowanceForm')));
  check('there is no button that installs a default set of caps', (await page.$('#alwSeedBtn')) === null);

  await page.click('#alwAddOneBtn');
  await page.waitForTimeout(250);
  check('the prompt reveals the add form', await page.isVisible('#allowanceForm'));

  await addAllowance(page, { name: 'Sanitaryware', kind: 'lump', cap: '40000' });
  await addAllowance(page, { name: 'Wall tiling', kind: 'per_sqft', cap: '60' });
  const rows = await page.$$('.cd-alw-row');
  check('each cap the owner enters becomes a row', rows.length === 2, String(rows.length));
  check('and the prompt retires once one exists', !(await page.isVisible('#allowancesEmpty')));

  const positions = await page.$$eval('.cd-alw-pos', (els) => els.map((e) => e.textContent.trim()));
  check('an untouched lump cap states its ceiling and says nothing has been spent', positions[0].includes('₹40,000.00') && positions[0].includes('Nothing spent'), positions[0]);
  check('a per-sq-ft ceiling with no area declines to state a position',
    positions[1].includes('/ sq ft') && positions[1].includes('no area recorded'), positions[1]);

  // ---- draw spend against a cap from the debit form ------------------------------------------------
  await page.goto(base + '/cash-outflow', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  check('the allowance picker is hidden on a non-contract debit', !(await page.isVisible('#allowanceWrap')));
  await page.selectOption('#scopeSelect', 'included');
  check('...and appears when the item is in the contract', await page.isVisible('#allowanceWrap'));
  const alwOptions = await page.$$eval('#allowanceSelect option', (os) => os.filter((o) => o.value).length);
  check('both caps are offered (a cap is not used up by being picked)', alwOptions === 2, String(alwOptions));

  await page.fill('#amount', '60000'); // deliberately OVER the ₹40,000 cap, to exercise the overrun wording
  await pickLedger(page, '#ledgerTrigger', '5.0');
  const capValue = await page.$eval('#allowanceSelect', (sel) => {
    const opt = [...sel.options].find((o) => o.text.startsWith('Sanitaryware'));
    return opt ? opt.value : '';
  });
  await page.selectOption('#allowanceSelect', capValue);
  await page.click('#saveBtn');
  await page.waitForTimeout(700);

  await page.goto(base + '/contract-details', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const drawnPos = await page.$$eval('.cd-alw-pos', (els) => els.map((e) => e.textContent.trim())).then((all) => all[0]);
  check('the draw shows up as an over-cap position on Contract Details',
    drawnPos.includes('₹60,000.00') && drawnPos.includes('₹20,000.00 over'), drawnPos);
  const overClass = await page.$$eval('.cd-alw-pos', (els) => els.map((e) => e.className)).then((cs) => cs[0]);
  check('and is styled as an overrun', overClass.includes('cd-over'), overClass);

  // an overrun settles nothing
  const money = (await page.evaluate(() => fetch('/api/overview').then((r) => r.json()))).money;
  check('the overrun changes no Overview figure', money.totalContractPaise === 229492500, String(money.totalContractPaise));

  check('no console or page errors throughout', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  await H.stopApp();
  console.log(failures === 0 ? '\n✓ CONTRACT PHASE A UI SUITE PASSED' : `\n✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
