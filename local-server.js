// Phase 5 — trivial static file server for running Plannr with server.js stopped.
//
// Serves public/ as the primary root (exactly what a real static host would serve), falling back to
// the project root for the handful of shared modules that live outside public/ by design (db.js,
// repo.js, db-engine.js, node-builtins-browser-stub.js, and node_modules/@sqlite.org/sqlite-wasm).
// No Express, no API, no dynamic routes — just two directories checked in order. This is what makes
// "serve public/ as static files only" compatible with db.js/repo.js staying at the project root
// (Phase 4's location) instead of being relocated into public/ for this one purpose.
//
// Run: node local-server.js [port]   (default 8080)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC_ROOT = path.join(__dirname, 'public');
const PROJECT_ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8080;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.json': 'application/json',
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? '/home.html' : urlPath;
  const candidates = [path.join(PUBLIC_ROOT, rel), path.join(PROJECT_ROOT, rel)];

  (function tryNext(i) {
    if (i >= candidates.length) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
    fs.readFile(candidates[i], (err, data) => {
      if (err) return tryNext(i + 1);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(candidates[i])] || 'application/octet-stream' });
      res.end(data);
    });
  })(0);
}).listen(PORT, '127.0.0.1', () => console.log(`Plannr (local mode) — http://127.0.0.1:${PORT}/`));
