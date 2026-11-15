// Cross-platform plan, step 1.3 — the people routes. This is the only copy: server.js (Express, the
// dev server) and public/local-api.js (the phone's fetch shim) both call register(app, ctx).
//
// `app` is anything with Express-style get/post/put/delete(path, ...handlers). The phone's shim runs
// only the last handler; Express runs them all, so `ctx.auth` is a real middleware there.
// `ctx` is built by each copy (coreContext in server.js and local-api.js); this file imports nothing,
// so it loads unchanged in Node and in the WebView.

export function register(app, ctx) {
  const { db, auth, getOwner } = ctx;

  // The user roster for the "By" attribution pickers: id + display name only, never username or
  // hash. Single-user app: the roster is just the one owner account.
  const USERS_ROSTER_STMT = db.prepare('SELECT id, display_name AS displayName FROM users ORDER BY id ASC');

  // 8 pages call /api/me, 3 use it to fill "By" dropdowns. The fixed local owner, no auth check.
  app.get('/api/me', (req, res) => {
    res.json({ user: getOwner() });
  });

  // Returns ONLY id + displayName, ordered by id — never username, password_hash or created_at.
  app.get('/api/users', auth, (req, res) => {
    res.json({ users: USERS_ROSTER_STMT.all() });
  });
}
