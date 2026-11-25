// The desktop trial's /api: the shared core (core/routes/*), registered the way server.js and
// public/local-api.js register it, answered in-process. No HTTP server and no port: main.js calls
// handle() from its app:// protocol handler.
//
// The database is the node:sqlite file userData/plannr.db, through db.js (docs/cross-platform-plan.md
// §4.4). db.js reads PLANNR_DB once, when it is first imported, so this module sets it to that file
// first and imports db.js afterwards. One API per process.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const rootModule = (name) => import(new URL(`../${name}`, import.meta.url).href);

export async function createDesktopApi({ userData }) {
  if (!userData) throw new Error('createDesktopApi: pass the userData folder.');
  fs.mkdirSync(userData, { recursive: true });
  const dbFile = path.join(path.resolve(userData), 'plannr.db');
  if (path.resolve(dbFile).startsWith(path.join(ROOT, 'data') + path.sep)) {
    throw new Error('createDesktopApi: the desktop app never opens the dev server\'s data/ folder.');
  }
  if (process.env.PLANNR_DB !== undefined && path.resolve(process.env.PLANNR_DB) !== dbFile) {
    throw new Error('createDesktopApi: PLANNR_DB is set to another file. The desktop database is userData/plannr.db.');
  }
  process.env.PLANNR_DB = dbFile;

  const dbm = await rootModule('db.js');
  const repo = await rootModule('repo.js');
  const requestRules = await rootModule('request-rules.js');
  const backupCrypto = (await rootModule('backup-crypto.js')).default;
  const { parseLedgerFilters } = await rootModule('core/parsers.js');
  const { createLedgerIndex } = await rootModule('core/ledger-index.js');
  const { createOwnerQueries } = await rootModule('core/owner.js');
  const { istDateStamp } = await rootModule('core/ist-date.js');
  const { checkHost, hostError } = await rootModule('core/host.js');
  const { createRequestQueue, queuedRoutes, createStartJobs } = await rootModule('core/request-queue.js');
  const ledgerCrud = await rootModule('core/ledger-crud.js');
  const overviewPdf = await rootModule('core/overview-pdf.js');
  const route = async (name) => rootModule(`core/routes/${name}.js`);
  if (dbm.DB_PATH !== dbFile) throw new Error('createDesktopApi: db.js was already opened on another file.');

  // The router: the same small path matcher as the phone's (public/local-api.js).
  const routes = [];
  const compile = (pattern) => {
    const paramNames = [];
    const parts = pattern.split('/').map((seg) => {
      if (seg.startsWith(':')) { paramNames.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    return { regex: new RegExp('^' + parts.join('/') + '$'), paramNames };
  };
  const on = (method) => (routePath, ...fns) => routes.push({ method, ...compile(routePath), handler: fns[fns.length - 1] });
  const requestQueue = createRequestQueue();
  const api = queuedRoutes({ get: on('GET'), post: on('POST'), put: on('PUT'), delete: on('DELETE') }, requestQueue);

  const { getOwner, userExists, requireApiAuth } = createOwnerQueries(dbm.dbAdapter);
  const ledgerIndex = createLedgerIndex(repo);
  const startJobs = createStartJobs(requestQueue);
  const { atStart } = startJobs;
  atStart(() => dbm.init());
  atStart(() => ledgerIndex.refresh());

  const snapshotDir = path.join(path.dirname(dbFile), 'safety-snapshots');
  const storageFull = (what) => `Storage is full — ${what} Free up space, then try again.`;
  const host = checkHost({
    pdf: { render: async () => { throw hostError(501, 'PDF export is not in the desktop trial yet.'); } },
    snapshot: {
      writeJson: async (backup) => {
        fs.mkdirSync(snapshotDir, { recursive: true });
        const file = path.join(snapshotDir, `plannr-pre-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(backup));
        return file;
      },
      writeDatabase: async () => dbm.writeRestoreSnapshot(),
    },
    now: () => new Date(),
    crypto: { encrypt: (bytes, passphrase) => backupCrypto.encrypt(bytes, passphrase), decrypt: (bytes, passphrase) => backupCrypto.decrypt(bytes, passphrase) },
    database: { exportBytes: async () => dbm.dbAdapter().exportBytes(), restore: (bytes) => dbm.restoreFromBytes(bytes) },
    storage: { info: async () => { let databaseBytes = null; try { databaseBytes = fs.statSync(dbFile).size; } catch { /* unknown */ } return { kind: 'desktop', databaseBytes }; } },
  });
  const coreContext = {
    adapter: dbm.dbAdapter(), atStart, repo, transaction: dbm.transaction, getOwner, userExists,
    isStorageFullError: dbm.isStorageFullError, istDateStamp, storageFull, parseLedgerFilters,
    host,
    auth: requireApiAuth, // never called: the router runs only the last handler, as on the phone
    logError: (...args) => console.error(...args),
    ledgerIndex,
    exclusive: (fn) => requestQueue.run(fn),
  };
  (await route('people')).register(api, coreContext);
  (await route('ledger-list')).register(api, coreContext);
  const { makeLedgerCrud, LEDGER_CRUDS } = ledgerCrud.createLedgerCrud(api, coreContext);
  const { REASON_MAX, CASH_IN_SELECT, cashInRow, LOANS_SELECT, loanRow, CUSTOM_CODE, ledgerLabel, resolveLedger, CASH_OUT_SELECT, cashOutRow } = (await route('cash-and-loans')).register(api, { ...coreContext, makeLedgerCrud });
  const { unitPricePaise, contractRow } = (await route('contracts')).register(api, { ...coreContext, ledgerLabel, resolveLedger });
  const { CONTRACTOR_PAYMENTS_SELECT, paymentRow } = (await route('contractor-payments')).register(api, { ...coreContext, makeLedgerCrud, ledgerLabel, resolveLedger, REASON_MAX });
  (await route('trash')).register(api, { ...coreContext, CASH_IN_SELECT, cashInRow, LOANS_SELECT, loanRow, CASH_OUT_SELECT, cashOutRow, contractRow, CONTRACTOR_PAYMENTS_SELECT, paymentRow });
  const { getBudgetPaise } = (await route('budget')).register(api, coreContext);
  (await route('notification-times')).register(api, coreContext);
  const { computeOverview } = (await route('overview')).register(api, { ...coreContext, ledgerLabel, CUSTOM_CODE, unitPricePaise, getBudgetPaise });
  const { readPdfQuery, overviewPdfHtml } = overviewPdf.createOverviewPdf({ computeOverview, LEDGER_CRUDS, cashOutRow, CUSTOM_CODE, ledgerIndex });
  (await route('pdf')).register(api, { ...coreContext, readPdfQuery, overviewPdfHtml });
  (await route('backup')).register(api, { ...coreContext, CUSTOM_CODE });
  (await route('storage')).register(api, coreContext);
  (await route('backup-reminder')).register(api, coreContext);

  await startJobs.whenDone();

  const JSON_TYPE = 'application/json; charset=utf-8';
  const answer = (status, obj) => ({ status, headers: { 'content-type': JSON_TYPE }, body: Buffer.from(JSON.stringify(obj)) });

  /** One /api request: { method, url, body (text) } -> { status, headers, body (bytes) }. */
  async function handle({ method = 'GET', url, body = '' }) {
    const u = new URL(url, 'app://plannr/');
    const m = String(method).toUpperCase();
    const parsed = requestRules.parseJsonBody(body == null ? '' : String(body), requestRules.bodyKind(m, u.pathname));
    if (parsed.error) return answer(parsed.status, parsed.error);
    for (const r of routes) {
      if (r.method !== m) continue;
      const match = r.regex.exec(u.pathname);
      if (!match) continue;
      const params = {};
      r.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
      const res = {
        statusCode: 200, headers: { 'content-type': JSON_TYPE }, payload: Buffer.from('null'),
        status(n) { this.statusCode = n; return this; },
        json(obj) { this.headers['content-type'] = JSON_TYPE; this.payload = Buffer.from(JSON.stringify(obj === undefined ? null : obj)); return this; },
        send(buf) { this.payload = Buffer.from(buf); return this; },
        setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); return this; },
      };
      try {
        await r.handler({ method: m, path: u.pathname, params, query: Object.fromEntries(u.searchParams), body: parsed.body }, res);
      } catch (e) {
        console.error('desktop api handler error:', e);
        return answer(500, { error: dbm.isStorageFullError(e) ? storageFull('this change was not saved.') : 'Something went wrong.' });
      }
      return { status: res.statusCode, headers: res.headers, body: res.payload };
    }
    return answer(404, requestRules.notFound(m, u.pathname));
  }

  const close = () => { try { dbm.db && dbm.db.close(); } catch { /* already closed */ } };
  return { handle, close, dbFile };
}
