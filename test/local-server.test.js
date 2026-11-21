// Phase 1 safety — local-server.js (the static server for testing the Android setup in a browser)
// must serve public/ plus only the allow-listed shared modules, never other project files, and must
// survive malformed requests. Spawns the real script on a random port.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 20000 + Math.floor(Math.random() * 20000);
let proc;

before(() => new Promise((resolve, reject) => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'local-server.js'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => reject(new Error('local-server.js did not start')), 15000);
  proc.stdout.on('data', (d) => { if (String(d).includes(`:${PORT}`)) { clearTimeout(timer); resolve(); } });
  proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`local-server.js exited early (${code})`)); });
}));
after(() => { if (proc) { proc.removeAllListeners('exit'); proc.kill(); } });

// http.request sends the path exactly as written; fetch() would normalise "..", "%2e%2e" itself.
function rawGet(urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.end();
  });
}

test('serves public pages and the allow-listed shared modules', async () => {
  assert.strictEqual(await rawGet('/'), 200);
  assert.strictEqual(await rawGet('/data-backup.html'), 200);
  assert.strictEqual(await rawGet('/db.js'), 200);
  assert.strictEqual(await rawGet('/node_modules/scrypt-js/package.json'), 200);
});

test('does not serve other project files', async () => {
  for (const p of ['/server.js', '/package.json', '/local-server.js', '/reset-db.js', '/run-tests.js', '/node_modules/express/package.json', '/.gitignore']) {
    assert.strictEqual(await rawGet(p), 404, p);
  }
});

test('path tricks cannot climb out of an allowed folder', async () => {
  for (const p of ['/../server.js', '/..%2fserver.js', '/node_modules/scrypt-js/../../server.js', '/node_modules/scrypt-js/%2e%2e/%2e%2e/package.json']) {
    assert.strictEqual(await rawGet(p), 404, p);
  }
  assert.strictEqual(await rawGet('/node_modules/scrypt-js/..%5c..%5cserver.js'), 400, 'backslash');
});

test('a malformed %-escape gets 400 and the server keeps running', async () => {
  assert.strictEqual(await rawGet('/%E0%A4%A'), 400);
  assert.strictEqual(await rawGet('/'), 200);
});
