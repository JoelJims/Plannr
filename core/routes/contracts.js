// Cross-platform plan, step 1.3 — the Contract Details API: the contract itself (at most one live),
// its scope list of services and its allowance caps, with their validation and row shapes. The only
// copy: server.js and public/local-api.js both call register(app, ctx) and get back the helpers
// their remaining routes still use. See core/routes/people.js for what `app` and `ctx` are;
// ledgerLabel and resolveLedger come from core/routes/cash-and-loans.js.
import { str, parsePaise, parseIsoDate } from '../parsers.js';

export function register(app, ctx) {
  const { auth, repo, ledgerLabel, resolveLedger } = ctx;

  // ---------------------------------------------------------------------------
  // Contract Details API. Logged-in only. Resource: contracts — a normal
  // add/edit/soft-delete list (/api/contracts). Each has contractor + area + a
  // headline ledger tag + an optional free-form amount + an OPTIONAL stated amount +
  // date signed + optional date ends + 0..many scheduled payment dates
  // (contract_payment_dates child). Money is INTEGER paise throughout.
  // ---------------------------------------------------------------------------
  const CONTRACTOR_MAX = 100;

  // Optional manually-typed total price. Empty -> null; otherwise a valid positive
  // paise amount (reuses parsePaise). -> { paise: number|null } or { error }.
  function parsePriceOptional(v) {
    const s = str(v);
    if (s === '') return { paise: null };
    const paise = parsePaise(s);
    if (paise === null) return { error: 'Enter a valid price greater than 0 (up to 2 decimals).' };
    return { paise };
  }

  const AREA_MAX = 200;

  // ---------------------------------------------------------------------------
  // Contract Phase A — the contract is a FIXED UNIT-RATE LUMP SUM: its price is a rate per square
  // foot times the final measured built-up area. The helpers below are what that costs.
  // ---------------------------------------------------------------------------

  // Areas are stored as INTEGER thousandths of a square foot, for the same reason money is stored as
  // integer paise: rate x area has to be exact integer arithmetic. Accepts up to 3 decimals.
  const MILLI_PER_SQFT = 1000;
  function parseAreaOptional(v) {
    const t = str(v).replace(/,/g, '');
    if (t === '') return { milli: null };
    if (!/^\d+(\.\d{1,3})?$/.test(t)) return { error: 'Enter a valid area in square feet (up to 3 decimals), or leave it blank.' };
    const [ip, dp = ''] = t.split('.');
    const milli = Number(ip) * MILLI_PER_SQFT + Number((dp + '000').slice(0, 3));
    if (!Number.isSafeInteger(milli) || milli <= 0) return { error: 'Enter an area greater than 0 square feet.' };
    return { milli };
  }

  // rate (paise per sq ft) x area (milli-sq-ft) -> paise. Returns null unless BOTH are present: one
  // half of a rate price is not a price, and guessing the other half is exactly the invented-number
  // problem that got contract_services.price_paise removed. Also used for a per-sqft allowance
  // ceiling, which is the same shape of calculation.
  function unitPricePaise(ratePaise, areaMilli) {
    if (ratePaise == null || areaMilli == null) return null;
    const product = ratePaise * areaMilli;
    if (!Number.isSafeInteger(product)) return null; // absurd inputs; the parsers below reject them first
    return Math.round(product / MILLI_PER_SQFT);
  }

  // Optional whole number in [min, max]. Blank -> null.
  function parseWholeOptional(v, min, max, message) {
    const t = str(v).replace(/,/g, '');
    if (t === '') return { value: null };
    if (!/^\d+$/.test(t)) return { error: message };
    const n = Number(t);
    if (!Number.isSafeInteger(n) || n < min || n > max) return { error: message };
    return { value: n };
  }

  // Optional percentage, 0–100, up to 2 decimals. Blank -> null. Stored as a REAL because it is a
  // RATE, not money — and, exactly like loans.interest_rate, it drives no calculation anywhere: it
  // records what the contract says the supervision charge on a change order is. Nothing multiplies
  // by it, so no rounding rule is needed and none is implied.
  function parsePercentOptional(v) {
    const t = str(v).replace(/,/g, '');
    if (t === '') return { value: null };
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return { error: 'Enter a supervision rate between 0 and 100 percent (up to 2 decimals), or leave it blank.' };
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { error: 'Enter a supervision rate between 0 and 100 percent (up to 2 decimals), or leave it blank.' };
    return { value: n };
  }

  // date_signed + N whole months, clamped to the end of the target month (31 Jan + 1 month = 28/29
  // Feb, never 2/3 Mar). Pure string maths on the ISO date — no Date parsing of the input, so no
  // timezone can shift it. '' when either half is missing: an expected completion date with no
  // signing date to count from would be a fabricated one.
  function addMonthsIso(iso, months) {
    if (!iso || months == null) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return '';
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const total = y * 12 + (mo - 1) + months;
    const ny = Math.floor(total / 12), nm = (total % 12) + 1;
    const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate(); // day 0 of month nm+1 = last day of nm
    const nd = Math.min(d, lastDay);
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(ny, 4)}-${pad(nm, 2)}-${pad(nd, 2)}`;
  }

  const NOTE_MAX = 2000;      // each of the three free-text contract notes
  const ALLOWANCE_NAME_MAX = 120;
  const ALLOWANCE_KINDS = new Set(['lump', 'per_sqft']);
  const MAX_MONTHS = 600;     // 50 years — a typo guard, not a domain rule

  // A service is a NAME and nothing else (Contract Phase A removed price_paise — the contract's
  // schedule of work attaches no price to any scope item).
  const serviceRow = (s) => ({ id: s.id, name: s.name });

  // One allowance row, with its DERIVED position. `spend` is this row's entry from
  // repo.contract.allowanceSpendFor(), or undefined when nothing has been drawn against it yet.
  //
  // effectiveCapPaise is the rupee ceiling this row can actually be measured against:
  //   · 'lump'     -> cap_paise, always present.
  //   · 'per_sqft' -> the ceiling RATE times the area this allowance covers. With no area recorded
  //                   there IS no rupee ceiling, so it stays null and positionPaise stays null too —
  //                   the row reports its ceiling as a rate and declines to compute an over/under
  //                   rather than inventing an area to make one appear.
  // positionPaise is SIGNED: positive = under the cap, negative = over it. Plannr only DISPLAYS it.
  // Where a contract says an overrun is added to the next progress payment and an underrun subtracted
  // from the final, that is a settlement the owner performs, not one this app performs for them.
  // Nothing here feeds owed, Total contract, or any Overview figure.
  const allowanceRow = (a, spend) => {
    const spentPaise = spend ? spend.spentPaise : 0;
    const effectiveCapPaise = a.cap_kind === 'per_sqft'
      ? unitPricePaise(a.cap_rate_per_sqft_paise, a.area_milli_sqft)
      : a.cap_paise;
    return {
      id: a.id,
      name: a.name,
      capKind: a.cap_kind,
      capPaise: a.cap_paise,
      capRatePerSqftPaise: a.cap_rate_per_sqft_paise,
      areaMilliSqft: a.area_milli_sqft,
      effectiveCapPaise,
      spentPaise,
      entryCount: spend ? spend.entryCount : 0,
      positionPaise: effectiveCapPaise == null ? null : effectiveCapPaise - spentPaise,
    };
  };

  // Shape a contract row for the API. Async (step 1.4 B11): it reads the contract's children.
  //
  // Contract Phase A changed two things here:
  //   · servicesPricedTotalPaise / remainderPaise are GONE. The remainder was "stated total − Σ priced
  //     services", and with no service carrying a price it could only ever equal the stated total —
  //     a line that restated a number already on screen and implied services were meant to add up to
  //     it. The services list is a scope list now, so there is nothing to subtract.
  //   · statedAmountPaise may now be DERIVED. When a rate and a measured area are both recorded, the
  //     stated price is their product and price_of_contract_paise is rewritten to match on every
  //     contract write; `pricingMode` says which it is, so the UI never presents a computed figure as
  //     something the owner typed. Dues maths is untouched: owed still reads the one stored column.
  const contractRow = async (r) => {
    const spend = await repo.contract.allowanceSpendFor(r.id);
    const computedPricePaise = unitPricePaise(r.rate_per_sqft_paise, r.measured_area_milli_sqft);
    return {
      id: r.id,
      contractorName: r.contractor_name || '',
      company: r.company || '',                     // Part F: optional company/firm (presentation only)
      areaOfWork: r.area_of_work || '',
      ledgerCode: r.ledger_code,
      subledgerCode: r.subledger_code,
      ledgerCustomName: r.ledger_custom_name,
      subledgerCustomName: r.subledger_custom_name,
      ledger: r.ledger_code ? ledgerLabel(r.ledger_code, r.subledger_code, r.ledger_custom_name, r.subledger_custom_name) : '',
      amountPaise: r.amount_paise,                  // optional free-form amount or null
      statedAmountPaise: r.price_of_contract_paise, // the stated amount owed maths reads — typed OR derived
      // Rate-based pricing (both optional, both editable at any time — the area is not known until
      // final measurement). 'rate' when both are present, 'typed' when a price was entered directly,
      // 'none' when the contract states no price at all (all three are valid).
      ratePerSqftPaise: r.rate_per_sqft_paise,
      measuredAreaMilliSqft: r.measured_area_milli_sqft,
      computedPricePaise,                           // rate × area, or null when either half is missing
      pricingMode: computedPricePaise != null ? 'rate' : (r.price_of_contract_paise != null ? 'typed' : 'none'),
      dateSigned: r.date_signed || '',
      dateEnds: r.contract_end_date || '',
      // Optional metadata. expectedCompletionDate is DERIVED (signing date + N months) and never
      // stored: it is a function of two fields that are both editable, so storing it would just be a
      // third value to keep in step.
      completionPeriodMonths: r.completion_period_months,
      expectedCompletionDate: addMonthsIso(r.date_signed, r.completion_period_months),
      supervisionRatePct: r.supervision_rate_pct,   // informational only; drives no calculation
      specifiedBrands: r.specified_brands || '',
      excludedScope: r.excluded_scope || '',
      ownerObligations: r.owner_obligations || '',
      paymentDates: await repo.contract.payDatesFor(r.id),
      services: (await repo.contract.servicesFor(r.id)).map(serviceRow), // scope list: names only
      allowances: (await repo.contract.allowancesFor(r.id)).map((a) => allowanceRow(a, spend.get(a.id))),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  };

  const getContractRow = (id) => repo.contract.getLive(id);

  // Columns written on contract create/update (id/timestamps/deleted_at excluded).
  const CONTRACT_COLS = ['contractor_name', 'area_of_work', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'amount_paise', 'price_of_contract_paise', 'contract_end_date', 'date_signed', 'company',
    // Contract Phase A — rate-based pricing + optional metadata. price_of_contract_paise stays in
    // the list and stays the single source of truth for owed; when a rate and an area are both
    // given, readContractBody() writes the product into it rather than whatever was typed.
    'rate_per_sqft_paise', 'measured_area_milli_sqft', 'completion_period_months', 'supervision_rate_pct', 'specified_brands', 'excluded_scope', 'owner_obligations'];
  const COMPANY_MAX = 120; // Part F: optional company/firm name cap

  // Validate + normalise a contract request body -> { values, paymentDates } or { error }.
  // Required: contractorName, areaOfWork, a valid headline ledger, date signed.
  // Optional: stated amount, free-form amount, date ends, and 0..many payment dates.
  function readContractBody(req) {
    const contractorName = str(req.body.contractorName).slice(0, CONTRACTOR_MAX);
    if (!contractorName) return { error: 'Contractor name is required.' };
    const areaOfWork = str(req.body.areaOfWork).slice(0, AREA_MAX);
    if (!areaOfWork) return { error: 'Area of work is required.' };

    const led = resolveLedger(req.body); // headline category (fixed-or-CUSTOM), shared rules
    if (led.error) return { error: led.error };

    const amount = parsePriceOptional(req.body.amountRupees); // optional free-form; blank -> null
    if (amount.error) return { error: amount.error };

    // The stated total is OPTIONAL: blank -> NULL. A contract with no stated price contributes 0 to
    // figure A (total contract) and 0 to owed; a contract that HAS one behaves exactly as before.
    const stated = parsePriceOptional(req.body.statedAmountRupees);
    if (stated.error) return { error: 'Enter a valid total contract value greater than 0 (up to 2 decimals), or leave it blank.' };

    // Contract Phase A — rate-based pricing. Both halves are OPTIONAL and independently editable at
    // any time: the rate is fixed at signing, the area is not known until final measurement, so a
    // contract routinely sits with a rate and no area for months. When BOTH land, the product REPLACES
    // whatever is in statedAmountRupees; a typed value sent alongside a complete rate price is
    // ignored, not rejected, so an older client or a stale tab can't 400 on an otherwise valid save.
    const rate = parsePriceOptional(req.body.ratePerSqftRupees);
    if (rate.error) return { error: 'Enter a valid rate per square foot greater than 0 (up to 2 decimals), or leave it blank.' };
    const area = parseAreaOptional(req.body.measuredAreaSqft);
    if (area.error) return { error: area.error };
    if (rate.paise != null && area.milli != null && unitPricePaise(rate.paise, area.milli) == null) {
      return { error: 'That rate and area multiply out to a number too large to record. Check both figures.' };
    }
    const computed = unitPricePaise(rate.paise, area.milli); // null unless BOTH halves are present

    // Contract Phase A — the signing date is OPTIONAL now (it was required). Every field on this form
    // is optional except the contractor, the area of work and the headline ledger. A malformed date
    // is still rejected; an absent one is simply absent, and the expected completion date it would
    // have anchored is then not reported rather than being counted from a made-up day.
    const signed = parseIsoDate(req.body.dateSigned);
    if (signed.error) return { error: signed.error };

    const ends = parseIsoDate(req.body.dateEnds); // optional; blank -> null
    if (ends.error) return { error: ends.error };

    const months = parseWholeOptional(req.body.completionPeriodMonths, 1, MAX_MONTHS, `Enter the completion period as a whole number of months between 1 and ${MAX_MONTHS}, or leave it blank.`);
    if (months.error) return { error: months.error };

    const supervision = parsePercentOptional(req.body.supervisionRatePct);
    if (supervision.error) return { error: supervision.error };

    const specifiedBrands = str(req.body.specifiedBrands).slice(0, NOTE_MAX);
    const excludedScope = str(req.body.excludedScope).slice(0, NOTE_MAX);
    const ownerObligations = str(req.body.ownerObligations).slice(0, NOTE_MAX);

    const company = str(req.body.company).slice(0, COMPANY_MAX); // Part F: optional; blank -> null below

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
        // DERIVED when the contract is rate-priced, TYPED otherwise. Materialising it into the one
        // column every consumer already reads (owed, figure A, the PDF, the Contractor Payments
        // "Remaining" line) is what keeps this change additive: nothing downstream learns about rates.
        // reconciliation.contractPriceDerivation re-checks the product on every Overview load and
        // flags any drift rather than silently correcting it.
        price_of_contract_paise: computed != null ? computed : stated.paise,
        rate_per_sqft_paise: rate.paise,
        measured_area_milli_sqft: area.milli,
        contract_end_date: ends.date,
        date_signed: signed.date,
        completion_period_months: months.value,
        supervision_rate_pct: supervision.value,
        specified_brands: specifiedBrands || null,
        excluded_scope: excludedScope || null,
        owner_obligations: ownerObligations || null,
        company: company || null,
      },
      paymentDates,
    };
  }

  // Replace a contract's scheduled payment-date children with a fresh list.
  const writePaymentDates = (contractId, dates) => repo.contract.writePayDates(contractId, dates);

  // Contracts CRUD. Phase 5D: AT MOST ONE live contract (enforced by the idx_contract_single_live
  // partial unique index). The path + the { contracts: [...] } response shape are UNCHANGED so the
  // frontend fetch doesn't churn — it is simply always an array of 0 or 1. paymentDatesFor() is
  // called once per returned row (contractRow); with the invariant that N+1 is now bounded at one
  // contract, so it needs no batching/restructuring.
  app.get('/api/contracts', auth, async (req, res) => {
    const contracts = [];
    for (const r of await repo.contract.list()) contracts.push(await contractRow(r));
    res.json({ contracts });
  });

  app.post('/api/contracts', auth, async (req, res) => {
    const v = readContractBody(req);
    if (v.error) return res.status(400).json({ error: v.error });
    // Phase 5D: the single-contract guard — a second contract is a clean 409, never a silent overwrite.
    // (idx_contract_single_live backstops it in the database.)
    if ((await repo.contract.liveCount()) > 0) {
      return res.status(409).json({ error: 'A contract already exists — Plannr tracks a single contract. Edit the existing one instead of adding another (or delete it first).' });
    }
    const info = await repo.contract.insert(CONTRACT_COLS, CONTRACT_COLS.map((c) => v.values[c]));
    await writePaymentDates(info.lastInsertRowid, v.paymentDates);
    res.status(201).json({ ok: true, contract: await contractRow(await getContractRow(info.lastInsertRowid)) });
  });

  app.put('/api/contracts/:id', auth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !(await getContractRow(id))) return res.status(404).json({ error: 'Contract not found.' });
    const v = readContractBody(req);
    if (v.error) return res.status(400).json({ error: v.error });
    await repo.contract.update(id, CONTRACT_COLS, CONTRACT_COLS.map((c) => v.values[c]));
    await writePaymentDates(id, v.paymentDates);
    res.json({ ok: true, contract: await contractRow(await getContractRow(id)) });
  });

  // ---------------------------------------------------------------------------
  // Contract services (Services phase, Part A). A contract's line-item services: a NAME + an OPTIONAL
  // price. Add / edit / soft-delete, nested under the parent contract so the id proves ownership.
  // A service's only job downstream is to be NAMED by a debit (cash_out.contract_service_id) as the
  // thing that spend was for. It never enters the dues maths — nothing does but the contract's stated
  // value and the contractor payments.
  // ---------------------------------------------------------------------------
  const SERVICE_NAME_MAX = 120;
  const getServiceRow = (id) => repo.contract.serviceLive(id);
  const getLiveServiceForContract = (cid, sid) => repo.contract.serviceForContract(cid, sid);

  // A service is a name. Contract Phase A dropped priceRupees; a body that still sends one is
  // IGNORED rather than rejected, so a stale tab or an older client cannot 400 on a valid save.
  function readServiceBody(req) {
    const name = str(req.body.name).slice(0, SERVICE_NAME_MAX);
    if (!name) return { error: 'Service name is required.' };
    return { values: { name } };
  }

  app.post('/api/contracts/:id/services', auth, async (req, res) => {
    const cid = Number(req.params.id);
    if (!Number.isInteger(cid) || !(await getContractRow(cid))) return res.status(404).json({ error: 'Contract not found.' });
    const v = readServiceBody(req);
    if (v.error) return res.status(400).json({ error: v.error });
    const info = await repo.contract.insertService(cid, v.values.name);
    res.status(201).json({ ok: true, service: serviceRow(await getServiceRow(info.lastInsertRowid)) });
  });

  app.put('/api/contracts/:id/services/:sid', auth, async (req, res) => {
    const cid = Number(req.params.id), sid = Number(req.params.sid);
    if (!Number.isInteger(cid) || !Number.isInteger(sid) || !(await getLiveServiceForContract(cid, sid))) return res.status(404).json({ error: 'Service not found.' });
    const v = readServiceBody(req);
    if (v.error) return res.status(400).json({ error: v.error });
    await repo.contract.updateService(sid, v.values.name);
    res.json({ ok: true, service: serviceRow(await getServiceRow(sid)) });
  });

  app.delete('/api/contracts/:id/services/:sid', auth, async (req, res) => {
    const cid = Number(req.params.id), sid = Number(req.params.sid);
    if (!Number.isInteger(cid) || !Number.isInteger(sid) || !(await getLiveServiceForContract(cid, sid))) return res.status(404).json({ error: 'Service not found.' });
    // Soft-delete. A LIVE debit may still reference this now-deleted service (keeping the provenance
    // link); it simply stops being offered by the picker. No block — services are informational.
    await repo.contract.softDeleteService(sid);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Contract allowances (Contract Phase A). The contract's allowance caps — the only rupee figures
  // the contract attaches to anything. Entirely OPTIONAL: a contract with none behaves normally.
  // Nested under the parent contract so the id proves ownership, exactly like services.
  //
  // Spend against a cap is DERIVED from live cash_out rows tagged with the allowance, never typed,
  // and the over/under position is DISPLAYED only. The contract settles an overrun by adding it to
  // the next progress payment and an underrun by subtracting it from the final — that is the owner's
  // decision to make on the day, so nothing here touches owed or any Overview total.
  // ---------------------------------------------------------------------------
  const getLiveAllowanceForContract = (cid, aid) => repo.contract.allowanceForContract(cid, aid);

  // Read + normalise an allowance body -> { values } | { error }.
  // 'lump'     needs capRupees.                    'per_sqft' needs capRatePerSqftRupees.
  // 'per_sqft' may ALSO carry areaSqft — optional, because a rate ceiling is a real cap on its own
  // and only becomes a rupee figure once an area is known. Without it the row simply reports no
  // position; making the area mandatory would force the owner to invent one.
  function readAllowanceBody(req) {
    const name = str(req.body.name).slice(0, ALLOWANCE_NAME_MAX);
    if (!name) return { error: 'Allowance name is required.' };
    const kind = str(req.body.capKind) || 'lump';
    if (!ALLOWANCE_KINDS.has(kind)) return { error: 'Choose whether this cap is a rupee amount or a rate per square foot.' };

    if (kind === 'lump') {
      const cap = parsePriceOptional(req.body.capRupees);
      if (cap.error) return { error: 'Enter a valid cap amount greater than 0 (up to 2 decimals).' };
      if (cap.paise == null) return { error: 'Enter the cap amount for this allowance.' };
      return { values: { name, cap_kind: 'lump', cap_paise: cap.paise, cap_rate_per_sqft_paise: null, area_milli_sqft: null } };
    }

    const rate = parsePriceOptional(req.body.capRatePerSqftRupees);
    if (rate.error) return { error: 'Enter a valid ceiling rate per square foot greater than 0 (up to 2 decimals).' };
    if (rate.paise == null) return { error: 'Enter the ceiling rate per square foot for this allowance.' };
    const area = parseAreaOptional(req.body.areaSqft); // optional
    if (area.error) return { error: area.error };
    if (area.milli != null && unitPricePaise(rate.paise, area.milli) == null) {
      return { error: 'That rate and area multiply out to a number too large to record. Check both figures.' };
    }
    return { values: { name, cap_kind: 'per_sqft', cap_paise: null, cap_rate_per_sqft_paise: rate.paise, area_milli_sqft: area.milli } };
  }

  // Re-shape one allowance for a single-row response (the list comes back via contractRow).
  const allowanceById = async (cid, aid) => {
    const row = await repo.contract.allowanceForContract(cid, aid);
    return row ? allowanceRow(row, (await repo.contract.allowanceSpendFor(cid)).get(aid)) : null;
  };

  app.post('/api/contracts/:id/allowances', auth, async (req, res) => {
    const cid = Number(req.params.id);
    if (!Number.isInteger(cid) || !(await getContractRow(cid))) return res.status(404).json({ error: 'Contract not found.' });
    const v = readAllowanceBody(req);
    if (v.error) return res.status(400).json({ error: v.error });
    const info = await repo.contract.insertAllowance(cid, { ...v.values, sort_order: await repo.contract.nextAllowanceOrder(cid) });
    res.status(201).json({ ok: true, allowance: await allowanceById(cid, Number(info.lastInsertRowid)) });
  });

  app.put('/api/contracts/:id/allowances/:aid', auth, async (req, res) => {
    const cid = Number(req.params.id), aid = Number(req.params.aid);
    if (!Number.isInteger(cid) || !Number.isInteger(aid) || !(await getLiveAllowanceForContract(cid, aid))) return res.status(404).json({ error: 'Allowance not found.' });
    const v = readAllowanceBody(req);
    if (v.error) return res.status(400).json({ error: v.error });
    await repo.contract.updateAllowance(aid, v.values);
    res.json({ ok: true, allowance: await allowanceById(cid, aid) });
  });

  app.delete('/api/contracts/:id/allowances/:aid', auth, async (req, res) => {
    const cid = Number(req.params.id), aid = Number(req.params.aid);
    if (!Number.isInteger(cid) || !Number.isInteger(aid) || !(await getLiveAllowanceForContract(cid, aid))) return res.status(404).json({ error: 'Allowance not found.' });
    // Soft-delete, same as a service. Debits already drawn against it keep their link (the spend is
    // still real spend, and it still counts in every Overview figure — only the cap stops being
    // reported); the allowance simply stops being offered on the debit form.
    await repo.contract.softDeleteAllowance(aid);
    res.json({ ok: true });
  });

  // Soft-delete a contract. Scheduled payment-date children are left in place (only
  // surfaced via the contract).
  app.delete('/api/contracts/:id', auth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid contract id.' });
    // Guard (Phase 4D): refuse while any LIVE contractor payment references this contract. Otherwise
    // A/F (which iterate live contracts) drop the contract while B/D/pie (which iterate live payments)
    // keep its ₹ — you end up having paid toward a contract totalling ₹0, and the Overview stops
    // reconciling. Same shape as the two Recycle-Bin guards and /api/delete-account.
    const live = await repo.contract.livePaymentsFor(id);
    if (live > 0) {
      return res.status(409).json({ error: `This contract has ${live} live contractor payment${live === 1 ? '' : 's'} recorded against it. Deleting it would leave ${live === 1 ? 'that payment' : 'those payments'} attributed to a contract that is gone (and unbalance the Overview), so it's blocked — delete or reassign ${live === 1 ? 'that payment' : 'those payments'} first, then delete the contract.` });
    }
    const info = await repo.contract.softDelete(id);
    if (info.changes === 0) return res.status(404).json({ error: 'Contract not found.' });
    res.json({ ok: true });
  });

  return { unitPricePaise, contractRow, CONTRACT_COLS };
}
