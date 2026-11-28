// "Send to WhatsApp" and "Send by email" on the Overview PDF (npm run test:share-pdf),
// docs/share-and-reminder-pdf-plan.md, section 4. In Chromium, under local-server.js (static files
// only, no database), with recording stand-ins for the phone's plugins:
// - @capacitor/core is answered by a stand-in that says "native" and gives every plugin
//   (registerPlugin(name)) a recorder: Filesystem, Share, ShareTo, MailComposer, LocalNotifications.
//   The page then runs the phone code (local-bootstrap.js -> local-api.js), as in the app.
// - The PDF itself comes from the PdfGenerator stand-in in test/shim-capacitor-fake.mjs.
// - navigator.onLine is overridden for the offline note.
// Checks: in a plain browser the two buttons are not shown; the settings' target decides which button
// is primary ("ask" shows both the same); each target calls the right plugin with the PDF's path, the
// recipients and the subject ({date} filled in); each fallback (WhatsApp missing, the ShareTo plugin
// failing, no mail app, the mail plugin failing) opens the share sheet and says why on screen; the
// offline note shows; no plugin method that sends is ever called and no request leaves the app.
// Last, a phone in India at 01:30 on 26 November (20:00 UTC on the 25th): the PDF's file name, from
// all three buttons, carries the phone's date (2026-11-26), the same date as the email subject.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 8127;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const CORE = '/node_modules/@capacitor/core/dist/index.js';
const PDFGEN = '/node_modules/@capgo/capacitor-pdf-generator/dist/esm/index.js';
const PDF_STANDIN = fs.readFileSync(path.join(ROOT, 'test', 'shim-capacitor-fake.mjs'), 'utf8');
// Everything the real module exports, except Capacitor and registerPlugin, which say "native" and
// hand out the recorders below.
const CORE_STANDIN = `export * from '${CORE}?real';
export function registerPlugin(name) { return window.__native.plugin(name); }
export const Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => true, registerPlugin };
`;
const CACHE = 'file:///data/user/0/com.plannr.app/cache/';
const ACCENT = 'rgb(245, 158, 11)';

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

// Runs in the page before any of its scripts. The suite changes window.__native.behave and
// window.__native.offline between checks.
function nativeStandIns() {
  Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => !(window.__native && window.__native.offline) });
  const calls = []; // emptied before each tap
  const ever = []; // every plugin call of the page's life, never emptied
  window.__native = {
    calls,
    ever,
    offline: false,
    behave: { whatsapp: 'opened', mail: 'yes', share: 'ok' },
    // Like Capacitor's own plugin object (registerPlugin in @capacitor/core): every name except
    // $$typeof and toJSON is a native method, `then` included. So code that awaits a plugin object,
    // or returns one from an async function, calls "then" on the phone; that fails and never settles
    // (seen on the emulator: "ShareTo.then()" is not implemented on android).
    plugin(name) {
      return new Proxy({}, {
        get(_, method) {
          if (typeof method !== 'string' || method === '$$typeof') return undefined;
          if (method === 'toJSON') return () => ({});
          return (...args) => window.__native.call(name, method, args);
        },
      });
    },
    async call(plugin, method, args) {
      if (method === 'then') { ever.push(`${plugin}.then`); throw new Error(`"${plugin}.then()" is not implemented on android`); }
      calls.push({ plugin, method, args: JSON.parse(JSON.stringify(args.filter((a) => typeof a !== 'function'))) });
      ever.push(`${plugin}.${method}`);
      const b = window.__native.behave;
      if (plugin === 'Filesystem' && method === 'writeFile') return { uri: 'file:///data/user/0/com.plannr.app/cache/' + args[0].path };
      if (plugin === 'ShareTo' && method === 'whatsapp') {
        if (b.whatsapp === 'error') throw new Error('stand-in ShareTo failed');
        return b.whatsapp === 'opened' ? { opened: true, app: 'com.whatsapp' } : { opened: false, reason: 'not-installed' };
      }
      if (plugin === 'MailComposer' && method === 'canComposeMail') return { canCompose: b.mail !== 'none' };
      if (plugin === 'MailComposer' && method === 'composeMail') {
        if (b.mail === 'error') throw new Error('stand-in mail composer failed');
        return { status: 'unknown' };
      }
      if (plugin === 'Share' && method === 'share') {
        if (b.share === 'cancel') throw new Error('Share canceled');
        return {};
      }
      if (method === 'addListener') return { remove: async () => {} };
      return {};
    },
  };
}

const waitForServer = () => new Promise((resolve, reject) => {
  const started = Date.now();
  const tryOnce = () => http.get(`${BASE}/overview.html`, (res) => { res.resume(); resolve(); })
    .on('error', () => (Date.now() - started > 10000 ? reject(new Error('local-server.js did not start')) : setTimeout(tryOnce, 150)));
  tryOnce();
});

(async () => {
  // local-server.js serves files only and opens no database; PLANNR_DB is set anyway, to a temp path.
  const env = { ...process.env, PLANNR_DB: path.join(os.tmpdir(), `plannr-share-pdf-${process.pid}.db`) };
  const server = spawn(process.execPath, ['local-server.js', String(PORT)], { cwd: ROOT, stdio: 'ignore', env });
  const browser = await chromium.launch();
  const outside = [];
  try {
    await waitForServer();

    // ---- 1. a plain browser: today's Download PDF only, no native-only buttons ----
    {
      const page = await (await browser.newContext()).newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${BASE}/overview.html`, { waitUntil: 'load' });
      await page.waitForSelector('#ovSendRow[data-state]', { state: 'attached', timeout: 15000 }).catch(() => {});
      check('plain browser: the page decided (no native bridge)', await page.getAttribute('#ovSendRow', 'data-state').catch(() => null) === 'browser');
      check('plain browser: Download PDF is shown', await page.isVisible('#ovPdfBtn'));
      check('plain browser: "Send to WhatsApp" and "Send by email" are not shown',
        await page.locator('#ovSendWaBtn').count() === 1 && !(await page.isVisible('#ovSendWaBtn')) && !(await page.isVisible('#ovSendMailBtn')));
      check('plain browser: no page errors', errors.length === 0, errors.join(' | '));
      await page.context().close();
    }

    // ---- 2. the app (native stand-ins), as a small Android phone: 320 px wide, touch, pixel ratio 2 ----
    // `options` adds context options (section 3 sets a time zone).
    const appContext = async (options = {}) => {
      const ctx = await browser.newContext({
        viewport: { width: 320, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
        ...options,
      });
      await ctx.addInitScript(nativeStandIns);
      await ctx.route((url) => url.pathname === CORE && !url.search, (route) => route.fulfill({ contentType: 'text/javascript', body: CORE_STANDIN }));
      await ctx.route((url) => url.pathname === PDFGEN, (route) => route.fulfill({ contentType: 'text/javascript', body: PDF_STANDIN }));
      return ctx;
    };
    const context = await appContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { if (!r.url().startsWith(BASE + '/') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url()); });

    const everAll = [];
    const open = async () => {
      everAll.push(...await page.evaluate(() => (window.__native ? window.__native.ever : [])).catch(() => []));
      await page.goto(`${BASE}/overview.html`, { waitUntil: 'load' });
      await page.waitForSelector('#ovSendRow[data-state]', { state: 'attached', timeout: 20000 });
    };
    const setShare = (body) => page.evaluate(async (b) => {
      await import('/local-bootstrap.js');
      const r = await fetch('/api/share-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return r.status;
    }, body);
    const behave = (b) => page.evaluate((x) => Object.assign(window.__native.behave, x), b);
    const offline = (on) => page.evaluate((x) => { window.__native.offline = x; }, on);
    const calls = () => page.evaluate(() => window.__native.calls.filter((c) => c.plugin !== 'LocalNotifications'));
    const resetCalls = () => page.evaluate(() => { window.__native.calls.length = 0; });
    const bg = (sel) => page.$eval(sel, (el) => getComputedStyle(el).backgroundColor);
    const msgText = async () => ((await page.textContent('#ovMsg')) || '').trim();
    const localDate = () => page.evaluate(() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; });
    // Tap a button, pick "Light" in the theme question, wait until the page has said something (or,
    // for Download PDF, which says nothing when the sheet is used, until the share sheet was asked for).
    const send = async (sel, until = 'message') => {
      await resetCalls();
      await page.evaluate(() => { const m = document.getElementById('ovMsg'); m.className = 'msg'; m.textContent = ''; });
      await page.click(sel);
      await page.click('[data-ch="0"]');
      await page.waitForFunction((u) => (u === 'sheet'
        ? window.__native.calls.some((c) => c.plugin === 'Share')
        : document.getElementById('ovMsg').classList.contains('show')), until, { timeout: 15000 }).catch(() => {});
      return { calls: await calls(), msg: await msgText(), visible: await page.isVisible('#ovMsg') };
    };
    // Can a finger reach the control? Hit-test its centre and four inset corners (ui-test-assertions rule 9).
    const reachable = (sel) => page.$eval(sel, (el) => {
      const r = el.getBoundingClientRect();
      const pts = [[(r.left + r.right) / 2, (r.top + r.bottom) / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]];
      return pts.every(([x, y]) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === el || el.contains(hit)); });
    });
    const box = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height), width: innerWidth }; });
    const named = (list, plugin, method) => list.filter((c) => c.plugin === plugin && c.method === method);

    await open();
    check('app: the page decided it is the app', await page.getAttribute('#ovSendRow', 'data-state') === 'native');
    check('app: "Send to WhatsApp" and "Send by email" are shown next to Download PDF',
      await page.isVisible('#ovSendWaBtn') && await page.isVisible('#ovSendMailBtn') && await page.isVisible('#ovPdfBtn'));
    for (const sel of ['#ovSendWaBtn', '#ovSendMailBtn']) {
      await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center' }));
      const b = await box(sel);
      check(`app at 320 px: ${sel} lies inside the screen width (visibility)`, b.left >= 0 && b.right <= b.width, JSON.stringify(b));
      check(`app at 320 px: ${sel} can be pressed (hit test at centre and corners)`, await reachable(sel));
    }
    check('app, target "ask" (the default): both buttons look the same, neither is primary',
      await bg('#ovSendWaBtn') === await bg('#ovSendMailBtn') && await bg('#ovSendWaBtn') !== ACCENT, `${await bg('#ovSendWaBtn')} / ${await bg('#ovSendMailBtn')}`);

    // -- WhatsApp as the target --
    check('saving target "whatsapp" works', await setShare({ target: 'whatsapp', emailTo: [], emailSubject: '' }) === 200);
    await open();
    check('target "whatsapp": Send to WhatsApp is the primary button, Send by email is not',
      await bg('#ovSendWaBtn') === ACCENT && await bg('#ovSendMailBtn') !== ACCENT, `${await bg('#ovSendWaBtn')} / ${await bg('#ovSendMailBtn')}`);

    let r = await send('#ovSendWaBtn');
    const written = named(r.calls, 'Filesystem', 'writeFile');
    const fname = written[0] && written[0].args[0].path;
    check('WhatsApp: the PDF is written to the app\'s cache folder',
      written.length === 1 && /^plannr-overview-full-\d{4}-\d{2}-\d{2}\.pdf$/.test(fname || '') && written[0].args[0].directory === 'CACHE', JSON.stringify(written.map((c) => ({ ...c.args[0], data: undefined }))));
    check('…and it is the PDF from the PDF plugin', written[0] && Buffer.from(written[0].args[0].data, 'base64').toString() === '%PDF-1.4 test stand-in');
    const wa = named(r.calls, 'ShareTo', 'whatsapp');
    check('WhatsApp: ShareTo.whatsapp gets that file', wa.length === 1 && wa[0].args[0].path === CACHE + fname, JSON.stringify(wa));
    check('WhatsApp opened: no share sheet, no mail app', named(r.calls, 'Share', 'share').length === 0 && r.calls.every((c) => c.plugin !== 'MailComposer'));
    check('WhatsApp opened: the page says to pick the chat and tap Send there', r.visible && /WhatsApp opened with the PDF attached/.test(r.msg) && /tap Send/.test(r.msg) && !/offline/i.test(r.msg), r.msg);

    await behave({ whatsapp: 'missing' });
    r = await send('#ovSendWaBtn');
    const sheet = named(r.calls, 'Share', 'share');
    check('WhatsApp not installed: ShareTo was asked first', named(r.calls, 'ShareTo', 'whatsapp').length === 1);
    check('WhatsApp not installed: the share sheet opens with the PDF',
      sheet.length === 1 && sheet[0].args[0].files && sheet[0].args[0].files[0] === CACHE + fname, JSON.stringify(sheet));
    check('WhatsApp not installed: the page says why the share sheet opened', r.visible && /WhatsApp is not installed, so the share sheet opened instead/.test(r.msg), r.msg);

    await behave({ whatsapp: 'error' });
    r = await send('#ovSendWaBtn');
    check('ShareTo plugin fails: the share sheet opens', named(r.calls, 'Share', 'share').length === 1);
    check('ShareTo plugin fails: the page says WhatsApp could not be opened, and why', r.visible
      && /Could not open WhatsApp/.test(r.msg) && /stand-in ShareTo failed/.test(r.msg) && /share sheet opened instead/.test(r.msg), r.msg);

    await behave({ whatsapp: 'missing', share: 'cancel' });
    r = await send('#ovSendWaBtn');
    check('fallback sheet closed: the reason stays and the page says nothing was shared', r.visible
      && /WhatsApp is not installed/.test(r.msg) && /PDF not shared: the share sheet was closed/.test(r.msg), r.msg);

    await behave({ whatsapp: 'opened', share: 'ok' });
    await offline(true);
    r = await send('#ovSendWaBtn');
    check('offline: the PDF is still made and handed to WhatsApp', named(r.calls, 'ShareTo', 'whatsapp').length === 1 && named(r.calls, 'Filesystem', 'writeFile').length === 1);
    check('offline: the page says WhatsApp will send it when the phone is back online', r.visible
      && /You're offline/.test(r.msg) && /WhatsApp will send it when you're back online/.test(r.msg), r.msg);
    await offline(false);

    // -- Email as the target --
    check('saving target "email" with two recipients and a subject works',
      await setShare({ target: 'email', emailTo: ['a@example.com', 'b@example.org'], emailSubject: 'Site report {date}' }) === 200);
    await open();
    check('target "email": Send by email is the primary button, Send to WhatsApp is not',
      await bg('#ovSendMailBtn') === ACCENT && await bg('#ovSendWaBtn') !== ACCENT, `${await bg('#ovSendMailBtn')} / ${await bg('#ovSendWaBtn')}`);

    r = await send('#ovSendMailBtn');
    const compose = named(r.calls, 'MailComposer', 'composeMail');
    const today = await localDate();
    check('email: the mail app is checked for first', named(r.calls, 'MailComposer', 'canComposeMail').length === 1);
    check('email: composeMail gets the recipients, the subject with {date} filled in, and the PDF', compose.length === 1
      && JSON.stringify(compose[0].args[0].to) === JSON.stringify(['a@example.com', 'b@example.org'])
      && compose[0].args[0].subject === `Site report ${today}`
      && JSON.stringify(compose[0].args[0].attachments) === JSON.stringify([{ path: CACHE + fname }]), JSON.stringify(compose));
    check('email: no share sheet, no WhatsApp', named(r.calls, 'Share', 'share').length === 0 && r.calls.every((c) => c.plugin !== 'ShareTo'));
    check('email: the page says to check the mail and tap Send there', r.visible && /mail app opened with the PDF attached/.test(r.msg) && /tap Send/.test(r.msg), r.msg);

    await behave({ mail: 'none' });
    r = await send('#ovSendMailBtn');
    check('no mail app: composeMail is not called and the share sheet opens',
      named(r.calls, 'MailComposer', 'composeMail').length === 0 && named(r.calls, 'Share', 'share').length === 1);
    check('no mail app: the page says why the share sheet opened', r.visible && /No mail app is set up on this phone, so the share sheet opened instead/.test(r.msg), r.msg);

    await behave({ mail: 'error' });
    r = await send('#ovSendMailBtn');
    check('mail plugin fails: the share sheet opens', named(r.calls, 'Share', 'share').length === 1);
    check('mail plugin fails: the page says the mail app could not be opened, and why', r.visible
      && /Could not open the mail app/.test(r.msg) && /stand-in mail composer failed/.test(r.msg) && /share sheet opened instead/.test(r.msg), r.msg);

    await behave({ mail: 'yes' });
    await offline(true);
    r = await send('#ovSendMailBtn');
    check('offline, email: the PDF still goes to the mail app, with the offline note', named(r.calls, 'MailComposer', 'composeMail').length === 1
      && r.visible && /You're offline/.test(r.msg) && /mail app will send it when you're back online/.test(r.msg), r.msg);
    await offline(false);

    // -- Download PDF keeps today's share sheet --
    r = await send('#ovPdfBtn', 'sheet');
    check('Download PDF still opens the share sheet only', named(r.calls, 'Share', 'share').length === 1
      && r.calls.every((c) => c.plugin !== 'ShareTo' && c.plugin !== 'MailComposer'));

    // -- Never sends --
    // Every plugin call of every page load (open() keeps each load's list before reloading).
    const all = everAll.concat(await page.evaluate(() => window.__native.ever));
    check('no plugin method that sends was ever called', all.length > 0 && !all.some((m) => /send/i.test(m)), `${all.length} calls: ${[...new Set(all)].join(', ')}`);
    check('no plugin object was ever awaited (no "<Plugin>.then" call)', !all.some((m) => /\.then$/.test(m)), all.filter((m) => /\.then$/.test(m)).join(', '));
    check('app: no page errors', errors.length === 0, errors.join(' | '));
    check('no request went anywhere outside the app', outside.length === 0, outside.join(' | '));

    // ---- 3. a phone in India at 01:30 on 26 November (20:00 UTC on the 25th) ----
    // The file name used to take the UTC date (2026-11-25) while the subject took the phone's date.
    // Fresh settings: target "ask" and the default subject "Plannr report – {date}".
    {
      const ist = await appContext({ timezoneId: 'Asia/Kolkata' });
      await ist.clock.setFixedTime(new Date('2026-11-25T20:00:00Z'));
      const p = await ist.newPage();
      const errs = [];
      p.on('pageerror', (e) => errs.push(e.message));
      p.on('request', (r) => { if (!r.url().startsWith(BASE + '/') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url()); });
      await p.goto(`${BASE}/overview.html`, { waitUntil: 'load' });
      await p.waitForSelector('#ovSendRow[data-state="native"]', { state: 'attached', timeout: 20000 });
      check('India: the page\'s clock says 01:30 on 26 November (20:00 UTC on the 25th)',
        await p.evaluate(() => { const d = new Date(); return d.getDate() === 26 && d.getHours() === 1 && d.toISOString().startsWith('2026-11-25'); }));
      // Tap, pick "Light", wait for the plugin call that hands the PDF over.
      const tap = async (sel, plugin, method) => {
        await p.evaluate(() => { window.__native.calls.length = 0; });
        await p.click(sel);
        await p.click('[data-ch="0"]');
        await p.waitForFunction(([pl, me]) => window.__native.calls.some((c) => c.plugin === pl && c.method === me), [plugin, method], { timeout: 15000 }).catch(() => {});
        return p.evaluate(() => window.__native.calls);
      };
      const nameOf = (list) => { const w = named(list, 'Filesystem', 'writeFile'); return w.length === 1 ? w[0].args[0].path : `${w.length} writes`; };
      const NAME = 'plannr-overview-full-2026-11-26.pdf';
      let c = await tap('#ovSendMailBtn', 'MailComposer', 'composeMail');
      const mail = named(c, 'MailComposer', 'composeMail');
      check('India, Send by email: the PDF is named for 26 November', nameOf(c) === NAME, nameOf(c));
      check('India, Send by email: the subject says 26 November too', mail.length === 1 && mail[0].args[0].subject === 'Plannr report – 2026-11-26', JSON.stringify(mail.map((m) => m.args[0].subject)));
      c = await tap('#ovSendWaBtn', 'ShareTo', 'whatsapp');
      check('India, Send to WhatsApp: the same name', nameOf(c) === NAME, nameOf(c));
      c = await tap('#ovPdfBtn', 'Share', 'share');
      check('India, Download PDF: the same name', nameOf(c) === NAME, nameOf(c));
      check('India: no page errors', errs.length === 0, errs.join(' | '));
      check('India: no request went anywhere outside the app', outside.length === 0, outside.join(' | '));
      await ist.close();
    }
  } catch (e) {
    check('suite ran to the end', false, e.message);
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall share-pdf checks passed');
  process.exit(failures ? 1 : 0);
})();
