// Cross-platform plan, step 1.3 — cash in, loans and cash out: their validation, row shapes and
// routes (each table's list/add/edit/delete, and cash out's Save All batch, through makeLedgerCrud
// from core/ledger-crud.js). The only copy: server.js and public/local-api.js both call
// register(app, ctx) and get back the helpers their remaining routes still use (contracts, the
// Recycle Bin, the overview and the PDF). See core/routes/people.js for what `app` and `ctx` are.
import { str, parsePaise, parseIsoDate, fmtRs } from '../parsers.js';

export function register(app, ctx) {
  const { repo, userExists, ledgerIndex, makeLedgerCrud } = ctx;

  const CASH_IN_BY_TYPES = new Set(['user', 'relative', 'custom']);
  const REASON_MAX = 300;
  const LABEL_MAX = 60;

  // Validate/resolve the "By" attribution from a request body. `existingByUserId` is the row's
  // stored by_user_id on EDIT (the PUT path passes it); undefined on CREATE.
  // -> { byType, byUserId, byLabel }  or  { error }.
  async function resolveBy(body, existingByUserId) {
    const byType = str(body.byType);
    if (!CASH_IN_BY_TYPES.has(byType)) return { error: 'Select who the money is from.' };
    if (byType === 'user') {
      // "By" records who PAID, not who entered the row — a shared, multi-user ledger — so any
      // real user is valid (create AND edit). Accept any existing by_user_id; reject unknowns.
      const id = Number(body.byUserId);
      if (Number.isInteger(id) && await userExists(id)) return { byType, byUserId: id, byLabel: null };
      // Edit round-trip: an already-NULL attribution (backup-import remap of an unknown user)
      // must stay editable — preserve NULL when the stored value is already NULL and this edit
      // carries no real id. Create stays strict (existingByUserId is undefined there).
      if (existingByUserId === null && body.byUserId == null) return { byType, byUserId: null, byLabel: null };
      return { error: 'The selected user does not exist.' };
    }
    if (byType === 'relative') {
      return { byType, byUserId: null, byLabel: (str(body.byLabel) || 'Relative').slice(0, LABEL_MAX) };
    }
    const label = str(body.byLabel); // custom
    if (!label) return { error: 'Enter a name for the custom source.' };
    return { byType, byUserId: null, byLabel: label.slice(0, LABEL_MAX) };
  }

  const CASH_IN_SELECT =
    `SELECT c.id, c.amount_paise, c.tx_date, c.by_type, c.by_user_id, c.by_label, c.reason, c.created_at,
            u.display_name AS user_display_name
       FROM cash_in c
       LEFT JOIN users u ON u.id = c.by_user_id`;

  // Shape a joined cash_in row into the API response object (amount in paise).
  function cashInRow(r) {
    return {
      id: r.id,
      amountPaise: r.amount_paise,
      txDate: r.tx_date,   // Phase 4C: user-chosen inflow date, ISO 'YYYY-MM-DD' (may be null on legacy rows)
      byType: r.by_type,
      byUserId: r.by_user_id,
      byLabel: r.by_label,
      by: r.by_type === 'user' ? (r.user_display_name || 'Unknown') : (r.by_label || ''),
      reason: r.reason || '',
      createdAt: r.created_at,
    };
  }

  // Cash Inflow CRUD (cash_in) — shapes/strings preserved exactly via makeLedgerCrud.
  makeLedgerCrud({
    basePath: '/api/cash-in',
    auditField: 'by_user_id', // Phase 2: log who-paid changes on edit
    table: 'cash_in',
    alias: 'c', // the table alias used in CASH_IN_SELECT
    select: CASH_IN_SELECT,
    listWhere: 'WHERE c.deleted_at IS NULL ORDER BY c.id ASC',
    byIdWhere: 'WHERE c.id = ?',
    shape: cashInRow,
    columns: ['amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'reason'],
    validate: async (req, existingByUserId) => {
      const amountPaise = parsePaise(req.body.amountRupees);
      if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };
      // Phase 4C — inflow date REQUIRED on new writes (ISO 'YYYY-MM-DD'), same rule as cash_out.tx_date.
      const txd = parseIsoDate(req.body.txDate);
      if (txd.error || !txd.date) return { error: 'Enter a valid date (YYYY-MM-DD).' };
      const by = await resolveBy(req.body, existingByUserId);
      if (by.error) return { error: by.error };
      return { values: { amount_paise: amountPaise, tx_date: txd.date, by_type: by.byType, by_user_id: by.byUserId, by_label: by.byLabel, reason: str(req.body.reason).slice(0, REASON_MAX) } };
    },
    listKey: 'entries',
    itemKey: 'entry',
    notFoundMsg: 'Entry not found.',
    invalidIdMsg: 'Invalid entry id.',
  });

  // ---------------------------------------------------------------------------
  // Loan Details API (loans). Logged-in only. Loan interest lives ONLY here (a
  // plain rate on the loan) — never a ledger line. Money is INTEGER paise.
  // ---------------------------------------------------------------------------
  const BANK_MAX = 100;
  const TENURE_MAX = 60;

  // Optional non-negative interest rate (a plain number like 8.5, not money).
  // -> { rate: number|null } or { error }.
  function parseRate(v) {
    const s = String(v == null ? '' : v).trim();
    if (s === '') return { rate: null }; // optional
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
      interestRate: r.interest_rate, // number or null
      tenure: r.tenure || '',
      createdAt: r.created_at,
    };
  }

  // Validate the shared loan fields from a request body.
  // -> { amountPaise, bankName, rate, tenure } or { error }.
  function readLoanBody(body) {
    const amountPaise = parsePaise(body.amountRupees);
    if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };
    const bankName = str(body.bankName);
    if (!bankName) return { error: 'Bank name is required.' };
    const rate = parseRate(body.interestRate);
    if (rate.error) return { error: rate.error };
    return { amountPaise, bankName: bankName.slice(0, BANK_MAX), rate: rate.rate, tenure: str(body.tenure).slice(0, TENURE_MAX) };
  }

  // Loan Details CRUD (loans) — shapes/strings preserved exactly via makeLedgerCrud.
  makeLedgerCrud({
    basePath: '/api/loans',
    table: 'loans',
    alias: '', // LOANS_SELECT has no table alias
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

  // ---------------------------------------------------------------------------
  // Cash Outflow API (cash_out) — money debited. Same CRUD conventions as
  // cash_in/loans (makeLedgerCrud). Adds ledger/sub-ledger validation against the
  // single-source ledgers.js, and a contract_scope. Money is INTEGER paise.
  // ---------------------------------------------------------------------------
  const CASH_OUT_BY_TYPES = new Set(['user', 'custom']); // Phase 1: 'contractor' removed (moves to a later Contractor Payments phase)
  const CONTRACT_SCOPES = new Set(['included', 'extra']);
  // Sentinel stored in ledger_code / subledger_code when the user typed a custom
  // ledger or sub-ledger (the typed text goes in ledger_custom_name / subledger_
  // custom_name). NOTE for a future Overview phase: ledger_code === CUSTOM_CODE is
  // the grouping key — all custom entries roll up under one "Custom / Uncategorized".
  const CUSTOM_CODE = 'CUSTOM';
  const CUSTOM_NAME_MAX = 80;

  const subBelongs = (ledgerCode, subCode) => {
    const l = ledgerIndex.byCode().get(ledgerCode);
    return !!l && l.subLedgers.some((s) => s.code === subCode);
  };
  // Human-readable "code name" for a row — resolves all four cases (fixed/custom
  // ledger × fixed/custom/none sub). Shows the sub if one is chosen, else the ledger.
  function ledgerLabel(ledgerCode, subCode, ledgerCustom, subCustom) {
    if (subCode === CUSTOM_CODE) return subCustom || '';        // custom sub -> typed name
    if (subCode) {                                              // fixed sub -> "code name"
      const l = ledgerIndex.byCode().get(ledgerCode);
      const s = l && l.subLedgers.find((x) => x.code === subCode);
      if (s) return `${s.code} ${s.name}`;
    }
    if (ledgerCode === CUSTOM_CODE) return ledgerCustom || '';  // custom ledger, no sub -> typed name
    const l = ledgerIndex.byCode().get(ledgerCode);                   // fixed ledger, no sub -> "code name"
    return l ? `${l.code} ${l.name}` : (ledgerCode || '');
  }

  // An optional link to another row (a service, an allowance) -> { id } or { error }.
  // id is undefined when the key is absent (keep the existing link), null when blank (clear it),
  // otherwise a positive whole number.
  function readOptionalLinkId(body, key, message) {
    if (!(key in body)) return { id: undefined };
    const raw = body[key];
    if (raw == null || raw === '') return { id: null };
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return { error: message };
    return { id: n };
  }

  // Shared ledger + sub-ledger resolution/validation from a request body. The SINGLE
  // source of ledger rules — used by cash_out and the contractor-payments ledger tag so
  // they accept the same dropdown + 'CUSTOM' inputs with identical error strings. Returns
  // { ledgerCode, subledgerCode, ledgerCustomName, subledgerCustomName } or { error }.
  function resolveLedger(body) {
    // Ledger: a real fixed code, or the CUSTOM sentinel with a typed name.
    const ledgerCode = str(body.ledgerCode);
    let ledgerCustomName = null;
    if (ledgerCode === CUSTOM_CODE) {
      ledgerCustomName = str(body.ledgerCustomName);
      if (!ledgerCustomName) return { error: 'Enter a name for the custom ledger.' };
      ledgerCustomName = ledgerCustomName.slice(0, CUSTOM_NAME_MAX);
    } else if (!ledgerIndex.byCode().has(ledgerCode)) {
      return { error: 'Select a valid ledger.' };
    }

    // Sub-ledger (optional): none, a real code (fixed ledger only, must belong),
    // or the CUSTOM sentinel with a typed name.
    let subledgerCode = str(body.subledgerCode);
    let subledgerCustomName = null;
    if (!subledgerCode) {
      subledgerCode = null; // — none —
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

  // "By" for outflow: {user, custom} only. Phase 1 removed 'contractor' — contractor
  // spending is no longer recorded as an outflow (a later phase adds a dedicated tab).
  // A NEW write with by_type='contractor' is rejected with a clear 400; existing legacy
  // 'contractor' rows are left untouched in the DB (this function never rewrites them).
  async function resolveCashOutBy(body, existingByUserId) {
    const byType = str(body.byType);
    if (byType === 'contractor') return { error: 'Contractor spending is no longer recorded as an outflow.' };
    if (!CASH_OUT_BY_TYPES.has(byType)) return { error: 'Select who the money is from.' };
    if (byType === 'user') {
      // "By" records who PAID, not who entered the row — shared ledger, so any real user is a
      // valid attribution (create AND edit). Accept any existing by_user_id; reject unknowns.
      const id = Number(body.byUserId);
      if (Number.isInteger(id) && await userExists(id)) return { byType, byUserId: id, byLabel: null };
      // Edit round-trip: preserve an already-NULL attribution (import remap of an unknown user)
      // so its other fields stay editable. Create stays strict (existingByUserId undefined there).
      if (existingByUserId === null && body.byUserId == null) return { byType, byUserId: null, byLabel: null };
      return { error: 'The selected user does not exist.' };
    }
    const label = str(body.byLabel); // custom
    if (!label) return { error: 'Enter a name for the custom source.' };
    return { byType, byUserId: null, byLabel: label.slice(0, LABEL_MAX) };
  }

  const CASH_OUT_SELECT =
    `SELECT c.id, c.amount_paise, c.tx_date, c.by_type, c.by_user_id, c.by_label, c.ledger_code,
            c.subledger_code, c.ledger_custom_name, c.subledger_custom_name, c.reason,
            c.contract_scope, c.contract_stated_paise, c.contract_service_id, c.contract_allowance_id, c.created_at,
            u.display_name AS user_display_name
       FROM cash_out c
       LEFT JOIN users u ON u.id = c.by_user_id`;

  function cashOutRow(r) {
    return {
      id: r.id,
      amountPaise: r.amount_paise,
      txDate: r.tx_date,    // user-chosen transaction date, ISO 'YYYY-MM-DD' (may be null on legacy rows)
      byType: r.by_type,
      byUserId: r.by_user_id,
      byLabel: r.by_label,
      by: r.by_type === 'user' ? (r.user_display_name || 'Unknown') : (r.by_label || ''),
      ledgerCode: r.ledger_code,
      subledgerCode: r.subledger_code,
      ledgerCustomName: r.ledger_custom_name,
      subledgerCustomName: r.subledger_custom_name,
      ledger: ledgerLabel(r.ledger_code, r.subledger_code, r.ledger_custom_name, r.subledger_custom_name), // resolved (fixed or custom)
      reason: r.reason || '',
      contractScope: r.contract_scope,
      contractStatedPaise: r.contract_stated_paise, // LEGACY (Phase 5E offset). No longer written or used in any maths.
      contractServiceId: r.contract_service_id,     // Services phase: the linked service (provenance), or null
      contractAllowanceId: r.contract_allowance_id, // Contract Phase A: the allowance this spend draws against, or null
      createdAt: r.created_at,
    };
  }

  // Services phase (Part E) — remember a typed custom LEDGER name in the caller's per-user list, so it is
  // selectable next time. INSERT OR IGNORE keys on idx_ledger_customs_tenant_name (no duplicates). Called
  // via afterWrite only when the row actually uses a custom ledger; a built-in ledger saves nothing.
  const saveLedgerCustom = async (values) => {
    if (values.ledger_code === CUSTOM_CODE && values.ledger_custom_name && values.ledger_custom_name.trim()) {
      await repo.ledgerCustoms.save(values.ledger_custom_name.trim());
    }
  };

  // Resolve + guard the two CONTRACT LINKS a debit can carry: the service it was for (provenance) and
  // the allowance it draws against. Runs AFTER validate, BEFORE the write, so it can MUTATE values and
  // reject with a status. finalize runs with ctx.req present (single POST/PUT + the batch loop pass req).
  //
  // The two links are deliberately NOT symmetrical:
  //   · SERVICE — at most one LIVE debit per service (idx_cash_out_service_live is the DB backstop;
  //     this gives the clean, naming 409). Pure provenance: it moves no figure.
  //     Contract Phase A removed the "only a PRICED service is linkable" rule along with the column —
  //     services carry no price now, so every live service is selectable.
  //   · ALLOWANCE — many debits per allowance, by design. An allowance is a CAP with a RUNNING spend;
  //     a uniqueness rule here would break the feature. It moves no figure either: the cap position is
  //     displayed, and the contract's settlement of an overrun/underrun stays the owner's to make.
  // Async (step 1.4 B11): it reads the contract's services and allowances.
  async function cashOutContractLinksFinalize(values, { existing }) {
    // Only an 'included' debit may carry either link; 'extra' forces both NULL so a stale link can't
    // linger if the scope flips back.
    if (values.contract_scope !== 'included') {
      values.contract_service_id = null;
      values.contract_allowance_id = null;
      return;
    }

    // undefined = the body did not send the key (the editable table doesn't) -> PRESERVE the existing
    // link on edit; on create there is no existing, so it's NULL (manual entry).
    let sid = values.contract_service_id;
    if (sid === undefined) sid = existing ? existing.contract_service_id : null;
    if (sid == null) values.contract_service_id = null;
    else {
      if (!(await repo.contract.serviceLinkable(sid))) return { status: 400, error: 'That contract service was not found — pick a listed service, or leave it blank.' };
      const other = await repo.contract.serviceClaimedByOther(sid, existing ? existing.id : -1);
      if (other) {
        return { status: 409, error: `That service is already linked to entry #${other.id} (${fmtRs(other.amount_paise)} on ${other.tx_date}). One service can be linked to only one entry — unlink it there first, or pick another service.` };
      }
      values.contract_service_id = sid;
    }

    let aid = values.contract_allowance_id;
    if (aid === undefined) aid = existing ? existing.contract_allowance_id : null;
    if (aid == null) { values.contract_allowance_id = null; return; }
    if (!(await repo.contract.allowanceLinkable(aid))) return { status: 400, error: 'That allowance was not found — pick a listed allowance, or leave it blank.' };
    values.contract_allowance_id = aid;
  }

  makeLedgerCrud({
    basePath: '/api/cash-out',
    alias: 'c', // the table alias used in CASH_OUT_SELECT
    batch: true, // Phase 6B: POST /api/cash-out/batch — Save All in one round trip (both pages)
    auditField: 'by_user_id', // Phase 2: log who-paid changes on edit
    finalize: cashOutContractLinksFinalize,              // service link + one-live-debit guard, and the allowance draw
    afterWrite: (values) => saveLedgerCustom(values), // Part E: remember a custom ledger name
    table: 'cash_out',
    select: CASH_OUT_SELECT,
    listWhere: 'WHERE c.deleted_at IS NULL ORDER BY c.id ASC',
    byIdWhere: 'WHERE c.id = ?',
    // Part A — SQL-side search/filter columns (see repo.crud). Text search spans the remark + the two
    // custom names; ledger/sub are equality; date + amount are ranges (sargable, sentinel-padded).
    searchCols: { date: 'tx_date', amount: 'amount_paise', ledger: 'ledger_code', subledger: 'subledger_code', text: ['reason', 'ledger_custom_name', 'subledger_custom_name'] },
    shape: cashOutRow,
    // contract_stated_paise is deliberately ABSENT from this list: new rows get NULL, and an edit of a
    // legacy row leaves its stored value untouched (the column is never in the UPDATE ... SET list).
    columns: ['amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'reason', 'contract_scope', 'contract_service_id', 'contract_allowance_id'],
    validate: async (req, existingByUserId) => {
      const amountPaise = parsePaise(req.body.amountRupees);
      if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };

      // Phase 1: transaction date is REQUIRED (ISO 'YYYY-MM-DD'). Reuse parseIsoDate
      // (also used for the contract end date). Missing -> 400; malformed -> 400.
      const txd = parseIsoDate(req.body.txDate);
      if (txd.error) return { error: txd.error };
      if (!txd.date) return { error: 'Select a date for this entry.' };

      const by = await resolveCashOutBy(req.body, existingByUserId);
      if (by.error) return { error: by.error };

      // Ledger + sub-ledger (fixed-or-CUSTOM) — shared with the standalone ledger picker.
      const led = resolveLedger(req.body);
      if (led.error) return { error: led.error };
      const { ledgerCode, subledgerCode, ledgerCustomName, subledgerCustomName } = led;

      // Contract Included (Yes=included / No=extra) tag. Values unchanged; only the
      // display label changed. It is NOT the removed service-link feature.
      const contractScope = str(req.body.contractScope);
      if (!CONTRACT_SCOPES.has(contractScope)) return { error: 'Select whether the work is included in the contract (Yes or No).' };

      // The Phase 5E reimbursement offset is GONE: contractStatedRupees is no longer read, and
      // contract_stated_paise is no longer written (see the `columns` note above). 'included' is now a
      // purely descriptive label. A body that still sends contractStatedRupees is silently ignored
      // rather than rejected, so an older client / stale tab cannot 400 on an otherwise valid entry.

      // Services phase (Part C/D) — the picked service id, recorded as PROVENANCE (which service this
      // spend was for). Manual entry stays valid: no contractServiceId means no link. undefined (key
      // absent, e.g. the editable table) tells finalize() to PRESERVE the existing link on edit;
      // null/'' clears it; a number is validated + guarded there.
      const service = readOptionalLinkId(req.body, 'contractServiceId', 'Invalid service selection.');
      if (service.error) return { error: service.error };
      const contractServiceId = service.id;

      // Contract Phase A — which allowance cap this spend draws against. Same undefined/null/number
      // convention as the service link above, resolved and validated in finalize().
      const allowance = readOptionalLinkId(req.body, 'contractAllowanceId', 'Invalid allowance selection.');
      if (allowance.error) return { error: allowance.error };
      const contractAllowanceId = allowance.id;

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
          contract_service_id: contractServiceId,     // finalize() resolves/guards this (may be undefined)
          contract_allowance_id: contractAllowanceId, // ditto
        },
      };
    },
    listKey: 'entries',
    itemKey: 'entry',
    notFoundMsg: 'Entry not found.',
    invalidIdMsg: 'Invalid entry id.',
  });

  return { REASON_MAX, CASH_IN_SELECT, cashInRow, LOANS_SELECT, loanRow, CUSTOM_CODE, ledgerLabel, resolveLedger, CASH_OUT_SELECT, cashOutRow };
}
