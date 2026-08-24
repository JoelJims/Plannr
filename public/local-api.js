// Phase 5 — local API layer + fetch shim.
//
// Runs Plannr entirely in the browser: intercepts window.fetch, matches /api/* URLs against the
// route table below, and runs the SAME logic server.js's Express handlers run — lifted from
// server.js as directly as possible (validation, computeOverview, resolveLedger/resolveBy, the
// contract/service-offset guards, backup validate/snapshot/replace). The money arithmetic is
// unchanged from server.js; this file does not reimplement it, it copies it.
//
// installFetchShim(repo) must be called only after db.js's ready() has resolved and repo.js has
// been imported (repo.js prepares statements eagerly at import time) — see local-bootstrap.js,
// which is the only thing that should ever call this.
//
// Phase 6a — PDF export, on-device. server.js renders buildOverviewPdfHtml()'s output with
// Playwright, which doesn't run on Android. Instead: WebView.createPrintDocumentAdapter(), driven
// manually against the app's own ParcelFileDescriptor (bypassing the print dialog/spooler entirely)
// via @capgo/capacitor-pdf-generator, which implements exactly that. Rendering goes through the
// WebView's own Chromium, so buildOverviewPdfHtml()'s inline <style>/inline SVG need no changes —
// ported verbatim below, byte-for-byte the same function bodies as server.js.
//
// Not ported: GET /api/health (never called by any page) and everything in server.js that only
// exists to drive Playwright specifically (the PDF concurrency guard, warmPdfBrowser, getPdfBrowser)
// — the print-adapter plugin needs none of that; it's not a shared headless-browser resource, it's a
// one-shot WebView spun up and torn down per call.
//
// Phase 7 adds the encrypted full-snapshot backup path (export-encrypted/import-encrypted) alongside
// the plain-JSON ledger export/import above — a separate concern (raw database bytes, not the
// ledger-table JSON), handled by backup-crypto.js + local-snapshot.js and just wired in here.

import { db, isStorageFullError } from './db.js';
import { encrypt, decrypt, looksLikeSqlite } from './backup-crypto.js';
import { exportSnapshotBytes, restoreSnapshotBytes } from './local-snapshot.js';
import { Capacitor } from '@capacitor/core';
import { PdfGenerator } from '@capgo/capacitor-pdf-generator';

export function installFetchShim(repo) {
  const originalFetch = window.fetch.bind(window);

  // ── tiny req/res mock so route handlers below can be copied from server.js almost verbatim ──────
  const routes = []; // { method, regex, paramNames, handler }
  function compilePath(pattern) {
    const paramNames = [];
    const parts = pattern.split('/').map((seg) => {
      if (seg.startsWith(':')) { paramNames.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    return { regex: new RegExp('^' + parts.join('/') + '$'), paramNames };
  }
  // Mimics app.get/post/put/delete(path, ...middleware, handler) — only the LAST function matters;
  // requireApiAuth/jsonBatch/jsonBackup/editGate are all no-ops or already-handled concerns here
  // (there is no session to check in this single-user app; body parsing is a plain JSON.parse below).
  function on(method) {
    return (routePath, ...fns) => routes.push({ method, ...compilePath(routePath), handler: fns[fns.length - 1] });
  }
  const localApp = { get: on('GET'), post: on('POST'), put: on('PUT'), delete: on('DELETE') };

  class Res {
    constructor() { this.statusCode = 200; this._body = undefined; this._kind = 'json'; }
    status(n) { this.statusCode = n; return this; }
    json(obj) { this._body = obj; this._kind = 'json'; return this; }
    send(buf) { this._body = buf; this._kind = 'raw'; return this; }
    setHeader() { return this; } // headers are irrelevant to the fetch shim's Response-like object
  }

  // ---------------------------------------------------------------------------
  // Single-user offline app: no login, no sessions — mirrors server.js exactly.
  // ---------------------------------------------------------------------------
  const OWNER_STMT = db.prepare('SELECT id, username, display_name AS displayName FROM users ORDER BY id ASC LIMIT 1');
  const getOwner = () => OWNER_STMT.get();
  const USERS_ROSTER_STMT = db.prepare('SELECT id, display_name AS displayName FROM users ORDER BY id ASC');
  const USER_EXISTS_STMT = db.prepare('SELECT 1 FROM users WHERE id = ?');
  const userExists = (id) => Number.isInteger(id) && !!USER_EXISTS_STMT.get(id);
  function requireApiAuth(req, res, next) { req.user = getOwner(); next(); }

  const str = (v) => String(v ?? '').trim();

  localApp.get('/api/me', (req, res) => { res.json({ user: getOwner() }); });
  localApp.get('/api/users', (req, res) => { res.json({ users: USERS_ROSTER_STMT.all() }); });
  // Phase 10b — the fixed ledger taxonomy itself (ledger_mains/ledger_subs), user-editable via CSV on
  // the Data Backup page. Ported verbatim from server.js's identical routes.
  localApp.get('/api/ledgers', (req, res) => { res.json({ ledgers: LEDGERS }); });
  localApp.get('/api/ledgers/csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="plannr-ledger-list.csv"');
    res.send(repo.ledgers.toCsv(LEDGERS));
  });
  localApp.post('/api/ledgers/csv', (req, res) => {
    const csvText = typeof req.body.csv === 'string' ? req.body.csv : '';
    if (!csvText.trim()) return res.status(400).json({ error: 'No CSV content received.' });
    const v = repo.ledgers.validateImport(csvText);
    if (!v.ok) return res.status(400).json({ error: v.error, rowErrors: v.rowErrors });
    try {
      repo.ledgers.replaceAll(v.mains, v.subs);
    } catch (e) {
      if (isStorageFullError(e)) return res.status(500).json({ error: 'Storage is full — the ledger list was not saved. Free up space, then try again.' });
      return res.status(500).json({ error: 'Could not save the ledger list: ' + e.message });
    }
    refreshLedgers();
    res.json({ ok: true, ledgers: LEDGERS });
  });

  localApp.get('/api/ledger-customs', (req, res) => { res.json({ customs: repo.ledgerCustoms.list() }); });
  localApp.delete('/api/ledger-customs', (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Which name? Pass it as ?name=…' });
    repo.ledgerCustoms.remove(name);
    res.json({ ok: true, customs: repo.ledgerCustoms.list() });
  });

  // ---------------------------------------------------------------------------
  // Shared ledger CRUD factory — ported from server.js's makeLedgerCrud() verbatim (routes register
  // against localApp instead of Express's app; everything else is unchanged, including the batch
  // transaction and its storage-full handling).
  // ---------------------------------------------------------------------------
  const BATCH_MAX_ROWS = 500;
  const LEDGER_CRUDS = {};
  function makeLedgerCrud(opts) {
    const { basePath, table, select, listWhere, byIdWhere, shape, columns, validate, listKey, itemKey, notFoundMsg, invalidIdMsg, auditField, finalize, afterWrite, alias } = opts;
    const rc = repo.crud({ table, select, listWhere, byIdWhere, columns, alias: alias || '', searchCols: opts.searchCols || null });
    LEDGER_CRUDS[table] = rc;
    const orderedVals = (values) => columns.map((c) => values[c]);

    localApp.get(basePath, (req, res) => {
      if (opts.searchCols) {
        const f = parseLedgerFilters(req);
        if (f.error) return res.status(400).json({ error: f.error });
        return res.json({ [listKey]: rc.search(f.filters).map(shape), total: rc.liveCount(), filtered: f.active });
      }
      res.json({ [listKey]: rc.list().map(shape) });
    });

    localApp.post(basePath, (req, res) => {
      const v = validate(req);
      if (v.error) return res.status(400).json({ error: v.error });
      if (finalize) { const f = finalize(v.values, { req, id: null, existing: null }); if (f && f.error) return res.status(f.status || 400).json({ error: f.error }); }
      const info = rc.insert(orderedVals(v.values));
      if (afterWrite) afterWrite(v.values, { req, id: Number(info.lastInsertRowid) });
      res.status(201).json({ ok: true, [itemKey]: shape(rc.getById(info.lastInsertRowid)) });
    });

    localApp.put(`${basePath}/:id`, (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || !rc.existsLive(id)) return res.status(404).json({ error: notFoundMsg });
      const existing = (finalize || afterWrite || auditField) ? rc.fullRow(id) : null;
      const oldVal = auditField ? (existing ? existing[auditField] : undefined) : undefined;
      const v = validate(req, oldVal);
      if (v.error) return res.status(400).json({ error: v.error });
      if (finalize) { const f = finalize(v.values, { req, id, existing }); if (f && f.error) return res.status(f.status || 400).json({ error: f.error }); }
      if (auditField && oldVal !== v.values[auditField]) console.warn(`[audit] ${table} id=${id}: ${auditField} ${oldVal} -> ${v.values[auditField]} (attribution changed on edit)`);
      rc.update(id, orderedVals(v.values));
      if (afterWrite) afterWrite(v.values, { req, id });
      res.json({ ok: true, [itemKey]: shape(rc.getById(id)) });
    });

    localApp.delete(`${basePath}/:id`, (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: invalidIdMsg });
      const info = rc.softDelete(id);
      if (info.changes === 0) return res.status(404).json({ error: notFoundMsg });
      res.json({ ok: true });
    });

    if (opts.batch) {
      localApp.post(`${basePath}/batch`, (req, res) => {
        const rows = req.body && Array.isArray(req.body.rows) ? req.body.rows : null;
        if (!rows) return res.status(400).json({ error: 'Expected a { rows: [...] } array.' });
        if (rows.length > BATCH_MAX_ROWS) return res.status(413).json({ error: `Too many rows in one save (${rows.length}); the maximum is ${BATCH_MAX_ROWS}. Save in smaller batches.` });

        const results = new Array(rows.length);
        const toWrite = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const id = Number(row && row.id);
          if (!Number.isInteger(id) || !rc.existsLive(id)) { results[i] = { id: row && row.id, ok: false, error: notFoundMsg }; continue; }
          const existing = (finalize || auditField) ? rc.fullRow(id) : null;
          const oldVal = auditField ? (existing ? existing[auditField] : undefined) : undefined;
          const v = validate({ body: row }, oldVal);
          if (v.error) { results[i] = { id, ok: false, error: v.error }; continue; }
          if (finalize) { const f = finalize(v.values, { req, id, existing }); if (f && f.error) { results[i] = { id, ok: false, error: f.error }; continue; } }
          toWrite.push({ i, id, values: v.values, oldVal });
        }

        db.exec('BEGIN');
        try {
          for (const w of toWrite) rc.update(w.id, orderedVals(w.values));
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          console.error(`${table} batch write failed, rolled back:`, e);
          if (isStorageFullError(e)) return res.status(500).json({ error: 'Storage is full — this save did not go through. Free up space, then try again.' });
          return res.status(500).json({ error: 'The save failed and was rolled back — no rows were changed.' });
        }

        for (const w of toWrite) {
          if (auditField && w.oldVal !== w.values[auditField]) console.warn(`[audit] ${table} id=${w.id}: ${auditField} ${w.oldVal} -> ${w.values[auditField]} (attribution changed on edit)`);
          if (afterWrite) afterWrite(w.values, { req, id: w.id });
          results[w.i] = { id: w.id, ok: true, [itemKey]: shape(rc.getById(w.id)) };
        }
        res.json({ results, saved: toWrite.length, failed: rows.length - toWrite.length });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Everything below is ported verbatim from server.js — validation helpers, resolveLedger/
  // resolveBy, the CRUD registrations, contracts + services, contractor payments, the Recycle Bin,
  // budget, and computeOverview(). No arithmetic changed.
  // ---------------------------------------------------------------------------
  const CASH_IN_BY_TYPES = new Set(['user', 'relative', 'custom']);
  const REASON_MAX = 300;
  const LABEL_MAX = 60;

  function parsePaise(v) {
    const s = String(v == null ? '' : v).trim().replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const [ip, dp = ''] = s.split('.');
    const paise = Number(ip) * 100 + Number((dp + '00').slice(0, 2));
    return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
  }

  function resolveBy(body, existingByUserId) {
    const byType = str(body.byType);
    if (!CASH_IN_BY_TYPES.has(byType)) return { error: 'Select who the money is from.' };
    if (byType === 'user') {
      const id = Number(body.byUserId);
      if (Number.isInteger(id) && userExists(id)) return { byType, byUserId: id, byLabel: null };
      if (existingByUserId === null && body.byUserId == null) return { byType, byUserId: null, byLabel: null };
      return { error: 'The selected user does not exist.' };
    }
    if (byType === 'relative') {
      return { byType, byUserId: null, byLabel: (str(body.byLabel) || 'Relative').slice(0, LABEL_MAX) };
    }
    const label = str(body.byLabel);
    if (!label) return { error: 'Enter a name for the custom source.' };
    return { byType, byUserId: null, byLabel: label.slice(0, LABEL_MAX) };
  }

  const CASH_IN_SELECT =
    `SELECT c.id, c.amount_paise, c.tx_date, c.by_type, c.by_user_id, c.by_label, c.reason, c.created_at,
            u.display_name AS user_display_name
       FROM cash_in c
       LEFT JOIN users u ON u.id = c.by_user_id`;

  function cashInRow(r) {
    return {
      id: r.id,
      amountPaise: r.amount_paise,
      txDate: r.tx_date,
      byType: r.by_type,
      byUserId: r.by_user_id,
      byLabel: r.by_label,
      by: r.by_type === 'user' ? (r.user_display_name || 'Unknown') : (r.by_label || ''),
      reason: r.reason || '',
      createdAt: r.created_at,
    };
  }

  makeLedgerCrud({
    basePath: '/api/cash-in',
    auditField: 'by_user_id',
    table: 'cash_in',
    alias: 'c',
    select: CASH_IN_SELECT,
    listWhere: 'WHERE c.deleted_at IS NULL ORDER BY c.id ASC',
    byIdWhere: 'WHERE c.id = ?',
    shape: cashInRow,
    columns: ['amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'reason'],
    validate: (req, existingByUserId) => {
      const amountPaise = parsePaise(req.body.amountRupees);
      if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };
      const txd = parseIsoDate(req.body.txDate);
      if (txd.error || !txd.date) return { error: 'Enter a valid date (YYYY-MM-DD).' };
      const by = resolveBy(req.body, existingByUserId);
      if (by.error) return { error: by.error };
      return { values: { amount_paise: amountPaise, tx_date: txd.date, by_type: by.byType, by_user_id: by.byUserId, by_label: by.byLabel, reason: str(req.body.reason).slice(0, REASON_MAX) } };
    },
    listKey: 'entries',
    itemKey: 'entry',
    notFoundMsg: 'Entry not found.',
    invalidIdMsg: 'Invalid entry id.',
  });

  const BANK_MAX = 100;
  const TENURE_MAX = 60;

  function parseRate(v) {
    const s = String(v == null ? '' : v).trim();
    if (s === '') return { rate: null };
    if (!/^\d+(\.\d+)?$/.test(s)) return { error: 'Interest rate must be a number (0 or more).' };
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return { error: 'Interest rate must be a number (0 or more).' };
    return { rate: n };
  }

  const LOANS_SELECT = 'SELECT id, amount_paise, bank_name, interest_rate, tenure, created_at FROM loans';

  function loanRow(r) {
    return {
      id: r.id,
      amountPaise: r.amount_paise,
      bankName: r.bank_name || '',
      interestRate: r.interest_rate,
      tenure: r.tenure || '',
      createdAt: r.created_at,
    };
  }

  function readLoanBody(body) {
    const amountPaise = parsePaise(body.amountRupees);
    if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };
    const bankName = str(body.bankName);
    if (!bankName) return { error: 'Bank name is required.' };
    const rate = parseRate(body.interestRate);
    if (rate.error) return { error: rate.error };
    return { amountPaise, bankName: bankName.slice(0, BANK_MAX), rate: rate.rate, tenure: str(body.tenure).slice(0, TENURE_MAX) };
  }

  makeLedgerCrud({
    basePath: '/api/loans',
    table: 'loans',
    alias: '',
    select: LOANS_SELECT,
    listWhere: 'WHERE deleted_at IS NULL ORDER BY id ASC',
    byIdWhere: 'WHERE id = ?',
    shape: loanRow,
    columns: ['amount_paise', 'bank_name', 'interest_rate', 'tenure'],
    validate: (req) => {
      const v = readLoanBody(req.body);
      if (v.error) return { error: v.error };
      return { values: { amount_paise: v.amountPaise, bank_name: v.bankName, interest_rate: v.rate, tenure: v.tenure } };
    },
    listKey: 'loans',
    itemKey: 'loan',
    notFoundMsg: 'Loan not found.',
    invalidIdMsg: 'Invalid loan id.',
  });

  const CASH_OUT_BY_TYPES = new Set(['user', 'custom']);
  const CONTRACT_SCOPES = new Set(['included', 'extra']);
  const CUSTOM_CODE = 'CUSTOM';
  const CUSTOM_NAME_MAX = 80;

  // Phase 10b — the ledger taxonomy is DATA now (ledger_mains/ledger_subs, seeded from ledgers.js on
  // first run — see db.js), not a static import: it can change at runtime via the Ledger List CSV
  // import, so LEDGERS/LEDGER_BY_CODE are rebuilt on demand rather than frozen once at import time.
  let LEDGERS, LEDGER_BY_CODE;
  function refreshLedgers() {
    LEDGERS = repo.ledgers.list();
    LEDGER_BY_CODE = new Map(LEDGERS.map((l) => [l.code, l]));
  }
  refreshLedgers();
  const subBelongs = (ledgerCode, subCode) => {
    const l = LEDGER_BY_CODE.get(ledgerCode);
    return !!l && l.subLedgers.some((s) => s.code === subCode);
  };
  function ledgerLabel(ledgerCode, subCode, ledgerCustom, subCustom) {
    if (subCode === CUSTOM_CODE) return subCustom || '';
    if (subCode) {
      const l = LEDGER_BY_CODE.get(ledgerCode);
      const s = l && l.subLedgers.find((x) => x.code === subCode);
      if (s) return `${s.code} ${s.name}`;
    }
    if (ledgerCode === CUSTOM_CODE) return ledgerCustom || '';
    const l = LEDGER_BY_CODE.get(ledgerCode);
    return l ? `${l.code} ${l.name}` : (ledgerCode || '');
  }

  function resolveLedger(body) {
    const ledgerCode = str(body.ledgerCode);
    let ledgerCustomName = null;
    if (ledgerCode === CUSTOM_CODE) {
      ledgerCustomName = str(body.ledgerCustomName);
      if (!ledgerCustomName) return { error: 'Enter a name for the custom ledger.' };
      ledgerCustomName = ledgerCustomName.slice(0, CUSTOM_NAME_MAX);
    } else if (!LEDGER_BY_CODE.has(ledgerCode)) {
      return { error: 'Select a valid ledger.' };
    }

    let subledgerCode = str(body.subledgerCode);
    let subledgerCustomName = null;
    if (!subledgerCode) {
      subledgerCode = null;
    } else if (subledgerCode === CUSTOM_CODE) {
      subledgerCustomName = str(body.subledgerCustomName);
      if (!subledgerCustomName) return { error: 'Enter a name for the custom sub-ledger.' };
      subledgerCustomName = subledgerCustomName.slice(0, CUSTOM_NAME_MAX);
    } else if (ledgerCode === CUSTOM_CODE) {
      return { error: 'A custom ledger cannot use a fixed sub-ledger.' };
    } else if (!subBelongs(ledgerCode, subledgerCode)) {
      return { error: 'Sub-ledger does not belong to the selected ledger.' };
    }

    return { ledgerCode, subledgerCode, ledgerCustomName, subledgerCustomName };
  }

  function resolveCashOutBy(body, existingByUserId) {
    const byType = str(body.byType);
    if (byType === 'contractor') return { error: 'Contractor spending is no longer recorded as an outflow.' };
    if (!CASH_OUT_BY_TYPES.has(byType)) return { error: 'Select who the money is from.' };
    if (byType === 'user') {
      const id = Number(body.byUserId);
      if (Number.isInteger(id) && userExists(id)) return { byType, byUserId: id, byLabel: null };
      if (existingByUserId === null && body.byUserId == null) return { byType, byUserId: null, byLabel: null };
      return { error: 'The selected user does not exist.' };
    }
    const label = str(body.byLabel);
    if (!label) return { error: 'Enter a name for the custom source.' };
    return { byType, byUserId: null, byLabel: label.slice(0, LABEL_MAX) };
  }

  const CASH_OUT_SELECT =
    `SELECT c.id, c.amount_paise, c.tx_date, c.by_type, c.by_user_id, c.by_label, c.ledger_code,
            c.subledger_code, c.ledger_custom_name, c.subledger_custom_name, c.reason,
            c.contract_scope, c.contract_stated_paise, c.contract_service_id, c.created_at,
            u.display_name AS user_display_name
       FROM cash_out c
       LEFT JOIN users u ON u.id = c.by_user_id`;

  function cashOutRow(r) {
    return {
      id: r.id,
      amountPaise: r.amount_paise,
      txDate: r.tx_date,
      byType: r.by_type,
      byUserId: r.by_user_id,
      byLabel: r.by_label,
      by: r.by_type === 'user' ? (r.user_display_name || 'Unknown') : (r.by_label || ''),
      ledgerCode: r.ledger_code,
      subledgerCode: r.subledger_code,
      ledgerCustomName: r.ledger_custom_name,
      subledgerCustomName: r.subledger_custom_name,
      ledger: ledgerLabel(r.ledger_code, r.subledger_code, r.ledger_custom_name, r.subledger_custom_name),
      reason: r.reason || '',
      contractScope: r.contract_scope,
      contractStatedPaise: r.contract_stated_paise,
      contractServiceId: r.contract_service_id,
      createdAt: r.created_at,
    };
  }

  const saveLedgerCustom = (values) => {
    if (values.ledger_code === CUSTOM_CODE && values.ledger_custom_name && values.ledger_custom_name.trim()) {
      repo.ledgerCustoms.save(values.ledger_custom_name.trim());
    }
  };

  function cashOutServiceFinalize(values, { existing }) {
    if (values.contract_scope !== 'included') { values.contract_service_id = null; return; }
    let sid = values.contract_service_id;
    if (sid === undefined) sid = existing ? existing.contract_service_id : null;
    if (sid == null) { values.contract_service_id = null; return; }
    const svc = repo.contract.serviceLivePriced(sid);
    if (!svc) return { status: 400, error: 'That contract service was not found — pick a listed service, or type the amount directly.' };
    if (svc.price_paise == null) return { status: 400, error: 'That service has no price set, so it cannot be linked — add a price to it, or type the amount directly.' };
    const other = repo.contract.serviceClaimedByOther(sid, existing ? existing.id : -1);
    if (other) {
      return { status: 409, error: `That service is already linked to entry #${other.id} (${fmtRs(other.amount_paise)} on ${other.tx_date}). One service can offset only one debit — unlink it there first, or pick another service.` };
    }
    values.contract_service_id = sid;
  }

  makeLedgerCrud({
    basePath: '/api/cash-out',
    alias: 'c',
    batch: true,
    auditField: 'by_user_id',
    finalize: cashOutServiceFinalize,
    afterWrite: (values) => saveLedgerCustom(values),
    table: 'cash_out',
    select: CASH_OUT_SELECT,
    listWhere: 'WHERE c.deleted_at IS NULL ORDER BY c.id ASC',
    byIdWhere: 'WHERE c.id = ?',
    searchCols: { date: 'tx_date', amount: 'amount_paise', ledger: 'ledger_code', subledger: 'subledger_code', text: ['reason', 'ledger_custom_name', 'subledger_custom_name'] },
    shape: cashOutRow,
    columns: ['amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'reason', 'contract_scope', 'contract_stated_paise', 'contract_service_id'],
    validate: (req, existingByUserId) => {
      const amountPaise = parsePaise(req.body.amountRupees);
      if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };

      const txd = parseIsoDate(req.body.txDate);
      if (txd.error) return { error: txd.error };
      if (!txd.date) return { error: 'Select a date for this entry.' };

      const by = resolveCashOutBy(req.body, existingByUserId);
      if (by.error) return { error: by.error };

      const led = resolveLedger(req.body);
      if (led.error) return { error: led.error };
      const { ledgerCode, subledgerCode, ledgerCustomName, subledgerCustomName } = led;

      const contractScope = str(req.body.contractScope);
      if (!CONTRACT_SCOPES.has(contractScope)) return { error: 'Select whether the work is included in the contract (Yes or No).' };

      let contractStatedPaise = null;
      if (contractScope === 'included') {
        contractStatedPaise = parsePaise(req.body.contractStatedRupees);
        if (contractStatedPaise === null) return { error: 'Enter the contract’s stated amount for this item (greater than 0, up to 2 decimals).' };
      }

      let contractServiceId;
      if ('contractServiceId' in req.body) {
        const raw = req.body.contractServiceId;
        if (raw == null || raw === '') contractServiceId = null;
        else { const n = Number(raw); if (!Number.isInteger(n) || n <= 0) return { error: 'Invalid service selection.' }; contractServiceId = n; }
      }

      return {
        values: {
          amount_paise: amountPaise,
          tx_date: txd.date,
          by_type: by.byType,
          by_user_id: by.byUserId,
          by_label: by.byLabel,
          ledger_code: ledgerCode,
          subledger_code: subledgerCode,
          ledger_custom_name: ledgerCustomName,
          subledger_custom_name: subledgerCustomName,
          reason: str(req.body.reason).slice(0, REASON_MAX),
          contract_scope: contractScope,
          contract_stated_paise: contractStatedPaise,
          contract_service_id: contractServiceId,
        },
      };
    },
    listKey: 'entries',
    itemKey: 'entry',
    notFoundMsg: 'Entry not found.',
    invalidIdMsg: 'Invalid entry id.',
  });

  const CONTRACTOR_MAX = 100;

  function parseIsoDate(v) {
    const s = str(v);
    if (s === '') return { date: null };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: 'Enter a valid date (YYYY-MM-DD).' };
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      return { error: 'Enter a valid date (YYYY-MM-DD).' };
    }
    return { date: s };
  }

  function parseAmountFilter(v) {
    const s = str(v);
    if (s === '') return { paise: null };
    const p = parsePaise(s);
    if (p === null) return { error: 'invalid' };
    return { paise: p };
  }

  function parseLedgerFilters(req) {
    const q = str(req.query.q).slice(0, 100).trim();
    const s = parseIsoDate(req.query.start); if (s.error) return { error: 'Enter a valid start date (YYYY-MM-DD).' };
    const e = parseIsoDate(req.query.end); if (e.error) return { error: 'Enter a valid end date (YYYY-MM-DD).' };
    if (s.date && e.date && s.date > e.date) return { error: 'Start date must be on or before the end date.' };
    const min = parseAmountFilter(req.query.min); if (min.error) return { error: 'Enter a valid minimum amount (greater than 0).' };
    const max = parseAmountFilter(req.query.max); if (max.error) return { error: 'Enter a valid maximum amount (greater than 0).' };
    if (min.paise != null && max.paise != null && min.paise > max.paise) return { error: 'The minimum amount must be less than or equal to the maximum.' };
    const ledger = str(req.query.ledger).slice(0, 40) || null;
    const subledger = ledger ? (str(req.query.subledger).slice(0, 40) || null) : null;
    const filters = { start: s.date, end: e.date, min: min.paise, max: max.paise, ledger, subledger, q: q || null };
    const active = !!(filters.start || filters.end || filters.min != null || filters.max != null || filters.ledger || filters.q);
    return { filters, active };
  }

  function parsePriceOptional(v) {
    const s = str(v);
    if (s === '') return { paise: null };
    const paise = parsePaise(s);
    if (paise === null) return { error: 'Enter a valid price greater than 0 (up to 2 decimals).' };
    return { paise };
  }

  const AREA_MAX = 200;
  const serviceRow = (s) => ({ id: s.id, name: s.name, pricePaise: s.price_paise });

  const contractRow = (r) => {
    const services = repo.contract.servicesFor(r.id);
    const servicesPricedTotalPaise = services.reduce((sum, s) => sum + (s.price_paise || 0), 0);
    return {
      id: r.id,
      contractorName: r.contractor_name || '',
      company: r.company || '',
      areaOfWork: r.area_of_work || '',
      ledgerCode: r.ledger_code,
      subledgerCode: r.subledger_code,
      ledgerCustomName: r.ledger_custom_name,
      subledgerCustomName: r.subledger_custom_name,
      ledger: r.ledger_code ? ledgerLabel(r.ledger_code, r.subledger_code, r.ledger_custom_name, r.subledger_custom_name) : '',
      amountPaise: r.amount_paise,
      statedAmountPaise: r.price_of_contract_paise,
      dateSigned: r.date_signed || '',
      dateEnds: r.contract_end_date || '',
      paymentDates: repo.contract.payDatesFor(r.id),
      services: services.map(serviceRow),
      servicesPricedTotalPaise,
      remainderPaise: (r.price_of_contract_paise || 0) - servicesPricedTotalPaise,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  };

  const getContractRow = (id) => repo.contract.getLive(id);
  const CONTRACT_COLS = ['contractor_name', 'area_of_work', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'amount_paise', 'price_of_contract_paise', 'contract_end_date', 'date_signed', 'company'];
  const COMPANY_MAX = 120;

  function readContractBody(req) {
    const contractorName = str(req.body.contractorName).slice(0, CONTRACTOR_MAX);
    if (!contractorName) return { error: 'Contractor name is required.' };
    const areaOfWork = str(req.body.areaOfWork).slice(0, AREA_MAX);
    if (!areaOfWork) return { error: 'Area of work is required.' };

    const led = resolveLedger(req.body);
    if (led.error) return { error: led.error };

    const amount = parsePriceOptional(req.body.amountRupees);
    if (amount.error) return { error: amount.error };

    const statedAmountPaise = parsePaise(req.body.statedAmountRupees);
    if (statedAmountPaise === null) return { error: 'Enter a valid stated contract amount greater than 0 (up to 2 decimals).' };

    const signed = parseIsoDate(req.body.dateSigned);
    if (signed.error) return { error: signed.error };
    if (!signed.date) return { error: 'Select the date the contract was signed.' };

    const ends = parseIsoDate(req.body.dateEnds);
    if (ends.error) return { error: ends.error };

    const company = str(req.body.company).slice(0, COMPANY_MAX);

    const rawDates = Array.isArray(req.body.paymentDates) ? req.body.paymentDates : [];
    const paymentDates = [];
    for (const d of rawDates) {
      const p = parseIsoDate(d);
      if (p.error || !p.date) return { error: 'Each payment date must be a valid date (YYYY-MM-DD).' };
      paymentDates.push(p.date);
    }

    return {
      values: {
        contractor_name: contractorName,
        area_of_work: areaOfWork,
        ledger_code: led.ledgerCode,
        subledger_code: led.subledgerCode,
        ledger_custom_name: led.ledgerCustomName,
        subledger_custom_name: led.subledgerCustomName,
        amount_paise: amount.paise,
        price_of_contract_paise: statedAmountPaise,
        contract_end_date: ends.date,
        date_signed: signed.date,
        company: company || null,
      },
      paymentDates,
    };
  }

  const writePaymentDates = (contractId, dates) => repo.contract.writePayDates(contractId, dates);

  localApp.get('/api/contracts', (req, res) => { res.json({ contracts: repo.contract.list().map(contractRow) }); });

  localApp.post('/api/contracts', (req, res) => {
    const v = readContractBody(req);
    if (v.error) return res.status(400).json({ error: v.error });
    if (repo.contract.liveCount() > 0) {
      return res.status(409).json({ error: 'A contract already exists — Plannr tracks a single contract. Edit the existing one instead of adding another (or delete it first).' });
    }
    const info = repo.contract.insert(CONTRACT_COLS, CONTRACT_COLS.map((c) => v.values[c]));
    writePaymentDates(info.lastInsertRowid, v.paymentDates);
    res.status(201).json({ ok: true, contract: contractRow(getContractRow(info.lastInsertRowid)) });
  });

  localApp.put('/api/contracts/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getContractRow(id)) return res.status(404).json({ error: 'Contract not found.' });
    const v = readContractBody(req);
    if (v.error) return res.status(400).json({ error: v.error });
    repo.contract.update(id, CONTRACT_COLS, CONTRACT_COLS.map((c) => v.values[c]));
    writePaymentDates(id, v.paymentDates);
    res.json({ ok: true, contract: contractRow(getContractRow(id)) });
  });

  const getServiceRow = (id) => repo.contract.serviceLive(id);
  const getLiveServiceForContract = (cid, sid) => repo.contract.serviceForContract(cid, sid);
  const SERVICE_NAME_MAX = 120;

  function readServiceBody(req) {
    const name = str(req.body.name).slice(0, SERVICE_NAME_MAX);
    if (!name) return { error: 'Service name is required.' };
    const price = parsePriceOptional(req.body.priceRupees);
    if (price.error) return { error: price.error };
    return { values: { name, price_paise: price.paise } };
  }

  localApp.post('/api/contracts/:id/services', (req, res) => {
    const cid = Number(req.params.id);
    if (!Number.isInteger(cid) || !getContractRow(cid)) return res.status(404).json({ error: 'Contract not found.' });
    const v = readServiceBody(req);
    if (v.error) return res.status(400).json({ error: v.error });
    const info = repo.contract.insertService(cid, v.values.name, v.values.price_paise);
    res.status(201).json({ ok: true, service: serviceRow(getServiceRow(info.lastInsertRowid)) });
  });

  localApp.put('/api/contracts/:id/services/:sid', (req, res) => {
    const cid = Number(req.params.id), sid = Number(req.params.sid);
    if (!Number.isInteger(cid) || !Number.isInteger(sid) || !getLiveServiceForContract(cid, sid)) return res.status(404).json({ error: 'Service not found.' });
    const v = readServiceBody(req);
    if (v.error) return res.status(400).json({ error: v.error });
    repo.contract.updateService(sid, v.values.name, v.values.price_paise);
    res.json({ ok: true, service: serviceRow(getServiceRow(sid)) });
  });

  localApp.delete('/api/contracts/:id/services/:sid', (req, res) => {
    const cid = Number(req.params.id), sid = Number(req.params.sid);
    if (!Number.isInteger(cid) || !Number.isInteger(sid) || !getLiveServiceForContract(cid, sid)) return res.status(404).json({ error: 'Service not found.' });
    repo.contract.softDeleteService(sid);
    res.json({ ok: true });
  });

  localApp.delete('/api/contracts/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid contract id.' });
    const live = repo.contract.livePaymentsFor(id);
    if (live > 0) {
      return res.status(409).json({ error: `This contract has ${live} live contractor payment${live === 1 ? '' : 's'} recorded against it. Deleting it would leave ${live === 1 ? 'that payment' : 'those payments'} attributed to a contract that is gone (and unbalance the Overview), so it's blocked — delete or reassign ${live === 1 ? 'that payment' : 'those payments'} first, then delete the contract.` });
    }
    const info = repo.contract.softDelete(id);
    if (info.changes === 0) return res.status(404).json({ error: 'Contract not found.' });
    res.json({ ok: true });
  });

  function resolveLedgerOptional(body) {
    if (str(body.ledgerCode) === '') return { ledgerCode: null, subledgerCode: null, ledgerCustomName: null, subledgerCustomName: null };
    return resolveLedger(body);
  }

  const CONTRACTOR_PAYMENTS_SELECT = `
    SELECT cp.id, cp.contract_id, cp.pay_date, cp.amount_paise,
           cp.ledger_code, cp.subledger_code, cp.ledger_custom_name, cp.subledger_custom_name,
           cp.remarks, cp.created_at,
           ct.contractor_name AS contractor_name, ct.area_of_work AS area_of_work
      FROM contractor_payments cp
      LEFT JOIN contract ct ON ct.id = cp.contract_id`;

  const paymentRow = (r) => ({
    id: r.id,
    contractId: r.contract_id,
    contractorName: r.contractor_name || '',
    areaOfWork: r.area_of_work || '',
    payDate: r.pay_date,
    amountPaise: r.amount_paise,
    ledgerCode: r.ledger_code,
    subledgerCode: r.subledger_code,
    ledgerCustomName: r.ledger_custom_name,
    subledgerCustomName: r.subledger_custom_name,
    ledger: r.ledger_code ? ledgerLabel(r.ledger_code, r.subledger_code, r.ledger_custom_name, r.subledger_custom_name) : '',
    remarks: r.remarks || '',
    createdAt: r.created_at,
  });

  makeLedgerCrud({
    basePath: '/api/contractor-payments',
    alias: 'cp',
    table: 'contractor_payments',
    select: CONTRACTOR_PAYMENTS_SELECT,
    listWhere: 'WHERE cp.deleted_at IS NULL ORDER BY cp.id ASC',
    byIdWhere: 'WHERE cp.id = ?',
    shape: paymentRow,
    columns: ['contract_id', 'pay_date', 'amount_paise', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'remarks'],
    validate: (req) => {
      const contractId = Number(req.body.contractId);
      if (!Number.isInteger(contractId) || !repo.contract.existsLive(contractId)) {
        return { error: 'Select a valid contract.' };
      }
      const d = parseIsoDate(req.body.payDate);
      if (d.error) return { error: d.error };
      if (!d.date) return { error: 'Select a date of payment.' };
      const amountPaise = parsePaise(req.body.amountRupees);
      if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };
      const led = resolveLedgerOptional(req.body);
      if (led.error) return { error: led.error };
      return { values: {
        contract_id: contractId,
        pay_date: d.date,
        amount_paise: amountPaise,
        ledger_code: led.ledgerCode,
        subledger_code: led.subledgerCode,
        ledger_custom_name: led.ledgerCustomName,
        subledger_custom_name: led.subledgerCustomName,
        remarks: str(req.body.remarks).slice(0, REASON_MAX),
      } };
    },
    listKey: 'payments',
    itemKey: 'payment',
    notFoundMsg: 'Payment not found.',
    invalidIdMsg: 'Invalid payment id.',
  });

  // ---------------------------------------------------------------------------
  // Recycle Bin — ported from server.js verbatim.
  // ---------------------------------------------------------------------------
  const TRASH_TABLES = ['cash_in', 'cash_out', 'loans', 'contract', 'contractor_payments'];
  const TRASH_SHAPERS = { cash_in: cashInRow, cash_out: cashOutRow, loans: loanRow, contract: contractRow, contractor_payments: paymentRow };
  const TRASH_REPO = {
    cash_in: repo.trash({ table: 'cash_in', select: CASH_IN_SELECT, alias: 'c' }),
    cash_out: repo.trash({ table: 'cash_out', select: CASH_OUT_SELECT, alias: 'c' }),
    loans: repo.trash({ table: 'loans', select: LOANS_SELECT, alias: '' }),
    contract: repo.trash({ table: 'contract', select: 'SELECT * FROM contract', alias: '' }),
    contractor_payments: repo.trash({ table: 'contractor_payments', select: CONTRACTOR_PAYMENTS_SELECT, alias: 'cp' }),
  };

  function fmtRs(paise) {
    const neg = paise < 0; paise = Math.abs(paise);
    const rupees = Math.floor(paise / 100);
    const p = String(paise % 100).padStart(2, '0');
    return (neg ? '-' : '') + '₹' + rupees.toLocaleString('en-IN') + '.' + p;
  }

  localApp.get('/api/trash', (req, res) => {
    const trash = {};
    for (const t of TRASH_TABLES) {
      trash[t] = TRASH_REPO[t].listDeleted().map((r) => ({ ...TRASH_SHAPERS[t](r), deletedAt: r.deleted_at }));
    }
    res.json({ trash });
  });

  function trashTable(req) { return TRASH_TABLES.includes(req.params.table) ? req.params.table : null; }

  localApp.post('/api/trash/:table/:id/restore', (req, res) => {
    const table = trashTable(req);
    if (!table) return res.status(400).json({ error: 'Unknown table.' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !TRASH_REPO[table].find(id)) return res.status(404).json({ error: 'That deleted item was not found.' });
    if (table === 'contractor_payments') {
      const row = repo.contract.paymentContractId(id);
      const parent = repo.contract.deletedAt(row.contract_id);
      if (!parent || parent.deleted_at !== null) {
        return res.status(409).json({ error: 'Restore the parent contract first — this payment belongs to a contract that is still in the Recycle Bin.' });
      }
    }
    if (table === 'contract' && repo.contract.liveCount() > 0) {
      return res.status(409).json({ error: 'Another contract is already live — Plannr tracks a single contract. Delete the current one before restoring this from the Recycle Bin.' });
    }
    if (table === 'cash_out') {
      const row = repo.contract.cashOutServiceId(id);
      if (row && row.contract_service_id != null) {
        const other = repo.contract.serviceClaimedByOther(row.contract_service_id, id);
        if (other) {
          return res.status(409).json({ error: `Can’t restore — its contract service is now linked to entry #${other.id} (${fmtRs(other.amount_paise)} on ${other.tx_date}). One service can offset only one debit. Unlink it there first, then restore.` });
        }
      }
    }
    TRASH_REPO[table].restore(id);
    res.json({ ok: true });
  });

  localApp.delete('/api/trash/:table/:id', (req, res) => {
    const table = trashTable(req);
    if (!table) return res.status(400).json({ error: 'Unknown table.' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !TRASH_REPO[table].find(id)) return res.status(404).json({ error: 'That deleted item was not found.' });
    if (table === 'contract') {
      const n = repo.contract.paymentsForAny(id);
      if (n > 0) {
        return res.status(409).json({ error: `This contract still has ${n} contractor payment${n === 1 ? '' : 's'} referencing it (live or in the Recycle Bin). Permanently deleting it would orphan ${n === 1 ? 'that payment' : 'those payments'} — delete or restore ${n === 1 ? 'it' : 'them'} first.` });
      }
      // cash_out.contract_service_id has no ON DELETE action, so a contract_services row cascading out
      // from this delete would otherwise throw a raw FK error if any cash-out entry (live or in the
      // Recycle Bin) still references one of this contract's services.
      const m = repo.contract.cashOutReferencingServices(id);
      if (m > 0) {
        return res.status(409).json({ error: `This contract still has ${m} cash-out entr${m === 1 ? 'y' : 'ies'} linked to one of its services (live or in the Recycle Bin). Permanently deleting it would orphan ${m === 1 ? 'that entry' : 'those entries'} — unlink or restore ${m === 1 ? 'it' : 'them'} first.` });
      }
    }
    TRASH_REPO[table].hardDelete(id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Budget + computeOverview() — ported verbatim. This is the money-arithmetic core; nothing here
  // was changed from server.js.
  // ---------------------------------------------------------------------------
  const BUDGET_STMT = db.prepare("SELECT value FROM settings WHERE key = 'budget_paise'");
  function getBudgetPaise() {
    const r = BUDGET_STMT.get();
    if (!r || r.value == null || r.value === '') return null;
    const n = Number(r.value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  localApp.get('/api/budget', (req, res) => { res.json({ budgetPaise: getBudgetPaise() }); });

  localApp.put('/api/budget', (req, res) => {
    const raw = req.body.budgetRupees;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise', NULL) ON CONFLICT(key) DO UPDATE SET value = NULL").run();
      return res.json({ budgetPaise: null });
    }
    const paise = parsePaise(raw);
    if (paise === null) return res.status(400).json({ error: 'Enter a valid budget greater than 0 (up to 2 decimals).' });
    db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(paise));
    res.json({ budgetPaise: paise });
  });

  // Phase 6b — up to 5 daily local-notification times ("HH:MM", 24h), ported verbatim from
  // server.js's identical route. Reuses the old daily_report_times settings key (inert since the
  // Phase 1.3 email-report scheduler was deleted). Scheduling itself is client-side
  // (notifications.js) — this is just persistence, same as budget above.
  const NOTIF_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  function normalizeNotificationTimes(raw) {
    if (!Array.isArray(raw) || raw.length > 5) return null;
    const seen = new Set(); const out = [];
    for (const t of raw) {
      const s = String(t ?? '').trim();
      if (!NOTIF_TIME_RE.test(s)) return null;
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out.sort();
  }
  function getNotificationTimes() {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'daily_report_times'").get();
    if (!r || r.value == null) return [];
    try { return normalizeNotificationTimes(JSON.parse(r.value)) || []; } catch { return []; }
  }

  localApp.get('/api/notification-times', (req, res) => { res.json({ times: getNotificationTimes() }); });

  localApp.put('/api/notification-times', (req, res) => {
    const times = normalizeNotificationTimes(req.body.times);
    if (times === null) return res.status(400).json({ error: 'Send up to 5 unique times as "HH:MM" (24h).' });
    db.prepare("INSERT INTO settings (key, value) VALUES ('daily_report_times', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(times));
    res.json({ times });
  });

  const CUSTOM_GROUP_NAME = 'Custom / Uncategorized';

  function computeOverview(range) {
    const start = (range && range.start) || null;
    const end = (range && range.end) || null;
    const bounded = !!(start || end);
    const lo = start || '0000-01-01', hi = end || '9999-12-31';

    const cum = repo.overview.cashoutCumulative();
    const includedOffset = cum.offset;
    const missingOffset = { count: cum.missCount, amountPaise: cum.missSum };

    const contractRows = repo.overview.contracts();
    const liveContractIds = new Set(contractRows.map((c) => c.id));

    const paidByContract = new Map();
    let cumulativePaid = 0;
    const orphan = { count: 0, amountPaise: 0, contractIds: [] };
    for (const g of repo.overview.paidByContract()) {
      paidByContract.set(g.contract_id, g.s);
      cumulativePaid += g.s;
      if (!liveContractIds.has(g.contract_id)) { orphan.count += g.c; orphan.amountPaise += g.s; orphan.contractIds.push(g.contract_id); }
    }

    let totalContract = 0, owedToContractors = 0;
    const contracts = contractRows.map((c, idx) => {
      const stated = c.price_of_contract_paise || 0;
      const paid = paidByContract.get(c.id) || 0;
      const offset = idx === 0 ? includedOffset : 0;
      const owed = stated - paid - offset;
      totalContract += stated; owedToContractors += owed;
      return {
        id: c.id,
        contractorName: c.contractor_name || '',
        areaOfWork: c.area_of_work || '',
        ledger: c.ledger_code ? ledgerLabel(c.ledger_code, c.subledger_code, c.ledger_custom_name, c.subledger_custom_name) : '',
        statedPaise: stated, paidPaise: paid, offsetPaise: offset, owedPaise: owed,
      };
    });

    const zero = () => ({ totalPaise: 0, userPaise: 0, otherPaise: 0 });
    const add = (o, byType, amt) => { o.totalPaise += amt; if (byType === 'user') o.userPaise += amt; else o.otherPaise += amt; };

    let spentBySelf = 0, paidToContractors = 0, userSpent = 0, otherSpent = 0;
    const ledMap = new Map();
    const rollup = (byType, ledgerCode, subCode, subCustom, amt) => {
      if (byType === 'user') userSpent += amt; else otherSpent += amt;
      const isCustom = ledgerCode === CUSTOM_CODE;
      const key = isCustom ? CUSTOM_CODE : ledgerCode;
      let L = ledMap.get(key);
      if (!L) {
        const meta = isCustom ? null : LEDGER_BY_CODE.get(ledgerCode);
        L = { code: key, name: isCustom ? CUSTOM_GROUP_NAME : (meta ? `${meta.code} ${meta.name}` : ledgerCode), isCustom, ...zero(), subs: new Map(), noSub: zero() };
        ledMap.set(key, L);
      }
      add(L, byType, amt);
      if (subCode) {
        let subKey, subName;
        if (subCode === CUSTOM_CODE) { subName = subCustom || 'Custom sub-ledger'; subKey = 'CUSTOM:' + subName; }
        else {
          const meta = isCustom ? null : LEDGER_BY_CODE.get(ledgerCode);
          const s = meta && meta.subLedgers.find((x) => x.code === subCode);
          subName = s ? `${s.code} ${s.name}` : subCode; subKey = subCode;
        }
        let S = L.subs.get(subKey);
        if (!S) { S = { code: subCode, name: subName, ...zero() }; L.subs.set(subKey, S); }
        add(S, byType, amt);
      } else {
        add(L.noSub, byType, amt);
      }
    };

    const outs = bounded ? repo.overview.outsRange(lo, hi) : repo.overview.outsAll();
    const payments = bounded ? repo.overview.paymentsRange(lo, hi) : repo.overview.paymentsAll();
    for (const r of outs) {
      spentBySelf += r.amount_paise;
      rollup(r.by_type, r.ledger_code, r.subledger_code, r.subledger_custom_name, r.amount_paise);
    }
    for (const p of payments) {
      paidToContractors += p.amount_paise;
      rollup('other', p.ledger_code || CUSTOM_CODE, p.subledger_code, p.subledger_custom_name, p.amount_paise);
    }

    const loanReceived = repo.overview.loansSum().s;
    const totalSpent = paidToContractors + spentBySelf;

    const ledgers = [...ledMap.values()]
      .sort((a, b) => (a.isCustom ? 1 : b.isCustom ? -1 : parseFloat(a.code) - parseFloat(b.code)))
      .map((L) => ({
        code: L.code, name: L.name, isCustom: L.isCustom,
        totalPaise: L.totalPaise, userPaise: L.userPaise, otherPaise: L.otherPaise,
        noSub: L.noSub, subs: [...L.subs.values()],
      }));

    const splitSumsToTotal = userSpent + otherSpent === totalSpent;
    const mainsSumToTotal = ledgers.reduce((a, L) => a + L.totalPaise, 0) === totalSpent;
    const subsSumToMains = ledgers.every((L) => L.subs.reduce((a, s) => a + s.totalPaise, 0) + L.noSub.totalPaise === L.totalPaise);

    const appliedAgainstContract = cumulativePaid + includedOffset;
    const overOffset = { over: totalContract > 0 && appliedAgainstContract > totalContract, contractPaise: totalContract, appliedPaise: appliedAgainstContract, excessPaise: Math.max(0, appliedAgainstContract - totalContract) };

    if (!splitSumsToTotal || !mainsSumToTotal || !subsSumToMains) {
      console.error('Overview reconciliation failed', { splitSumsToTotal, mainsSumToTotal, subsSumToMains });
    }
    if (orphan.count > 0) {
      console.warn(`Overview reconciliation: ${orphan.count} live contractor payment(s) totalling ${orphan.amountPaise} paise reference a soft-deleted or missing contract (contract ids: ${orphan.contractIds.join(', ')}). Counted in B/D/pie but not offset in A/F — figures reported AS-IS, not adjusted. Restore or reassign those payments' contract to rebalance.`);
    }
    if (missingOffset.count > 0) {
      console.warn(`Overview reconciliation: ${missingOffset.count} 'included' debit(s) totalling ${missingOffset.amountPaise} paise have a NULL or zero contract_stated_paise — a reimbursement offset that does nothing (dues don't drop for that spend). Likely a pre-Phase-5 backup import or direct SQL. Set the contract's stated amount on those debits to rebalance. Reported AS-IS.`);
    }
    if (overOffset.over) {
      console.warn(`Overview reconciliation: payments + included offsets (${overOffset.appliedPaise} paise) exceed the contract value (${overOffset.contractPaise} paise) by ${overOffset.excessPaise} paise — over-offset. owed is reported unclamped (negative = overpaid), not adjusted.`);
    }

    return {
      budgetPaise: getBudgetPaise(),
      ledgers,
      money: {
        totalContractPaise: totalContract,
        paidToContractorsPaise: paidToContractors,
        spentBySelfPaise: spentBySelf,
        totalSpentPaise: totalSpent,
        loanReceivedPaise: loanReceived,
        owedToContractorsPaise: owedToContractors,
      },
      contracts,
      upcomingPayments: computeUpcomingPayments(),
      reconciliation: {
        ok: splitSumsToTotal && mainsSumToTotal && subsSumToMains && orphan.count === 0 && missingOffset.count === 0 && !overOffset.over,
        orphanedContractorPayments: orphan,
        includedDebitsMissingOffset: missingOffset,
        overOffset: overOffset,
      },
    };
  }

  const IST_TZ = 'Asia/Kolkata';
  function istDateStamp(d = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TZ }).format(d); }
  function daysBetweenIso(fromIso, toIso) {
    const [ya, ma, da] = fromIso.split('-').map(Number);
    const [yb, mb, db2] = toIso.split('-').map(Number);
    return Math.round((Date.UTC(yb, mb - 1, db2) - Date.UTC(ya, ma - 1, da)) / 86400000);
  }
  function computeUpcomingPayments() {
    const today = istDateStamp();
    const out = [];
    for (const c of repo.contract.list()) {
      for (const d of repo.contract.payDatesFor(c.id)) {
        const daysRemaining = daysBetweenIso(today, d);
        const paidOnDate = repo.contract.paymentOnDate(c.id, d);
        out.push({ date: d, daysRemaining, paidOnDate, possiblyOverdue: daysRemaining < 0 && !paidOnDate });
      }
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  }

  localApp.get('/api/overview', (req, res) => {
    const s = parseIsoDate(req.query.start);
    if (s.error) return res.status(400).json({ error: 'Invalid start date (YYYY-MM-DD).' });
    const e = parseIsoDate(req.query.end);
    if (e.error) return res.status(400).json({ error: 'Invalid end date (YYYY-MM-DD).' });
    if (s.date && e.date && s.date > e.date) return res.status(400).json({ error: 'Start date must be on or before the end date.' });
    res.json(computeOverview({ start: s.date, end: e.date }));
  });

  // ---------------------------------------------------------------------------
  // Overview PDF (Phase 6a) — ported verbatim from server.js: same fmtRs/pdfEsc/PDF_PALETTE/
  // pdfSlices/pdfPieSvg/fmtDatePdf/buildOverviewPdfHtml, same HTML, same layout. Only the render
  // BACKEND differs (the print-adapter plugin's WebView instead of Playwright's).
  // ---------------------------------------------------------------------------
  function fmtRs(paise) {
    const neg = paise < 0; paise = Math.abs(paise);
    const rupees = Math.floor(paise / 100);
    const p = String(paise % 100).padStart(2, '0');
    return (neg ? '-' : '') + '₹' + rupees.toLocaleString('en-IN') + '.' + p;
  }
  const pdfEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Phase 10a: 24 main ledgers now (was 23, and this palette had only 20) — 4 more so no ledger
  // wraps around to reuse an earlier one's colour.
  const PDF_PALETTE = ['#f59e0b', '#fbbf24', '#b45309', '#d97706', '#fcd34d', '#92400e', '#ef8a4b',
    '#eab308', '#a16207', '#f4a06a', '#c2703d', '#facc15', '#7c3f12', '#fdba74', '#9a6a2f', '#e0a800',
    '#ffcf70', '#8a5a2b', '#f6b352', '#6f4518', '#c2410c', '#b45f06', '#7c2d12', '#eab676'];
  // Phase 11 audit: same fix as overview.html's colorByCode / server.js's pdfSlices — a 25th+ main
  // ledger must never wrap back onto an earlier ledger's colour here either. The fixed 24 above are
  // untouched.
  function extraLedgerColor(extraIndex) {
    const hue = (extraIndex * 137.508) % 360;
    return `hsl(${hue.toFixed(1)}, 65%, 50%)`;
  }
  function pdfSlices(o) {
    return (o.ledgers || []).filter((L) => L.totalPaise > 0).map((L) => {
      const idx = Math.max(0, LEDGERS.findIndex((x) => x.code === L.code));
      const color = L.code === CUSTOM_CODE ? '#8a5a2b' : (idx < PDF_PALETTE.length ? PDF_PALETTE[idx] : extraLedgerColor(idx - PDF_PALETTE.length));
      return { label: L.name, value: L.totalPaise, color };
    });
  }
  function pdfPieSvg(slices) {
    const total = slices.reduce((a, s) => a + s.value, 0);
    if (total <= 0) return '<p class="muted">No spending to chart in this range.</p>';
    const cx = 50, cy = 50, r = 46;
    if (slices.length === 1) return `<svg viewBox="0 0 100 100" class="pie"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${slices[0].color}"/></svg>`;
    let a0 = -Math.PI / 2;
    const paths = slices.map((s) => {
      const a1 = a0 + (s.value / total) * Math.PI * 2;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const large = (a1 - a0) > Math.PI ? 1 : 0; a0 = a1;
      return `<path d="M${cx},${cy} L${x0.toFixed(3)},${y0.toFixed(3)} A${r},${r} 0 ${large},1 ${x1.toFixed(3)},${y1.toFixed(3)} Z" fill="${s.color}" stroke="#fff" stroke-width="0.6"/>`;
    }).join('');
    return `<svg viewBox="0 0 100 100" class="pie">${paths}</svg>`;
  }

  function fmtDatePdf(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso == null ? '' : iso));
    return m ? (m[3] + '/' + m[2] + '/' + m[1].slice(2)) : String(iso == null ? '' : iso);
  }
  function buildOverviewPdfHtml(part, o, rows, range, theme) {
    const m = o.money;
    const fmtOwed = (v) => (v < 0 ? 'Overpaid by ' + fmtRs(-v) : fmtRs(v));
    const rangeLabel = (range.start || range.end) ? `${fmtDatePdf(range.start) || '…'} to ${fmtDatePdf(range.end) || '…'}` : 'All transactions';
    const slices = pdfSlices(o);
    const incl = (s) => (s === 'included' ? 'Yes' : 'No');

    const figuresBlock = () => {
      const figs = [
        ['Total contract (A)', m.totalContractPaise], ['Paid to contractors (B)', m.paidToContractorsPaise],
        ['Spent by self (C)', m.spentBySelfPaise], ['Total spent (D)', m.totalSpentPaise],
        ['Loan received (E)', m.loanReceivedPaise], ['Owed to contractors (F)', m.owedToContractorsPaise],
      ];
      return '<h2>Headline figures</h2><div class="figs">' +
        figs.map(([k, v]) => `<div class="fig"><div class="k">${pdfEsc(k)}</div><div class="v ${v < 0 ? 'neg' : ''}">${k.startsWith('Owed') ? fmtOwed(v) : fmtRs(v)}</div></div>`).join('') + '</div>';
    };
    const owedBlock = () => {
      if (!o.contracts.length) return '<h2>Owed on the contract</h2><p class="muted">No contract yet.</p>';
      return '<h2>Owed on the contract</h2><table><thead><tr><th>Contractor</th><th>Area · Ledger</th><th class="num">Stated</th><th class="num">Paid</th><th class="num">Owed</th></tr></thead><tbody>' +
        o.contracts.map((c) => `<tr><td>${pdfEsc(c.contractorName || '—')}</td><td>${pdfEsc([c.areaOfWork, c.ledger].filter(Boolean).join(' · ')) || '—'}</td><td class="num">${fmtRs(c.statedPaise)}</td><td class="num">${fmtRs(c.paidPaise)}</td><td class="num ${c.owedPaise < 0 ? 'neg' : ''}">${fmtOwed(c.owedPaise)}</td></tr>`).join('') +
        `</tbody><tfoot><tr><td colspan="4">Owed to contractors (F)</td><td class="num">${fmtOwed(m.owedToContractorsPaise)}</td></tr></tfoot></table>`;
    };
    const budgetBlock = () => {
      if (o.budgetPaise == null) return '<h2>Budget</h2><p class="muted">No budget set. Total spent (D): <b>' + fmtRs(m.totalSpentPaise) + '</b>.</p>';
      const diff = o.budgetPaise - m.totalSpentPaise;
      return `<h2>Budget vs actual</h2><p>Budget <b>${fmtRs(o.budgetPaise)}</b> · Spent <b>${fmtRs(m.totalSpentPaise)}</b> · ${diff < 0 ? 'Over by <b class="neg">' + fmtRs(-diff) + '</b>' : '<b>' + fmtRs(diff) + '</b> left'}.</p>`;
    };
    const pieBlock = () => {
      if (!slices.length) return '<h2>Spending by Ledger</h2><p class="muted">No spending in this range.</p>';
      return '<h2>Spending by Ledger</h2><div class="pie-wrap">' + pdfPieSvg(slices) +
        '<div class="legend">' + slices.map((s) => `<div class="lg"><span class="sw" style="background:${s.color}"></span><span class="l">${pdfEsc(s.label)}</span><span class="v">${fmtRs(s.value)}</span></div>`).join('') + '</div></div>';
    };
    const ledgerTableBlock = () => {
      if (!slices.length) return '<h2>Spending by Ledger</h2><p class="muted">No spending in this range.</p>';
      return '<h2>Spending by Ledger</h2><table><thead><tr><th>Ledger</th><th class="num">Amount</th></tr></thead><tbody>' +
        slices.map((s) => `<tr><td>${pdfEsc(s.label)}</td><td class="num">${fmtRs(s.value)}</td></tr>`).join('') +
        `</tbody><tfoot><tr><td>Total spent (D)</td><td class="num">${fmtRs(m.totalSpentPaise)}</td></tr></tfoot></table>`;
    };
    const txTableBlock = () => {
      if (!rows.length) return '<h2>Transactions</h2><p class="muted">No outflow entries in this range.</p>';
      const total = rows.reduce((a, e) => a + e.amountPaise, 0);
      return '<h2>Transactions</h2><table><thead><tr><th class="num">#</th><th>Date</th><th class="num">Amount</th><th>By</th><th>Ledger</th><th>Remark</th><th>Contract Included</th><th class="num">Contract Stated</th></tr></thead><tbody>' +
        rows.map((e, i) => `<tr><td class="num">${i + 1}</td><td>${e.txDate ? pdfEsc(fmtDatePdf(e.txDate)) : '—'}</td><td class="num">${fmtRs(e.amountPaise)}</td><td>${pdfEsc(e.by)}</td><td>${pdfEsc(e.ledger)}</td><td>${e.reason ? pdfEsc(e.reason) : '—'}</td><td>${incl(e.contractScope)}</td><td class="num">${e.contractScope === 'included' && e.contractStatedPaise != null ? fmtRs(e.contractStatedPaise) : '—'}</td></tr>`).join('') +
        `</tbody><tfoot><tr><td colspan="2">Total (${rows.length})</td><td class="num">${fmtRs(total)}</td><td colspan="5"></td></tr></tfoot></table>`;
    };

    const TITLE = { full: 'Overview', summary: 'Overview — summary', pie: 'Spending by Ledger — chart', table: 'Transactions', ledger: 'Spending by Ledger' };
    let body;
    if (part === 'pie') body = pieBlock();
    else if (part === 'table') body = txTableBlock();
    else if (part === 'ledger') body = ledgerTableBlock();
    else if (part === 'summary') body = figuresBlock() + owedBlock() + budgetBlock() + pieBlock() + ledgerTableBlock();
    else body = figuresBlock() + owedBlock() + budgetBlock() + pieBlock() + txTableBlock();

    const dark = theme === 'dark';
    const C = dark
      ? { bg: '#15161a', text: '#ececee', sub: '#a9aab0', head: '#f6b352', accent: '#f5b45b', line: '#2c2d33', line2: '#3a3b42', muted: '#9a9ba1', figB: '#3a3020', neg: '#f87171', swB: 'rgba(255,255,255,0.25)' }
      : { bg: '#ffffff', text: '#1a1a1a', sub: '#555555', head: '#7c3f12', accent: '#b45309', line: '#eeeeee', line2: '#dddddd', muted: '#888888', figB: '#eadfce', neg: '#b91c1c', swB: 'rgba(0,0,0,0.15)' };

    return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: ${C.text}; background: ${C.bg}; margin: 0; padding: 6px 2px; font-size: 12px; }
    .hdr { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 2px solid #f59e0b; padding-bottom: 8px; margin-bottom: 16px; }
    .brand { font-size: 22px; font-weight: 800; letter-spacing: 0.02em; color: ${C.text}; }
    .brand span { color: ${C.accent}; }
    .sub { font-size: 12px; color: ${C.sub}; text-align: right; }
    .sub b { color: ${C.text}; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: ${C.head}; border-bottom: 1px solid ${C.line}; padding-bottom: 4px; margin: 20px 0 10px; }
    .figs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .fig { border: 1px solid ${C.figB}; border-radius: 4px; padding: 8px 10px; }
    .fig .k { font-size: 10.5px; color: ${C.muted}; text-transform: uppercase; letter-spacing: 0.04em; }
    .fig .v { font-size: 17px; font-weight: 700; margin-top: 3px; color: ${C.accent}; }
    .fig .v.neg, .neg { color: ${C.neg}; }
    table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
    th, td { text-align: left; padding: 5px 7px; border-bottom: 1px solid ${C.line}; }
    th { text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; color: ${C.muted}; }
    td.num, th.num { text-align: right; white-space: nowrap; }
    tfoot td { font-weight: 700; border-top: 2px solid ${C.line2}; border-bottom: none; }
    .muted { color: ${C.muted}; }
    .pie-wrap { display: flex; gap: 22px; align-items: center; }
    .pie { width: 200px; height: 200px; flex: none; }
    .legend { flex: 1 1 auto; }
    .lg { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 2px 0; }
    .sw { width: 12px; height: 12px; flex: none; border: 1px solid ${C.swB}; }
    .lg .l { flex: 1 1 auto; }
    .lg .v { font-weight: 600; white-space: nowrap; }
  </style></head><body>
    <div class="hdr">
      <div class="brand">Plann<span>r</span></div>
      <div class="sub">${pdfEsc(TITLE[part] || 'Overview')}<br>Date range: <b>${pdfEsc(rangeLabel)}</b></div>
    </div>
    ${body}
  </body></html>`;
  }

  function base64ToBytes(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Phase 6a follow-up — the print-adapter plugin's native call has no cancel API and, if the hidden
  // WebView it spins up never fires onPageFinished/onLayout, its PluginCall promise simply never
  // settles: no throw, no reject, nothing for a try/catch to catch. Without this, that hang is
  // indistinguishable from "nothing happened" — exactly the silent failure reported on-device. This
  // turns an infinite silent wait into a real, visible error after a bounded time.
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — the native print adapter did not respond.`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  localApp.get('/api/overview/pdf', async (req, res) => {
    const s = parseIsoDate(req.query.start); if (s.error) return res.status(400).json({ error: 'Invalid start date (YYYY-MM-DD).' });
    const e = parseIsoDate(req.query.end); if (e.error) return res.status(400).json({ error: 'Invalid end date (YYYY-MM-DD).' });
    if (s.date && e.date && s.date > e.date) return res.status(400).json({ error: 'Start date must be on or before the end date.' });
    const part = ['full', 'pie', 'table', 'ledger'].includes(String(req.query.part)) ? String(req.query.part) : 'full';
    const theme = String(req.query.theme) === 'dark' ? 'dark' : 'light';

    if (!Capacitor.isNativePlatform()) {
      return res.status(503).json({ error: 'PDF export needs the Android app — this browser preview cannot generate one.' });
    }
    if (!Capacitor.isPluginAvailable('PdfGenerator')) {
      // Distinguishes "isNativePlatform() is true but the plugin never registered" from every other
      // failure mode below — a real possibility the on-screen message must be able to name outright.
      return res.status(500).json({ error: `PDF export: the PdfGenerator plugin is not available on this platform (${Capacitor.getPlatform()}). It may not have registered correctly.` });
    }

    const range = { start: s.date, end: e.date };
    const inR = (d) => { if (!range.start && !range.end) return true; if (d == null) return false; if (range.start && d < range.start) return false; if (range.end && d > range.end) return false; return true; };
    const o = computeOverview(range);
    const rows = LEDGER_CRUDS.cash_out.list().map(cashOutRow).filter((r) => inR(r.txDate));
    const html = buildOverviewPdfHtml(part, o, rows, range, theme);

    try {
      const result = await withTimeout(
        PdfGenerator.fromData({ data: html, type: 'base64', documentSize: 'A4', fileName: `plannr-overview-${part}.pdf` }),
        25000,
        'PDF generation'
      );
      if (!result || result.type !== 'base64' || !result.base64) {
        return res.status(500).json({ error: 'PDF generation returned an unexpected result: ' + JSON.stringify(result) });
      }
      res.send(base64ToBytes(result.base64));
    } catch (err) {
      console.error('PDF generation failed:', err);
      res.status(500).json({ error: 'Could not generate the PDF: ' + (err && err.message ? err.message : String(err)) });
    }
  });

  // ---------------------------------------------------------------------------
  // Data backup — ported from server.js, with ONE necessary change: the pre-import safety snapshot
  // can't be written to disk beside the DB file (no such filesystem access here), so it's offered as
  // a browser download instead (same download-a-Blob technique data-backup.html already uses for the
  // manual JSON/CSV exports). `data.snapshot` becomes a human-readable description rather than a file
  // path — data-backup.html's existing message ("A safety copy of your previous data was saved to
  // " + data.snapshot) still reads correctly either way. Everything else — validateBackup, the
  // teardown/replace transaction, the by_user_id remap, storage-full handling — is unchanged.
  // ---------------------------------------------------------------------------
  const BACKUP_SCHEMA_VERSION = 1;
  const BACKUP_TABLES = ['contract', 'contract_services', 'contract_payment_dates', 'contractor_payments', 'loans', 'settings', 'cash_in', 'cash_out'];
  const IMPORT_OWNED_TABLES = ['cash_out', 'contract_services', 'contract_payment_dates', 'contractor_payments', 'contract', 'cash_in', 'loans', 'settings'];
  const BACKUP_COLS = {
    contract: ['id', 'contractor_name', 'area_of_work', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'amount_paise', 'price_of_contract_paise', 'contract_end_date', 'date_signed', 'company', 'created_at', 'updated_at', 'deleted_at'],
    contract_services: ['id', 'contract_id', 'name', 'price_paise', 'created_at', 'updated_at', 'deleted_at'],
    contract_payment_dates: ['id', 'contract_id', 'pay_date', 'created_at'],
    contractor_payments: ['id', 'contract_id', 'pay_date', 'amount_paise', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'remarks', 'created_at', 'updated_at', 'deleted_at'],
    loans: ['id', 'amount_paise', 'bank_name', 'interest_rate', 'tenure', 'created_at', 'updated_at', 'deleted_at'],
    settings: ['key', 'value'],
    cash_in: ['id', 'amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'reason', 'created_at', 'updated_at', 'deleted_at'],
    cash_out: ['id', 'amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'reason', 'contract_scope', 'contract_stated_paise', 'contract_service_id', 'created_at', 'updated_at', 'deleted_at'],
  };
  const CONTACT_SETTINGS_KEYS = ['daily_report_recipients', 'daily_report_whatsapp'];

  function assertImportOwnershipComplete() {
    const owned = new Set(IMPORT_OWNED_TABLES);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    const offenders = [];
    for (const t of tables) {
      for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all()) {
        if (owned.has(fk.table) && !owned.has(t)) offenders.push(`${t}.${fk.from} -> ${fk.table}(${fk.to})`);
      }
    }
    if (offenders.length) {
      throw new Error(
        'IMPORT_OWNED_TABLES is incomplete — these tables have a foreign key into an import-owned table but ' +
        'are not themselves owned, so a backup import would clear their parent and cascade/orphan them ' +
        'silently: ' + offenders.join('; ') + '. Add them to IMPORT_OWNED_TABLES (children-first).'
      );
    }
  }
  assertImportOwnershipComplete();

  function buildBackup({ includeContacts = false } = {}) {
    const tables = {};
    for (const t of BACKUP_TABLES) tables[t] = repo.backup.exportTable(t);
    if (!includeContacts) tables.settings = tables.settings.filter((r) => !CONTACT_SETTINGS_KEYS.includes(r.key));
    return { app: 'plannr', kind: 'plannr-backup', schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: new Date().toISOString(), tables };
  }

  function validateBackup(data) {
    const isInt = (v) => Number.isInteger(v);
    const optInt = (v) => v == null || Number.isInteger(v);
    const optStr = (v) => v == null || typeof v === 'string';
    const optNum = (v) => v == null || (typeof v === 'number' && Number.isFinite(v));

    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'This is not a valid Plannr backup file.' };
    if (data.schemaVersion !== BACKUP_SCHEMA_VERSION) return { error: `Unsupported backup version (found ${JSON.stringify(data.schemaVersion)}; this app restores version ${BACKUP_SCHEMA_VERSION}).` };
    const T = data.tables;
    if (!T || typeof T !== 'object') return { error: 'Backup is missing its "tables" section.' };
    for (const t of BACKUP_TABLES) {
      if ((t === 'contract_payment_dates' || t === 'contractor_payments' || t === 'contract_services') && T[t] === undefined) continue;
      if (!Array.isArray(T[t])) return { error: `Backup is missing or has an invalid "${t}" table.` };
    }

    const contractIds = new Set();
    for (const r of T.contract) {
      if (!isInt(r.id)) return { error: 'contract: a row has a non-integer id.' };
      if (!optInt(r.amount_paise)) return { error: 'contract: amount_paise must be integer paise or null.' };
      if (!optInt(r.price_of_contract_paise)) return { error: 'contract: price_of_contract_paise must be integer paise or null.' };
      if (!optStr(r.area_of_work)) return { error: 'contract: area_of_work must be a string or null.' };
      if (!(r.ledger_code == null || r.ledger_code === CUSTOM_CODE || LEDGER_BY_CODE.has(r.ledger_code))) return { error: `contract: unknown ledger_code ${JSON.stringify(r.ledger_code)}.` };
      if (!(r.subledger_code == null || r.subledger_code === CUSTOM_CODE || (r.ledger_code != null && subBelongs(r.ledger_code, r.subledger_code)))) return { error: `contract: subledger_code ${JSON.stringify(r.subledger_code)} does not belong to ledger ${JSON.stringify(r.ledger_code)}.` };
      { const d = parseIsoDate(r.date_signed); if (!(r.date_signed == null || (!d.error && d.date))) return { error: `contract: date_signed must be ISO YYYY-MM-DD or null (got ${JSON.stringify(r.date_signed)}).` }; }
      { const d = parseIsoDate(r.contract_end_date); if (!(r.contract_end_date == null || (!d.error && d.date))) return { error: `contract: contract_end_date must be ISO YYYY-MM-DD or null (got ${JSON.stringify(r.contract_end_date)}).` }; }
      if (!optStr(r.company)) return { error: 'contract: company must be a string or null.' };
      contractIds.add(r.id);
    }
    const serviceIds = new Set();
    for (const r of (T.contract_services || [])) {
      if (!isInt(r.id)) return { error: 'contract_services: a row has a non-integer id.' };
      if (!isInt(r.contract_id) || !contractIds.has(r.contract_id)) return { error: `contract_services: contract_id ${JSON.stringify(r.contract_id)} is not present in the backup's contracts.` };
      if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'contract_services: name must be a non-empty string.' };
      if (!optInt(r.price_paise)) return { error: 'contract_services: price_paise must be integer paise or null.' };
      serviceIds.add(r.id);
    }
    for (const r of (T.contract_payment_dates || [])) {
      if (!isInt(r.id)) return { error: 'contract_payment_dates: a row has a non-integer id.' };
      if (!isInt(r.contract_id) || !contractIds.has(r.contract_id)) return { error: `contract_payment_dates: contract_id ${JSON.stringify(r.contract_id)} is not present in the backup's contracts.` };
      { const d = parseIsoDate(r.pay_date); if (d.error || !d.date) return { error: `contract_payment_dates: pay_date must be ISO YYYY-MM-DD (got ${JSON.stringify(r.pay_date)}).` }; }
    }
    for (const r of (T.contractor_payments || [])) {
      if (!isInt(r.id)) return { error: 'contractor_payments: a row has a non-integer id.' };
      if (!isInt(r.contract_id) || !contractIds.has(r.contract_id)) return { error: `contractor_payments: contract_id ${JSON.stringify(r.contract_id)} is not present in the backup's contracts.` };
      { const d = parseIsoDate(r.pay_date); if (d.error || !d.date) return { error: `contractor_payments: pay_date must be ISO YYYY-MM-DD (got ${JSON.stringify(r.pay_date)}).` }; }
      if (!isInt(r.amount_paise) || r.amount_paise <= 0) return { error: 'contractor_payments: amount_paise must be a positive integer (paise).' };
      if (!(r.ledger_code == null || r.ledger_code === CUSTOM_CODE || LEDGER_BY_CODE.has(r.ledger_code))) return { error: `contractor_payments: unknown ledger_code ${JSON.stringify(r.ledger_code)}.` };
      if (!(r.subledger_code == null || r.subledger_code === CUSTOM_CODE || (r.ledger_code != null && subBelongs(r.ledger_code, r.subledger_code)))) return { error: `contractor_payments: subledger_code ${JSON.stringify(r.subledger_code)} does not belong to ledger ${JSON.stringify(r.ledger_code)}.` };
    }
    for (const r of T.loans) {
      if (!isInt(r.id)) return { error: 'loans: a row has a non-integer id.' };
      if (!optInt(r.amount_paise)) return { error: 'loans: amount_paise must be integer paise or null.' };
      if (!optNum(r.interest_rate)) return { error: 'loans: interest_rate must be a number or null.' };
    }
    for (const r of T.settings) {
      if (typeof r.key !== 'string') return { error: 'settings: a row has a non-string key.' };
      if (!optStr(r.value)) return { error: 'settings: value must be a string or null.' };
    }
    for (const r of T.cash_in) {
      if (!isInt(r.id)) return { error: 'cash_in: a row has a non-integer id.' };
      if (!isInt(r.amount_paise) || r.amount_paise <= 0) return { error: 'cash_in: amount_paise must be a positive integer (paise).' };
      if (!['user', 'relative', 'custom'].includes(r.by_type)) return { error: `cash_in: invalid by_type ${JSON.stringify(r.by_type)}.` };
      if (!optInt(r.by_user_id)) return { error: 'cash_in: by_user_id must be an integer or null.' };
      { const d = parseIsoDate(r.tx_date); if (!(r.tx_date == null || (!d.error && d.date))) return { error: `cash_in: tx_date must be an ISO YYYY-MM-DD date or null (got ${JSON.stringify(r.tx_date)}).` }; }
    }
    for (const r of T.cash_out) {
      if (!isInt(r.id)) return { error: 'cash_out: a row has a non-integer id.' };
      if (!isInt(r.amount_paise) || r.amount_paise <= 0) return { error: 'cash_out: amount_paise must be a positive integer (paise).' };
      { const d = parseIsoDate(r.tx_date); if (!(r.tx_date == null || (!d.error && d.date))) return { error: `cash_out: tx_date must be an ISO YYYY-MM-DD date or null (got ${JSON.stringify(r.tx_date)}).` }; }
      if (!['user', 'contractor', 'custom'].includes(r.by_type)) return { error: `cash_out: invalid by_type ${JSON.stringify(r.by_type)}.` };
      if (!optInt(r.by_user_id)) return { error: 'cash_out: by_user_id must be an integer or null.' };
      if (!(r.ledger_code === CUSTOM_CODE || LEDGER_BY_CODE.has(r.ledger_code))) return { error: `cash_out: unknown ledger_code ${JSON.stringify(r.ledger_code)}.` };
      if (!(r.subledger_code == null || r.subledger_code === CUSTOM_CODE || subBelongs(r.ledger_code, r.subledger_code))) return { error: `cash_out: subledger_code ${JSON.stringify(r.subledger_code)} does not belong to ledger ${JSON.stringify(r.ledger_code)}.` };
      if (!['included', 'extra'].includes(r.contract_scope)) return { error: `cash_out: invalid contract_scope ${JSON.stringify(r.contract_scope)}.` };
      if (!optInt(r.contract_stated_paise)) return { error: 'cash_out: contract_stated_paise must be an integer (paise) or null.' };
      if (!(r.contract_service_id == null || (isInt(r.contract_service_id) && serviceIds.has(r.contract_service_id)))) return { error: `cash_out: contract_service_id ${JSON.stringify(r.contract_service_id)} is not present in the backup's contract_services.` };
    }
    return { ok: true };
  }

  localApp.get('/api/backup/export', (req, res) => {
    const includeContacts = req.query.includeContacts === '1';
    const backup = buildBackup({ includeContacts });
    res.json(backup);
  });

  // Design decision (flagged): server.js writes the pre-import safety snapshot to a file beside the
  // DB (fs.writeFileSync). There is no such filesystem here, so this triggers a browser download of
  // the same JSON instead — the user ends up with the identical safety net (a file they can restore
  // from), just delivered as a download rather than a silent server-side write.
  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  localApp.post('/api/backup/import', (req, res) => {
    const v = validateBackup(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const T = req.body.tables;

    let snapshot;
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `plannr-safety-snapshot-${stamp}.json`;
      downloadJson(filename, buildBackup({ includeContacts: true }));
      snapshot = `a downloaded file (${filename})`;
    } catch (e) {
      console.error('Backup snapshot failed:', e);
      return res.status(500).json({ error: 'Could not write the safety snapshot, so the import was aborted — your current data is unchanged.' });
    }

    const userIds = new Set(db.prepare('SELECT id FROM users').all().map((u) => u.id));
    let remappedUsers = 0;
    const existingTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));

    db.exec('BEGIN');
    try {
      for (const t of IMPORT_OWNED_TABLES) { if (t === 'settings') continue; if (existingTables.has(t)) repo.backup.deleteTenantRows(t); }

      for (const t of BACKUP_TABLES) {
        if (t === 'settings') {
          for (const r of (T.settings || [])) repo.backup.upsertSetting(r.key, r.value === undefined ? null : r.value);
          continue;
        }
        const cols = BACKUP_COLS[t];
        for (const r of (T[t] || [])) {
          const vals = cols.map((col) => {
            let val = r[col];
            if (col === 'by_user_id' && val != null && !userIds.has(val)) { val = null; remappedUsers++; }
            return val === undefined ? null : val;
          });
          repo.backup.insertRow(t, cols, vals);
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error('Backup import failed, rolled back:', e);
      if (isStorageFullError(e)) return res.status(500).json({ error: 'Storage is full — the import did not go through. Free up space, then try again.', snapshot });
      return res.status(500).json({ error: 'The import failed and was rolled back — your current data is unchanged. The file may be internally inconsistent.', snapshot });
    }

    const imported = {};
    for (const t of BACKUP_TABLES) imported[t] = (T[t] || []).length;
    res.json({ ok: true, imported, remappedUsers, snapshot });
  });

  // ---------------------------------------------------------------------------
  // Phase 7 — encrypted full-snapshot backup. A different thing from the plain-JSON export/import
  // above: this is the WHOLE database (every table, users/sessions included), byte-for-byte, the
  // local-mode equivalent of backup-db.js's VACUUM INTO + backup-crypto.js encryption. The body carries
  // the encrypted bytes as base64 (this is an in-process call through the fetch shim, not a real HTTP
  // request, so there's no size pressure that would justify anything fancier than JSON + base64).
  // ---------------------------------------------------------------------------
  localApp.post('/api/backup/export-encrypted', async (req, res) => {
    const passphrase = typeof req.body.passphrase === 'string' ? req.body.passphrase : '';
    if (!passphrase) return res.status(400).json({ error: 'Enter a passphrase to encrypt this backup.' });
    try {
      const plain = exportSnapshotBytes();
      const enc = await encrypt(plain, passphrase);
      res.send(enc);
    } catch (e) {
      console.error('Encrypted export failed:', e);
      res.status(500).json({ error: 'Could not build the encrypted backup: ' + e.message });
    }
  });

  localApp.post('/api/backup/import-encrypted', async (req, res) => {
    const passphrase = typeof req.body.passphrase === 'string' ? req.body.passphrase : '';
    const dataBase64 = typeof req.body.dataBase64 === 'string' ? req.body.dataBase64 : '';
    if (!passphrase) return res.status(400).json({ error: 'Enter the passphrase this backup was encrypted with.' });
    if (!dataBase64) return res.status(400).json({ error: 'Choose an encrypted backup file first.' });

    let encBytes;
    try {
      const binary = atob(dataBase64);
      encBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) encBytes[i] = binary.charCodeAt(i);
    } catch {
      return res.status(400).json({ error: 'That file could not be read — choose a Plannr encrypted backup (.db.enc).' });
    }

    let plain;
    try {
      plain = await decrypt(encBytes, passphrase);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (!looksLikeSqlite(plain)) {
      return res.status(400).json({ error: 'Decryption succeeded but the result does not look like a SQLite database — the file may be corrupt.' });
    }

    try {
      await restoreSnapshotBytes(plain);
    } catch (e) {
      console.error('Encrypted import failed:', e);
      if (isStorageFullError(e)) return res.status(500).json({ error: 'Storage is full — the restore did not go through. Free up space, then try again.' });
      return res.status(500).json({ error: 'Restore failed partway through: ' + e.message + ' Reload the page to see the current state before continuing.' });
    }
    res.json({ ok: true });
  });

  repo.configure({ contractCols: CONTRACT_COLS, backupTables: BACKUP_TABLES, backupCols: BACKUP_COLS });

  // ---------------------------------------------------------------------------
  // The fetch shim itself. Only /api/* is intercepted; everything else (styles.css, plannr-ui.js,
  // the page HTML itself) goes through <script src>/<link href>, never window.fetch, so there is
  // nothing else to pass through in practice — but a non-/api/ fetch is forwarded to the real fetch
  // defensively rather than swallowed.
  // ---------------------------------------------------------------------------
  function toResponse(res) {
    const status = res.statusCode;
    const ok = status >= 200 && status < 300;
    const isBlob = res._kind === 'raw';
    return {
      ok, status,
      async json() { return isBlob ? JSON.parse(res._body) : res._body; },
      async blob() { return isBlob ? new Blob([res._body]) : new Blob([JSON.stringify(res._body)], { type: 'application/json' }); },
      async text() { return isBlob ? String(res._body) : JSON.stringify(res._body); },
    };
  }

  window.fetch = async function (input, init) {
    const rawUrl = typeof input === 'string' ? input : input.url;
    if (!rawUrl.startsWith('/api/')) return originalFetch(input, init);
    const method = ((init && init.method) || 'GET').toUpperCase();
    const u = new URL(rawUrl, window.location.origin);
    const pathname = u.pathname;
    const query = Object.fromEntries(u.searchParams);
    let body = {};
    if (init && init.body) { try { body = JSON.parse(init.body); } catch { body = {}; } }

    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
      const req = { params, query, body };
      const res = new Res();
      try {
        await r.handler(req, res); // handlers may be sync or async (Phase 7's encrypted backup routes are async)
      } catch (e) {
        console.error('local-api handler error:', e);
        res.status(500).json({ error: 'Something went wrong.' });
      }
      return toResponse(res);
    }
    return toResponse(new Res().status(404).json({ error: `Not found (local mode): ${method} ${pathname}` }));
  };
}
