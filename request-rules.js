// Cross-platform plan, step 1.2: the checks every /api request goes through before its route runs.
// Shared by server.js (desktop/dev) and public/local-api.js (the phone), so both answer the same:
// - a body size limit for each kind of route, each with its own "too large" message;
// - a body that is not valid JSON, or not a JSON object or array, gets 400 "Invalid request.";
// - an unknown /api route or method gets a JSON 404 (see notFound below).
// sync-public-modules.js copies this file into public/, like backup-format.js. It has no imports.

export const BODY_LIMITS = Object.freeze({
  normal: 32 * 1024,         // every ordinary add / edit / setting
  batch: 256 * 1024,         // Save All on the cash-out page: many rows in one request
  backup: 20 * 1024 * 1024,  // restoring a backup file (JSON, or encrypted as base64)
});

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
  backup: 'That backup file is too large to restore (the limit is 20 MB).',
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
