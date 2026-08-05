// Shared password hashing + strength validation — the ONE place bcrypt and the cost factor live.
// server.js and set-password.js both use this, so they can never diverge on implementation or
// rounds. Phase 7's move to the async bcrypt API is meant to happen HERE and nowhere else — which
// is exactly why hashing was extracted out of server.js before that change.
//
// NOTE: the login timing-equalizer (DUMMY_HASH) stays in server.js — that is a login-FLOW concern,
// not a hashing one. This module only knows how to hash, verify, and judge password strength.

// Phase 8D — NATIVE bcrypt (chosen at INSTALL time). One library, no runtime fallback: if the
// native module is missing this require throws loudly at boot rather than silently dropping back to
// bcryptjs, so which implementation is in use is never ambiguous. Native does the same 12-round
// $2 algorithm several times faster than the pure-JS bcryptjs it replaces (bcryptjs was login's
// whole latency). Cross-compatible with every already-stored bcryptjs hash (verified both ways).
const bcrypt = require('bcrypt');

const ROUNDS = 12;              // SINGLE source of the bcrypt cost factor
const MIN_PASSWORD_LENGTH = 8;  // SINGLE source of the strength rule registration enforces

// Async hashing (bcrypt.hash/compare) so a bcrypt no longer BLOCKS the event loop for its whole
// duration; concurrent requests interleave. CRITICAL: callers MUST `await` these — an un-awaited
// bcrypt.compare() returns a Promise, always truthy, so login would accept ANY password (fails wide
// open). New hashes use native bcrypt's default $2b$ prefix; the already-stored $2a$ hashes keep
// verifying because bcrypt.compare accepts $2a$/$2b$/$2y$ alike (cross-compat verified) — same
// algorithm, same 12 rounds, same security. No salt pinning.
async function hash(plain) { return bcrypt.hash(plain, ROUNDS); }
async function verify(plain, hashStr) { return bcrypt.compare(plain, hashStr); }

// Synchronous hash — used ONLY for DUMMY_HASH at module load (a one-time boot cost). Kept sync so a
// first login can't arrive before the equalizer hash exists. Do NOT use on the request path.
function hashSync(plain) { return bcrypt.hashSync(plain, ROUNDS); }

// The SAME strength rule /api/register and /api/change-password apply. Returns an error string, or
// null if the password is acceptable — so callers can't set a password weaker than the app permits.
function passwordError(plain) {
  if (String(plain).length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  return null;
}

module.exports = { ROUNDS, MIN_PASSWORD_LENGTH, hash, verify, hashSync, passwordError };
