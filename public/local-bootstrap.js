// Phase 5 — local-only bootstrap. Every page's inline <script> explicitly does
// `await import('/local-bootstrap.js')` as its first statement (the <script type="module"> tag in
// <head> just starts loading it earlier, in parallel with parsing — dynamic import() of an
// already-loading module reuses the same promise). That explicit await is required: DOMContentLoaded
// does NOT wait for a deferred module's top-level await to settle (verified empirically — it only
// waits for the module's synchronous portion to run), so relying on script ordering alone is not
// enough to guarantee this finishes before a page's own fetch() calls run.
//
// Then decide which backend answers /api (runtime-mode.js, Phase 2 Step 6): inside the Capacitor app
// it is always the local database, with no probe at all; in a plain browser it is the desktop dev
// server (server.js) only if the page carries server.js's X-Plannr-Dev-Server marker. In server mode
// window.fetch is left alone (installing the shim there would hijack every fetch() on a
// server.js-backed page — what broke test-ui/run.js the first time this was written). Otherwise the
// local kvvfs database is opened and the shim installed.

// Phase 6b — registers the local-notification tap listener (always opens Overview). Unconditional
// and outside the local-only branch below: it must be active on EVERY page under EVERY environment
// so a tap lands on Overview no matter which page happened to be open when the app was resumed, and
// it is a deliberate no-op under server.js/local-server.js (no native Capacitor bridge there).
await import('./notifications.js');

const { Capacitor } = await import('@capacitor/core');
const { detectMode } = await import('./runtime-mode.js');
const mode = await detectMode({ isNative: Capacitor.isNativePlatform(), path: location.pathname });
window.__plannrMode = mode; // read by test-ui/runtime-mode.js
if (mode === 'server') {
  console.log('[local-bootstrap] desktop dev server (server.js) detected — leaving fetch alone (not local-only mode).');
} else {
  const { ready, init, migrationPlan } = await import('./db.js');
  await ready();
  // Phase 2 (Step 2): before a schema upgrade touches existing data, copy the whole database into the
  // app's private folder (safety-snapshots.js). If that copy cannot be written and verified, stop
  // here: the data stays exactly as it is, at its old version. init() itself refuses a database from
  // a newer app version (an older APK installed over newer data) without changing anything.
  const plan = migrationPlan();
  try {
    if (plan.needsSnapshot && !plan.tooNew) {
      const { writePreMigrationSnapshot } = await import('./safety-snapshots.js');
      await writePreMigrationSnapshot(plan);
    }
    await init(); // creates/migrates the schema — must run before repo.js prepares any statement against it
  } catch (e) {
    showStartupError(e);
    throw e;
  }
  const repo = await import('./repo.js');
  const { installFetchShim } = await import('./local-api.js');
  installFetchShim(repo);
  console.log('[local-bootstrap] local-only mode: fetch shim installed, no network requests will be made for /api/*.');
}

// A start-up failure would otherwise leave a blank page. Show the reason (plain text, never HTML).
function showStartupError(e) {
  const show = () => {
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'margin:16px;padding:16px;border:2px solid #b00020;border-radius:8px;background:#fff4f4;color:#5f0010;font:16px/1.4 system-ui,sans-serif;white-space:pre-wrap';
    box.textContent = 'Plannr could not open your data. ' + (e && e.message ? e.message : String(e));
    document.body.prepend(box);
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
}
