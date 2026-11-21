// Phase 5 — trivial static file server for running Plannr with server.js stopped.
//
// Serves public/ as the primary root (exactly what a real static host would serve), falling back to
// the project root ONLY for the shared modules that live outside public/ by design: the files and
// vendor packages listed in sync-public-modules.js (db.js, repo.js, db-engine.js, ...,
// node_modules/@sqlite.org/sqlite-wasm, ...). No Express, no API, no dynamic routes.
//
// Phase 1 safety: the fallback used to serve ANY project-root file (server.js, package.json,
// data/plannr.db if present, ...), and a malformed %-escape crashed the process. Now every path is
// normalised and must stay inside its root, the project-root fallback is an allow-list, and bad
// requests get a 400 instead of taking the server down.
//
// Run: node local-server.js [port]   (default 8080)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { FILES, VENDOR_PACKAGES } = require('./sync-public-modules'); // just the lists; copies nothing

const PUBLIC_ROOT = path.join(__dirname, 'public');
const PROJECT_ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8080;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.json': 'application/json',
};

const SHARED_FILES = new Set(FILES.map((f) => '/' + f));
const VENDOR_PREFIXES = VENDOR_PACKAGES.map((p) => '/node_modules/' + p.split(path.sep).join('/') + '/');
const fromProjectRootAllowed = (rel) => SHARED_FILES.has(rel) || VENDOR_PREFIXES.some((p) => rel.startsWith(p));

// The absolute file for `rel` under `root`, or null if it would land outside `root`.
function insideRoot(root, rel) {
  const full = path.resolve(root, '.' + rel);
  return full.startsWith(root + path.sep) ? full : null;
}

function reply(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch { return reply(res, 400, 'bad request'); }
  // A backslash is a path separator on Windows, and a NUL byte truncates paths: neither belongs in a URL.
  if (urlPath.includes('\\') || urlPath.includes('\0')) return reply(res, 400, 'bad request');

  // Collapse "." and ".." first, so the allow-list check sees the path that will actually be read.
  const rel = path.posix.normalize(urlPath === '/' ? '/home.html' : urlPath);
  const candidates = [insideRoot(PUBLIC_ROOT, rel)];
  if (fromProjectRootAllowed(rel)) candidates.push(insideRoot(PROJECT_ROOT, rel));
  const files = candidates.filter(Boolean);

  (function tryNext(i) {
    if (i >= files.length) return reply(res, 404, 'not found');
    fs.readFile(files[i], (err, data) => {
      if (err) return tryNext(i + 1);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(files[i])] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
  })(0);
}).listen(PORT, '127.0.0.1', () => console.log(`Plannr (local mode) — http://127.0.0.1:${PORT}/`));
