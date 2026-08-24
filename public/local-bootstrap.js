// Phase 5 — local-only bootstrap. Every page's inline <script> explicitly does
// `await import('/local-bootstrap.js')` as its first statement (the <script type="module"> tag in
// <head> just starts loading it earlier, in parallel with parsing — dynamic import() of an
// already-loading module reuses the same promise). That explicit await is required: DOMContentLoaded
// does NOT wait for a deferred module's top-level await to settle (verified empirically — it only
// waits for the module's synchronous portion to run), so relying on script ordering alone is not
// enough to guarantee this finishes before a page's own fetch() calls run.
//
// First, probe whether a real API server is actually there (server.js, still the reference
// implementation the Node tests run against). If it is, this is NOT local-only mode — leave
// window.fetch alone entirely and do nothing further; installing the shim here would hijack every
// fetch() call on a server.js-backed page too (exactly what broke test-ui/run.js the first time this
// was written). Only when there is no real backend do we open the local kvvfs database and install
// the shim.
//
// The probe can't just fetch a nonexistent /api/* path and check for a 404 — Chrome logs "Failed to
// load resource: 404" to the console for ANY failed fetch, regardless of how the JS handles it, which
// would itself be a console error on every page load in local mode (the opposite of what this app
// wants). Instead it HEADs the current page's own URL (guaranteed to exist, 200 in both modes) and
// checks for an ETag response header — express.static sets one by default (server.js relies on this
// default; see its own comment on the static middleware), and local-server.js's plain http server
// does not set one at all. No request ever 404s, so there is nothing for Chrome to log either way.

// Phase 6b — registers the local-notification tap listener (always opens Overview). Unconditional
// and outside the local-only branch below: it must be active on EVERY page under EVERY environment
// so a tap lands on Overview no matter which page happened to be open when the app was resumed, and
// it is a deliberate no-op under server.js/local-server.js (no native Capacitor bridge there).
await import('./notifications.js');

const probe = await fetch(location.pathname, { method: 'HEAD' }).catch(() => null);
if (probe && probe.headers.has('etag')) {
  console.log('[local-bootstrap] a real API server is present (ETag from express.static) — leaving fetch alone (not local-only mode).');
} else {
  const { ready, init } = await import('./db.js');
  await ready();
  init(); // creates/migrates the schema — must run before repo.js prepares any statement against it
  const repo = await import('./repo.js');
  const { installFetchShim } = await import('./local-api.js');
  installFetchShim(repo);
  console.log('[local-bootstrap] local-only mode: fetch shim installed, no network requests will be made for /api/*.');
}
