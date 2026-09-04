// The "what's this" disclosure — the one progressive-disclosure control, now carried by four pages.
//
// The copy pass that introduced it moved load-bearing detail off the page and behind a toggle. That
// trade is only honest if the toggle actually works: text that is collapsed AND unreachable has been
// deleted, not disclosed. This drives every .wt on every page in a real browser and pins the four
// things that make it a disclosure rather than a delete — it starts closed, it opens, what it opens
// is the real text, and it is reachable from the keyboard. Plus the phone-width check, because a
// toggle that overflows a 390px screen is a toggle nobody on a job site will use.
//
// Visibility is asked of Playwright (:visible), never inferred from a bounding box: a child of a
// CLOSED <details> still reports a laid-out height in Chromium, so measuring rects says "open" for
// something the reader cannot see.
//
// Run: node test-ui/disclosure.js
const H = require('../test/helpers');
const { chromium } = require('playwright');

const PHONE_W = 390;
const PHONE = { width: PHONE_W, height: 844 };
const DESK = { width: 1400, height: 1600 };
const PAGES = ['/data-backup', '/contract-details', '/overview', '/']; // home is served at /, not /home

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  const base = (await H.startApp()).base;
  const { cookie } = H.seedLoggedIn();
  const token = cookie.split('=')[1];

  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: DESK });
  await ctx.addCookies([{ name: 'plannr_session', value: token, domain: new URL(base).hostname, path: '/' }]);
  const page = await ctx.newPage();
  const errors = [];
  const failedRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${new URL(r.url()).pathname}`); });

  let seen = 0;

  for (const route of PAGES) {
    console.log(`\n── ${route} ─────────────────────────────────────────`);
    await page.goto(base + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // Only the toggles a reader can actually reach on load. A .wt inside a section that is still
    // hidden (the allowance one, which appears with the first cap) is not on trial here.
    const wt = page.locator('details.wt:visible');
    const n = await wt.count();
    if (!n) { check('no disclosure reachable on load', true, 'none expected'); continue; }
    seen += n;

    let openOnLoad = 0;
    for (let i = 0; i < n; i++) if (await wt.nth(i).locator('.wt-body').isVisible()) openOnLoad++;
    check(`${n} disclosure(s), all collapsed on load`, openOnLoad === 0, `${openOnLoad} showing their body`);

    const summaries = [];
    for (let i = 0; i < n; i++) summaries.push((await wt.nth(i).locator('summary').textContent()).trim());
    check('each is labelled', summaries.every((t) => /what's this/i.test(t)), summaries.join(' | '));

    for (let i = 0; i < n; i++) {
      const body = wt.nth(i).locator('.wt-body');
      const before = await body.isVisible();
      await wt.nth(i).locator('summary').click();
      await page.waitForTimeout(120);
      const after = await body.isVisible();
      const words = (await body.textContent()).trim().split(/\s+/).filter(Boolean).length;
      check(`disclosure ${i + 1} opens and holds real text`,
        before === false && after === true && words >= 8, `hidden -> ${after ? 'shown' : 'still hidden'}, ${words} words`);
      await wt.nth(i).locator('summary').click(); // put it back
      await page.waitForTimeout(80);
    }

    // Keyboard: a <summary> is focusable and Enter toggles it. Native behaviour — but list-style:none
    // plus a custom ::before marker is exactly the styling that tends to break it.
    const first = wt.nth(0);
    await first.locator('summary').focus();
    check('the summary takes keyboard focus', await first.locator('summary').evaluate((el) => document.activeElement === el));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    check('Enter opens it', await first.locator('.wt-body').isVisible());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    check('it has a visible focus indicator', await first.locator('summary').evaluate((el) => {
      const cs = getComputedStyle(el, ':focus-visible');
      return cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px';
    }));
  }

  check('no console or page errors throughout', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('no failed requests throughout', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));

  // ---- phone width: force every disclosure open and check nothing spills sideways ----
  // Reveals conditionally-hidden sections too (the allowance block on Contract Details, the upcoming-
  // payments panel on Overview), so the toggles that only appear once there is data are measured as
  // well — otherwise they sit at height 0 inside a hidden ancestor and prove nothing.
  console.log('\n── phone width (390px), every section revealed and open ─────');
  const pctx = await browser.newContext({ viewport: PHONE });
  await pctx.addCookies([{ name: 'plannr_session', value: token, domain: new URL(base).hostname, path: '/' }]);
  const pp = await pctx.newPage();
  for (const route of ['/data-backup', '/contract-details', '/overview']) {
    await pp.goto(base + route, { waitUntil: 'networkidle' });
    await pp.waitForTimeout(400);
    await pp.$$eval('details.wt', (els) => els.forEach((e) => {
      for (let n = e; n && n !== document.body; n = n.parentElement) if (n.hidden) n.hidden = false;
      e.open = true;
    }));
    await pp.waitForTimeout(250);
    const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${route}: no horizontal overflow with every disclosure open`, overflow <= 0, `${overflow}px`);
    const tap = await pp.locator('details.wt > summary').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    check(`${route}: every summary row has a tappable height`, tap.length > 0 && tap.every((h) => h >= 20), `${tap.length} row(s), heights ${[...new Set(tap)].join('/')}`);
    const bodies = await pp.locator('details.wt .wt-body').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    check(`${route}: every open body has width inside the viewport`, bodies.every((w) => w > 0 && w <= PHONE_W), `widths ${[...new Set(bodies)].join('/')}`);
  }
  await pctx.close();

  check('the disclosures were found across the pages, not just one', seen >= 5, `${seen} reachable on load`);

  await browser.close();
  await H.stopApp();
  console.log(failures === 0 ? '\n✓ DISCLOSURE SUITE PASSED' : `\n✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
