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
  await page.selectOption('#cLedgerSelect', '5.0');

  // the derived readout stays quiet until BOTH halves are present
  await page.fill('#cRate', '2150');
  check('one half of a rate price shows the "not yet a price" note, not a total',
    await page.isVisible('#cComputed') && (await page.textContent('#cComputed')).includes('together set the total'));
  check('the typed total stays editable while the rate price is incomplete', !(await page.isDisabled('#cStated')));

  await page.fill('#cAreaSqft', '2347.5');
  const computed = (await page.textContent('#cComputed')).trim();
  check('rate + area shows the derived total', computed.includes('50,47,125'), computed);
  check('and disables the typed total so an ignored number cannot sit in an enabled box', await page.isDisabled('#cStated'));
  check('with a note saying where the figure came from', await page.isVisible('#cStatedDerivedNote'));

  // optional metadata, including the derived expected completion date
  await page.check('#hasSignedDate');
  await page.selectOption('#dsDay', '31');
  await page.selectOption('#dsMonth', '1');
  await page.selectOption('#dsYear', '2026');
  await page.fill('#cMonths', '1');
  const expected = (await page.textContent('#cExpected')).trim();
  check('expected completion is derived and clamps to the month end (31 Jan + 1 month)', expected.includes('28/02/26'), expected);
  await page.fill('#cSupervision', '12.5');
  await page.fill('#cBrands', 'Cement: UltraTech');
  await page.fill('#cExcluded', 'Compound wall');
  await page.fill('#cObligations', 'Water at site');

  await page.click('#contractSaveBtn');
  await page.waitForTimeout(600);
  const saved = (await page.evaluate(() => fetch('/api/contracts').then((r) => r.json()))).contracts[0];
  check('the contract saved with the DERIVED total in the stated column', saved.statedAmountPaise === 504712500, String(saved.statedAmountPaise));
  check('pricingMode reports how the total was arrived at', saved.pricingMode === 'rate', saved.pricingMode);
  check('metadata round-tripped through the form', saved.supervisionRatePct === 12.5 && saved.specifiedBrands === 'Cement: UltraTech' && saved.completionPeriodMonths === 1);
  check('the form reloads in edit mode with the rate and area repopulated',
    (await page.inputValue('#cRate')) === '2150.00' && (await page.inputValue('#cAreaSqft')) === '2347.5',
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
  await page.fill('#cAreaSqft', '2347.5');
  await page.waitForTimeout(150);
  check('...and a typed total is taken over, not destroyed', (await page.inputValue('#cStated')) === '5047125.00');
  await page.fill('#cRate', '');
  await page.waitForTimeout(150);
  check('...it comes back verbatim when the rate price is broken up', (await page.inputValue('#cStated')) === '2500000',
    await page.inputValue('#cStated'));
  await page.fill('#cRate', '2150');
  await page.waitForTimeout(150);

  // ---- scope list: names only --------------------------------------------------------------------
  check('the scope + allowances section appears once a contract exists', await page.isVisible('#servicesSection'));
  check('there is no service price input anywhere on the page', (await page.$$('.cd-svc-price')).length === 0 && (await page.$('#svcPrice')) === null);
  check('and no remainder line', (await page.$('#remainderLine')) === null);
  await page.fill('#svcName', 'Electrical rough-in');
  await page.click('#svcAddBtn');
  await page.waitForTimeout(500);
  check('a scope item can be added', (await page.$$('.cd-svc-row')).length === 1);

  // ---- allowances: the ten standard caps ---------------------------------------------------------
  check('the standard-set button is offered while there are no allowances', await page.isVisible('#alwSeedBtn'));
  page.once('dialog', (d) => d.accept());
  await page.click('#alwSeedBtn');
  await page.waitForTimeout(700);
  const rows = await page.$$('.cd-alw-row');
  check('the ten contract allowances seed in one action', rows.length === 10, String(rows.length));
  check('and the button withdraws once they exist', !(await page.isVisible('#alwSeedBtn')));

  const positions = await page.$$eval('.cd-alw-pos', (els) => els.map((e) => e.textContent.trim()));
  check('an untouched lump cap states its ceiling and says nothing has been spent', positions[0].includes('₹35,000.00') && positions[0].includes('Nothing spent'), positions[0]);
  check('a per-sq-ft ceiling with no area declines to state a position',
    positions[7].includes('/ sq ft') && positions[7].includes('no area recorded'), positions[7]);

  // ---- draw spend against a cap from the debit form ------------------------------------------------
  await page.goto(base + '/cash-outflow', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  check('the allowance picker is hidden on a non-contract debit', !(await page.isVisible('#allowanceWrap')));
  await page.selectOption('#scopeSelect', 'included');
  check('...and appears when the item is in the contract', await page.isVisible('#allowanceWrap'));
  const alwOptions = await page.$$eval('#allowanceSelect option', (os) => os.filter((o) => o.value).length);
  check('all ten allowances are offered (a cap is not used up by being picked)', alwOptions === 10, String(alwOptions));

  await page.fill('#amount', '60000'); // deliberately OVER the ₹50,000 cap, to exercise the overrun wording
  await page.selectOption('#ledgerSelect', '5.0');
  const doorValue = await page.$eval('#allowanceSelect', (sel) => {
    const opt = [...sel.options].find((o) => o.text.startsWith('Main entry steel door'));
    return opt ? opt.value : '';
  });
  await page.selectOption('#allowanceSelect', doorValue);
  await page.click('#saveBtn');
  await page.waitForTimeout(700);

  await page.goto(base + '/contract-details', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const doorPos = await page.$$eval('.cd-alw-pos', (els) => els.map((e) => e.textContent.trim())).then((all) => all[3]);
  check('the draw shows up as an over-cap position on Contract Details',
    doorPos.includes('₹60,000.00') && doorPos.includes('₹10,000.00 over'), doorPos);
  const overClass = await page.$$eval('.cd-alw-pos', (els) => els.map((e) => e.className)).then((cs) => cs[3]);
  check('and is styled as an overrun', overClass.includes('cd-over'), overClass);

  // an overrun settles nothing
  const money = (await page.evaluate(() => fetch('/api/overview').then((r) => r.json()))).money;
  check('the overrun changes no Overview figure', money.totalContractPaise === 504712500, String(money.totalContractPaise));

  check('no console or page errors throughout', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  await H.stopApp();
  console.log(failures === 0 ? '\n✓ CONTRACT PHASE A UI SUITE PASSED' : `\n✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
