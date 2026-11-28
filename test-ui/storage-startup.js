// Step 1.4 C9: which copy the app opens at startup, in Chromium (npm run test:storage-startup).
//
// The phone's two storage plugins are stood in for by test-ui/_fake-native-plugins.js (files in
// sessionStorage, databases on the app's own sqlite-wasm), loaded before the app's scripts. The app
// is the real phone code under local-server.js: local-bootstrap.js -> storage-native.js -> db.js.
// Each scenario has its own browser context (its own localStorage and sessionStorage):
//   1. no plugins (the browser preview): localStorage, nothing else touched;
//   2. the plugins, never moved: localStorage, no file made;
//   3. the marker says native-v1: the app reads and writes the file, not localStorage; the encrypted
//      backup and restore work on the file; useAdapter() after ready() is refused;
//   4. the file missing: the recovery screen; "Use the old copy" after the confirmation;
//   5. the file damaged: the recovery screen; a wrong passphrase changes nothing; "Restore an
//      encrypted backup" puts the backup in a new file and keeps the damaged one aside;
//   6. an interrupted move: the candidate deleted and the "interrupted" prompt; a file nothing
//      explains set aside.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8113;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, '_fake-native-plugins.js');
const MAIN = '/data/user/0/com.plannr.app/databases/plannrSQLite.db';
const CANDIDATE = '/data/user/0/com.plannr.app/databases/plannr-movingSQLite.db';
const MARKER = '/data/user/0/com.plannr.app/files/plannr-storage.json';
const MOVED_AT = '2026-11-19T10:00:00.000Z';
const PASS = 'storage-startup-passphrase';
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  const server = spawn(process.execPath, ['local-server.js', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch();
  const unexpected = [];

  async function newPage({ fake = true } = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    if (fake) await page.addInitScript({ path: FAKE });
    page.dialogs = [];
    page.on('dialog', (d) => { page.dialogs.push(d.message()); d.accept(); });
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    return page;
  }
  // Open a page and wait for local-bootstrap.js; resolves with its error if it stopped (recovery).
  const open = async (page, file = 'data-backup.html') => {
    await page.goto(`${BASE}/${file}`, { waitUntil: 'load' });
    return page.evaluate(() => import('/local-bootstrap.js').then(() => null, (e) => String(e && e.message)));
  };
  const storageOf = (page) => page.evaluate(() => window.__plannrStorage);
  const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json };
  }, [method, url, body]);
  const addCashIn = (page, reason) => api(page, 'POST', '/api/cash-in', { amountRupees: '1234', txDate: '2026-11-19', byType: 'relative', byLabel: 'Startup test', reason });
  const reasons = async (page) => {
    const r = await api(page, 'GET', '/api/cash-in');
    const rows = Array.isArray(r.json) ? r.json : (r.json && (r.json.rows || r.json.entries || r.json.items)) || [];
    return rows.map((x) => x.reason);
  };
  const fakeFiles = (page) => page.evaluate(() => window.__plannrFakeFs.list());
  const kvvfsRecords = (page) => page.evaluate(() => JSON.stringify(Object.keys(localStorage).filter((k) => k.startsWith('kvvfs-local')).sort().map((k) => [k, localStorage.getItem(k)])));
  // What a finished move leaves: the kvvfs database exported into the file, and the marker.
  const makeMoved = (page) => page.evaluate(async ([main, marker, at]) => {
    const { openKvvfsAdapter } = await import('/db-adapter-kvvfs.js');
    const a = await openKvvfsAdapter();
    const bytes = await a.exportBytes();
    await a.close();
    window.__plannrFakeFs.putFile(main, bytes);
    window.__plannrFakeFs.putFile(marker, new TextEncoder().encode(JSON.stringify({ storage: 'native-v1', movedAt: at, oldCopy: { kept: true, since: at, bytes: bytes.length } })));
  }, [MAIN, MARKER, MOVED_AT]);
  // Rows of the file's own database, read straight from the stand-in file.
  const fileReasons = (page) => page.evaluate(async (main) => {
    const { getSqlite3 } = await import('/db-engine.js');
    const s3 = getSqlite3();
    const bytes = window.__plannrFakeFs.getFile(main);
    const db = new s3.oo1.DB(':memory:', 'c');
    const p = s3.wasm.allocFromTypedArray(bytes);
    s3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.length, bytes.length, s3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | s3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    try { return db.selectValues('SELECT reason FROM cash_in ORDER BY id'); } finally { db.close(); }
  }, MAIN);
  const marker = (page) => page.evaluate((m) => { const b = window.__plannrFakeFs.getFile(m); return b ? JSON.parse(new TextDecoder().decode(b)) : null; }, MARKER);
  const exportEncrypted = (page) => page.evaluate(async (pp) => {
    const r = await fetch('/api/backup/export-encrypted', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: pp }) });
    if (!r.ok) return null;
    return Array.from(new Uint8Array(await (await r.blob()).arrayBuffer()));
  }, PASS);

  try {
    // ---- 1. No plugins ----
    {
      console.log('1. the browser preview (no storage plugins)');
      const page = await newPage({ fake: false });
      const stopped = await open(page);
      const s = await storageOf(page);
      check('localStorage, not native', !stopped && s && s.use === 'localstorage' && s.native === false, JSON.stringify(s) + (stopped || ''));
      check('the app answers', (await api(page, 'GET', '/api/ledgers')).status === 200);
      await page.context().close();
    }

    // ---- 2. Plugins, never moved ----
    {
      console.log('2. the storage plugins, never moved');
      const page = await newPage();
      await open(page);
      const s = await storageOf(page);
      check('localStorage, on a native build, no prompt', s && s.use === 'localstorage' && s.native === true && s.prompt === null, JSON.stringify(s));
      check('no file was made', (await fakeFiles(page)).length === 0, JSON.stringify(await fakeFiles(page)));
      check('the app answers on localStorage', (await addCashIn(page, 'on localStorage')).status === 201);
      await page.context().close();
    }

    // ---- 3. The marker says native-v1 ----
    let enc = null;
    {
      console.log('3. the data in its file (native-v1)');
      const page = await newPage();
      await open(page);
      await addCashIn(page, 'A: before the move');
      await makeMoved(page);
      const kvBefore = await kvvfsRecords(page);
      const stopped = await open(page);
      const s = await storageOf(page);
      check('the app opens the file', !stopped && s && s.use === 'native', JSON.stringify(s) + (stopped || ''));
      check('it shows the data that was moved', (await reasons(page)).includes('A: before the move'));
      const add = await addCashIn(page, 'B: in the file');
      check('a save goes through', add.status === 201, JSON.stringify(add.json));
      check('the save is in the file', (await fileReasons(page)).includes('B: in the file'));
      check('localStorage is not written (the old copy is unchanged)', (await kvvfsRecords(page)) === kvBefore);
      await open(page);
      check('after a reload the save is still there (it reached the file)', (await storageOf(page)).use === 'native' && (await reasons(page)).includes('B: in the file'));
      const refused = await page.evaluate(async () => { try { (await import('/db.js')).useAdapter({}); return 'accepted'; } catch (e) { return e.message; } });
      check('useAdapter() after ready() is refused', /before ready\(\)/.test(refused), refused);

      // Step 1.4 C11: /api/storage on the file, the meter's texts, and the storage-full text on the file.
      const st = await api(page, 'GET', '/api/storage');
      const sizes = await page.evaluate((m) => ({ file: window.__plannrFakeFs.getFile(m).length, old: Object.keys(localStorage).filter((k) => k.startsWith('kvvfs-local')).reduce((n, k) => n + k.length + localStorage.getItem(k).length, 0) * 2 }), MAIN);
      check('/api/storage on the file: its size, the old copy counted, the free space, against 25 MB', st.status === 200 && st.json.kind === 'file' && st.json.databaseBytes === sizes.file && sizes.old > 0 && st.json.backupBytes === sizes.file + sizes.old && st.json.backupLimitBytes === 25 * 1048576 && st.json.freeBytes === 8e9 && st.json.level === 'ok' && st.json.freeLow === false, JSON.stringify({ ...st.json, sizes }));
      await page.waitForFunction(() => !/Checking/.test(document.getElementById('storageText').textContent)).catch(() => {});
      const meter = await page.evaluate(() => ({ text: document.getElementById('storageText').textContent, msg: document.getElementById('storageMsg').textContent, label: document.getElementById('storageBar').getAttribute('aria-label'), hidden: document.getElementById('storageBar').hidden }));
      check('the meter on the file: the file, the old copy, the Google backup estimate against 25 MB', /^Your data file is (?:under )?[\d.]+ MB\. With the old copy \((?:under )?[\d.]+ MB\), Android's Google backup of Plannr is about (?:under )?[\d.]+ MB of the 25 MB it allows \(\d+%\)\.$/.test(meter.text) && meter.msg === '' && meter.label === 'Google backup size' && !meter.hidden, JSON.stringify(meter));
      await page.evaluate(() => sessionStorage.setItem('fakefs-free', String(50 * 1048576)));
      await open(page);
      await page.waitForFunction(() => /free/.test(document.getElementById('storageMsg').textContent)).catch(() => {});
      const low = await page.evaluate(() => document.getElementById('storageMsg').textContent);
      await page.evaluate(() => sessionStorage.removeItem('fakefs-free'));
      check('low free space on the phone is said, with what to do', low === 'This phone has only 50 MB free. New entries cannot be saved once the phone is full: free up space on the phone.', low);
      await page.evaluate(() => sessionStorage.setItem('fakefs-full', '1'));
      const full = await addCashIn(page, 'D: the phone is full');
      await page.evaluate(() => sessionStorage.removeItem('fakefs-full'));
      // Q11 wording (the owner's exact text, request-rules.js STORAGE_FULL).
      check('a full phone on the file says the phone\'s storage is full', full.status === 500 && (full.json && full.json.error) === "Your phone's storage is full. Free up some space and try again. Nothing was changed.", JSON.stringify(full.json));
      check('…and nothing was saved', !(await reasons(page)).includes('D: the phone is full') && !(await fileReasons(page)).includes('D: the phone is full'));
      enc = await exportEncrypted(page);
      check('an encrypted backup can be made from the file', Array.isArray(enc) && enc.length > 100);
      await addCashIn(page, 'C: after the backup');
      const dataBase64 = await page.evaluate((arr) => { const b = new Uint8Array(arr); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }, enc);
      const restored = await api(page, 'POST', '/api/backup/import-encrypted', { passphrase: PASS, dataBase64 });
      check('the encrypted backup restores onto the file', restored.status === 200, JSON.stringify(restored.json));
      const after = await reasons(page);
      check('…with the backup\'s data (B there, C gone)', after.includes('B: in the file') && !after.includes('C: after the backup'), after.join(' | '));
      check('…written to the file itself', !(await fileReasons(page)).includes('C: after the backup'));
      check('…and localStorage still untouched', (await kvvfsRecords(page)) === kvBefore);

      // ---- 4. The file missing ----
      console.log('4. the file missing: the recovery screen');
      await page.evaluate((m) => window.__plannrFakeFs.delFile(m), MAIN);
      const why = await open(page);
      check('the page stops at startup', /recovery screen/.test(String(why)), String(why));
      const screen = await page.evaluate(() => { const r = document.getElementById('storage-recovery'); return r && r.innerText; });
      check('the recovery screen says the file is missing and nothing changed', /missing\. Nothing has been changed\./.test(screen || ''), (screen || '').slice(0, 200));
      check('it offers the old copy with its date', /Use the old copy as it was on 19 Nov 2026/.test(screen || ''));
      check('with the file missing, it does not speak of a damaged file', !/damaged file/.test(screen || ''));
      check('nothing was changed (localStorage, no new file)', (await kvvfsRecords(page)) === kvBefore && !(await fakeFiles(page)).includes(MAIN));
      const nav = page.waitForNavigation({ waitUntil: 'load' });
      await page.click('#recovery-use-old');
      await nav;
      check('a confirmation came first, saying what is not in the old copy', page.dialogs.some((m) => /Anything entered after that is not in it/.test(m)), page.dialogs.join(' | '));
      await page.evaluate(() => import('/local-bootstrap.js'));
      const s2 = await storageOf(page);
      check('after it, the app is on the old copy (localStorage)', s2 && s2.use === 'localstorage', JSON.stringify(s2));
      const m = await marker(page);
      check('the marker says localstorage-v1, an emergency', m && m.storage === 'localstorage-v1' && m.emergency === true, JSON.stringify(m));
      const rs = await reasons(page);
      check('the old copy is what was there at the move (A, not B)', rs.includes('A: before the move') && !rs.includes('B: in the file'), rs.join(' | '));
      await page.context().close();
    }

    // ---- 5. The file damaged: restore an encrypted backup ----
    {
      console.log('5. the file damaged: restore an encrypted backup');
      const page = await newPage();
      await open(page);
      await addCashIn(page, 'A: before the move');
      await makeMoved(page);
      await open(page);
      await addCashIn(page, 'B: in the file');
      const backup = await exportEncrypted(page);
      await page.evaluate((m) => window.__plannrFakeFs.putFile(m, new TextEncoder().encode('damaged: not a database')), MAIN);
      const why = await open(page);
      const screen = await page.evaluate(() => { const r = document.getElementById('storage-recovery'); return r && r.innerText; });
      check('the recovery screen says the file is damaged', /recovery screen/.test(String(why)) && /damaged\. Nothing has been changed\./.test(screen || ''), String(why));
      check('…and that the damaged file is kept', /The damaged file is kept\./.test(screen || ''));
      await page.setInputFiles('#recovery-file', { name: 'plannr-backup.db.enc', mimeType: 'application/octet-stream', buffer: Buffer.from(backup) });
      await page.fill('#recovery-passphrase', 'not the passphrase');
      await page.click('#recovery-restore');
      await page.waitForFunction(() => /pass|decrypt|wrong|could not/i.test(document.getElementById('recovery-status').textContent));
      const msg = await page.evaluate(() => document.getElementById('recovery-status').textContent);
      const files1 = await fakeFiles(page);
      check('a wrong passphrase is refused and changes nothing', !files1.some((f) => /setaside/.test(f)) && files1.includes(MAIN), msg);
      await page.fill('#recovery-passphrase', PASS);
      const nav = page.waitForNavigation({ waitUntil: 'load' });
      await page.click('#recovery-restore');
      await nav;
      await page.evaluate(() => import('/local-bootstrap.js'));
      const s = await storageOf(page);
      const rs = await reasons(page);
      check('after the restore the app opens the new file, with the backup\'s data', s && s.use === 'native' && rs.includes('B: in the file'), JSON.stringify(s) + ' ' + rs.join(' | '));
      const files2 = await fakeFiles(page);
      const aside = files2.find((f) => /plannr-setaside-.*SQLite\.db$/.test(f));
      const kept = aside && (await page.evaluate((f) => new TextDecoder().decode(window.__plannrFakeFs.getFile(f)), aside));
      check('the damaged file is kept aside, unchanged', kept === 'damaged: not a database', JSON.stringify(files2));
      check('the marker still says native-v1', ((await marker(page)) || {}).storage === 'native-v1');
      await page.context().close();
    }

    // ---- 6. An interrupted move ----
    {
      console.log('6. an interrupted move');
      const page = await newPage();
      await open(page);
      await page.evaluate((c) => {
        window.__plannrFakeFs.putFile(c, new TextEncoder().encode('half a candidate'));
        localStorage.setItem('plannr-storage-move', JSON.stringify({ checksum: 'x'.repeat(64), done: ['space', 'backup', 'snapshot'] }));
      }, CANDIDATE);
      await open(page);
      const s = await storageOf(page);
      check('the candidate is deleted and the app stays on localStorage, with the "interrupted" prompt', s && s.use === 'localstorage' && s.prompt === 'interrupted' && !(await fakeFiles(page)).includes(CANDIDATE), JSON.stringify(s));
      check('the progress hint is kept for "Continue"', await page.evaluate(() => !!localStorage.getItem('plannr-storage-move')));
      await page.evaluate(() => localStorage.removeItem('plannr-storage-move'));
      await makeMoved(page);
      await page.evaluate((m) => window.__plannrFakeFs.delFile(m), MARKER);
      await open(page);
      const files = await fakeFiles(page);
      check('a database file nothing explains is set aside, not deleted', !files.includes(MAIN) && files.some((f) => /plannr-setaside-.*SQLite\.db$/.test(f)), JSON.stringify(files));
      check('…and the app stays on localStorage', (await storageOf(page)).use === 'localstorage');
      await page.context().close();
    }
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await browser.close();
    server.kill();
  }
  for (const u of unexpected) console.log('  unexpected:', u);
  console.log(failures ? `\nstorage-startup: ${failures} FAILED` : '\nstorage-startup: all passed');
  process.exit(failures ? 1 : 0);
})();
