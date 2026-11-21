// The platform services the shared core may call (step 1.4 A4).
//
// The core never imports a platform module (Express, Playwright, Capacitor, node:fs). Whatever has
// to differ between the phone and the desktop reaches it as ctx.host, one object per platform:
//   - server.js builds the dev server's (later the desktop app's);
//   - public/local-api.js builds the phone's.
// Each platform passes its host through checkHost() when it starts, so a missing service fails at
// startup, not in the middle of a request.
//
// The list grows only when a part of step 1.4 needs a service (docs/step-1.4-storage-plan.md §4).

export const HOST_SERVICES = Object.freeze({
  'pdf.render': 'pdf.render(html, { part }) -> Promise<bytes>: render the Overview PDF page (A4). '
    + 'Throws hostError(status, message) when the user should see that exact answer.',
  'snapshot.writeJson': 'snapshot.writeJson(backup) -> Promise<string>: save a safety copy of the '
    + 'current data before a JSON restore replaces it; returns where it went.',
  'now': 'now() -> Date: the current time (A6). The core never reads the clock itself, so a test can '
    + 'fix it; the backup reminder stamps and counts days with it.',
  'crypto.encrypt': 'crypto.encrypt(bytes, passphrase) -> Promise<bytes>: the encrypted backup format '
    + '(core/backup-crypto.js, PLBK version 1) with the scrypt of the platform (C11).',
  'crypto.decrypt': 'crypto.decrypt(bytes, passphrase) -> Promise<bytes>: the reverse; rejects with a '
    + 'message for the user on a wrong passphrase, a changed file or a bad header (C11).',
  'database.exportBytes': 'database.exportBytes() -> Promise<bytes>: the whole database as a SQLite '
    + 'file, taken while nothing else writes (the encrypted backup, C11).',
  'storage.info': 'storage.info() -> Promise<{ kind, ... }>: what this platform knows about where the '
    + 'data is kept, for GET /api/storage (core/routes/storage.js, C11).',
});

// Services a platform may leave out. If it supplies one, it must be a function; the core answers
// without it. A pair listed together must be supplied together.
export const HOST_OPTIONAL = Object.freeze({
  'database.restore': 'database.restore(bytes) -> Promise: replace the whole database with a decrypted '
    + 'backup (checked first; a newer schema throws an error with code BACKUP_TOO_NEW), then bring it '
    + 'up to this version. The phone and the dev server both supply it (step 1.4 D1); without it the encrypted restore answers 501.',
  'snapshot.writeDatabase': 'snapshot.writeDatabase() -> Promise<string|null>: save a whole-database '
    + 'safety copy before an encrypted restore replaces it; returns where it went.',
});
const OPTIONAL_PAIRS = [['database.restore', 'snapshot.writeDatabase']];

// An error whose HTTP status and message the core route passes to the page unchanged, e.g. "the
// server is busy" or "PDF export needs the Android app". `cause` keeps the original error for logs.
export function hostError(status, message, cause) {
  const e = new Error(message);
  e.status = status;
  e.userMessage = message;
  if (cause !== undefined) e.cause = cause;
  return e;
}

const lookUp = (host, name) => name.split('.').reduce((o, key) => (o == null ? undefined : o[key]), host);

/** The service `name` if the host supplies it as a function, else undefined. */
export const hostService = (host, name) => (typeof lookUp(host, name) === 'function' ? lookUp(host, name) : undefined);

export function checkHost(host) {
  const missing = Object.keys(HOST_SERVICES).filter((name) => !hostService(host, name));
  for (const name of Object.keys(HOST_OPTIONAL)) {
    if (lookUp(host, name) !== undefined && !hostService(host, name)) missing.push(`${name} (not a function)`);
  }
  for (const pair of OPTIONAL_PAIRS) {
    const given = pair.filter((name) => hostService(host, name));
    if (given.length && given.length < pair.length) missing.push(...pair.filter((name) => !given.includes(name)).map((name) => `${name} (needed with ${given.join(', ')})`));
  }
  if (missing.length) throw new Error(`The platform host is missing: ${missing.join(', ')} (see core/host.js).`);
  return host;
}
