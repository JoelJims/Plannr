// The fixed local owner, shared by the dev server (server.js) and the phone (public/local-api.js).
//
// Plannr is a single-user offline app: no login, no sessions. The one users row is the owner, and
// every request resolves to it. There is no registration route, so the row must already exist.
//
// `getAdapter` is called on every query, never once at start: the test harness loads server.js before
// it seeds a user, and a restore can replace the database, so a value captured early would go stale.
// Both queries go through the async interface (step 1.4 B15): they answer with a Promise.
export function createOwnerQueries(getAdapter) {
  const getOwner = () => getAdapter().get('SELECT id, username, display_name AS displayName FROM users ORDER BY id ASC LIMIT 1');
  // Is `id` a users row? Used to check a chosen by_user_id. A non-integer id is never looked up.
  const userExists = async (id) => Number.isInteger(id) && !!(await getAdapter().get('SELECT 1 FROM users WHERE id = ?', [id]));
  // No auth check: sets req.user to the owner (kept for any future per-request use).
  async function requireApiAuth(req, res, next) {
    try { req.user = await getOwner(); } catch (e) { return next(e); }
    next();
  }
  return { getOwner, userExists, requireApiAuth };
}
