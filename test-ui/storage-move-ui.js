// Step 1.4 C10: the storage move on the Data Backup page, in Chromium (npm run test:storage-move-ui).
//
// The phone's two storage plugins are stood in for by test-ui/_fake-native-plugins.js (files in
// sessionStorage, so they survive a reload in the same tab), loaded before the app's scripts. The app
// is the real phone code under local-server.js; the move's source is the real kvvfs database in
// localStorage. Each scenario has its own browser context:
//   1. no plugins (the browser preview): the section stays hidden;
//   2. low space: the move refuses with both numbers, before any backup, and nothing changes;
//   3. the move: the passphrase is asked for; the step-1 backup is saved and confirmed; the overlay
//      shows every step in order with the page inert; the page reopens on the file, which holds the
//      data; the old copy is unchanged; the panel shows the check's result and the old copy;
//      then "Move data back" (too big refused without asking; cancel; confirm) and the move again,
//      and "Delete the old copy" (refused without a backup since the move; cancel; confirm);
//   4. a reload in the middle of the move: the "interrupted" prompt; "Continue" finishes without a
//      second backup; "Not now" keeps the app on the old storage for this session.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8114;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, '_fake-native-plugins.js');
const MAIN = '/data/user/0/com.plannr.app/databases/plannrSQLite.db';
const MARKER = '/data/user/0/com.plannr.app/files/plannr-storage.json';
const PASS = 'storage-move-ui-passphrase';
const ORDER = ['space', 'backup', 'snapshot', 'write', 'check', 'place', 'switch'];
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  const server = spawn(process.execPath, ['local-server.js', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch();

  async function newPage({ fake = true } = {}) {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    if (fake) await page.addInitScript({ path: FAKE });
    // Every step the overlay marks as current, with whether the page behind it was inert, kept in
    // sessionStorage so it survives the reload that follows a switch.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const list = document.getElementById('moveSteps');
        if (!list) return;
        new MutationObserver(() => {
          const now = list.querySelector('li[data-state="now"]');
          if (!now) return;
          const seen = JSON.parse(sessionStorage.getItem('test-seen-steps') || '[]');
          const entry = `${now.dataset.step}:${document.querySelector('.bk-stack').inert ? 'inert' : 'LIVE'}`;
          if (seen[seen.length - 1] !== entry) { seen.push(entry); sessionStorage.setItem('test-seen-steps', JSON.stringify(seen)); }
        }).observe(list, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
      });
    });
    page.dialogs = [];
    page.on('dialog', (d) => { page.dialogs.push(d.type()); d.accept(); });
    page.downloads = [];
    page.on('download', (d) => page.downloads.push(d.suggestedFilename()));
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    return page;
  }
  const open = async (page) => {
    await page.goto(`${BASE}/data-backup.html`, { waitUntil: 'load' });
    await page.evaluate(() => import('/local-bootstrap.js'));
    await panelReady(page);
  };
  // The move panel is set up after the storage is chosen: it shows its section, then (in the same
  // task) the prompt and the buttons. Read nothing before that, or a check races it.
  const panelReady = (page) => page.waitForFunction(() => window.__plannrStorage !== undefined && (!window.__plannrStorage.native || !document.getElementById('moveSection').hidden));
  const settle = (page) => page.waitForLoadState('load').then(() => page.evaluate(() => import('/local-bootstrap.js'))).then(() => panelReady(page)).then(() => page.waitForTimeout(300));
  const storageOf = (page) => page.evaluate(() => window.__plannrStorage && { use: window.__plannrStorage.use, prompt: window.__plannrStorage.prompt });
  const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json };
  }, [method, url, body]);
  const addCashIn = (page, reason) => api(page, 'POST', '/api/cash-in', { amountRupees: '1234', txDate: '2026-11-19', byType: 'relative', byLabel: 'Move UI test', reason });
  const reasons = async (page) => {
    const r = await api(page, 'GET', '/api/cash-in');
    const rows = Array.isArray(r.json) ? r.json : (r.json && (r.json.rows || r.json.entries || r.json.items)) || [];
    return rows.map((x) => x.reason);
  };
  const fakeFiles = (page) => page.evaluate(() => window.__plannrFakeFs.list());
  const kvvfsRecords = (page) => page.evaluate(() => JSON.stringify(Object.keys(localStorage).filter((k) => k.startsWith('kvvfs-local')).sort().map((k) => [k, localStorage.getItem(k)])));
  const kvvfsCount = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kvvfs-local')).length);
  const marker = (page) => page.evaluate((m) => { const b = window.__plannrFakeFs.getFile(m); return b ? JSON.parse(new TextDecoder().decode(b)) : null; }, MARKER);
  const text = (page, id) => page.evaluate((i) => { const el = document.getElementById(i); return el ? el.textContent.trim() : null; }, id);
  const visible = (page, id) => page.evaluate((i) => { const el = document.getElementById(i); return !!el && !el.hidden && !!(el.offsetWidth || el.offsetHeight); }, id);
  const seenSteps = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('test-seen-steps') || '[]'));
  const fillPass = async (page, a, b = a) => { await page.fill('#movePass', a); await page.fill('#movePass2', b); };
  const answerConfirm = async (page, ok) => {
    await page.waitForSelector('.pl-confirm-backdrop:not([hidden])');
    const title = await page.textContent('#plcTitle');
    await page.click(`.pl-confirm-backdrop [data-plc="${ok ? 'ok' : 'cancel'}"]`);
    return title;
  };
  const waitMsg = (page, id, re) => page.waitForFunction(([i, src]) => new RegExp(src).test(document.getElementById(i).textContent), [id, re.source], { timeout: 20000 });
  // Run the move from the button; answer the step-1 confirmation; resolves once the page has reloaded.
  const runMove = async (page, { button = '#moveBtn', confirmBackup = true } = {}) => {
    const reloaded = page.waitForEvent('framenavigated', { timeout: 30000 });
    await page.click(button);
    if (confirmBackup) await answerConfirm(page, true);
    await reloaded;
    await settle(page);
  };

  try {
    // ---- 1. No plugins ----
    {
      console.log('1. the browser preview (no storage plugins)');
      const page = await newPage({ fake: false });
      await open(page);
      await page.waitForTimeout(300);
      check('the section stays hidden', !(await visible(page, 'moveSection')));
      await page.context().close();
    }

    // ---- 2. Low space ----
    {
      console.log('2. low space');
      const page = await newPage();
      await page.addInitScript(() => sessionStorage.setItem('fakefs-free', String(1.5 * 1024 * 1024)));
      await open(page);
      await addCashIn(page, 'low space');
      const kv = await kvvfsRecords(page);
      await fillPass(page, PASS);
      await page.click('#moveBtn');
      await waitMsg(page, 'moveMsg', /needs about/);
      const m = await text(page, 'moveMsg');
      check('refused with both numbers', /Plannr needs about \d+ MB free to move your data\. Your phone has 1 MB free\./.test(m), m);
      check('before any backup (no download, no confirmation)', page.downloads.length === 0 && !(await visible(page, 'moveOverlay')), JSON.stringify(page.downloads));
      check('nothing changed: no file, localStorage the same', (await fakeFiles(page)).length === 0 && (await kvvfsRecords(page)) === kv);
      await page.context().close();
    }

    // ---- 3. The move, the way back and the old copy ----
    {
      console.log('3. the move, then move back, move again, delete the old copy');
      const page = await newPage();
      await open(page);
      check('on a native build the section shows, with the move button', (await visible(page, 'moveSection')) && (await visible(page, 'moveBtn')) && !(await visible(page, 'moveInterrupted')));
      await addCashIn(page, 'A: before the move');
      await page.click('#moveBtn');
      await waitMsg(page, 'moveMsg', /passphrase/i);
      check('no passphrase: asked for one, nothing started', /starts with an encrypted backup/.test(await text(page, 'moveMsg')) && page.downloads.length === 0 && (await fakeFiles(page)).length === 0, await text(page, 'moveMsg'));
      await fillPass(page, PASS, PASS + 'x');
      await page.click('#moveBtn');
      await waitMsg(page, 'moveMsg', /match/);
      check('two different passphrases: refused', (await fakeFiles(page)).length === 0);

      // Cancel at the step-1 confirmation: nothing changes.
      await fillPass(page, PASS);
      await page.click('#moveBtn');
      check('the step-1 confirmation is asked', /Confirm you have the backup/.test(await answerConfirm(page, false)));
      await waitMsg(page, 'moveMsg', /did not start/);
      check('cancelled: the move did not start, nothing changed', (await fakeFiles(page)).length === 0 && !(await visible(page, 'moveOverlay')) && (await storageOf(page)).use === 'localstorage');
      check('the backup file was offered', page.downloads.length === 1 && /^plannr-backup-\d{4}-\d\d-\d\d\.db\.enc$/.test(page.downloads[0]), JSON.stringify(page.downloads));
      check('the page is usable again (not inert)', !(await page.evaluate(() => document.querySelector('.bk-stack').inert)));

      // The move.
      await page.evaluate(() => { localStorage.setItem('plannr-test-move-delay-ms', '60'); sessionStorage.removeItem('test-seen-steps'); });
      await runMove(page);
      const seen = await seenSteps(page);
      check('the overlay showed every step in order, the page inert throughout',
        JSON.stringify(seen) === JSON.stringify(ORDER.map((s) => s + ':inert')), JSON.stringify(seen));
      check('a second backup was saved for the move', page.downloads.length === 2);
      const s = await storageOf(page);
      check('the page reopened on the file', s && s.use === 'native', JSON.stringify(s));
      check('the data moved', (await reasons(page)).includes('A: before the move'));
      const mk = await marker(page);
      check('the marker says native-v1 with the check', mk && mk.storage === 'native-v1' && mk.check && mk.check.tables > 5 && mk.oldCopy.kept === true, JSON.stringify(mk && { s: mk.storage, c: mk.check && mk.check.tables }));
      await page.waitForFunction(() => /All \d+ tables match/.test(document.getElementById('moveDoneText').textContent));
      check('the panel shows the check', /^Your data is in its own file on this phone since \d+ \w+ \d{4}\. All \d+ tables match \([\d,]+ rows\)\.$/.test(await text(page, 'moveDoneText')), await text(page, 'moveDoneText'));
      check('the panel shows the old copy, kept, with its date and size', /^Old copy kept \(from \d+ \w+ \d{4}, \d+\.\d MB\)\./.test(await text(page, 'oldCopyText')), await text(page, 'oldCopyText'));
      check('the move form is gone', !(await visible(page, 'moveBtn')) && (await visible(page, 'deleteOldCopyBtn')) && (await visible(page, 'moveBackBtn')));
      const kvAfter = await kvvfsRecords(page);
      check('the old copy is kept', (await kvvfsCount(page)) > 0 && kvAfter !== '[]');
      check('a save goes into the file, not the old copy', (await addCashIn(page, 'B: in the file')).status === 201 && (await kvvfsRecords(page)) === kvAfter);

      // Delete the old copy: refused without a backup since the move.
      await page.click('#deleteOldCopyBtn');
      await waitMsg(page, 'moveMsg', /Save an encrypted backup first/);
      check('delete: refused without a backup since the move', (await kvvfsCount(page)) > 0, await text(page, 'moveMsg'));

      // Move data back: too little space is said without asking (the size limit is the same path; the
      // fake file store cannot hold a near-limit database twice, so the core tests cover that one).
      await page.evaluate(() => sessionStorage.setItem('fakefs-free', String(1024 * 1024)));
      await page.click('#moveBackBtn');
      await waitMsg(page, 'moveMsg', /needs about/);
      check('move back: too little space, said before any question', /Plannr needs about \d+ MB free/.test(await text(page, 'moveMsg')) && !(await page.evaluate(() => { const b = document.querySelector('.pl-confirm-backdrop'); return !!b && !b.hidden; })), await text(page, 'moveMsg'));
      await page.evaluate(() => sessionStorage.removeItem('fakefs-free'));
      // Cancel, then confirm.
      await page.click('#moveBackBtn');
      check('move back asks first', /Move your data back\?/.test(await answerConfirm(page, false)));
      await waitMsg(page, 'moveMsg', /Nothing was changed/);
      check('cancelled: still on the file', (await marker(page)).storage === 'native-v1');
      await page.evaluate(() => sessionStorage.removeItem('test-seen-steps'));
      const reloadedBack = page.waitForEvent('framenavigated', { timeout: 30000 });
      await page.click('#moveBackBtn');
      await answerConfirm(page, true);
      await reloadedBack;
      await settle(page);
      check('move back: every step shown, the page inert', JSON.stringify(await seenSteps(page)) === JSON.stringify(['size', 'snapshot', 'write', 'check', 'switch'].map((x) => x + ':inert')), JSON.stringify(await seenSteps(page)));
      const sb = await storageOf(page);
      check('the page reopened on the old storage', sb && sb.use === 'localstorage', JSON.stringify(sb));
      const rb = await reasons(page);
      check('with the data entered on the file', rb.includes('A: before the move') && rb.includes('B: in the file'), JSON.stringify(rb));
      check('the marker says localstorage-v1; the file is kept', (await marker(page)).storage === 'localstorage-v1' && (await fakeFiles(page)).includes(MAIN));
      check('the section says it was moved back, and offers the move again', /moved back to the old storage on/.test(await text(page, 'moveStateText')) && (await visible(page, 'moveBtn')), await text(page, 'moveStateText'));

      // The move again, over the kept file.
      await addCashIn(page, 'C: after moving back');
      await fillPass(page, PASS);
      await runMove(page);
      check('moved again: on the file, with everything', (await storageOf(page)).use === 'native' && (await reasons(page)).includes('C: after moving back'));

      // A backup since the move, then delete the old copy (cancel, then confirm).
      await page.waitForTimeout(1100); // the backup's stamp has whole seconds
      await page.fill('#encExportPass', PASS);
      await page.fill('#encExportPass2', PASS);
      await page.click('#encExportBtn');
      await waitMsg(page, 'encExportMsg', /download\(\) triggered/);
      await page.click('#deleteOldCopyBtn');
      check('delete asks first', /Delete the old copy\?/.test(await answerConfirm(page, false)));
      await waitMsg(page, 'moveMsg', /The old copy is kept/);
      check('cancelled: the old copy is still there', (await kvvfsCount(page)) > 0);
      await page.click('#deleteOldCopyBtn');
      await answerConfirm(page, true);
      await waitMsg(page, 'moveMsg', /The old copy was deleted/);
      check('deleted: the localStorage copy is gone, the marker records it', (await kvvfsCount(page)) === 0 && (await marker(page)).oldCopy.kept === false, await text(page, 'moveMsg'));
      check('the panel says so, and the delete button is gone', /^The old copy was deleted on \d+ \w+ \d{4}\.$/.test(await text(page, 'oldCopyText')) && !(await visible(page, 'deleteOldCopyBtn')), await text(page, 'oldCopyText'));
      await open(page);
      check('the app still opens on the file with all the data', (await storageOf(page)).use === 'native' && (await reasons(page)).length >= 3);
      check('no page errors', page.errors.length === 0, page.errors.join(' | '));
      await page.context().close();
    }

    // ---- 4. A reload in the middle of the move ----
    {
      console.log('4. a reload in the middle of the move: "Continue" and "Not now"');
      const page = await newPage();
      await open(page);
      await addCashIn(page, 'D: before the interrupted move');
      await page.evaluate(() => localStorage.setItem('plannr-test-move-delay-ms', '400'));
      await fillPass(page, PASS);
      await page.click('#moveBtn');
      await answerConfirm(page, true);
      await page.waitForSelector('#moveSteps li[data-step="check"][data-state="now"]', { timeout: 30000 });
      await page.reload({ waitUntil: 'load' });
      await settle(page);
      const s = await storageOf(page);
      check('after the reload: still on the old storage, the prompt', s.use === 'localstorage' && (await visible(page, 'moveInterrupted')), JSON.stringify(s));
      check('the half-done file was removed', !(await fakeFiles(page)).some((f) => /plannr-moving|plannrSQLite/.test(f)), JSON.stringify(await fakeFiles(page)));
      check('the data is all there', (await reasons(page)).includes('D: before the interrupted move'));
      // "Not now": the prompt goes for this session, the app works.
      await page.click('#moveNotNowBtn');
      await waitMsg(page, 'moveMsg', /keeps working on the old storage/);
      check('"Not now": the prompt is hidden, the app keeps working', !(await visible(page, 'moveInterrupted')) && (await addCashIn(page, 'E: after not now')).status === 201);
      await open(page);
      check('"Not now" holds for this session', !(await visible(page, 'moveInterrupted')));
      // "Continue" (the prompt shown again): the data changed since ("E"), so the backup is asked again.
      await page.evaluate(() => { sessionStorage.removeItem('plannr-move-not-now'); localStorage.setItem('plannr-test-move-delay-ms', '0'); });
      await open(page);
      check('the prompt is back in a new session', await visible(page, 'moveInterrupted'));
      const downloads = page.downloads.length;
      await page.fill('#movePass', ''); await page.fill('#movePass2', '');
      await page.click('#moveContinueBtn');
      await waitMsg(page, 'moveMsg', /passphrase/i);
      check('"Continue" with the data changed: a new backup is needed (the passphrase is asked)', page.downloads.length === downloads, await text(page, 'moveMsg'));
      await fillPass(page, PASS);
      await runMove(page);
      check('"Continue" finished: on the file, with everything', (await storageOf(page)).use === 'native' && (await reasons(page)).includes('E: after not now'));
      await page.context().close();
    }

    {
      console.log('5. "Continue" with the data unchanged: no second backup');
      const page = await newPage();
      await open(page);
      await addCashIn(page, 'F: unchanged');
      await page.evaluate(() => localStorage.setItem('plannr-test-move-delay-ms', '400'));
      await fillPass(page, PASS);
      await page.click('#moveBtn');
      await answerConfirm(page, true);
      await page.waitForSelector('#moveSteps li[data-step="write"][data-state="now"]', { timeout: 30000 });
      await page.reload({ waitUntil: 'load' });
      await settle(page);
      check('the prompt is shown', await visible(page, 'moveInterrupted'));
      await page.evaluate(() => { localStorage.setItem('plannr-test-move-delay-ms', '0'); sessionStorage.removeItem('test-seen-steps'); });
      const downloads = page.downloads.length;
      await runMove(page, { button: '#moveContinueBtn', confirmBackup: false });
      check('no passphrase, no second backup', page.downloads.length === downloads, JSON.stringify(page.downloads));
      check('the backup and snapshot steps were skipped', !(await seenSteps(page)).some((x) => /^(backup|snapshot):/.test(x)), JSON.stringify(await seenSteps(page)));
      check('on the file, with the data', (await storageOf(page)).use === 'native' && (await reasons(page)).includes('F: unchanged'));
      await page.context().close();
    }
  } catch (e) {
    failures++;
    console.log('  ✗ the suite stopped: ' + (e && e.stack ? e.stack : e));
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll storage-move UI checks passed');
  process.exit(failures ? 1 : 0);
})();
