// Cross-platform plan, step 1.3 — the Contractor Payments API: money paid against the contract,
// one list/add/edit/delete table through makeLedgerCrud (core/ledger-crud.js). The only copy:
// server.js and public/local-api.js both call register(app, ctx) and get back what the Recycle Bin
// still uses. See core/routes/people.js for what `app` and `ctx` are; ledgerLabel, resolveLedger
// and REASON_MAX come from core/routes/cash-and-loans.js.
import { str, parsePaise, parseIsoDate } from '../parsers.js';

export function register(app, ctx) {
  const { repo, makeLedgerCrud, ledgerLabel, resolveLedger, REASON_MAX } = ctx;

  // ---------------------------------------------------------------------------
  // Contractor Payments API (Phase 3). Money PAID to a contractor, each tied to a
  // specific contract. A normal add/edit/soft-delete list via makeLedgerCrud. The
  // ledger fields are an OPTIONAL DISPLAY tag; they do NOT drive dues math — owed is the contract's
  // stated value minus Σ amount_paise of its payments, never a payment's ledger.
  // ---------------------------------------------------------------------------

  // Like resolveLedger, but the ledger is OPTIONAL: an empty ledgerCode -> all NULL
  // (no tag). When a ledger IS chosen the SAME rules/error strings apply (delegates).
  function resolveLedgerOptional(body) {
    if (str(body.ledgerCode) === '') return { ledgerCode: null, subledgerCode: null, ledgerCustomName: null, subledgerCustomName: null };
    return resolveLedger(body);
  }

  // Joined so each payment carries its parent contract's name/area for display.
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
    alias: 'cp', // the table alias used in CONTRACTOR_PAYMENTS_SELECT
    table: 'contractor_payments',
    select: CONTRACTOR_PAYMENTS_SELECT,
    listWhere: 'WHERE cp.deleted_at IS NULL ORDER BY cp.id ASC',
    byIdWhere: 'WHERE cp.id = ?',
    shape: paymentRow,
    columns: ['contract_id', 'pay_date', 'amount_paise', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'remarks'],
    validate: async (req) => { // async: it checks the contract (step 1.4 B11)
      // Contract required + must be a live contract.
      const contractId = Number(req.body.contractId);
      if (!Number.isInteger(contractId) || !(await repo.contract.existsLive(contractId))) {
        return { error: 'Select a valid contract.' };
      }
      // Date of payment required (ISO). Amount required (> 0, integer paise).
      const d = parseIsoDate(req.body.payDate);
      if (d.error) return { error: d.error };
      if (!d.date) return { error: 'Select a date of payment.' };
      const amountPaise = parsePaise(req.body.amountRupees);
      if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };
      // Ledger tag OPTIONAL.
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

  return { CONTRACTOR_PAYMENTS_SELECT, paymentRow };
}
