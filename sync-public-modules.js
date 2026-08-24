// Phase 8b — copies the shared data-layer modules (and every browser-only vendor package the
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
// The same problem applies to every vendor package the import maps reference by absolute path
// (/node_modules/@sqlite.org/sqlite-wasm/..., /node_modules/scrypt-js/..., the Capacitor plugins
// added from Phase 8b onward) — those paths also only resolved via local-server.js's fallback.
// Copying the whole package directories (not just the specific files currently referenced) matches
// exactly what that fallback already exposed, so nothing about how a package resolves its own
// internal assets (sqlite-wasm's .wasm file and worker script, a plugin's web.js/definitions.js)
// changes.
//
// Run this before `npx cap sync` (or `npm run android:sync`, which does both). Safe to re-run — it
// always copies fresh from the source of truth.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

// Phase 10b: ledgers.js moved here from public/ — it's now seed data db.js reads at init() time
// (on both sides, same reasoning as db.js/repo.js themselves), not a page's runtime source.
const FILES = ['db.js', 'repo.js', 'db-engine.js', 'node-builtins-browser-stub.js', 'ledgers.js'];
// Every package an import map points at by absolute /node_modules/... path — those paths only
// resolve if the whole package directory is here too (see the header comment).
const VENDOR_PACKAGES = [
  path.join('@sqlite.org', 'sqlite-wasm'), 'scrypt-js',
  path.join('@capacitor', 'core'), path.join('@capacitor', 'local-notifications'),
  // Phase 6a — the on-device PDF print-adapter plugin, plus @capacitor/share/filesystem to get the
  // rendered PDF into the native share sheet, and @capacitor/synapse (filesystem's own dependency,
  // discovered by reading its ESM entry — see the patch step below).
  path.join('@capgo', 'capacitor-pdf-generator'), path.join('@capacitor', 'share'),
  path.join('@capacitor', 'filesystem'), path.join('@capacitor', 'synapse'),
];

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

// Capacitor plugins' ESM builds routinely re-export/dynamically-import a sibling file by an
// extension-less relative specifier (./web, ./definitions) — fine for a bundler (which tries
// .js/.ts extensions itself) or Node's own resolver, but a literal 404 under a browser's native ES
// module loader, which requires the exact file (first hit: @capacitor/local-notifications, Phase 6b —
// it broke local-bootstrap.js on every page). Patch every COPIED .js file's relative specifiers to be
// explicit; the real node_modules install (what Node/npm actually use) is left untouched.
const KNOWN_EXT = /\.(js|mjs|cjs|json)$/i;
const REL_SPECIFIER = /((?:from|import)\s*\(?\s*['"])(\.\.?\/[^'"]+)(['"]\s*\)?)/g;
function patchExtensionlessRelativeImports(dir) {
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    if (!entry.endsWith('.js') && !entry.endsWith('.mjs')) continue;
    const file = path.join(dir, entry);
    if (!fs.statSync(file).isFile()) continue;
    let changed = false;
    const patched = fs.readFileSync(file, 'utf8').replace(REL_SPECIFIER, (whole, pre, spec, post) => {
      if (KNOWN_EXT.test(spec)) return whole;
      changed = true;
      return pre + spec + '.js' + post;
    });
    if (changed) {
      fs.writeFileSync(file, patched);
      console.log(`[sync-public-modules] patched extension-less relative import(s) in ${path.relative(PUBLIC, file)}`);
    }
  }
}
patchExtensionlessRelativeImports(publicNodeModules);

console.log('[sync-public-modules] done.');
