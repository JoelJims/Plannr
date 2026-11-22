// Cross-platform plan, step 1.3 — what goes into the Overview PDF: the request's query checks, the
// figures and cash-out rows it is built from, and the HTML (escaping, palette, pie, tables). The only
// copy. Turning the HTML into a PDF stays with each platform, as decided in step 1.2: Playwright on
// the dev server (server.js), the print plugin on the phone (public/local-api.js). Both call
// createOverviewPdf(ctx) with computeOverview (core/routes/overview.js), LEDGER_CRUDS
// (core/ledger-crud.js), cashOutRow and CUSTOM_CODE (core/routes/cash-and-loans.js), and ledgerIndex.
import { parseIsoDate, fmtRs } from './parsers.js';

export function createOverviewPdf(ctx) {
  const { computeOverview, LEDGER_CRUDS, cashOutRow, CUSTOM_CODE, ledgerIndex } = ctx;

  // GET /api/overview/pdf's query: ?start=&end= (ISO, optional), ?part=full|pie|table|ledger,
  // ?theme=light|dark. -> { part, theme, range } or { error } (a 400).
  function readPdfQuery(query) {
    const s = parseIsoDate(query.start); if (s.error) return { error: 'Invalid start date (YYYY-MM-DD).' };
    const e = parseIsoDate(query.end); if (e.error) return { error: 'Invalid end date (YYYY-MM-DD).' };
    if (s.date && e.date && s.date > e.date) return { error: 'Start date must be on or before the end date.' };
    const part = ['full', 'pie', 'table', 'ledger'].includes(String(query.part)) ? String(query.part) : 'full';
    const theme = String(query.theme) === 'dark' ? 'dark' : 'light';
    return { part, theme, range: { start: s.date, end: e.date } };
  }

  const pdfEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Amber-family palette for the printed pie; Custom = deep amber (PDF_CUSTOM_COLOR).
  //
  // Phase C re-derived it, and it is the WEAK one of the two palettes — knowingly. Measured before:
  // min ΔE00 2.99, six pairs under 5, forty-seven under 10, and #8a5a2b appeared BOTH as the 18th
  // ledger's colour and as the Custom slice's, so those two slices were byte-identical whenever both
  // had spend. After: no exact duplicate, nothing under ΔE00 5, min 6.00 — but still 39 pairs under 10.
  //
  // That ceiling is structural, not laziness. Hue is the axis that separates categories; this palette
  // gives hue up by design to stay in the app's amber identity on white paper, leaving only lightness
  // and a little chroma to hold 24 categories apart. Measured alternatives, if that trade is ever
  // revisited: staying amber but allowing heavy drift into browns and olives reaches min ΔE00 11.64
  // (and stops reading as amber); dropping the hue constraint entirely reaches 20.14. Both are design
  // decisions about the report's identity, not bug fixes, so neither was taken unilaterally.
  const PDF_PALETTE = [
    '#f59e0b', '#ffc31b', '#9a5115', '#d97706', '#e3c153', '#973913', '#ef8a4b', '#d2b001',
    '#a56b1a', '#dda077', '#c2703d', '#e8d12f', '#7d452a', '#f6ba83', '#876322', '#d29e0f',
    '#ffcf70', '#845f44', '#eca955', '#6f4518', '#c2410c', '#b45f06', '#7c2d12', '#cea871'];
  // Custom's slice colour. Pulled out of the literal it used to be written as, because it also has to
  // participate in the distinctness check — the old code hard-coded a value that was already in the
  // palette, which no amount of checking the palette alone would ever have caught.
  const PDF_CUSTOM_COLOR = '#8a5a2b';
  // Ledgers past the fixed 24, same farthest-point derivation as overview.html's LEDGER_PALETTE_EXT
  // (see the long note there for why the golden-angle generator was retired). Not hue-constrained:
  // the old generator emitted full-spectrum hsl() here too, and forcing extras into an amber family
  // that cannot separate its own 24 would make things worse, not better.
  const PDF_PALETTE_EXT = [
    '#f720f8', '#1dc2fc', '#144ea8', '#058f67', '#d5cdf2', '#27f164', '#8e2b69', '#7f7a92',
    '#ff758f', '#b6d9cd', '#49554c', '#638af8', '#277f92', '#739114', '#851cf6', '#868779',
    '#0d6007', '#d41346', '#11b4b3', '#5d4e56', '#ca8ec6', '#f9c5c5', '#9dbf7c', '#a0adb9'];
  // Beyond 48 mains — unverified last resort, as on screen.
  function extraLedgerColor(extraIndex) {
    const hue = (extraIndex * 137.508) % 360;
    return `hsl(${hue.toFixed(1)}, 65%, 50%)`;
  }
  function pdfLedgerColor(idx) {
    if (idx < PDF_PALETTE.length) return PDF_PALETTE[idx];
    const ext = idx - PDF_PALETTE.length;
    return ext < PDF_PALETTE_EXT.length ? PDF_PALETTE_EXT[ext] : extraLedgerColor(ext - PDF_PALETTE_EXT.length);
  }
  function pdfSlices(o) {
    return (o.ledgers || []).filter((L) => L.totalPaise > 0).map((L) => {
      const idx = Math.max(0, ledgerIndex.list().findIndex((x) => x.code === L.code));
      const color = L.code === CUSTOM_CODE ? PDF_CUSTOM_COLOR : pdfLedgerColor(idx);
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

  // Build the standalone, light-theme print document for one part.
  // paise date 'YYYY-MM-DD' -> 'dd/mm/yy' for the PDF (display-only; storage stays ISO).
  function fmtDatePdf(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso == null ? '' : iso));
    return m ? (m[3] + '/' + m[2] + '/' + m[1].slice(2)) : String(iso == null ? '' : iso);
  }
  function buildOverviewPdfHtml(part, o, rows, range, theme) {
    const m = o.money;
    // Phase 4C — owed(F) is a signed balance (negative = overpaid; never clamped). Present a negative as
    // "Overpaid by ₹X" so it doesn't misread as money due. Same rule as the UI's PlannrUI.formatOwed.
    const fmtOwed = (v) => (v < 0 ? 'Overpaid by ' + fmtRs(-v) : fmtRs(v));
    const rangeLabel = (range.start || range.end) ? `${fmtDatePdf(range.start) || '…'} to ${fmtDatePdf(range.end) || '…'}` : 'All transactions';
    const slices = pdfSlices(o);
    const incl = (s) => (s === 'included' ? 'Yes' : 'No'); // "Contract Included" display

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
      // Phase 5D enforces a single contract, so this is singular now (the loop still maps the 0-or-1
      // array — correct for both cases). Heading + empty text reworded from the old "per contract".
      if (!o.contracts.length) return '<h2>Owed on the contract</h2><p class="muted">No contract yet.</p>';
      return '<h2>Owed on the contract</h2><table><thead><tr><th>Contractor</th><th>Area · Ledger</th><th class="num">Stated</th><th class="num">Paid</th><th class="num">Owed</th></tr></thead><tbody>' +
        o.contracts.map((c) => `<tr><td>${pdfEsc(c.contractorName || '—')}</td><td>${pdfEsc([c.areaOfWork, c.ledger].filter(Boolean).join(' · ')) || '—'}</td><td class="num">${fmtRs(c.statedPaise)}</td><td class="num">${fmtRs(c.paidPaise)}</td><td class="num ${c.owedPaise < 0 ? 'neg' : ''}">${fmtOwed(c.owedPaise)}</td></tr>`).join('') +
        `</tbody><tfoot><tr><td colspan="4">Owed to contractors (F)</td><td class="num">${fmtOwed(m.owedToContractorsPaise)}</td></tr></tfoot></table>`;
    };
    const budgetBlock = () => {
      if (o.budgetPaise == null) return '<h2>Budget</h2><p class="muted">No budget set. Total spent (D): <b>' + fmtRs(m.totalSpentPaise) + '</b>.</p>';
      // F4 option (b), decided by the owner 2026-11-22: the budget is for the whole project, so this
      // line uses the WHOLE project's spend, even when a range is set: "Spent" and "left" / "over" alike,
      // so it adds up (budget − spent = left). With a range set, "Spent" says "in total", because the
      // range's own D is in the headline figures. With no range the whole spend IS D.
      // Same rule as the screen's budget bar (public/overview.html, renderTotalBar).
      const whole = m.wholeProjectSpentPaise;
      const diff = o.budgetPaise - whole;
      const inTotal = (range.start || range.end) ? ' in total' : '';
      return `<h2>Budget vs actual</h2><p>Budget <b>${fmtRs(o.budgetPaise)}</b> · Spent <b>${fmtRs(whole)}</b>${inTotal} · ${diff < 0 ? '<b class="neg">' + fmtRs(-diff) + '</b> over total budget' : '<b>' + fmtRs(diff) + '</b> left of total budget'}.</p>`;
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
      // The Contract Stated column is gone with the reimbursement offset — the number it printed is
      // no longer written or used, so a column that would read '—' on every future row is not carried.
      // Contract Included (Yes/No) stays: that label is still recorded.
      return '<h2>Transactions</h2><table><thead><tr><th class="num">#</th><th>Date</th><th class="num">Amount</th><th>By</th><th>Ledger</th><th>Remark</th><th>Contract Included</th></tr></thead><tbody>' +
        rows.map((e, i) => `<tr><td class="num">${i + 1}</td><td>${e.txDate ? pdfEsc(fmtDatePdf(e.txDate)) : '—'}</td><td class="num">${fmtRs(e.amountPaise)}</td><td>${pdfEsc(e.by)}</td><td>${pdfEsc(e.ledger)}</td><td>${e.reason ? pdfEsc(e.reason) : '—'}</td><td>${incl(e.contractScope)}</td></tr>`).join('') +
        `</tbody><tfoot><tr><td colspan="2">Total (${rows.length})</td><td class="num">${fmtRs(total)}</td><td colspan="4"></td></tr></tfoot></table>`;
    };

    const TITLE = { full: 'Overview', summary: 'Overview — summary', pie: 'Spending by Ledger — chart', table: 'Transactions', ledger: 'Spending by Ledger' };
    let body;
    if (part === 'pie') body = pieBlock();
    else if (part === 'table') body = txTableBlock();
    else if (part === 'ledger') body = ledgerTableBlock();
    // Phase 4C — 'summary' = the useful, bounded composition for the SCHEDULED/catch-up daily report:
    // headline figures + owed + budget + pie + the 23-line ledger rollup, and NO 1,800-row transactions
    // table (that PDF ran to 81 pages). The four MANUAL exports (full/pie/table/ledger) are unchanged.
    else if (part === 'summary') body = figuresBlock() + owedBlock() + budgetBlock() + pieBlock() + ledgerTableBlock();
    else body = figuresBlock() + owedBlock() + budgetBlock() + pieBlock() + txTableBlock();

    // Light (default) or dark palette — chosen by the user before export.
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

  // The PDF's HTML: the Overview figures for the range, and the cash-out rows dated in it.
  async function overviewPdfHtml({ part, theme, range }) {
    const o = await computeOverview(range);
    const inR = (d) => { if (!range.start && !range.end) return true; if (d == null) return false; if (range.start && d < range.start) return false; if (range.end && d > range.end) return false; return true; };
    const rows = (await LEDGER_CRUDS.cash_out.list()).map(cashOutRow).filter((r) => inR(r.txDate));
    return buildOverviewPdfHtml(part, o, rows, range, theme);
  }

  return { readPdfQuery, overviewPdfHtml };
}
