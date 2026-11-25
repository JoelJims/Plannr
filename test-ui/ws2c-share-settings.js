// Share settings on Home (npm run test:share-settings), in a real browser against server.js on a
// temp database (test/helpers.js). docs/share-and-reminder-pdf-plan.md, section 3: where PDFs go
// (WhatsApp / Email / Ask each time), the email recipient(s) and the subject. Checks: the defaults show,
// a save is read back after a reload, a bad address is refused with the server's message and changes
// nothing, a failed save request shows a message, and the page throws no errors. Nothing is sent anywhere: this only stores settings.
const H = require('../test/helpers');
const { chromium } = require('playwright');

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  const base = (await H.startApp()).base;
  H.db.prepare("DELETE FROM settings WHERE key IN ('share_target', 'share_email_to', 'share_email_subject')").run();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await (await browser.newContext()).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/home.html`, { waitUntil: 'networkidle' });

    const section = page.locator('#shareSettings');
    check('Home has a "Sending PDFs" section', await section.count() === 1);
    if (await section.count() !== 1) throw new Error('no #shareSettings section');
    const target = page.locator('#shareTargetSelect');
    const to = page.locator('#shareEmailTo');
    const subject = page.locator('#shareEmailSubject');
    const save = page.locator('#shareSaveBtn');
    const msg = page.locator('#shareMsg');
    await page.waitForFunction(() => document.getElementById('shareSettings').dataset.loaded === '1');
    check('defaults: "Ask each time", no recipient, the default subject',
      await target.inputValue() === 'ask' && await to.inputValue() === '' && await subject.inputValue() === 'Plannr report – {date}',
      `${await target.inputValue()} / "${await to.inputValue()}" / "${await subject.inputValue()}"`);
    check('each field has a label', await page.locator('label[for="shareTargetSelect"]').count() === 1
      && await page.locator('label[for="shareEmailTo"]').count() === 1 && await page.locator('label[for="shareEmailSubject"]').count() === 1);

    await target.selectOption('email');
    await to.fill('a@example.com, b@example.org');
    await subject.fill('Site report');
    await save.click();
    await page.waitForFunction(() => !document.getElementById('shareMsg').hidden);
    check('Save says "Saved."', (await msg.textContent()).trim() === 'Saved.', await msg.textContent());
    const api = (await H.get('/api/share-settings')).json;
    check('…and the server holds it', JSON.stringify(api) === JSON.stringify({ target: 'email', emailTo: ['a@example.com', 'b@example.org'], emailSubject: 'Site report' }), JSON.stringify(api));

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('shareSettings').dataset.loaded === '1');
    check('after a reload the saved values show', await target.inputValue() === 'email'
      && await to.inputValue() === 'a@example.com, b@example.org' && await subject.inputValue() === 'Site report',
      `${await target.inputValue()} / "${await to.inputValue()}" / "${await subject.inputValue()}"`);

    await to.fill('a@example.com, not-an-address');
    await save.click();
    await page.waitForFunction(() => document.getElementById('shareMsg').classList.contains('error'));
    check('a bad address is refused with a clear message', /email addresses/.test(await msg.textContent()), await msg.textContent());
    const after = (await H.get('/api/share-settings')).json;
    check('…and nothing changed on the server', JSON.stringify(after.emailTo) === JSON.stringify(['a@example.com', 'b@example.org']), JSON.stringify(after));
    // A failed request (no answer at all) is caught and said on screen, not left as a silent rejection.
    await page.route('**/api/share-settings', (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()));
    await to.fill('a@example.com');
    await save.click();
    await page.waitForFunction(() => /Could not save/.test(document.getElementById('shareMsg').textContent), null, { timeout: 3000 }).catch(() => {});
    check('a failed save request shows a message', /Could not save/.test(await msg.textContent()) && await msg.evaluate((el) => el.classList.contains('error')), await msg.textContent());
    await page.unroute('**/api/share-settings');
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('suite ran to the end', false, e.message);
  } finally {
    await browser.close();
    await H.stopApp();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall share-settings checks passed');
  process.exit(failures ? 1 : 0);
})();
