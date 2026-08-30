// Ledger browser (Phase C) — grouping, search, and what it does to the <select> behind it.
//
// The picker is a facade: the native <select> still holds the value and still fires `change`, which
// is the only reason createCashOutForm/createLedgerPicker needed no changes at all. So the checks
// that matter most here are not about the panel looking right — they are about the select ending up
// with the value the panel promised, and the sub-ledger rebuild firing off the back of it.
//
// Run: node test-ui/ledger-picker.js
const H = require('../test/helpers');
const { chromium } = require('playwright');

const PHONE = { width: 390, height: 844 };
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

const openPicker = async (page, trigger) => {
  await page.click(trigger);
  await page.waitForSelector('.lb-backdrop:not([hidden]) .lb-search', { timeout: 5000 });
};
const closed = (page) => page.waitForSelector('.lb-backdrop', { state: 'hidden', timeout: 5000 });

(async () => {
  const base = (await H.startApp()).base;
  const { cookie } = H.seedLoggedIn();
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: PHONE });
  await ctx.addCookies([{ name: 'plannr_session', value: cookie.split('=')[1], domain: new URL(base).hostname, path: '/' }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(base + '/cash-outflow', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  console.log('── grouping ──────────────────────────────────────────────────────');
  check('the native select is not the visible control', !(await page.isVisible('#ledgerSelect')));
  check('a trigger stands in front of it', await page.isVisible('#ledgerTrigger'));
  check('the trigger starts unset', (await page.textContent('#ledgerTriggerLabel')).trim() === '— select ledger —');

  await openPicker(page, '#ledgerTrigger');
  const groups = await page.$$eval('.lb-grouphead .lb-groupname', (els) => els.map((e) => e.textContent.trim()));
  check('seven sections', groups.length === 7, `${groups.length}: ${groups.join(' / ')}`);

  // Every main ledger must land in exactly one section — a taxonomy entry that falls through the
  // ranges is invisible in the picker, which is the one failure mode worth engineering against.
  const counts = await page.$$eval('.lb-groupcount', (els) => els.map((e) => Number(e.textContent)));
  const totalGrouped = counts.reduce((a, b) => a + b, 0);
  const mains = await page.evaluate(() => (window.LEDGERS || []).length);
  check('every main ledger is in exactly one section', totalGrouped === mains, `${totalGrouped} grouped vs ${mains} mains`);

  check('sections start collapsed', (await page.$$('.lb-groupbody:not([hidden])')).length === 0);
  await page.click('.lb-grouphead >> nth=1');
  await page.waitForTimeout(150);
  check('a section expands on click', (await page.$$('.lb-groupbody:not([hidden])')).length === 1);
  check('and reports it via aria-expanded', (await page.getAttribute('.lb-grouphead >> nth=1', 'aria-expanded')) === 'true');

  console.log('\n── search ────────────────────────────────────────────────────────');
  await page.fill('.lb-search', 'cement');
  await page.waitForTimeout(150);
  const hits = await page.$$eval('.lb-row-flat .lb-name', (els) => els.map((e) => e.textContent.trim().toLowerCase()));
  check('search returns matches', hits.length > 0, `${hits.length} hits`);
  check('every hit actually contains the term', hits.every((h) => h.includes('cement')), hits.slice(0, 4).join(' | '));
  check('search flattens the tree (no collapsed sections to fight)', (await page.$$('.lb-grouphead')).length === 0);

  // The brief: filter mains AND sub-ledgers. A term that only exists as a sub-ledger name must
  // still find it.
  await page.fill('.lb-search', 'granite');
  await page.waitForTimeout(150);
  const subHits = await page.$$eval('.lb-row[data-act="sub"]', (els) => els.map((e) => e.getAttribute('data-sub')));
  check('a sub-ledger-only term finds sub-ledgers', subHits.length > 0, `matched ${subHits.join(', ')}`);
  const parentShown = await page.$$eval('.lb-row[data-act="sub"] .lb-parent', (els) => els.map((e) => e.textContent.trim()));
  check('each sub result names the main it sits under', parentShown.length === subHits.length, parentShown.slice(0, 2).join(' | '));

  await page.fill('.lb-search', 'zzzznotathing');
  await page.waitForTimeout(150);
  check('a miss says so rather than showing an empty panel', (await page.textContent('.lb-empty')).includes('Nothing matches'));

  console.log('\n── it drives the select ──────────────────────────────────────────');
  await page.fill('.lb-search', 'granite');
  await page.waitForTimeout(150);
  const pick = await page.$eval('.lb-row[data-act="sub"]', (e) => ({ code: e.getAttribute('data-code'), sub: e.getAttribute('data-sub') }));
  await page.click('.lb-row[data-act="sub"]');
  await closed(page);
  check('picking a sub sets the main select', (await page.inputValue('#ledgerSelect')) === pick.code, `${await page.inputValue('#ledgerSelect')} (expected ${pick.code})`);
  check('...and the sub select, which only has options because change fired', (await page.inputValue('#subSelect')) === pick.sub, `${await page.inputValue('#subSelect')} (expected ${pick.sub})`);
  check('the trigger label reflects the choice', (await page.textContent('#ledgerTriggerLabel')).includes(pick.sub));

  // Choosing a main alone must clear a previously chosen sub, or the form carries a sub that no
  // longer belongs to its parent.
  await openPicker(page, '#ledgerTrigger');
  await page.fill('.lb-search', '1.0');
  await page.waitForTimeout(150);
  await page.click('.lb-row[data-act="main"][data-code="1.0"]');
  await closed(page);
  check('picking a main sets it', (await page.inputValue('#ledgerSelect')) === '1.0');
  check('and clears the stale sub-ledger', (await page.inputValue('#subSelect')) === '', `"${await page.inputValue('#subSelect')}"`);

  console.log('\n── custom, and closing ───────────────────────────────────────────');
  await openPicker(page, '#ledgerTrigger');
  await page.click('.lb-row-custom');
  await closed(page);
  check('the CUSTOM sentinel is still reachable', (await page.inputValue('#ledgerSelect')) === 'CUSTOM');
  check('and it reveals the custom-name input, so change() reached syncCustom', await page.isVisible('#ledgerCustom'));

  await openPicker(page, '#ledgerTrigger');
  await page.keyboard.press('Escape');
  await closed(page);
  check('Escape closes the panel', true);
  check('focus returns to the trigger', await page.evaluate(() => document.activeElement && document.activeElement.id === 'ledgerTrigger'));

  console.log('\n── phone width ───────────────────────────────────────────────────');
  await openPicker(page, '#ledgerTrigger');
  const panel = await page.$eval('.lb-panel', (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  check('the panel is full-bleed at 390px', panel.w === 390, `${panel.w}px wide`);
  check('and full-height, so the list gets the whole screen', panel.h >= 800, `${panel.h}px tall`);
  const searchTop = await page.$eval('.lb-search', (e) => Math.round(e.getBoundingClientRect().top));
  check('the search box is at the top, reachable without scrolling', searchTop < 80, `${searchTop}px`);
  await page.click('.lb-grouphead >> nth=0');
  await page.waitForTimeout(150);
  // Only rows that are actually on screen: a row inside a collapsed sub-list measures 0, which
  // says nothing about whether a thumb can hit it.
  const rowH = await page.$$eval('.lb-row', (els) => els
    .filter((e) => e.offsetParent !== null)
    .slice(0, 8)
    .map((e) => Math.round(e.getBoundingClientRect().height)));
  check('rows are at least 40px tall for a thumb', rowH.length > 0 && Math.min(...rowH) >= 40, `heights ${rowH.join('/')}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('the open panel adds no horizontal scroll', overflow <= 0, `${overflow}px`);
  await page.keyboard.press('Escape');
  await closed(page);

  console.log('\n── the other two pages ───────────────────────────────────────────');
  for (const [path, trig, sel] of [['/contract-details', '#cLedgerTrigger', '#cLedgerSelect'], ['/contractor-payments', '#cpLedgerTrigger', '#cpLedgerSelect']]) {
    await page.goto(base + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await openPicker(page, trig);
    await page.fill('.lb-search', '1.0');
    await page.waitForTimeout(150);
    await page.click('.lb-row[data-act="main"][data-code="1.0"]');
    await closed(page);
    check(`${path}: the picker drives its select`, (await page.inputValue(sel)) === '1.0', await page.inputValue(sel));
  }

  check('no console or page errors throughout', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  await H.stopApp();
  console.log(failures === 0 ? '\n✓ LEDGER PICKER PASSED' : `\n✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
