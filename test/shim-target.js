// Cross-platform plan, step 1.1: run the HTTP test files against the PHONE's API code
// (public/local-api.js) as well as against server.js. Used by test/helpers.js when
// PLANNR_TEST_TARGET=shim (run-tests.js does that in its second pass).
//
// The phone code expects to run in a page. This file gives it the minimum a page has:
// - window.fetch to wrap: local-api.js replaces it with its /api router (installFetchShim).
// - window.location: used to parse request URLs.
// - window.localStorage: read by /api/storage (in the app it holds the database; here it is empty).
// - window.scrypt: data-backup.html loads scrypt-js with a <script> tag; backup-crypto.js uses it.
// - document: the browser fallback for a safety snapshot is a file download (a link it clicks).
//
// The shared modules that sync-public-modules.js copies from the repo root into public/ (db.js,
// repo.js, ledgers.js, backup-format.js, request-rules.js) are byte-identical copies. The phone
// code is given the root files themselves, so both targets share one database connection and one
// module instance, and public/db.js never creates a public/data folder. A stale copy fails loudly.
//
// Platform services the phone code reaches through Capacitor plugins get test stand-ins, imported
// by public/local-api.js only:
// - the PDF plugin (shim-capacitor-fake.mjs) records the PDF page, so tests can check its HTML.
// Likewise the one module that needs sqlite-wasm itself, local-snapshot.js (the whole-database copy
// behind an encrypted backup), is replaced everywhere by shim-snapshot-fake.mjs.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const SHARED = ['db.js', 'repo.js', 'ledgers.js', 'backup-format.js', 'request-rules.js'];
const LOCAL_API = path.join(PUB, 'local-api.js');
const CAPACITOR_IMPORTS = ['@capacitor/core', '@capgo/capacitor-pdf-generator'];
const FAKE_CAPACITOR = pathToFileURL(path.join(__dirname, 'shim-capacitor-fake.mjs')).href;
const LOCAL_SNAPSHOT = path.join(PUB, 'local-snapshot.js');
const FAKE_SNAPSHOT = pathToFileURL(path.join(__dirname, 'shim-snapshot-fake.mjs')).href;
const isLocalApi = (url) => !!url && url.startsWith('file:') && fileURLToPath(url).toLowerCase() === LOCAL_API.toLowerCase();

function useRootCopiesOfSharedModules() {
  for (const f of SHARED) {
    if (!fs.readFileSync(path.join(PUB, f)).equals(fs.readFileSync(path.join(ROOT, f)))) {
      throw new Error(`public/${f} differs from ${f}: run "npm run sync:public-modules" first`);
    }
  }
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      // The PDF route's Capacitor imports get the recording stand-ins (shim-capacitor-fake.mjs).
      if (CAPACITOR_IMPORTS.includes(specifier) && isLocalApi(context.parentURL)) {
        return { url: FAKE_CAPACITOR, format: 'module', shortCircuit: true };
      }
      const r = nextResolve(specifier, context);
      if (r.url && r.url.startsWith('file:')) {
        const p = fileURLToPath(r.url);
        if (p.toLowerCase() === LOCAL_SNAPSHOT.toLowerCase()) return { ...r, url: FAKE_SNAPSHOT };
        if (path.dirname(p) === PUB && SHARED.includes(path.basename(p))) {
          return { ...r, url: pathToFileURL(path.join(ROOT, path.basename(p))).href };
        }
      }
      return r;
    },
  });
}

function fakePage() {
  const store = new Map();
  const localStorage = {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
  const element = () => ({ click() {}, remove() {}, setAttribute() {}, style: {} });
  globalThis.window = {
    // The page's own fetch: only reached by a request the /api router does not take. On the phone
    // that would go to the network, so it is recorded (test/offline.test.js checks the list).
    fetch: async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      outsideRequests.push(url);
      throw new Error(`not an /api request (no page server on the phone): ${url}`);
    },
    location: { origin: 'https://localhost' },
    localStorage,
    scrypt: require('scrypt-js'),
  };
  globalThis.document = { createElement: element, body: { appendChild() {}, prepend() {} } };
}

const outsideRequests = [];
let shimFetch = null;
async function start() {
  if (shimFetch) return;
  useRootCopiesOfSharedModules();
  fakePage();
  const repo = await import(pathToFileURL(path.join(PUB, 'repo.js')).href);
  const { installFetchShim } = await import(pathToFileURL(path.join(PUB, 'local-api.js')).href);
  installFetchShim(repo);
  shimFetch = globalThis.window.fetch;
}

// Same return shape as helpers.req(). The shim's responses carry no headers or cookies (the pages
// never read them on the phone), so those are always empty here.
async function request(method, urlPath, { body } = {}) {
  let payload;
  if (body !== undefined) payload = typeof body === 'string' ? body : JSON.stringify(body);
  const r = await shimFetch(urlPath, { method, body: payload });
  const raw = await r.text();
  let json = null, text = null;
  try { json = JSON.parse(raw); } catch { text = raw; }
  return { status: r.status, json, text, headers: new Headers(), setCookie: [], cookie: '' };
}

// The shim's own Response-like object (json(), text(), blob()), for binary answers.
const fetchRaw = (urlPath, init) => shimFetch(urlPath, init);

// The HTML page the phone's PDF route hands to the PDF plugin, through the real route.
async function pdfHtml({ part, theme, range }) {
  const fake = await import(FAKE_CAPACITOR);
  const q = new URLSearchParams({ part, theme });
  if (range.start) q.set('start', range.start);
  if (range.end) q.set('end', range.end);
  const before = fake.pdfRequests.length;
  const r = await request('GET', `/api/overview/pdf?${q}`);
  if (r.status !== 200) throw new Error(`the phone's PDF route answered ${r.status}: ${JSON.stringify(r.json || r.text)}`);
  if (fake.pdfRequests.length !== before + 1) throw new Error("the phone's PDF route did not call the PDF plugin");
  return fake.pdfRequests[fake.pdfRequests.length - 1].data;
}

module.exports = { start, request, fetchRaw, pdfHtml, outsideRequests };
