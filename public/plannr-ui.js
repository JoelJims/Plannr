// Plannr — shared front-end helpers for the ledger screens (no build step).
// Loaded as a classic script (`<script src="/plannr-ui.js"></script>`) BEFORE a
// page's inline script; exposes window.PlannrUI. Extracted VERBATIM from
// cash-inflow.html / loan-details.html so behaviour is byte-identical.
(function (root) {
  // paise -> "₹12,34,567.89" using exact integer math + Indian grouping.
  function formatPaise(paise) {
    const neg = paise < 0; paise = Math.abs(paise);
    const rupees = Math.floor(paise / 100);
    const p = String(paise % 100).padStart(2, '0');
    return (neg ? '-' : '') + '₹' + rupees.toLocaleString('en-IN') + '.' + p;
  }

  // Phase 4C — owed(F) / remaining is a SIGNED balance (negative = overpaid; computeOverview never
  // clamps it, and the reconciliation checks depend on that). Present a negative as "Overpaid by ₹X"
  // so a negative "owed to contractor" doesn't misread as money still due. Value stays signed.
  function formatOwed(paise) { return paise < 0 ? ('Overpaid by ' + formatPaise(-paise)) : formatPaise(paise); }

  // paise -> a plain rupees string for an edit input, exact (no float).
  const paiseToInput = (paise) => Math.floor(paise / 100) + '.' + String(paise % 100).padStart(2, '0');

  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // DISPLAY-ONLY date formatting. Storage/calculation stays ISO 'YYYY-MM-DD' everywhere;
  // these only affect how a date is shown / typed in the UI.
  //   formatDate('2026-03-10') -> '10/03/26'   (dd/mm/yy)
  //   parseDmy('10/03/26')     -> '2026-03-10' (ISO) or null if invalid
  function formatDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso == null ? '' : iso));
    return m ? (m[3] + '/' + m[2] + '/' + m[1].slice(2)) : String(iso == null ? '' : iso);
  }
  function parseDmy(s) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    let d = +m[1], mo = +m[2], y = +m[3];
    if (y < 100) y += 2000;                       // 'yy' -> 20yy (matches the app's 2000–2099 range)
    if (mo < 1 || mo > 12 || d < 1) return null;
    const leap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
    const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
    if (d > dim) return null;
    return String(y).padStart(4, '0') + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  // Message-area controls bound to an element: { show(text, type), clear() }.
  function makeMsg(el) {
    return {
      show: (text, type) => { el.textContent = text; el.className = 'msg show ' + type; },
      clear: () => { el.className = 'msg'; },
    };
  }

  // ---------------------------------------------------------------------------
  // Shared Cash Outflow FORM editor. Extracted VERBATIM from cash-outflow.html so
  // the Overview edit modal reuses the EXACT same behaviour: dependent Ledger→Sub
  // dropdowns, the "Custom…" sentinel inputs, the Included/Extra contract-scope tag,
  // plus request-body building with the same client-side validation strings.
  //
  // It owns only the FORM FIELDS (passed in as `els`); the page owns its own list,
  // Sl.No, save/cancel buttons and fetch calls. Element ids can be anything — refs
  // are passed directly — so two pages can host the same form without id clashes.
  //   els: { amount, bySelect, customWrap, byCustom, ledgerSelect, ledgerCustomWrap,
  //          ledgerCustom, subSelect, subCustomWrap, subCustom, reason, scopeSelect,
  //          [dateDay, dateMonth, dateYear] }
  // The date els are OPTIONAL: when all three are supplied (cash-outflow page) the form
  // owns a required day/month/year picker; when omitted (Overview edit modal) the form
  // still round-trips the row's existing tx_date via readBody so PUTs keep the date.
  // Methods: setUser(user) · populate(entry) · reset() · readBody()
  const CUSTOM_CODE = 'CUSTOM'; // must match the server sentinel

  // Day / Month / Year dependent dropdowns — the SAME approach as the /select-date
  // screen (date.js): fixed 2000–2099 year range, day list rebuilt from the chosen
  // month + year so impossible dates (e.g. Feb 30) can't be picked. Produces and
  // consumes ISO 'YYYY-MM-DD'. Defaults to today. Attached to three <select> els.
  const DP_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DP_YEAR_MIN = 2000, DP_YEAR_MAX = 2099;
  const dpLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
  const dpDaysInMonth = (m, y) => [31, dpLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  function dpOption(value, label) { const o = document.createElement('option'); o.value = String(value); o.textContent = String(label); return o; }

  function attachDatePicker(els) {
    const dayEl = els.day, monthEl = els.month, yearEl = els.year;
    const monthFrag = document.createDocumentFragment();
    DP_MONTHS.forEach((name, i) => monthFrag.appendChild(dpOption(i + 1, name)));
    monthEl.replaceChildren(monthFrag);
    const yearFrag = document.createDocumentFragment();
    for (let y = DP_YEAR_MIN; y <= DP_YEAR_MAX; y++) yearFrag.appendChild(dpOption(y, y));
    yearEl.replaceChildren(yearFrag);

    function rebuildDays() {
      const month = Number(monthEl.value), year = Number(yearEl.value);
      const max = dpDaysInMonth(month, year);
      const prev = Number(dayEl.value) || 1;
      const frag = document.createDocumentFragment();
      for (let d = 1; d <= max; d++) frag.appendChild(dpOption(d, d));
      dayEl.replaceChildren(frag);
      dayEl.value = String(Math.min(prev, max));
    }
    monthEl.addEventListener('change', rebuildDays);
    yearEl.addEventListener('change', rebuildDays);

    function setToday() {
      const t = new Date();
      const y = Math.min(DP_YEAR_MAX, Math.max(DP_YEAR_MIN, t.getFullYear()));
      monthEl.value = String(t.getMonth() + 1);
      yearEl.value = String(y);
      rebuildDays();
      dayEl.value = String(Math.min(t.getDate(), dpDaysInMonth(Number(monthEl.value), Number(yearEl.value))));
    }
    setToday();

    return {
      getISO() {
        return yearEl.value + '-' + String(monthEl.value).padStart(2, '0') + '-' + String(dayEl.value).padStart(2, '0');
      },
      setISO(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
        if (!m) { setToday(); return; } // null/blank/legacy -> default to today
        const y = Math.min(DP_YEAR_MAX, Math.max(DP_YEAR_MIN, Number(m[1])));
        monthEl.value = String(Number(m[2]));
        yearEl.value = String(y);
        rebuildDays();
        dayEl.value = String(Math.min(Number(m[3]), dpDaysInMonth(Number(monthEl.value), Number(yearEl.value))));
      },
      reset() { setToday(); },
    };
  }

  function createCashOutForm(els) {
    const LEDGERS = root.LEDGERS || [];
    let lastTxDate = null; // remembers a populated row's tx_date so readBody() can carry
                           // it through when this form has NO date picker (Overview modal).
    const datePicker = (els.dateDay && els.dateMonth && els.dateYear)
      ? attachDatePicker({ day: els.dateDay, month: els.dateMonth, year: els.dateYear })
      : null;

    function buildLedgers() {
      els.ledgerSelect.innerHTML = '<option value="">— select ledger —</option>' +
        LEDGERS.map((l) => `<option value="${l.code}">${escapeHtml(l.code + ' ' + l.name)}</option>`).join('') +
        `<option value="${CUSTOM_CODE}">Custom…</option>`;
    }
    function buildSubs(ledgerCode) {
      const l = ledgerCode === CUSTOM_CODE ? null : LEDGERS.find((x) => x.code === ledgerCode);
      const subs = l ? l.subLedgers : [];
      els.subSelect.innerHTML = '<option value="">— none —</option>' +
        subs.map((s) => `<option value="${s.code}">${escapeHtml(s.code + ' ' + s.name)}</option>`).join('') +
        `<option value="${CUSTOM_CODE}">Custom…</option>`;
      els.subSelect.disabled = !ledgerCode;
    }
    function syncCustom(selectEl, wrapEl, inputEl) {
      const on = selectEl.value === CUSTOM_CODE;
      wrapEl.hidden = !on;
      if (!on) inputEl.value = '';
    }
    els.ledgerSelect.addEventListener('change', () => {
      buildSubs(els.ledgerSelect.value);
      syncCustom(els.ledgerSelect, els.ledgerCustomWrap, els.ledgerCustom);
      syncCustom(els.subSelect, els.subCustomWrap, els.subCustom);
    });
    els.subSelect.addEventListener('change', () => syncCustom(els.subSelect, els.subCustomWrap, els.subCustom));
    els.bySelect.addEventListener('change', () => { els.customWrap.hidden = els.bySelect.value !== 'custom'; });
    // The contract-stated field is GONE (the reimbursement offset was removed), so the 'included'
    // scope reveals only the two CONTRACT LINKS: which contract service this spend was for
    // (provenance), and which allowance cap it draws against. Neither moves a figure. A non-contract
    // ('extra') row shows neither, so the everyday entry path keeps its Phase-4 tap cost.
    function syncScope() {
      const on = els.scopeSelect.value === 'included';
      if (els.serviceWrap) els.serviceWrap.hidden = !on;
      if (els.serviceSelect && !on) els.serviceSelect.value = '';
      if (els.allowanceWrap) els.allowanceWrap.hidden = !on;
      if (els.allowanceSelect && !on) els.allowanceSelect.value = '';
    }
    if (els.serviceWrap || els.serviceSelect || els.allowanceWrap || els.allowanceSelect) els.scopeSelect.addEventListener('change', syncScope);

    buildLedgers();
    buildSubs('');

    return {
      setUser(user, roster) {
        // Phase 2: "Expense By" offers EVERY real user (from the roster) + Custom, because
        // By records who PAID, not who entered the row. Falls back to just the session user
        // when the roster is unavailable (degraded, never blank). Contractor stays gone (Phase 1).
        const list = (Array.isArray(roster) && roster.length) ? roster : (user ? [user] : []);
        els.bySelect.innerHTML =
          list.map((u) => `<option value="user:${u.id}">${escapeHtml(u.displayName)}</option>`).join('') +
          `<option value="custom">Add custom…</option>`;
      },
      // The selectable services (the page pre-filters out any already claimed by a live debit, so
      // the one-live-debit guard rarely trips). Contract Phase A: a service is a NAME — there is no
      // price to filter on and none to show in the option label.
      setServices(services) {
        if (!els.serviceSelect) return;
        els.serviceSelect.innerHTML = '<option value="">— none —</option>' +
          (services || []).map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
      },
      // Contract Phase A — the allowance caps this spend may draw against. Unlike services, an
      // allowance is NOT consumed by being picked: many debits draw against one cap, so nothing is
      // filtered out here. The label carries the cap so the choice is informed at the point of entry
      // ('— no cap set' for a per-square-foot ceiling with no area recorded yet, which is a real
      // state and not an error).
      setAllowances(allowances) {
        if (!els.allowanceSelect) return;
        const label = (a) => {
          if (a.effectiveCapPaise != null) return `${a.name} — cap ₹${(a.effectiveCapPaise / 100).toLocaleString('en-IN')}`;
          if (a.capRatePerSqftPaise != null) return `${a.name} — ₹${(a.capRatePerSqftPaise / 100).toLocaleString('en-IN')}/sq ft, no area set`;
          return a.name;
        };
        els.allowanceSelect.innerHTML = '<option value="">— none —</option>' +
          (allowances || []).map((a) => `<option value="${a.id}">${escapeHtml(label(a))}</option>`).join('');
      },
      // Services phase (Part E) — the caller's saved custom LEDGER names, as a <datalist> for the input.
      setCustoms(names) {
        if (!els.ledgerCustomList) return;
        els.ledgerCustomList.replaceChildren(...(names || []).map((n) => { const o = document.createElement('option'); o.value = n; return o; }));
      },
      populate(e) {
        lastTxDate = e.txDate || null;
        if (datePicker) datePicker.setISO(e.txDate); // null/legacy -> today
        els.amount.value = paiseToInput(e.amountPaise);
        // Legacy 'contractor' rows fall through to the custom branch (Contractor is no
        // longer an option); the label is preserved so the row stays readable/editable.
        if (e.byType === 'user') {
          const val = 'user:' + e.byUserId;
          // Phase 2 guard: if this attribution has no option (imported row / absent user),
          // add one carrying the stored value, labelled from the row's resolved `by`, so the
          // select always equals the stored value — never blank, never a silent rewrite.
          if (!els.bySelect.querySelector(`option[value="${val}"]`)) {
            els.bySelect.insertAdjacentHTML('afterbegin', `<option value="${escapeHtml(val)}">${escapeHtml(e.by || 'Unknown')}</option>`);
          }
          els.bySelect.value = val; els.customWrap.hidden = true;
        }
        else { els.bySelect.value = 'custom'; els.customWrap.hidden = false; els.byCustom.value = e.byLabel || ''; }
        els.ledgerSelect.value = e.ledgerCode;
        buildSubs(e.ledgerCode);
        els.subSelect.value = e.subledgerCode || '';
        syncCustom(els.ledgerSelect, els.ledgerCustomWrap, els.ledgerCustom);
        if (e.ledgerCode === CUSTOM_CODE) els.ledgerCustom.value = e.ledgerCustomName || '';
        syncCustom(els.subSelect, els.subCustomWrap, els.subCustom);
        if (e.subledgerCode === CUSTOM_CODE) els.subCustom.value = e.subledgerCustomName || '';
        els.reason.value = e.reason || '';
        els.scopeSelect.value = e.contractScope;
        syncScope();
      },
      // Phase 4A — reset({ keepLedger:true }) carries the ledger + sub-ledger (and their Custom…
      // inputs + the built sub options) across a save, so a cluster of same-ledger entries needs only
      // the amount. Everything else — date (→today), amount, remark, By, scope — always clears;
      // those are per-entry and carrying them risks silently duplicating a figure. A plain reset()
      // (Cancel, and every non-cash-outflow caller) clears the ledger too, exactly as before.
      reset(opts = {}) {
        lastTxDate = null;
        if (datePicker) datePicker.reset(); // back to today
        els.amount.value = '';
        els.reason.value = '';
        els.byCustom.value = '';
        els.bySelect.selectedIndex = 0;
        els.customWrap.hidden = true;
        els.scopeSelect.value = '';
        if (els.serviceSelect) els.serviceSelect.value = '';
        if (els.allowanceSelect) els.allowanceSelect.value = '';
        syncScope();
        if (!opts.keepLedger) {
          els.ledgerSelect.value = '';
          buildSubs('');
          syncCustom(els.ledgerSelect, els.ledgerCustomWrap, els.ledgerCustom);
          syncCustom(els.subSelect, els.subCustomWrap, els.subCustom);
        }
      },
      readBody() {
        const amt = els.amount.value.trim().replace(/,/g, '');
        if (!/^\d+(\.\d{1,2})?$/.test(amt) || Number(amt) <= 0) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };
        const sel = els.bySelect.value;
        const body = { amountRupees: amt, reason: els.reason.value, ledgerCode: els.ledgerSelect.value, subledgerCode: els.subSelect.value, contractScope: els.scopeSelect.value };
        // Transaction date: from the picker when present (cash-outflow), else the
        // existing row's date carried from populate() (Overview modal has no picker).
        body.txDate = datePicker ? datePicker.getISO() : lastTxDate;
        if (sel.startsWith('user:')) { body.byType = 'user'; body.byUserId = Number(sel.slice(5)); }
        else if (sel === 'custom') { body.byType = 'custom'; body.byLabel = els.byCustom.value.trim(); if (!body.byLabel) return { error: 'Enter a name for the custom source.' }; }
        else return { error: 'Select who the money is from.' };
        if (!els.ledgerSelect.value) return { error: 'Select a valid ledger.' };
        if (els.ledgerSelect.value === CUSTOM_CODE) { body.ledgerCustomName = els.ledgerCustom.value.trim(); if (!body.ledgerCustomName) return { error: 'Enter a name for the custom ledger.' }; }
        if (els.subSelect.value === CUSTOM_CODE) { body.subledgerCustomName = els.subCustom.value.trim(); if (!body.subledgerCustomName) return { error: 'Enter a name for the custom sub-ledger.' }; }
        if (!els.scopeSelect.value) return { error: 'Select whether the work is included in the contract (Yes or No).' };
        // Record WHICH service this spend was for (provenance) and WHICH allowance cap it draws
        // against. Both optional and independent: picking neither sends no link, which stays
        // perfectly valid, and the key being ABSENT is what tells the server to preserve an
        // existing link on an edit.
        if (els.serviceSelect && els.scopeSelect.value === 'included' && els.serviceSelect.value) {
          body.contractServiceId = Number(els.serviceSelect.value);
        }
        if (els.allowanceSelect && els.scopeSelect.value === 'included' && els.allowanceSelect.value) {
          body.contractAllowanceId = Number(els.allowanceSelect.value);
        }
        return { body };
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Standalone Ledger -> Sub-ledger picker: the SAME dependent dropdowns + "Custom…"
  // sentinel reveals as the Cash Outflow ledger fields (same CUSTOM_CODE sentinel and
  // window.LEDGERS source, byte-identical build/sync logic), but WITHOUT the rest of
  // the cash-out form — so a screen that needs only the ledger identity (Contract
  // Services) can host it. createCashOutForm is deliberately left as-is so the cash
  // outflow / overview forms stay byte-identical.
  //   els: { ledgerSelect, ledgerCustomWrap, ledgerCustom, subSelect, subCustomWrap, subCustom }
  // Methods: populate({ ledgerCode, subledgerCode, ledgerCustomName, subledgerCustomName })
  //          · reset() · readBody() -> { body:{ ledgerCode, subledgerCode, [ledgerCustomName], [subledgerCustomName] } } | { error }
  function createLedgerPicker(els) {
    const LEDGERS = root.LEDGERS || [];
    function buildLedgers() {
      els.ledgerSelect.innerHTML = '<option value="">— select ledger —</option>' +
        LEDGERS.map((l) => `<option value="${l.code}">${escapeHtml(l.code + ' ' + l.name)}</option>`).join('') +
        `<option value="${CUSTOM_CODE}">Custom…</option>`;
    }
    function buildSubs(ledgerCode) {
      const l = ledgerCode === CUSTOM_CODE ? null : LEDGERS.find((x) => x.code === ledgerCode);
      const subs = l ? l.subLedgers : [];
      els.subSelect.innerHTML = '<option value="">— none —</option>' +
        subs.map((s) => `<option value="${s.code}">${escapeHtml(s.code + ' ' + s.name)}</option>`).join('') +
        `<option value="${CUSTOM_CODE}">Custom…</option>`;
      els.subSelect.disabled = !ledgerCode;
    }
    function syncCustom(selectEl, wrapEl, inputEl) {
      const on = selectEl.value === CUSTOM_CODE;
      wrapEl.hidden = !on;
      if (!on) inputEl.value = '';
    }
    els.ledgerSelect.addEventListener('change', () => {
      buildSubs(els.ledgerSelect.value);
      syncCustom(els.ledgerSelect, els.ledgerCustomWrap, els.ledgerCustom);
      syncCustom(els.subSelect, els.subCustomWrap, els.subCustom);
    });
    els.subSelect.addEventListener('change', () => syncCustom(els.subSelect, els.subCustomWrap, els.subCustom));

    buildLedgers();
    buildSubs('');

    return {
      populate(s) {
        els.ledgerSelect.value = s.ledgerCode || '';
        buildSubs(s.ledgerCode || '');
        els.subSelect.value = s.subledgerCode || '';
        syncCustom(els.ledgerSelect, els.ledgerCustomWrap, els.ledgerCustom);
        if (s.ledgerCode === CUSTOM_CODE) els.ledgerCustom.value = s.ledgerCustomName || '';
        syncCustom(els.subSelect, els.subCustomWrap, els.subCustom);
        if (s.subledgerCode === CUSTOM_CODE) els.subCustom.value = s.subledgerCustomName || '';
      },
      reset() {
        els.ledgerSelect.value = '';
        buildSubs('');
        syncCustom(els.ledgerSelect, els.ledgerCustomWrap, els.ledgerCustom);
        syncCustom(els.subSelect, els.subCustomWrap, els.subCustom);
      },
      readBody() {
        if (!els.ledgerSelect.value) return { error: 'Select a valid ledger.' };
        const body = { ledgerCode: els.ledgerSelect.value, subledgerCode: els.subSelect.value };
        if (els.ledgerSelect.value === CUSTOM_CODE) { body.ledgerCustomName = els.ledgerCustom.value.trim(); if (!body.ledgerCustomName) return { error: 'Enter a name for the custom ledger.' }; }
        if (els.subSelect.value === CUSTOM_CODE) { body.subledgerCustomName = els.subCustom.value.trim(); if (!body.subledgerCustomName) return { error: 'Enter a name for the custom sub-ledger.' }; }
        return { body };
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Shared cyber-HUD confirmation modal — a styled stand-in for window.confirm on
  // COMMIT actions. Lazily injects ONE dialog into <body>; returns Promise<bool>.
  // Used for the "save an edit to an EXISTING record" confirmation.
  //   confirmModal({ title, message, confirmLabel }) -> Promise<boolean>
  // ---------------------------------------------------------------------------
  let _confirmWrap = null;
  function confirmModal(o) {
    o = o || {};
    if (!_confirmWrap) {
      const wrap = document.createElement('div');
      wrap.className = 'pl-confirm-backdrop';
      wrap.hidden = true;
      wrap.innerHTML =
        '<div class="pl-confirm" role="alertdialog" aria-modal="true" aria-labelledby="plcTitle" aria-describedby="plcMsg">' +
          '<div class="pl-confirm-head"><h2 id="plcTitle"></h2></div>' +
          '<p id="plcMsg"></p>' +
          '<div class="pl-confirm-actions">' +
            '<button type="button" class="btn ghost" data-plc="cancel">Cancel</button>' +
            '<button type="button" class="btn primary" data-plc="ok"></button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      _confirmWrap = wrap;
    }
    const wrap = _confirmWrap;
    wrap.querySelector('#plcTitle').textContent = o.title || 'Are you sure?';
    wrap.querySelector('#plcMsg').textContent = o.message || '';
    const ok = wrap.querySelector('[data-plc="ok"]');
    const cancel = wrap.querySelector('[data-plc="cancel"]');
    ok.textContent = o.confirmLabel || 'Confirm';
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return; done = true;
        wrap.hidden = true;
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        wrap.removeEventListener('mousedown', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onBackdrop = (e) => { if (e.target === wrap) finish(false); };
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      wrap.addEventListener('mousedown', onBackdrop);
      document.addEventListener('keydown', onKey);
      wrap.hidden = false;
      ok.focus();
    });
  }

  // Shared cyber-HUD CHOICE modal — like confirmModal but with N labelled options.
  // Resolves the chosen option's `value`, or null if cancelled/dismissed.
  //   choiceModal({ title, message, options:[{label, value}] }) -> Promise<value|null>
  let _choiceWrap = null;
  function choiceModal(o) {
    o = o || {};
    if (!_choiceWrap) {
      const wrap = document.createElement('div');
      wrap.className = 'pl-confirm-backdrop';
      wrap.hidden = true;
      wrap.innerHTML =
        '<div class="pl-confirm" role="dialog" aria-modal="true" aria-labelledby="plChTitle" aria-describedby="plChMsg">' +
          '<div class="pl-confirm-head"><h2 id="plChTitle"></h2></div>' +
          '<p id="plChMsg"></p>' +
          '<div class="pl-confirm-actions" id="plChActions"></div>' +
        '</div>';
      document.body.appendChild(wrap);
      _choiceWrap = wrap;
    }
    const wrap = _choiceWrap;
    const opts = o.options || [];
    wrap.querySelector('#plChTitle').textContent = o.title || 'Choose';
    wrap.querySelector('#plChMsg').textContent = o.message || '';
    const actions = wrap.querySelector('#plChActions');
    actions.innerHTML = opts.map((op, i) => `<button type="button" class="btn ${i === 0 ? 'primary' : 'ghost'}" data-ch="${i}">${escapeHtml(op.label)}</button>`).join('') +
      '<button type="button" class="btn ghost" data-ch="cancel">Cancel</button>';
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return; done = true;
        wrap.hidden = true;
        actions.removeEventListener('click', onClick);
        wrap.removeEventListener('mousedown', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onClick = (e) => { const b = e.target.closest && e.target.closest('[data-ch]'); if (!b) return; const c = b.getAttribute('data-ch'); finish(c === 'cancel' ? null : opts[Number(c)].value); };
      const onBackdrop = (e) => { if (e.target === wrap) finish(null); };
      const onKey = (e) => { if (e.key === 'Escape') finish(null); };
      actions.addEventListener('click', onClick);
      wrap.addEventListener('mousedown', onBackdrop);
      document.addEventListener('keydown', onKey);
      wrap.hidden = false;
      const first = actions.querySelector('button'); if (first) first.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // Shared BULK-EDITABLE cash_out table — ONE implementation used by the Overview
  // table AND the Money Debited log. Read mode shows rows; enterEdit() turns every
  // (filtered) row into inline inputs; the page's "Save All" calls collect() for
  // per-row validation, saves the valid CHANGED rows, and flags + holds back the
  // rest (bad rows stay editable, highlighted). Fixed columns: Serial, Date, Ledger,
  // Sub-ledger, Amount, By, Remark, Contract Included, (status/actions).
  //   opts: { tbody, emptyText, onDirty(bool) }
  //   setUser(u) · setEntries(list) · setFilter(fn) · enterEdit() · cancelEdit()
  //   · isEditing() · isDirty() · collect() -> { valid:[{id,body}], invalid:[{id,msg}], changed }
  //   · flag(id,msg) · markSaved(id)
  // Validation strings mirror createCashOutForm.readBody (single source of rules).
  // ---------------------------------------------------------------------------
  const TX_COLSPAN = 9; // Serial,Date,Ledger,Sub-ledger,Amount,By,Remark,Contract Included,(actions)
  function createEditableCashOutTable(opts) {
    const LEDGERS = root.LEDGERS || [];
    const tbody = opts.tbody;
    const tableEl = tbody.closest('table'); // Phase 3B: collapse the empty actions column in read mode
    const onDirty = opts.onDirty || function () {};
    let user = null;      // session user — fallback roster when /api/users is unavailable
    let roster = [];      // Phase 2: full user list ({id, displayName}) for the By dropdown
    let entries = [];
    let filter = function () { return true; };
    let editing = false;
    const base = new Map();     // id -> baseline field-value strings (for dirty detection)
    const dirtySet = new Set();  // Phase 6D: ids of currently-changed rows — isDirty() is a size check
                                 // instead of re-scanning every row on each keystroke. render() resets it.
    // Overview-scoped chrome (opt-in; the Money Debited log passes neither, so it is
    // unchanged): tooltips = mark Ledger/Sub-ledger cells so a width-truncated name can
    // be revealed in full; deleteInEditMode = hide the per-row Delete until Edit is active.
    const tooltips = !!opts.tooltips;
    const deleteInEdit = !!opts.deleteInEditMode;

    const inclText = (s) => (s === 'included' ? 'Yes' : 'No'); // "Contract Included" display
    const FIELDS = ['date', 'amount', 'by', 'byLabel', 'ledger', 'ledgerCustom', 'sub', 'subCustom', 'reason', 'scope'];

    // Ledger and sub-ledger resolved to display names for their SEPARATE columns.
    function ledgerName(e) {
      if (e.ledgerCode === CUSTOM_CODE) return e.ledgerCustomName || '';
      const l = LEDGERS.find((x) => x.code === e.ledgerCode);
      return l ? (l.code + ' ' + l.name) : (e.ledgerCode || '');
    }
    function subName(e) {
      if (!e.subledgerCode) return '';
      if (e.subledgerCode === CUSTOM_CODE) return e.subledgerCustomName || '';
      const l = LEDGERS.find((x) => x.code === e.ledgerCode);
      const s = l && l.subLedgers.find((x) => x.code === e.subledgerCode);
      return s ? (s.code + ' ' + s.name) : e.subledgerCode;
    }

    function fieldVals(e) {
      return {
        date: formatDate(e.txDate),
        amount: paiseToInput(e.amountPaise),
        by: e.byType === 'user' ? ('user:' + e.byUserId) : 'custom',
        byLabel: e.byType === 'user' ? '' : (e.byLabel || ''),
        ledger: e.ledgerCode || '',
        ledgerCustom: e.ledgerCode === CUSTOM_CODE ? (e.ledgerCustomName || '') : '',
        sub: e.subledgerCode || '',
        subCustom: e.subledgerCode === CUSTOM_CODE ? (e.subledgerCustomName || '') : '',
        reason: e.reason || '',
        scope: e.contractScope || 'extra',
      };
    }
    function ledgerOptions(sel) {
      return '<option value="">— select —</option>' +
        LEDGERS.map((l) => `<option value="${escapeHtml(l.code)}"${l.code === sel ? ' selected' : ''}>${escapeHtml(l.code + ' ' + l.name)}</option>`).join('') +
        `<option value="${CUSTOM_CODE}"${sel === CUSTOM_CODE ? ' selected' : ''}>Custom…</option>`;
    }
    function subOptions(ledgerCode, sel) {
      const l = ledgerCode === CUSTOM_CODE ? null : LEDGERS.find((x) => x.code === ledgerCode);
      const subs = l ? l.subLedgers : [];
      return '<option value="">— none —</option>' +
        subs.map((s) => `<option value="${escapeHtml(s.code)}"${s.code === sel ? ' selected' : ''}>${escapeHtml(s.code + ' ' + s.name)}</option>`).join('') +
        `<option value="${CUSTOM_CODE}"${sel === CUSTOM_CODE ? ' selected' : ''}>Custom…</option>`;
    }
    const dash = '<span class="tx-dim">—</span>';
    function readRow(e, i) {
      return `<tr data-id="${e.id}">
        <td data-label="Serial" class="tx-slno">${i + 1}</td>
        <td data-label="Date" class="tx-date">${e.txDate ? escapeHtml(formatDate(e.txDate)) : dash}</td>
        <td data-label="Ledger"${tooltips ? ` class="tx-tip" data-full="${escapeHtml(ledgerName(e))}"` : ''}>${tooltips ? '<span class="tx-clabel">Ledger</span>' : ''}${escapeHtml(ledgerName(e)) || dash}</td>
        <td data-label="Sub-ledger"${tooltips ? ` class="tx-tip" data-full="${escapeHtml(subName(e))}"` : ''}>${tooltips ? '<span class="tx-clabel">Sub-ledger</span>' : ''}${escapeHtml(subName(e)) || dash}</td>
        <td data-label="Amount" class="tx-amount">${formatPaise(e.amountPaise)}</td>
        <td data-label="By">${escapeHtml(e.by)}</td>
        <td data-label="Remark">${e.reason ? escapeHtml(e.reason) : dash}</td>
        <td data-label="In Contract?">${inclText(e.contractScope)}</td>
        <td class="tx-actions">${deleteInEdit ? '' : `<button type="button" class="tx-btn del" data-del="${e.id}">Delete</button>`}</td>
      </tr>`;
    }
    function editRow(e, i) {
      const v = fieldVals(e);
      // Phase 2: build one option per real user from the roster, selected by EXACT match
      // (v.by === 'user:' + u.id) — never indexOf. indexOf was the data-corruption bug: it
      // marked ANY 'user:*' attribution as "this user", so viewing user 2 rendered user 1's
      // row as user 2 and Save All silently rewrote it. Fall back to the session user only
      // when the roster is unavailable (degraded, never blank).
      const list = roster.length ? roster : (user ? [user] : []);
      let byOpts = list.map((u) => `<option value="user:${u.id}"${v.by === 'user:' + u.id ? ' selected' : ''}>${escapeHtml(u.displayName)}</option>`).join('');
      // Guard against this bug class recurring: if the stored 'user:' attribution matches NO
      // option (imported row, NULL by_user_id, or a user absent from this install), add an
      // option carrying the row's ACTUAL stored value, selected, labelled from its already-
      // resolved `by` text. The select's value then always equals the stored attribution, so
      // an untouched row is a guaranteed no-op on save.
      if (v.by.indexOf('user:') === 0 && !list.some((u) => v.by === 'user:' + u.id)) {
        byOpts += `<option value="${escapeHtml(v.by)}" selected>${escapeHtml(e.by || 'Unknown')}</option>`;
      }
      byOpts += `<option value="custom"${v.by === 'custom' ? ' selected' : ''}>Custom…</option>`;
      return `<tr data-id="${e.id}" class="tx-editing">
        <td data-label="Serial" class="tx-slno">${i + 1}</td>
        <td data-label="Date"><input type="text" class="tx-in" data-f="date" placeholder="dd/mm/yy" maxlength="10" value="${escapeHtml(v.date)}"></td>
        <td data-label="Ledger">
          <select class="tx-sel" data-f="ledger">${ledgerOptions(v.ledger)}</select>
          <input type="text" class="tx-in tx-sub" data-f="ledgerCustom" placeholder="Custom ledger" maxlength="80" value="${escapeHtml(v.ledgerCustom)}"${v.ledger === CUSTOM_CODE ? '' : ' hidden'}>
        </td>
        <td data-label="Sub-ledger">
          <select class="tx-sel" data-f="sub">${subOptions(v.ledger, v.sub)}</select>
          <input type="text" class="tx-in tx-sub" data-f="subCustom" placeholder="Custom sub-ledger" maxlength="80" value="${escapeHtml(v.subCustom)}"${v.sub === CUSTOM_CODE ? '' : ' hidden'}>
        </td>
        <td data-label="Amount"><input type="text" inputmode="decimal" class="tx-in tx-num" data-f="amount" value="${escapeHtml(v.amount)}"></td>
        <td data-label="By">
          <select class="tx-sel" data-f="by">${byOpts}</select>
          <input type="text" class="tx-in tx-sub" data-f="byLabel" placeholder="Name" maxlength="60" value="${escapeHtml(v.byLabel)}"${v.by === 'custom' ? '' : ' hidden'}>
        </td>
        <td data-label="Remark"><input type="text" class="tx-in" data-f="reason" maxlength="300" value="${escapeHtml(v.reason)}"></td>
        <td data-label="In Contract?">
          <select class="tx-sel" data-f="scope">
            <option value="included"${v.scope === 'included' ? ' selected' : ''}>Yes</option>
            <option value="extra"${v.scope === 'extra' ? ' selected' : ''}>No</option>
          </select>
        </td>
        <td class="tx-actions">${deleteInEdit ? `<button type="button" class="tx-btn del" data-del="${e.id}">Delete</button>` : ''}<span class="tx-rowmsg" data-msg></span></td>
      </tr>`;
    }
    function visible() { return entries.filter(filter); }
    function render() {
      const rows = visible();
      base.clear();
      dirtySet.clear(); // Phase 6D: innerHTML is about to be rewritten; a fresh render has no dirty
                        // rows (baseline == the values just rendered) and can't retain stale ids.
      // Phase 3B: collapse the empty actions column in read mode; restore it in edit mode.
      if (tableEl) tableEl.classList.toggle('tx-actions-collapsed', !editing);
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="${TX_COLSPAN}" class="tx-empty">${escapeHtml(opts.emptyText || 'No entries yet.')}</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map((e, i) => (editing ? editRow(e, i) : readRow(e, i))).join('');
      if (editing) rows.forEach((e) => base.set(e.id, fieldVals(e)));
    }

    // Delegated per-row wiring (edit mode only): dependent Ledger→Sub, custom reveals,
    // By→custom-label reveal, and dirty notification.
    tbody.addEventListener('change', (ev) => {
      if (!editing || !ev.target.getAttribute) return;
      const f = ev.target.getAttribute('data-f');
      if (!f) return;
      const tr = ev.target.closest('tr');
      if (f === 'ledger') {
        const lc = ev.target.value;
        tr.querySelector('[data-f="sub"]').innerHTML = subOptions(lc, '');
        tr.querySelector('[data-f="ledgerCustom"]').hidden = lc !== CUSTOM_CODE;
        tr.querySelector('[data-f="subCustom"]').hidden = true;
      } else if (f === 'sub') {
        tr.querySelector('[data-f="subCustom"]').hidden = ev.target.value !== CUSTOM_CODE;
      } else if (f === 'by') {
        tr.querySelector('[data-f="byLabel"]').hidden = ev.target.value !== 'custom';
      }
      updateRowDirty(tr); onDirty(isDirty());
    });
    tbody.addEventListener('input', (ev) => {
      if (!editing || !ev.target.getAttribute || !ev.target.getAttribute('data-f')) return;
      updateRowDirty(ev.target.closest('tr')); onDirty(isDirty());
    });
    // Phase 6D: recompute dirtiness for THIS row only and update its membership in dirtySet.
    // rowChanged stays the single source of truth per row, so typing a value and typing the
    // original back removes the row from the set (revert clears dirtiness — not "once dirty, always").
    function updateRowDirty(tr) {
      if (!tr) return;
      const id = Number(tr.getAttribute('data-id'));
      if (rowChanged(tr)) dirtySet.add(id); else dirtySet.delete(id);
    }

    function rowVals(tr) {
      const o = {};
      FIELDS.forEach((f) => { const el = tr.querySelector(`[data-f="${f}"]`); o[f] = el ? el.value : ''; });
      return o;
    }
    function rowChanged(tr) {
      const b = base.get(Number(tr.getAttribute('data-id')));
      if (!b) return false;
      const cur = rowVals(tr);
      return FIELDS.some((f) => (cur[f] || '') !== (b[f] || ''));
    }
    function buildBody(tr) {
      const v = rowVals(tr);
      const amt = v.amount.trim().replace(/,/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(amt) || Number(amt) <= 0) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };
      const iso = parseDmy(v.date); // dd/mm/yy -> ISO (display-only format; storage stays ISO)
      if (!iso) return { error: 'Enter a valid date as dd/mm/yy.' };
      const body = { amountRupees: amt, txDate: iso, reason: v.reason, contractScope: v.scope, ledgerCode: v.ledger, subledgerCode: v.sub };
      if (v.by.indexOf('user:') === 0) { body.byType = 'user'; body.byUserId = Number(v.by.slice(5)); }
      else if (v.by === 'custom') { body.byType = 'custom'; body.byLabel = v.byLabel.trim(); if (!body.byLabel) return { error: 'Enter a name for the custom source.' }; }
      else return { error: 'Select who the money is from.' };
      if (!v.ledger) return { error: 'Select a valid ledger.' };
      if (v.ledger === CUSTOM_CODE) { body.ledgerCustomName = v.ledgerCustom.trim(); if (!body.ledgerCustomName) return { error: 'Enter a name for the custom ledger.' }; }
      if (v.sub === CUSTOM_CODE) { body.subledgerCustomName = v.subCustom.trim(); if (!body.subledgerCustomName) return { error: 'Enter a name for the custom sub-ledger.' }; }
      if (!v.scope) return { error: 'Select whether the work is included in the contract (Yes or No).' };
      // The contract-stated amount is gone: 'included' is now just a label. The PUT deliberately omits
      // contractServiceId, which tells the server to PRESERVE an existing service link on edit.
      return { body };
    }
    function setRowMsg(tr, msg) {
      const cell = tr.querySelector('[data-msg]');
      if (cell) cell.textContent = msg || '';
      tr.classList.toggle('tx-err', !!msg);
    }
    function isDirty() {
      // Phase 6D: O(1) — the dirty set is kept current by updateRowDirty on each input/change.
      return editing && dirtySet.size > 0;
    }

    return {
      setUser(u) { user = u; },
      setRoster(list) { roster = Array.isArray(list) ? list : []; if (editing) render(); }, // Phase 2
      setEntries(list) { entries = list || []; editing = false; render(); onDirty(false); },
      setFilter(fn) { filter = fn || function () { return true; }; if (!editing) render(); },
      isEditing() { return editing; },
      isDirty: isDirty,
      enterEdit() { if (editing || !visible().length) return false; editing = true; render(); onDirty(false); return true; },
      cancelEdit() { editing = false; render(); onDirty(false); },
      collect() {
        const valid = [], invalid = [];
        let byChanges = 0; // Phase 2: rows whose "By" (who paid) attribution changed — surfaced loudly before save
        [].slice.call(tbody.querySelectorAll('tr[data-id]')).forEach((tr) => {
          const id = Number(tr.getAttribute('data-id'));
          if (!rowChanged(tr)) { setRowMsg(tr, ''); return; }
          const b0 = base.get(id), cur = rowVals(tr);
          if (b0 && (cur.by !== b0.by || cur.byLabel !== b0.byLabel)) byChanges++;
          const b = buildBody(tr);
          if (b.error) { setRowMsg(tr, b.error); invalid.push({ id: id, msg: b.error }); }
          else { setRowMsg(tr, ''); valid.push({ id: id, body: b.body }); }
        });
        return { valid: valid, invalid: invalid, changed: valid.length + invalid.length, byChanges: byChanges };
      },
      flag(id, msg) { const tr = tbody.querySelector(`tr[data-id="${id}"]`); if (tr) setRowMsg(tr, msg); },
      markSaved(id) { const tr = tbody.querySelector(`tr[data-id="${id}"]`); if (tr) { setRowMsg(tr, ''); base.set(id, rowVals(tr)); dirtySet.delete(id); onDirty(isDirty()); } }, // Phase 6D: baseline now matches -> row no longer dirty
    };
  }

  // Shared "Save All" confirm message built from a collect() result — INCLUDING the loud
  // attribution warning when any row changes who paid. Both Overview and Money Debited call
  // this, so no Save All consumer can silently omit the warning (that omission was the bug).
  function saveAllMessage(c) {
    const total = c.valid.length + c.invalid.length;
    let msg = `Save your edits to ${total} existing transaction${total === 1 ? '' : 's'}? This overwrites the saved record${total === 1 ? '' : 's'}.`;
    if (c.byChanges > 0) msg += ` ⚠ ${c.byChanges} ${c.byChanges === 1 ? 'entry' : 'entries'} will change who paid (the "By" attribution).`;
    return msg;
  }

  // Phase 6B — SHARED Save All batch write. Sends every valid changed row to POST /api/cash-out/batch
  // in ONE request (was one PUT per row), then applies the per-row results: markSaved on success,
  // flag on failure. Per-row hold-back is preserved (the server validates+writes each row
  // independently). Client-invalid rows in c.invalid were already flagged by collect(). Both pages
  // call this — the batch call lives here so a third consumer can't diverge (Phase 2.1's lesson).
  //   c    — a collect() result { valid:[{id,body}], invalid:[{id,msg}], ... }
  //   opts — { table (for markSaved/flag), headers (extra request headers) }
  // Returns { saved, held } (held includes the client-invalid rows).
  async function saveAllBatch(c, opts) {
    opts = opts || {};
    const table = opts.table;
    let held = c.invalid.length;      // client-invalid rows: already flagged in place by collect()
    if (!c.valid.length) return { saved: 0, held };
    const rows = c.valid.map((v) => Object.assign({ id: v.id }, v.body));
    let data;
    try {
      const res = await fetch('/api/cash-out/batch', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
        body: JSON.stringify({ rows: rows }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) { // whole-request failure (too-many 413 / rollback 500): flag every row
        const msg = data.error || 'Could not save.';
        c.valid.forEach((v) => table && table.flag(v.id, msg));
        return { saved: 0, held: held + c.valid.length, requestError: msg };
      }
    } catch {
      c.valid.forEach((v) => table && table.flag(v.id, 'Network error.'));
      return { saved: 0, held: held + c.valid.length, networkError: true };
    }
    let saved = 0;
    const byId = new Map((data.results || []).map((r) => [r.id, r]));
    for (const v of c.valid) {
      const r = byId.get(v.id);
      if (r && r.ok) { if (table) table.markSaved(v.id); saved++; }
      else { if (table) table.flag(v.id, (r && r.error) || 'Could not save this row.'); held++; }
    }
    return { saved: saved, held: held };
  }

  // ---------------------------------------------------------------------------
  // Part A — shared outflow FILTER BAR (Money Debited + Overview). Renders its own
  // controls into a container via DOM APIs (CSP-safe: classes only, no inline
  // style=). Reports the active filters up via onChange; the PAGE turns them into a
  // /api/cash-out?…  query (server-side filtering — never client-side over the DOM).
  //   opts: { container, showDates, onChange(filters) }
  //   returns: getFilters() · setCount(shown,total) · setEnabled(bool) · clearAll()
  // filters shape: { q, ledger, subledger, min, max, start?, end? } (strings/'' — the
  // page/ server parse). start/end only present when showDates.
  // ---------------------------------------------------------------------------
  function createLedgerFilterBar(opts) {
    const LEDGERS = root.LEDGERS || [];
    const container = opts.container;
    const showDates = !!opts.showDates;
    const onChange = opts.onChange || function () {};

    const el = (tag, cls, attrs) => { const n = document.createElement(tag); if (cls) n.className = cls; if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
    const opt = (value, label, sel) => { const o = document.createElement('option'); o.value = value; o.textContent = label; if (sel) o.selected = true; return o; };

    // ── controls row ──
    const bar = el('div', 'plf');
    const controls = el('div', 'plf-controls');

    const qField = el('label', 'plf-field plf-field-q'); qField.append(el('span', 'plf-lbl')); qField.lastChild.textContent = 'Search';
    const q = el('input', 'plf-in', { type: 'search', placeholder: 'Remark or custom name…', maxlength: '100', 'aria-label': 'Search remark or custom name' });
    qField.append(q);

    const ledgerField = el('label', 'plf-field'); ledgerField.append(el('span', 'plf-lbl')); ledgerField.lastChild.textContent = 'Ledger';
    const ledger = el('select', 'plf-sel', { 'aria-label': 'Filter by ledger' });
    ledger.append(opt('', '— any ledger —', true));
    LEDGERS.forEach((l) => ledger.append(opt(l.code, l.code + ' ' + l.name)));
    ledger.append(opt(CUSTOM_CODE, 'Custom'));
    ledgerField.append(ledger);

    const subField = el('label', 'plf-field'); subField.append(el('span', 'plf-lbl')); subField.lastChild.textContent = 'Sub-ledger';
    const sub = el('select', 'plf-sel', { 'aria-label': 'Filter by sub-ledger' });
    sub.append(opt('', '— any —', true)); sub.disabled = true;
    subField.append(sub);

    const minField = el('label', 'plf-field plf-field-amt'); minField.append(el('span', 'plf-lbl')); minField.lastChild.textContent = 'Min ₹';
    const min = el('input', 'plf-in plf-num', { type: 'text', inputmode: 'decimal', placeholder: '0', 'aria-label': 'Minimum amount in rupees' });
    minField.append(min);
    const maxField = el('label', 'plf-field plf-field-amt'); maxField.append(el('span', 'plf-lbl')); maxField.lastChild.textContent = 'Max ₹';
    const max = el('input', 'plf-in plf-num', { type: 'text', inputmode: 'decimal', placeholder: 'any', 'aria-label': 'Maximum amount in rupees' });
    maxField.append(max);

    let start = null, end = null;
    if (showDates) {
      const sField = el('label', 'plf-field'); sField.append(el('span', 'plf-lbl')); sField.lastChild.textContent = 'From';
      start = el('input', 'plf-in plf-date', { type: 'date', 'aria-label': 'From date' }); sField.append(start);
      const eField = el('label', 'plf-field'); eField.append(el('span', 'plf-lbl')); eField.lastChild.textContent = 'To';
      end = el('input', 'plf-in plf-date', { type: 'date', 'aria-label': 'To date' }); eField.append(end);
      controls.append(sField, eField);
    }
    controls.append(qField, ledgerField, subField, minField, maxField);
    bar.append(controls);

    // ── status row: count + active-filter chips + Clear all ──
    const status = el('div', 'plf-status');
    const count = el('span', 'plf-count');
    const chips = el('span', 'plf-chips');
    const clearBtn = el('button', 'plf-clear', { type: 'button' }); clearBtn.textContent = 'Clear all'; clearBtn.hidden = true;
    status.append(count, chips, clearBtn);
    bar.append(status);
    container.append(bar);

    // Dependent Ledger → Sub-ledger options (mirrors the entry form / editable table).
    function refreshSubs() {
      const l = LEDGERS.find((x) => x.code === ledger.value);
      const subs = l ? l.subLedgers : [];
      sub.replaceChildren(opt('', '— any —', true));
      subs.forEach((s) => sub.append(opt(s.code, s.code + ' ' + s.name)));
      sub.disabled = subs.length === 0;
    }

    function getFilters() {
      const f = { q: q.value.trim(), ledger: ledger.value || '', subledger: (ledger.value && sub.value) || '', min: min.value.trim(), max: max.value.trim() };
      if (showDates) { f.start = start.value || ''; f.end = end.value || ''; }
      return f;
    }
    function activeChips() {
      const f = getFilters(); const out = [];
      if (f.q) out.push('Search “' + f.q + '”');
      if (f.ledger) out.push('Ledger ' + (f.ledger === CUSTOM_CODE ? 'Custom' : f.ledger) + (f.subledger ? ' · ' + f.subledger : ''));
      if (f.min) out.push('≥ ₹' + f.min);
      if (f.max) out.push('≤ ₹' + f.max);
      if (showDates && f.start) out.push('from ' + formatDate(f.start));
      if (showDates && f.end) out.push('to ' + formatDate(f.end));
      return out;
    }
    function renderChips() {
      const list = activeChips();
      chips.replaceChildren(...list.map((tx) => { const c = el('span', 'plf-chip'); c.textContent = tx; return c; }));
      clearBtn.hidden = list.length === 0;
    }
    // setCount(shown, total): the page passes the SQL result count + the unfiltered total.
    function setCount(shown, total) {
      renderChips();
      const active = activeChips().length > 0;
      if (total == null) { count.textContent = shown + (shown === 1 ? ' entry' : ' entries'); return; }
      count.textContent = active ? ('Showing ' + shown + ' of ' + total) : (total + (total === 1 ? ' entry' : ' entries'));
    }

    // debounce the text box (keystrokes) — selects/amounts/dates fire immediately.
    let qTimer = null;
    const fire = () => onChange(getFilters());
    q.addEventListener('input', () => { if (qTimer) clearTimeout(qTimer); qTimer = setTimeout(fire, 250); });
    ledger.addEventListener('change', () => { refreshSubs(); fire(); });
    sub.addEventListener('change', fire);
    for (const inp of [min, max]) inp.addEventListener('change', fire);
    if (showDates) for (const d of [start, end]) d.addEventListener('change', fire);
    clearBtn.addEventListener('click', () => clearAll());

    function clearAll() {
      q.value = ''; ledger.value = ''; sub.value = ''; refreshSubs(); min.value = ''; max.value = '';
      if (showDates) { start.value = ''; end.value = ''; }
      fire();
    }
    function setEnabled(on) {
      for (const c of [q, ledger, sub, min, max, clearBtn].concat(showDates ? [start, end] : [])) c.disabled = !on;
      if (on) sub.disabled = !LEDGERS.find((x) => x.code === ledger.value); // keep sub disabled when no ledger
      bar.classList.toggle('plf-disabled', !on);
    }

    return { getFilters, setCount, setEnabled, clearAll };
  }

  // ===========================================================================================
  // Ledger browser — a searchable, grouped picker for the main ledger.
  //
  // The native <select> is fine for a dozen options. The taxonomy is 24 mains and ~160 sub-ledgers,
  // and on a phone that is an unscrollable wall with no way to find "granite" except by knowing it
  // lives under Finishes. This puts a search box over the whole taxonomy and collapses the mains
  // into seven sections.
  //
  // It does NOT replace the <select> elements — it drives them. The select stays in the DOM as the
  // value carrier, visually hidden, and every selection here writes to it and dispatches `change`,
  // so createCashOutForm/createLedgerPicker's existing buildSubs/syncCustom/readBody logic runs
  // exactly as before and none of it had to learn about this component.
  // ===========================================================================================

  // ---- THE grouping constant. Remapping the picker is editing this and nothing else. ----------
  // `from`/`to` are inclusive main-ledger numbers (the integer part of the N.0 code). Any main that
  // falls outside every range lands in a trailing "Other" group rather than vanishing — a taxonomy
  // edited through the Ledger List CSV can add a 25th main, and a picker that silently hid it would
  // be worse than an ugly one.
  //
  // Ranges follow the CURRENT taxonomy's own names (1.0 LAND & LEGAL … 24.0 CONTINGENCY &
  // UNPLANNED). For the v2 list, whose numbering runs Materials first, the mapping is the commented
  // block below — swap the two and nothing else changes.
  const LEDGER_GROUPS = [
    { name: 'Pre-construction', from: 1, to: 5 },   // land, design, approvals, site prep, temp setup
    { name: 'Materials', from: 6, to: 11 },
    { name: 'Labour', from: 12, to: 14 },
    { name: 'Fit-out', from: 15, to: 17 },          // kitchen, interiors, appliances
    { name: 'Site & external', from: 18, to: 21 },
    { name: 'Money', from: 22, to: 22 },
    { name: 'Closing', from: 23, to: 24 },
  ];
  // const LEDGER_GROUPS = [                        // v2 taxonomy
  //   { name: 'Materials', from: 1, to: 7 },
  //   { name: 'Labour', from: 8, to: 11 },
  //   { name: 'Pre-construction', from: 12, to: 15 },
  //   { name: 'Contract boundaries', from: 16, to: 17 },
  //   { name: 'Post-contract', from: 18, to: 21 },
  //   { name: 'Money', from: 22, to: 22 },
  //   { name: 'Closing', from: 23, to: 24 },
  // ];

  const SEARCH_RESULT_CAP = 60; // a phone cannot use 200 results; narrow the query instead

  function groupLedgers(ledgers) {
    const out = LEDGER_GROUPS.map((g) => ({ name: g.name, ledgers: [] }));
    const other = { name: 'Other', ledgers: [] };
    for (const l of ledgers) {
      const n = parseInt(l.code, 10);
      const gi = LEDGER_GROUPS.findIndex((g) => n >= g.from && n <= g.to);
      (gi < 0 ? other : out[gi]).ledgers.push(l);
    }
    if (other.ledgers.length) out.push(other);
    return out.filter((g) => g.ledgers.length);
  }

  // What the trigger button reads. Mirrors the server's ledgerLabel so the closed picker and the
  // saved row say the same thing.
  function ledgerTriggerLabel(ledgerSelect, subSelect) {
    const code = ledgerSelect.value;
    if (!code) return '— select ledger —';
    if (code === CUSTOM_CODE) return 'Custom…';
    const L = (root.LEDGERS || []).find((x) => x.code === code);
    if (!L) return code;
    const sub = subSelect && subSelect.value;
    if (sub && sub !== CUSTOM_CODE) {
      const S = (L.subLedgers || []).find((x) => x.code === sub);
      if (S) return `${S.code} ${S.name}`;
    }
    if (sub === CUSTOM_CODE) return `${L.code} ${L.name} · Custom sub`;
    return `${L.code} ${L.name}`;
  }

  let _lbWrap = null;
  function ledgerBrowserPanel() {
    if (_lbWrap) return _lbWrap;
    const wrap = document.createElement('div');
    wrap.className = 'lb-backdrop';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="lb-panel" role="dialog" aria-modal="true" aria-label="Choose a ledger">' +
        '<div class="lb-head">' +
          '<input type="search" class="lb-search" placeholder="Search ledgers and sub-ledgers" aria-label="Search ledgers and sub-ledgers" autocomplete="off">' +
          '<button type="button" class="lb-close" data-act="close" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="lb-body" tabindex="-1"></div>' +
      '</div>';
    document.body.appendChild(wrap);
    _lbWrap = wrap;
    return wrap;
  }

  // els: { ledgerSelect, subSelect, trigger, label }
  function createLedgerBrowser(els) {
    const { ledgerSelect, subSelect, trigger, label } = els;

    function syncLabel() { label.textContent = ledgerTriggerLabel(ledgerSelect, subSelect); }
    ledgerSelect.addEventListener('change', syncLabel);
    if (subSelect) subSelect.addEventListener('change', syncLabel);
    syncLabel();

    // Choosing a ledger writes through the select and fires `change`, which is what makes every
    // existing consumer (sub-ledger rebuild, Custom… reveal, readBody) keep working untouched.
    function choose(code, subCode) {
      ledgerSelect.value = code;
      ledgerSelect.dispatchEvent(new Event('change', { bubbles: true }));
      if (subSelect) {
        subSelect.value = subCode || '';
        subSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncLabel();
    }

    function rowHtml(code, name, sub) {
      const cls = sub ? 'lb-row lb-row-sub' : 'lb-row lb-row-main';
      const attrs = sub ? `data-act="sub" data-code="${code}" data-sub="${sub}"` : `data-act="main" data-code="${code}"`;
      const shown = sub || code;
      return `<button type="button" class="${cls}" ${attrs}><span class="lb-code">${escapeHtml(shown)}</span><span class="lb-name">${escapeHtml(name)}</span></button>`;
    }

    function renderBrowse(body, openGroups, openMains) {
      const groups = groupLedgers(root.LEDGERS || []);
      body.innerHTML = groups.map((g, gi) => {
        const gOpen = openGroups.has(gi);
        const mains = g.ledgers.map((l) => {
          const mOpen = openMains.has(l.code);
          const subs = (l.subLedgers || []).map((sb) => rowHtml(l.code, sb.name, sb.code)).join('');
          return '<div class="lb-main">' +
            '<div class="lb-mainline">' +
              rowHtml(l.code, l.name) +
              `<button type="button" class="lb-expand" data-act="expand" data-code="${l.code}" aria-expanded="${mOpen}" aria-label="Sub-ledgers of ${escapeHtml(l.name)}"><span class="lb-caret">▸</span></button>` +
            '</div>' +
            `<div class="lb-subs"${mOpen ? '' : ' hidden'}>${subs}</div>` +
          '</div>';
        }).join('');
        return '<div class="lb-group">' +
          `<button type="button" class="lb-grouphead" data-act="group" data-i="${gi}" aria-expanded="${gOpen}">` +
            '<span class="lb-caret">▸</span>' +
            `<span class="lb-groupname">${escapeHtml(g.name)}</span>` +
            `<span class="lb-groupcount">${g.ledgers.length}</span>` +
          '</button>' +
          `<div class="lb-groupbody"${gOpen ? '' : ' hidden'}>${mains}</div>` +
        '</div>';
      }).join('') + `<button type="button" class="lb-row lb-row-custom" data-act="main" data-code="${CUSTOM_CODE}"><span class="lb-name">Custom…</span></button>`;
    }

    // Search flattens the tree: no point collapsing sections around three matches. Matches on the
    // sub-ledger name, the main's name, or either code, and a sub result shows the main it sits
    // under so "Misc" is never ambiguous across 24 identically-named entries.
    function renderSearch(body, q) {
      const needle = q.toLowerCase();
      const hits = [];
      for (const l of (root.LEDGERS || [])) {
        const mainHit = l.name.toLowerCase().includes(needle) || l.code.startsWith(needle);
        if (mainHit) hits.push({ code: l.code, name: l.name, sub: null, parent: null });
        for (const sb of (l.subLedgers || [])) {
          if (sb.name.toLowerCase().includes(needle) || sb.code.startsWith(needle)) {
            hits.push({ code: l.code, name: sb.name, sub: sb.code, parent: l.name });
          }
        }
      }
      if (!hits.length) {
        body.innerHTML = '<p class="lb-empty">Nothing matches that. Try a shorter word, or a code like 6.1.</p>';
        return;
      }
      const shown = hits.slice(0, SEARCH_RESULT_CAP);
      body.innerHTML = shown.map((h) => {
        const cls = h.sub ? 'lb-row lb-row-sub lb-row-flat' : 'lb-row lb-row-main lb-row-flat';
        const attrs = h.sub ? `data-act="sub" data-code="${h.code}" data-sub="${h.sub}"` : `data-act="main" data-code="${h.code}"`;
        const parent = h.parent ? `<span class="lb-parent">${escapeHtml(h.parent)}</span>` : '';
        return `<button type="button" class="${cls}" ${attrs}><span class="lb-code">${escapeHtml(h.sub || h.code)}</span><span class="lb-name">${escapeHtml(h.name)}</span>${parent}</button>`;
      }).join('')
        + (hits.length > shown.length ? `<p class="lb-empty">${hits.length - shown.length} more match — narrow the search.</p>` : '');
    }

    function open() {
      const wrap = ledgerBrowserPanel();
      const search = wrap.querySelector('.lb-search');
      const body = wrap.querySelector('.lb-body');
      const openGroups = new Set();
      const openMains = new Set();

      // Open the section (and the main) the current value sits in, so the picker starts where the
      // user already is rather than fully collapsed.
      const cur = ledgerSelect.value;
      if (cur && cur !== CUSTOM_CODE) {
        const groups = groupLedgers(root.LEDGERS || []);
        const gi = groups.findIndex((g) => g.ledgers.some((l) => l.code === cur));
        if (gi >= 0) openGroups.add(gi);
        if (subSelect && subSelect.value && subSelect.value !== CUSTOM_CODE) openMains.add(cur);
      }

      search.value = '';
      renderBrowse(body, openGroups, openMains);
      wrap.hidden = false;
      search.focus();

      const rerender = () => {
        const q = search.value.trim();
        if (q) renderSearch(body, q); else renderBrowse(body, openGroups, openMains);
      };

      const finish = () => {
        wrap.hidden = true;
        search.removeEventListener('input', rerender);
        body.removeEventListener('click', onClick);
        wrap.removeEventListener('mousedown', onBackdrop);
        document.removeEventListener('keydown', onKey);
        wrap.querySelector('.lb-close').removeEventListener('click', finish);
        trigger.focus();
      };

      function onClick(e) {
        const btn = e.target.closest && e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        if (act === 'group') {
          const i = Number(btn.getAttribute('data-i'));
          if (openGroups.has(i)) openGroups.delete(i); else openGroups.add(i);
          rerender();
        } else if (act === 'expand') {
          const code = btn.getAttribute('data-code');
          if (openMains.has(code)) openMains.delete(code); else openMains.add(code);
          rerender();
        } else if (act === 'main') {
          choose(btn.getAttribute('data-code'), '');
          finish();
        } else if (act === 'sub') {
          choose(btn.getAttribute('data-code'), btn.getAttribute('data-sub'));
          finish();
        }
      }
      const onBackdrop = (e) => { if (e.target === wrap) finish(); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(); } };

      search.addEventListener('input', rerender);
      body.addEventListener('click', onClick);
      wrap.addEventListener('mousedown', onBackdrop);
      document.addEventListener('keydown', onKey);
      wrap.querySelector('.lb-close').addEventListener('click', finish);
    }

    trigger.addEventListener('click', open);
    return { open, syncLabel };
  }

  root.PlannrUI = { formatPaise, formatOwed, paiseToInput, escapeHtml, formatDate, makeMsg, createCashOutForm, createLedgerPicker, createLedgerBrowser, LEDGER_GROUPS, createDatePicker: attachDatePicker, confirmModal, choiceModal, createEditableCashOutTable, createLedgerFilterBar, saveAllMessage, saveAllBatch };
})(window);
