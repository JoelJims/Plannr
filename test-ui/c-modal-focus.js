// Modal focus (finding F18): PlannrUI.confirmModal and PlannrUI.choiceModal must behave like real
// dialogs for a keyboard user. Four things are checked for each, in a real browser:
//   1. opening it puts focus on a button inside the dialog;
//   2. Tab and Shift+Tab keep focus inside the dialog (they wrap from the last button to the first);
//   3. Escape closes it (confirmModal answers false, choiceModal answers null);
//   4. after it closes, focus is back on the control that opened it.
//
// Run: npm run test:modal-focus (also part of the full suite and CI, like every test:* script)
const H = require('../test/helpers');
const { chromium } = require('playwright');

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  const base = (await H.startApp()).base;
  const { cookie } = H.seedLoggedIn();
  const token = cookie.split('=')[1];

  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.addCookies([{ name: 'plannr_session', value: token, domain: new URL(base).hostname, path: '/' }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + '/cash-inflow', { waitUntil: 'networkidle' }); // a page that loads plannr-ui.js

  // An opener button on the page, focused, that opens the modal on click (as the pages do).
  async function openFrom(kind) {
    await page.evaluate((k) => {
      let b = document.getElementById('cModalOpener');
      if (!b) { b = document.createElement('button'); b.id = 'cModalOpener'; b.type = 'button'; b.textContent = 'open'; document.body.prepend(b); }
      b.onclick = () => {
        window.__cModalResult = 'pending';
        const p = k === 'confirm'
          ? window.PlannrUI.confirmModal({ title: 'T', message: 'M', confirmLabel: 'Yes' })
          : window.PlannrUI.choiceModal({ title: 'T', message: 'M', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] });
        p.then((v) => { window.__cModalResult = v; });
      };
      b.focus();
    }, kind);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
  }
  const focusInfo = () => page.evaluate(() => {
    const a = document.activeElement;
    const dialog = a && a.closest && a.closest('.pl-confirm');
    return { inDialog: !!dialog && !dialog.closest('[hidden]'), id: a && a.id, text: a && a.textContent };
  });

  for (const kind of ['confirm', 'choice']) {
    console.log(`\n── ${kind}Modal ─────────────────────────────`);
    await openFrom(kind);
    check('opening puts focus inside the dialog', (await focusInfo()).inDialog);
    const buttons = kind === 'confirm' ? 2 : 3;
    let stayed = true;
    for (let i = 0; i < buttons + 2; i++) { await page.keyboard.press('Tab'); if (!(await focusInfo()).inDialog) stayed = false; }
    check('Tab keeps focus inside the dialog', stayed);
    stayed = true;
    for (let i = 0; i < buttons + 2; i++) { await page.keyboard.press('Shift+Tab'); if (!(await focusInfo()).inDialog) stayed = false; }
    check('Shift+Tab keeps focus inside the dialog', stayed);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const result = await page.evaluate(() => window.__cModalResult);
    check('Escape closes it', result === (kind === 'confirm' ? false : null), `answered ${JSON.stringify(result)}`);
    const after = await focusInfo();
    check('focus goes back to the opener', after.id === 'cModalOpener', `focus on ${after.id || after.text || 'nothing'}`);

    // Closing with a button click returns focus to the opener too.
    await openFrom(kind);
    await page.locator('.pl-confirm-backdrop:not([hidden]) .pl-confirm button').first().click();
    await page.waitForTimeout(100);
    check('a button click also returns focus to the opener', (await focusInfo()).id === 'cModalOpener');
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(failures ? `\n✗ ${failures} check(s) failed` : '\n✓ all modal focus checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
