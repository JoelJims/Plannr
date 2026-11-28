// Cross-platform plan, step 1.2: the checks every /api request goes through before its route runs.
// Shared by server.js (desktop/dev) and public/local-api.js (the phone), so both answer the same:
// - a body size limit for each kind of route, each with its own "too large" message;
// - a body that is not valid JSON, or not a JSON object or array, gets 400 "Invalid request.";
// - an unknown /api route or method gets a JSON 404 (see notFound below).
// sync-public-modules.js copies this file into public/, like backup-format.js. It has no imports.

const MB = 1024 * 1024;

// F14 (review 2026-11-21): the backup limit was 20 MB, so an encrypted file (sent as base64, a third
// larger) over about 15 MB could not be restored. 32 MB takes an encrypted file of up to 24 MB: every
// database the storage meter calls healthy (it warns strongly from 23 MB). Peak memory of a phone
// restore at the limit, by estimate: the page's file bytes, binary string, base64 and JSON body, the
// parsed body, the decoded and the decrypted bytes and the write of the file, about 11 x 24 MB =
// 260 MB if every copy lived at once (the page's are unreachable by then; the JS strings stay near
// 6 x 24 MB = 145 MB), inside what Android gives a WebView on a 2 GB phone (a JS heap of about 512 MB).
export const BODY_LIMITS = Object.freeze({
  normal: 32 * 1024,         // every ordinary add / edit / setting
  batch: 256 * 1024,         // Save All on the cash-out page: many rows in one request
  backup: 32 * MB,           // restoring a backup file (JSON, or encrypted as base64)
});

// F14: the largest backup FILE each restore takes. A JSON backup is the body itself; an encrypted
// file travels as base64 (4 characters for every 3 bytes) next to the passphrase (1 KB is kept for it).
export const RESTORE_FILE_LIMITS = Object.freeze({
  json: BODY_LIMITS.backup,
  encrypted: Math.floor((BODY_LIMITS.backup - 1024) / 4) * 3,
});
const mb = (bytes) => String(Math.round((bytes / MB) * 10) / 10); // 25164288 -> "24", 19 MB + a bit -> "19.1"

// F14: the export note (Data Backup page, through GET /api/backup/size-note). From 75% of what a
// restore takes: at the encrypted limit that is 18 MB, still 6 MB (about 29,000 typical entries) of
// room, so there is time to act, and a normal household never sees it (1,000 entries are about 0.5 MB).
export const BACKUP_WARN_FRACTION = 0.75;
export function backupSizeNote(kind, fileBytes) {
  const limit = RESTORE_FILE_LIMITS[kind];
  if (!limit || !(fileBytes >= BACKUP_WARN_FRACTION * limit)) return null;
  const what = kind === 'encrypted' ? 'an encrypted backup' : 'a JSON backup';
  const todo = 'permanently delete items you no longer need from the Recycle Bin, then export a new backup';
  if (fileBytes > limit) return `This backup is ${mb(fileBytes)} MB, over the ${mb(limit)} MB limit for restoring ${what} in Plannr, so it cannot be restored as it is. Keep it, and to make one that can: ${todo}.`;
  return `This backup is getting large: ${mb(fileBytes)} MB of the ${mb(limit)} MB that Plannr can restore from ${what}. It can still be restored. To keep it that way, ${todo}.`;
}

const BATCH_PATH = /^\/api\/[a-z-]+\/batch$/;
const BACKUP_PATHS = new Set(['/api/backup/import', '/api/backup/import-encrypted']);

export function bodyKind(method, path) {
  if (method === 'POST' && BACKUP_PATHS.has(path)) return 'backup';
  if (method === 'POST' && BATCH_PATH.test(path)) return 'batch';
  return 'normal';
}

const TOO_LARGE = {
  normal: 'That is too much text to save in one go (the limit is 32 KB). Shorten the longest text and try again.',
  batch: 'That request was too large to process in one go — save fewer rows at a time (the batch limit is 500 rows).',
  backup: `That backup file is too large to restore: the limit is ${mb(RESTORE_FILE_LIMITS.encrypted)} MB for an encrypted backup and ${mb(RESTORE_FILE_LIMITS.json)} MB for a JSON backup.`,
};
export const tooLarge = (kind) => ({ error: TOO_LARGE[kind] || TOO_LARGE.normal });
export const invalidRequest = () => ({ error: 'Invalid request.' });
// Q11 (the owner's decision): a save that failed for any reason except a full storage (that answer is
// each platform's own "Storage is full — ..." text). A failed read keeps "Something went wrong.".
export const SAVE_FAILED = "Couldn't save – try again.";
export const serverError = (method) => ({ error: method === 'GET' || method === 'HEAD' ? 'Something went wrong.' : SAVE_FAILED });
export const notFound = (method, path) => ({ error: `Not found: ${method} ${path}` });

// UTF-8 size of a string, which is what the desktop's limit counts. Cheap answers first: every
// UTF-16 code unit is 1 to 3 bytes in UTF-8.
function overLimit(text, limit) {
  if (text.length > limit) return true;
  if (text.length * 3 <= limit) return false;
  return new TextEncoder().encode(text).length > limit;
}

// The phone has no HTTP layer, so it reads the body itself, by the same rules express.json uses on
// the desktop (strict mode): an empty body is {}; anything else must be a JSON object or array.
// Returns { body } or { status, error }.
export function parseJsonBody(text, kind) {
  if (text == null || text === '') return { body: {} };
  if (overLimit(text, BODY_LIMITS[kind] ?? BODY_LIMITS.normal)) return { status: 413, error: tooLarge(kind) };
  let value;
  try { value = JSON.parse(text); } catch { return { status: 400, error: invalidRequest() }; }
  if (value === null || typeof value !== 'object') return { status: 400, error: invalidRequest() };
  return { body: value };
}
