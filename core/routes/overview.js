// Cross-platform plan, step 1.3 — the Overview: every figure on the Overview screen (computeOverview,
// the money arithmetic over live rows in integer paise), the contract's upcoming payment dates, and
// GET /api/overview. The PDF uses computeOverview too. The only copy: server.js and
// public/local-api.js both call register(app, ctx). See core/routes/people.js for what `app` and
// `ctx` are; the other names come from the earlier core route groups.
import { parseIsoDate } from '../parsers.js';

export function register(app, ctx) {
  const {
    auth, repo, ledgerIndex, istDateStamp, ledgerLabel, CUSTOM_CODE, unitPricePaise, getBudgetPaise,
  } = ctx;

  // All ledger_code='CUSTOM' outflows roll up under ONE group with this label.
  const CUSTOM_GROUP_NAME = 'Custom / Uncategorized';

  // Compute the whole Overview summary from LIVE (non-deleted) rows. Money is INTEGER
  // paise throughout.
  //   `range` (optional) = { start, end } ISO 'YYYY-MM-DD' bounds, inclusive; a null
  //   bound is unbounded on that side, and no range = everything (the default). The
  //   range scopes ONLY the SPENDING views — B (paid to contractors), C (spent by self),
  //   D (total spent), and the Spending-by-Ledger rollup / pie — by each transaction's
  //   own date (cash_out.tx_date, contractor_payments.pay_date). Dateless legacy rows
  //   drop out once a bound is set. A (total contract), E (loans) and F (owed) are
  //   running agreements/balances and stay CUMULATIVE, unaffected by the range.
  //   Every spend transaction counts in the ledger rollup regardless of who paid or of
  //   contract scope: cash_out AND contractor_payments both contribute; a contractor
  //   payment with no ledger tag rolls up under Custom / Uncategorized.
  // Async (step 1.4 B10): it reads through the async database interface.
  async function computeOverview(range) {
    const start = (range && range.start) || null;
    const end = (range && range.end) || null;
    const bounded = !!(start || end);              // any bound set -> range mode (dateless rows drop out)
    const lo = start || '0000-01-01', hi = end || '9999-12-31'; // open sentinels -> sargable col>=? AND col<=?

    // The Phase 5E reimbursement offset is REMOVED, all-or-nothing: no 'included' debit reduces owed,
    // whatever contract_stated_paise a legacy row still holds. Nothing reads that column any more, so
    // the cumulative 'included' scan that fed the offset (and its missing-offset check) is gone too.

    // Live contract (single, Phase 5D). area_of_work + headline ledger label the owed row.
    const contractRows = await repo.overview.contracts();
    const liveContractIds = new Set(contractRows.map((c) => c.id));

    // paid grouped by contract_id (cumulative) — ONE aggregate feeds three things: the owed balance
    // (paidByContract), the cumulative paid total (over-offset check), and orphaned-payment detection
    // (groups whose contract is soft-deleted/missing). No payment rows are fetched for any of these.
    const paidByContract = new Map();
    let cumulativePaid = 0;
    const orphan = { count: 0, amountPaise: 0, contractIds: [] };
    for (const g of await repo.overview.paidByContract()) {
      paidByContract.set(g.contract_id, g.s);
      cumulativePaid += g.s;
      if (!liveContractIds.has(g.contract_id)) { orphan.count += g.c; orphan.amountPaise += g.s; orphan.contractIds.push(g.contract_id); }
    }

    // Per-contract dues + A/F — all CUMULATIVE (unaffected by the range).
    //   owed(C) = stated − Σ paid   (RAW; negative = overpaid, never clamped)
    // An UNSTATED contract (price_of_contract_paise NULL) reads as stated = 0: it adds nothing to A
    // and nothing to owed — but its payments still count in B/D/pie, exactly as before.
    let totalContract = 0, owedToContractors = 0;
    const contracts = contractRows.map((c) => {
      const stated = c.price_of_contract_paise || 0;
      const paid = paidByContract.get(c.id) || 0;
      const owed = stated - paid;
      totalContract += stated; owedToContractors += owed;
      return {
        id: c.id,
        contractorName: c.contractor_name || '',
        areaOfWork: c.area_of_work || '',
        ledger: c.ledger_code ? ledgerLabel(c.ledger_code, c.subledger_code, c.ledger_custom_name, c.subledger_custom_name) : '',
        statedPaise: stated, paidPaise: paid, owedPaise: owed,
      };
    });

    // Spending-by-Ledger rollup (the pie) + B/C/D — RANGE-SCOPED, counting EVERY spend
    // transaction: cash_out (spent by self) AND contractor_payments (paid to a
    // contractor). Nothing is excluded by who paid or by contract scope. The user/other
    // split feeds the reconciliation self-check only (not shown); payments count as 'other'.
    const zero = () => ({ totalPaise: 0, userPaise: 0, otherPaise: 0 });
    const add = (o, byType, amt) => { o.totalPaise += amt; if (byType === 'user') o.userPaise += amt; else o.otherPaise += amt; };

    let spentBySelf = 0, paidToContractors = 0, userSpent = 0, otherSpent = 0; // C, B
    const ledMap = new Map();
    const rollup = (byType, ledgerCode, subCode, subCustom, amt) => {
      if (byType === 'user') userSpent += amt; else otherSpent += amt;
      const isCustom = ledgerCode === CUSTOM_CODE;
      const key = isCustom ? CUSTOM_CODE : ledgerCode;
      let L = ledMap.get(key);
      if (!L) {
        const meta = isCustom ? null : ledgerIndex.byCode().get(ledgerCode);
        L = { code: key, name: isCustom ? CUSTOM_GROUP_NAME : (meta ? `${meta.code} ${meta.name}` : ledgerCode), isCustom, ...zero(), subs: new Map(), noSub: zero() };
        ledMap.set(key, L);
      }
      add(L, byType, amt);
      if (subCode) {
        let subKey, subName;
        if (subCode === CUSTOM_CODE) { subName = subCustom || 'Custom sub-ledger'; subKey = 'CUSTOM:' + subName; }
        else {
          const meta = isCustom ? null : ledgerIndex.byCode().get(ledgerCode);
          const s = meta && meta.subLedgers.find((x) => x.code === subCode);
          subName = s ? `${s.code} ${s.name}` : subCode; subKey = subCode;
        }
        let S = L.subs.get(subKey);
        if (!S) { S = { code: subCode, name: subName, ...zero() }; L.subs.set(subKey, S); }
        add(S, byType, amt);
      } else {
        add(L.noSub, byType, amt); // logged with no sub-ledger
      }
    };

    // Phase 6C — RANGE-SCOPED row fetches: the range is pushed into SQL (partial index on tx_date/
    // pay_date), so only the in-range rows are transferred. These feed C, B and the pie ONLY.
    const outs = bounded ? await repo.overview.outsRange(lo, hi) : await repo.overview.outsAll();
    const payments = bounded ? await repo.overview.paymentsRange(lo, hi) : await repo.overview.paymentsAll();
    for (const r of outs) {
      spentBySelf += r.amount_paise; // C (range)
      rollup(r.by_type, r.ledger_code, r.subledger_code, r.subledger_custom_name, r.amount_paise);
    }
    for (const p of payments) {
      paidToContractors += p.amount_paise; // B (range)
      rollup('other', p.ledger_code || CUSTOM_CODE, p.subledger_code, p.subledger_custom_name, p.amount_paise);
    }

    const loanReceived = (await repo.overview.loansSum()).s; // E (cumulative)
    const totalSpent = paidToContractors + spentBySelf; // D = B + C (range)
    // F4 option (b), decided by the owner 2026-11-22: the budget block (the bar, its "Spent" caption and
    // "left" / "over") compares the WHOLE project's spend with the budget, even when a range is set (the
    // budget is for the whole project); so does the PDF's budget line. With no range this is D itself;
    // with a range, the same two tables are summed with no date bound (live rows only; dateless rows count).
    let wholeProjectSpent = totalSpent;
    if (bounded) {
      wholeProjectSpent = 0;
      for (const r of await repo.overview.outsAll()) wholeProjectSpent += r.amount_paise;
      for (const p of await repo.overview.paymentsAll()) wholeProjectSpent += p.amount_paise;
    }

    const ledgers = [...ledMap.values()]
      .sort((a, b) => (a.isCustom ? 1 : b.isCustom ? -1 : parseFloat(a.code) - parseFloat(b.code)))
      .map((L) => ({
        code: L.code, name: L.name, isCustom: L.isCustom,
        totalPaise: L.totalPaise, userPaise: L.userPaise, otherPaise: L.otherPaise,
        noSub: L.noSub, subs: [...L.subs.values()],
      }));

    // Reconciliation self-check now balances against D (B + C) — the pie counts all spend.
    const splitSumsToTotal = userSpent + otherSpent === totalSpent;
    const mainsSumToTotal = ledgers.reduce((a, L) => a + L.totalPaise, 0) === totalSpent;
    const subsSumToMains = ledgers.every((L) => L.subs.reduce((a, s) => a + s.totalPaise, 0) + L.noSub.totalPaise === L.totalPaise);

    // Reconciliation detections (cumulative, computed from the aggregates above):
    //  · orphan (Phase 4D) — payments whose parent contract is soft-deleted/missing: their ₹ is still
    //    in B/D/pie but not counted in A/F. From the paidByContract groups (contract_id not live).
    //  · overOffset (Phase 5E, retained) — payments exceed the contract value. The 'included'-debit
    //    offset no longer contributes, so this is now purely "paid more than the contract is worth".
    // The Phase 5E missing-offset check is GONE: a NULL/0 contract_stated_paise on an 'included' debit
    // is the normal case now, so the check would fire on every single hand.
    // Both flag-and-log only; NO figure is adjusted (same discipline as Phase 4D).
    const appliedAgainstContract = cumulativePaid;
    const overOffset = { over: totalContract > 0 && appliedAgainstContract > totalContract, contractPaise: totalContract, appliedPaise: appliedAgainstContract, excessPaise: Math.max(0, appliedAgainstContract - totalContract) };

    // Contract Phase A — contractPriceDerivation. A rate-priced contract stores the PRODUCT of its
    // rate and its measured area in price_of_contract_paise, so that owed, figure A, the PDF and the
    // Contractor Payments "Remaining" line all keep reading the one column they always read. That
    // makes the stored price a DERIVED value, and a derived value that is materialised can drift —
    // a backup restored from a file whose stored price disagreed with its own rate and area is the
    // realistic way in, since the import writes columns verbatim rather than re-running the write
    // path. This recomputes the product for every rate-priced live contract and flags a mismatch.
    // Flag-and-log only: it reports the figure AS STORED and corrects nothing, exactly like the two
    // checks above. Re-saving the contract on the Contract Details page rewrites it.
    const priceDrift = [];
    for (const c of contractRows) {
      const expected = unitPricePaise(c.rate_per_sqft_paise, c.measured_area_milli_sqft);
      if (expected != null && expected !== (c.price_of_contract_paise || 0)) {
        priceDrift.push({ contractId: c.id, storedPaise: c.price_of_contract_paise, expectedPaise: expected });
      }
    }
    const contractPriceDerivation = { drifted: priceDrift.length > 0, contracts: priceDrift };

    if (!splitSumsToTotal || !mainsSumToTotal || !subsSumToMains) {
      console.error('Overview reconciliation failed', { splitSumsToTotal, mainsSumToTotal, subsSumToMains });
    }
    if (orphan.count > 0) {
      console.warn(`Overview reconciliation: ${orphan.count} live contractor payment(s) totalling ${orphan.amountPaise} paise reference a soft-deleted or missing contract (contract ids: ${orphan.contractIds.join(', ')}). Counted in B/D/pie but not offset in A/F — figures reported AS-IS, not adjusted. Restore or reassign those payments' contract to rebalance.`);
    }
    if (overOffset.over) {
      console.warn(`Overview reconciliation: contractor payments (${overOffset.appliedPaise} paise) exceed the contract value (${overOffset.contractPaise} paise) by ${overOffset.excessPaise} paise — over-offset. owed is reported unclamped (negative = overpaid), not adjusted.`);
    }
    if (contractPriceDerivation.drifted) {
      console.warn(`Overview reconciliation: ${priceDrift.length} rate-priced contract(s) have a stored price that no longer equals rate × measured area — ${priceDrift.map((d) => `#${d.contractId}: stored ${d.storedPaise} paise, rate × area ${d.expectedPaise} paise`).join('; ')}. The STORED figure is what every total above uses; re-save the contract to recompute it.`);
    }

    return {
      budgetPaise: await getBudgetPaise(),
      ledgers,
      // Money model (A–F). A/E/F are cumulative; B/C/D reflect the selected date range.
      money: {
        totalContractPaise: totalContract,        // A (cumulative)
        paidToContractorsPaise: paidToContractors, // B (range)
        spentBySelfPaise: spentBySelf,            // C (range)
        totalSpentPaise: totalSpent,              // D = B + C (range)
        wholeProjectSpentPaise: wholeProjectSpent, // D over the whole project, ignoring the range (the budget block)
        loanReceivedPaise: loanReceived,          // E (cumulative)
        owedToContractorsPaise: owedToContractors, // F = stated − Σ paid (cumulative)
      },
      contracts, // per-contract: { id, contractorName, statedPaise, paidPaise, owedPaise }
      upcomingPayments: await computeUpcomingPayments(), // Part C — scheduled dates forward + soft overdue
      // Phase 4D + 5E — reconciliation status (additive, backward-compatible; the frontend may
      // surface it later). ok=false means the summary doesn't self-reconcile. Every sub-object is a
      // flag over data reported AS-IS — nothing here adjusts a figure.
      reconciliation: {
        ok: splitSumsToTotal && mainsSumToTotal && subsSumToMains && orphan.count === 0 && !overOffset.over && !contractPriceDerivation.drifted,
        orphanedContractorPayments: orphan,          // { count, amountPaise, contractIds }   (Phase 4D)
        overOffset: overOffset,                      // { over, contractPaise, appliedPaise, excessPaise } (Phase 5E)
        contractPriceDerivation,                     // { drifted, contracts: [{ contractId, storedPaise, expectedPaise }] } (Phase A)
      },
    };
  }

  // Part C — surface the contract's SCHEDULED payment dates forward. HONEST about the data:
  //   • contract_payment_dates carries NO amount → we never claim a due/overdue ₹ amount.
  //   • there is NO key linking a recorded payment to a scheduled date → "overdue" is a BEST-EFFORT
  //     match: a past scheduled date with no LIVE payment on that exact (contract_id, pay_date). It is
  //     flagged softly (possiblyOverdue), never as a hard financial assertion.
  // Returns [{ date, daysRemaining (>=0 future, <0 past), paidOnDate, possiblyOverdue }], date-sorted.
  function daysBetweenIso(fromIso, toIso) {
    const [ya, ma, da] = fromIso.split('-').map(Number);
    const [yb, mb, db2] = toIso.split('-').map(Number);
    return Math.round((Date.UTC(yb, mb - 1, db2) - Date.UTC(ya, ma - 1, da)) / 86400000);
  }
  async function computeUpcomingPayments() {
    const today = istDateStamp();
    const out = [];
    for (const c of await repo.contract.list()) { // one live contract, but the loop is correct either way
      for (const d of await repo.contract.payDatesFor(c.id)) {
        const daysRemaining = daysBetweenIso(today, d);
        const paidOnDate = await repo.contract.paymentOnDate(c.id, d);
        out.push({ date: d, daysRemaining, paidOnDate, possiblyOverdue: daysRemaining < 0 && !paidOnDate });
      }
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  }

  // Optional inclusive date range via ?start=&end= (ISO 'YYYY-MM-DD'); blank/absent = all.
  app.get('/api/overview', auth, async (req, res) => {
    const s = parseIsoDate(req.query.start);
    if (s.error) return res.status(400).json({ error: 'Invalid start date (YYYY-MM-DD).' });
    const e = parseIsoDate(req.query.end);
    if (e.error) return res.status(400).json({ error: 'Invalid end date (YYYY-MM-DD).' });
    if (s.date && e.date && s.date > e.date) return res.status(400).json({ error: 'Start date must be on or before the end date.' });
    res.json(await computeOverview({ start: s.date, end: e.date }));
  });

  return { computeOverview };
}
