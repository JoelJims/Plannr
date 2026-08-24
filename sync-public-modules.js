// Phase 8b — copies the shared data-layer modules (and the two browser-only vendor packages the
// import maps point at) into public/, so Capacitor's webDir is fully self-contained.
//
// db.js, repo.js, db-engine.js, and node-builtins-browser-stub.js live at the project root, not in
// public/, because server.js and the 91 Node tests import them from there (require('./db') etc.) and
// must keep doing so unchanged. local-server.js papered over this with a two-root fallback (serve
// public/, fall back to the project root) — a trick that only works because it's a static server we
// wrote ourselves. A Capacitor WebView only ever sees webDir (public/); there is no second root to
// fall back to. Rather than relocate the canonical files (which would mean updating every require()
// in server.js and every test file), this copies them into public/ instead, leaving the root copies
// as the single source of truth for Node.
//
// The same problem applies to the two vendor packages the import maps reference by absolute path
// (/node_modules/@sqlite.org/sqlite-wasm/... and /node_modules/scrypt-js/scrypt.js) — those paths
// also only resolved via local-server.js's fallback. Copying the whole package directories (not just
// the specific files currently referenced) matches exactly what that fallback already exposed, so
// nothing about how sqlite-wasm resolves its own internal assets (the .wasm file, the worker script)
// changes.
//
// Run this before `npx cap sync` (or `npm run android:sync`, which does both). Safe to re-run — it
// always copies fresh from the source of truth.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

const FILES = ['db.js', 'repo.js', 'db-engine.js', 'node-builtins-browser-stub.js'];
// Phase 6b added @capacitor/core + @capacitor/local-notifications to the import maps (notifications.js) —
// same reasoning as the two below: those absolute paths only resolve if the whole package is here too.
const VENDOR_PACKAGES = [path.join('@sqlite.org', 'sqlite-wasm'), 'scrypt-js', path.join('@capacitor', 'core'), path.join('@capacitor', 'local-notifications')];

for (const f of FILES) {
  fs.copyFileSync(path.join(ROOT, f), path.join(PUBLIC, f));
  console.log(`[sync-public-modules] copied ${f}`);
}

const publicNodeModules = path.join(PUBLIC, 'node_modules');
fs.mkdirSync(publicNodeModules, { recursive: true });
for (const pkg of VENDOR_PACKAGES) {
  const src = path.join(ROOT, 'node_modules', pkg);
  const dest = path.join(publicNodeModules, pkg);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[sync-public-modules] copied node_modules/${pkg}`);
}

// @capacitor/local-notifications' ESM entry (dist/esm/index.js) re-exports/dynamically imports two
// sibling files by extension-less relative specifier (./web, ./definitions) — fine for a bundler
// (which tries .js/.ts extensions itself) or Node's own resolver, but a literal 404 under a browser's
// native ES module loader, which requires the exact file. Patch the COPIED file only; the real
// node_modules install (what Node/npm actually use) is left untouched.
const lnIndexPath = path.join(publicNodeModules, '@capacitor', 'local-notifications', 'dist', 'esm', 'index.js');
const lnIndexSrc = fs.readFileSync(lnIndexPath, 'utf8')
  .replace("import('./web')", "import('./web.js')")
  .replace("from './definitions'", "from './definitions.js'");
fs.writeFileSync(lnIndexPath, lnIndexSrc);
console.log('[sync-public-modules] patched @capacitor/local-notifications/dist/esm/index.js (extension-less relative imports)');

console.log('[sync-public-modules] done.');
