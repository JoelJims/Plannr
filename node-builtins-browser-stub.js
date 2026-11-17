// Phase 4c — browser-side stub for db.js's static `node:fs` / `node:path` / `node:sqlite` imports.
//
// db.js imports these three Node built-ins statically (named imports) so its Node path stays fully
// synchronous (see db.js's header for why). A static import is unconditional — it resolves the moment
// the module loads, regardless of any runtime `isNode` check — so a real browser loading db.js needs
// SOMETHING importable at these three specifiers, even though the code that would actually use them
// is never reached when isNode is false.
//
// Wire this in with an import map on whatever HTML/entry point hosts the browser build:
//
//   <script type="importmap">
//   { "imports": {
//       "node:fs": "/node-builtins-browser-stub.js",
//       "node:path": "/node-builtins-browser-stub.js",
//       "node:sqlite": "/node-builtins-browser-stub.js"
//   } }
//   </script>
//
// All three map to this one file; db.js only imports the named bindings below from each.

// node:fs — never called in a browser (see db.js's `isNode` guard; the desktop-only safety snapshot
// before a schema upgrade and its "upgrade pending" record use these).
export function existsSync() { return false; }
export function mkdirSync() {}
export function readdirSync() { return []; }
export function readFileSync() { throw new Error('node-builtins-browser-stub: readFileSync is desktop-only.'); }
export function renameSync() { throw new Error('node-builtins-browser-stub: renameSync is desktop-only.'); }
export function rmSync() {}
export function statSync() { throw new Error('node-builtins-browser-stub: statSync is desktop-only.'); }
export function writeFileSync() { throw new Error('node-builtins-browser-stub: writeFileSync is desktop-only.'); }
// node:path — never called either
export function join(...parts) { return parts.join('/'); }
export function dirname(p) { return String(p).replace(/[\\/][^\\/]*$/, '') || '.'; }

export class DatabaseSync { // node:sqlite
  constructor() {
    throw new Error('node-builtins-browser-stub: DatabaseSync should never be constructed — db.js only uses this under isNode. If this throws, isNode detection is wrong.');
  }
}
