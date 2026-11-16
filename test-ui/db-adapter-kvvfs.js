// Step 1.4 B2: the wasm-kvvfs adapter (public/db-adapter-kvvfs.js) against the adapter contract
// suite (test/adapter-contract.mjs) in Chromium: npm run test:db-adapter-kvvfs.
//
// A fresh Playwright browser context, so its localStorage holds nothing but what this suite writes.
// The page is a blank test page on local-server.js's origin (served by page.route), so it loads the
// same files the app loads. Each contract case starts from an empty kvvfs database. Then the checks
// that only kvvfs has: a replaced database is what the next open sees (it is in localStorage), and a
// refused replace leaves every localStorage record exactly as it was.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8103;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

const TEST_PAGE = `<!doctype html><meta charset="utf-8"><title>adapter contract</title>
<script type="importmap">{ "imports": { "@sqlite.org/sqlite-wasm": "/node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs" } }</script>
<body>kvvfs adapter contract</body>`;

(async () => {
  const server = spawn(process.execPath, ['local-server.js', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${BASE}/__adapter-test.html`, (r) => r.fulfill({ contentType: 'text/html', body: TEST_PAGE }));
    await page.route(`${BASE}/__adapter-contract.mjs`, (r) => r.fulfill({
      contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'test', 'adapter-contract.mjs'), 'utf8'),
    }));
    await page.goto(`${BASE}/__adapter-test.html`, { waitUntil: 'load' });

    // ---- The contract suite ----
    const results = await page.evaluate(async () => {
      const { CONTRACT_CASES } = await import('/__adapter-contract.mjs');
      const { openKvvfsAdapter } = await import('/db-adapter-kvvfs.js');
      const wipe = () => { for (const k of Object.keys(localStorage)) if (k.startsWith('kvvfs-local')) localStorage.removeItem(k); };
      const out = [];
      for (const c of CONTRACT_CASES) {
        wipe();
        const db = await openKvvfsAdapter();
        try { await c.run(db); out.push({ name: c.name, ok: true }); } catch (e) { out.push({ name: c.name, ok: false, error: String(e && e.message) }); }
        try { await db.close(); } catch { /* a case may close it */ }
      }
      wipe();
      return out;
    });
    check('every contract case ran', results.length >= 13, `${results.length} cases`);
    for (const r of results) check(`contract (wasm-kvvfs): ${r.name}`, r.ok, r.error);

    // ---- What only kvvfs has ----
    const persisted = await page.evaluate(async () => {
      const { openKvvfsAdapter } = await import('/db-adapter-kvvfs.js');
      const a = await openKvvfsAdapter();
      await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT); INSERT INTO t (x) VALUES (\'kept\')');
      const bytes = await a.exportBytes();
      await a.exec("INSERT INTO t (x) VALUES ('dropped by the replace')");
      await a.replaceWith(bytes);
      await a.close();
      const b = await openKvvfsAdapter(); // as after a reload: a new connection to the same records
      const rows = await b.all('SELECT x FROM t');
      const info = await b.info();
      await b.close();
      return { rows: rows.map((r) => r.x), info };
    });
    check('a replaced database is what the next open sees', JSON.stringify(persisted.rows) === '["kept"]', JSON.stringify(persisted.rows));
    check('info names wasm-kvvfs, its slot and a size', persisted.info.engine === 'wasm-kvvfs' && persisted.info.path === 'kvvfs:local' && persisted.info.sizeBytes > 0, JSON.stringify(persisted.info));

    const refused = await page.evaluate(async () => {
      const { openKvvfsAdapter } = await import('/db-adapter-kvvfs.js');
      const records = () => JSON.stringify(Object.keys(localStorage).filter((k) => k.startsWith('kvvfs-local')).sort().map((k) => [k, localStorage.getItem(k)]));
      // An image whose rows break a foreign key: made with a second, in-memory adapter-free database.
      const { getSqlite3 } = await import('/db-engine.js');
      const sqlite3 = getSqlite3();
      const m = new sqlite3.oo1.DB(':memory:', 'c');
      m.exec('PRAGMA foreign_keys = OFF; CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER NOT NULL REFERENCES p(id)); INSERT INTO c VALUES (1, 99)');
      const broken = sqlite3.capi.sqlite3_js_db_export(m);
      m.close();
      const a = await openKvvfsAdapter();
      const before = records();
      let message = '';
      try { await a.replaceWith(broken); } catch (e) { message = e.message; }
      const after = records();
      const still = (await a.all('SELECT x FROM t')).map((r) => r.x);
      await a.close();
      return { message, same: before === after, still };
    });
    check('a replace with broken foreign keys is refused', /broken foreign key/.test(refused.message), refused.message);
    check('...and every localStorage record is exactly as it was', refused.same && JSON.stringify(refused.still) === '["kept"]', JSON.stringify(refused.still));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `✗ DB ADAPTER (KVVFS) SUITE FAILED (${failures})` : '✓ DB ADAPTER (KVVFS) SUITE PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
