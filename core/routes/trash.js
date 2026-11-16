// Cross-platform plan, step 1.3 — the Recycle Bin: list, restore and permanently delete the
// soft-deleted rows of the five tables that soft-delete, with the guards that keep the Overview
// reconciling. The only copy: server.js and public/local-api.js both call register(app, ctx). See
// core/routes/people.js for what `app` and `ctx` are; the SELECTs and row shapes come from the
// other core route groups (cash-and-loans, contracts, contractor-payments).
import { fmtRs } from '../parsers.js';

export function register(app, ctx) {
  const {
    auth, repo, CASH_IN_SELECT, cashInRow, LOANS_SELECT, loanRow, CASH_OUT_SELECT, cashOutRow, contractRow, CONTRACTOR_PAYMENTS_SELECT, paymentRow,
  } = ctx;

  // ---------------------------------------------------------------------------
  // Phase 3C — Recycle Bin: view / restore / permanently-delete soft-deleted rows for the
  // five soft-deleting tables. Everything below is auth-gated. Statements are prepared once
  // here (module scope, AFTER init() and after the SELECTs/shapers above — the Phase 1 pattern).
  // ---------------------------------------------------------------------------
  const TRASH_TABLES = ['cash_in', 'cash_out', 'loans', 'contract', 'contractor_payments']; // the ONLY allowed :table values
  const TRASH_SHAPERS = { cash_in: cashInRow, cash_out: cashOutRow, loans: loanRow, contract: contractRow, contractor_payments: paymentRow };
  // The Recycle Bin routes through repo.trash.
  const TRASH_REPO = {
    cash_in:  repo.trash({ table: 'cash_in', select: CASH_IN_SELECT, alias: 'c' }),
    cash_out: repo.trash({ table: 'cash_out', select: CASH_OUT_SELECT, alias: 'c' }),
    loans:    repo.trash({ table: 'loans', select: LOANS_SELECT, alias: '' }),
    contract: repo.trash({ table: 'contract', select: 'SELECT * FROM contract', alias: '' }),
    contractor_payments: repo.trash({ table: 'contractor_payments', select: CONTRACTOR_PAYMENTS_SELECT, alias: 'cp' }),
  };

  // GET /api/trash — soft-deleted rows for all five tables, each shaped like the live list plus
  // deletedAt, newest-deleted first.
  app.get('/api/trash', auth, (req, res) => {
    const trash = {};
    for (const t of TRASH_TABLES) {
      trash[t] = TRASH_REPO[t].listDeleted().map((r) => ({ ...TRASH_SHAPERS[t](r), deletedAt: r.deleted_at }));
    }
    res.json({ trash });
  });

  // Validate :table against the allowlist; return the name or null.
  function trashTable(req) { return TRASH_TABLES.includes(req.params.table) ? req.params.table : null; }

  // POST /api/trash/:table/:id/restore — un-delete (deleted_at = NULL, bump updated_at).
  app.post('/api/trash/:table/:id/restore', auth, (req, res) => {
    const table = trashTable(req);
    if (!table) return res.status(400).json({ error: 'Unknown table.' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !TRASH_REPO[table].find(id)) return res.status(404).json({ error: 'That deleted item was not found.' });
    // Guard: a contractor payment must not go live under a still-deleted contract — otherwise a
    // live payment sits under a deleted contract, inflating Overview spend while the contract's
    // value stays out of the totals. Require the contract to be restored first.
    if (table === 'contractor_payments') {
      const row = repo.contract.paymentContractId(id);
      const parent = repo.contract.deletedAt(row.contract_id);
      if (!parent || parent.deleted_at !== null) {
        return res.status(409).json({ error: 'Restore the parent contract first — this payment belongs to a contract that is still in the Recycle Bin.' });
      }
    }
    // Phase 5H — the single-live-contract invariant (idx_contract_single_live). Guard explicitly:
    // refuse restoring a contract while another is already live. Message style matches the two
    // guards above and /api/delete-account.
    if (table === 'contract' && repo.contract.liveCount() > 0) {
      return res.status(409).json({ error: 'Another contract is already live — Plannr tracks a single contract. Delete the current one before restoring this from the Recycle Bin.' });
    }
    // Services phase (Part D) — a soft-deleted debit RELEASED its service (the partial-unique index only
    // counts live rows). If ANOTHER live debit has since CLAIMED that service, restoring this one would
    // make two live debits offset a single substitution — the DB index would raise a raw 500. Guard
    // explicitly with the same 409 shape: refuse, naming the claimant.
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

  // DELETE /api/trash/:table/:id — permanent hard delete.
  app.delete('/api/trash/:table/:id', auth, (req, res) => {
    const table = trashTable(req);
    if (!table) return res.status(400).json({ error: 'Unknown table.' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !TRASH_REPO[table].find(id)) return res.status(404).json({ error: 'That deleted item was not found.' });
    // Guard: contractor_payments.contract_id references contract(id) with NO ACTION (unlike
    // contract_payment_dates / contract_services, which CASCADE). Hard-deleting a contract that
    // any payment — live OR soft-deleted — still references would orphan/violate the FK, so
    // refuse and say so (modelled on the /api/delete-account guard).
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
      // Contract Phase A: contract_allowances CASCADEs the same way, and cash_out.contract_allowance_id
      // has no ON DELETE action either — same crash, same pre-flight count.
      const k = repo.contract.cashOutReferencingAllowances(id);
      if (k > 0) {
        return res.status(409).json({ error: `This contract still has ${k} cash-out entr${k === 1 ? 'y' : 'ies'} drawing against one of its allowances (live or in the Recycle Bin). Permanently deleting it would orphan ${k === 1 ? 'that entry' : 'those entries'} — unlink or restore ${k === 1 ? 'it' : 'them'} first.` });
      }
    }
    TRASH_REPO[table].hardDelete(id); // contract_payment_dates / contract_services children cascade
    res.json({ ok: true });
  });
}
