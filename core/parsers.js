// Cross-platform plan, step 1.3 — the pure input checks and formatting both backends use: no
// database, no state. The only copy: server.js, public/local-api.js and the core routes import it.

// Normalize a text field: coerce to string and trim. NOT for passwords — a leading or trailing
// space is a legitimate password character.
export const str = (v) => String(v ?? '').trim();

// Parse a rupees amount (string/number, up to 2 decimals, commas allowed) into an exact INTEGER
// number of paise using string math — no float rounding drift. Returns a positive safe integer, or
// null if invalid / not greater than 0.
export function parsePaise(v) {
  const s = String(v == null ? '' : v).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [ip, dp = ''] = s.split('.');
  const paise = Number(ip) * 100 + Number((dp + '00').slice(0, 2));
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

// Q10 (review 2026-11-21), the owner's decisions: a cap of ₹1 crore on single entries only
// (2026-11-27), and safe sums with no precision loss. So there are two limits, both in integer paise:
//   · Entry cap, MAX_AMOUNT_PAISE = ₹1,00,00,000.00 (₹1 crore), message AMOUNT_CAP_MESSAGE: one cash
//     in, one cash out (add, edit, Save All rows) and one contractor payment. Checked by
//     parseAmountToSave.
//   · Totals limit, MAX_TOTAL_PAISE = ₹10,00,00,00,000.00 (₹1,000 crore), message TOTAL_LIMIT_MESSAGE:
//     the budget, a loan, the contract's reference amount, total, rate and rate x area, and an
//     allowance's cap and rate. These are often more than ₹1 crore. Checked by parseTotalToSave.
// Why the totals limit keeps sums exact: amounts are integer paise, and a sum of integers stays an
// exact integer in a JavaScript number while it is at most Number.MAX_SAFE_INTEGER paise. At the
// totals limit that is over 9,000 totals; an entry at the entry cap uses a thousandth of that room,
// so over nine million entries.
export const MAX_AMOUNT_PAISE = 1000000000;
export const AMOUNT_CAP_MESSAGE = 'An amount can be at most ₹1,00,00,000 (₹1 crore).';
export const MAX_TOTAL_PAISE = 1000000000000;
export const TOTAL_LIMIT_MESSAGE = 'A total can be at most ₹10,00,00,00,000 (₹1,000 crore).';

// A typed amount that is about to be saved -> { paise } or { error }. The error is capMessage for an
// amount over max (also one too large to hold exactly), otherwise invalidMessage (not an amount
// greater than 0 with up to 2 decimals). max and capMessage default to the entry cap.
export function parseAmountToSave(v, invalidMessage, { max = MAX_AMOUNT_PAISE, capMessage = AMOUNT_CAP_MESSAGE } = {}) {
  const paise = parsePaise(v);
  if (paise !== null) return paise > max ? { error: capMessage } : { paise };
  const s = String(v == null ? '' : v).trim().replace(/,/g, '');
  return { error: /^\d+(\.\d{1,2})?$/.test(s) && Number(s) > 0 ? capMessage : invalidMessage };
}

// The same for a total (see above): at most MAX_TOTAL_PAISE, else TOTAL_LIMIT_MESSAGE.
export function parseTotalToSave(v, invalidMessage) {
  return parseAmountToSave(v, invalidMessage, { max: MAX_TOTAL_PAISE, capMessage: TOTAL_LIMIT_MESSAGE });
}

// Optional ISO 'YYYY-MM-DD' date. Empty -> null. Rejects malformed or impossible dates (e.g.
// 2026-13-40). -> { date: string|null } or { error }.
export function parseIsoDate(v) {
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

// An OPTIONAL amount filter bound (rupees). Empty -> no bound (null). Otherwise a valid positive
// paise amount (reuses parsePaise). -> { paise: number|null } or { error }.
export function parseAmountFilter(v) {
  const s = str(v);
  if (s === '') return { paise: null };
  const p = parsePaise(s);
  if (p === null) return { error: 'invalid' };
  return { paise: p };
}

// The outflow search/filter query as a repo.crud.search filters object. Every field is optional; an
// all-empty query means "no filters" (active:false -> the full list). Dates reuse parseIsoDate;
// amounts reuse parsePaise via parseAmountFilter; text/ledger are bounded-length strings.
export function parseLedgerFilters(req) {
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

// Base64 text -> bytes (an encrypted backup sent to the restore route; the phone's PDF). Throws on
// text that is not base64.
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// paise -> "₹12,34,567.89" (Indian grouping; exact integer math). The backends' twin of the
// pages' formatPaise, used in messages and the PDF.
export function fmtRs(paise) {
  const neg = paise < 0; paise = Math.abs(paise);
  const rupees = Math.floor(paise / 100);
  const p = String(paise % 100).padStart(2, '0');
  return (neg ? '-' : '') + '₹' + rupees.toLocaleString('en-IN') + '.' + p;
}
