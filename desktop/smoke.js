// The desktop trial's smoke run (not part of `npm test`; it needs the Electron binary).
//
//   node desktop/smoke.js <empty-folder-for-userData>
//
// It starts the app twice on that folder with Playwright's _electron (the root `playwright`
// package) and the Electron in desktop/node_modules. Run 1: the home page opens from app://plannr,
// a loan is added and then edited through the page's own /api. Run 2 (a restart): the edited loan is
// still there. Any request that is not app://plannr/ fails the run. Exit code 0 = passed.
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const userData = process.argv[2];
if (!userData) { console.error('Usage: node desktop/smoke.js <empty-folder-for-userData>'); process.exit(2); }
fs.mkdirSync(userData, { recursive: true });
if (fs.readdirSync(userData).length) { console.error('The userData folder must be empty.'); process.exit(2); }

const exe = path.join(import.meta.dirname, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const env = { ...process.env, PLANNR_DESKTOP_USERDATA: path.resolve(userData) };
delete env.PLANNR_DB;
delete env.ELECTRON_RUN_AS_NODE;

const offApp = [];
const pageErrors = [];
async function launch() {
  const app = await electron.launch({ executablePath: exe, args: [import.meta.dirname], env });
  const page = await app.firstWindow();
  page.on('request', (r) => { if (!r.url().startsWith('app://plannr/')) offApp.push(r.url()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.waitForLoadState('load');
  await page.waitForFunction(() => window.__plannrMode !== undefined, null, { timeout: 15000 });
  return { app, page };
}
const call = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json() };
}, [method, url, body]);

const results = {};
try {
  let { app, page } = await launch();
  results.url = page.url();
  results.mode = await page.evaluate(() => window.__plannrMode);
  results.preload = await page.evaluate(() => JSON.stringify(window.plannrDesktop));
  results.nodeInPage = await page.evaluate(() => typeof require !== 'undefined' || typeof process !== 'undefined');
  const added = await call(page, 'POST', '/api/loans', { amountRupees: '1500', bankName: 'Smoke bank', interestRate: '9', tenure: '24 months' });
  results.add = added.status;
  const list1 = await call(page, 'GET', '/api/loans');
  const loans1 = Object.values(list1.body).find(Array.isArray) || [];
  const id = loans1[0] && loans1[0].id;
  const edited = await call(page, 'PUT', `/api/loans/${id}`, { amountRupees: '1750', bankName: 'Smoke bank edited', interestRate: '9', tenure: '24 months' });
  results.edit = edited.status;
  results.outside = await page.evaluate(() => fetch('https://example.com/').then(() => 'loaded', () => 'blocked'));
  await app.close();

  ({ app, page } = await launch());
  const list2 = await call(page, 'GET', '/api/loans');
  const loans2 = Object.values(list2.body).find(Array.isArray) || [];
  results.afterRestart = loans2.map((l) => ({ bankName: l.bankName, amountPaise: l.amountPaise }));
  await app.close();

  results.dbFile = fs.existsSync(path.join(userData, 'plannr.db'));
  results.offAppRequests = offApp.filter((u) => u !== 'https://example.com/');
  results.blockedOutside = offApp.includes('https://example.com/') && results.outside === 'blocked';
  results.pageErrors = pageErrors;
  const ok = results.url === 'app://plannr/home.html' && results.mode === 'server' && results.preload === '{"runtime":"desktop"}'
    && results.nodeInPage === false && results.add >= 200 && results.add < 300 && results.edit === 200
    && results.afterRestart.length === 1 && results.afterRestart[0].bankName === 'Smoke bank edited' && results.afterRestart[0].amountPaise === 175000
    && results.dbFile && results.offAppRequests.length === 0 && results.outside === 'blocked';
  console.log(JSON.stringify(results, null, 2));
  console.log(ok ? 'SMOKE PASSED' : 'SMOKE FAILED');
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log(JSON.stringify(results, null, 2));
  console.error('SMOKE FAILED:', e);
  process.exit(1);
}
