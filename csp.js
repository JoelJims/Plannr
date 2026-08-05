// Phase 8C — Content Security Policy via STARTUP HASHING.
//
// Why startup hashing over per-request nonces: it has ZERO per-request cost and works with
// res.sendFile UNCHANGED (nonces would force read-and-substitute on every page, losing sendFile's
// streaming and adding per-request work — not worth it for a handful of static pages). The one cost
// is that editing a page's inline <script>/<style> needs a server restart to recompute its hash;
// `npm run dev`'s --watch already restarts on file change, so in practice nothing breaks.
//
// What breaks startup hashing (documented so nobody is surprised): (1) editing an inline block
// without restarting → its hash no longer matches → the block is refused; (2) any inline content
// generated at RUNTIME (we have none — dynamic bits use the CSSOM / createElement, not parsed inline
// markup); (3) a byte differing from what the parser hashes — handled below by normalising newlines.
//
// Every inline <script> (plain, type=module, AND type=importmap) and every inline <style> BLOCK is
// hashed. External <script src> and <link rel=stylesheet> are covered by 'self'. There are ZERO
// inline event handlers and ZERO style= attributes across the pages (both verified), so script-src
// and style-src need NO 'unsafe-inline'/'unsafe-hashes' — hashes + 'self' only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const REPORT_ONLY = process.env.PLANNR_CSP_REPORT_ONLY === '1';
const HEADER_NAME = REPORT_ONLY ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';

// The browser hashes the inline element's TEXT after the HTML parser has normalised newlines
// (CRLF and lone CR both become LF). Hash the same normalised bytes or every hash mismatches on a
// CRLF checkout.
function sha256(text) {
  return "'sha256-" + crypto.createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('base64') + "'";
}

// Extract inline block contents (between the tags), exactly what the browser hashes. Skips
// <script src=…> (external → 'self'). Non-greedy up to the first closing tag, mirroring the HTML
// parser's own rule for where a raw-text element ends.
function inlineHashes(html, tag) {
  const re = new RegExp('<' + tag + '\\b([^>]*)>([\\s\\S]*?)</' + tag + '>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    if (tag === 'script' && /\bsrc\s*=/.test(m[1] || '')) continue; // external script → 'self'
    out.push(sha256(m[2]));
  }
  return out;
}

function buildCsp(scriptHashes, styleHashes) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",            // date.css + several pages use data:image/svg+xml backgrounds
    "font-src 'self'",                 // the six local woff2 faces
    "connect-src 'self'",              // every fetch is same-origin /api/*
    ("style-src 'self' " + styleHashes.join(' ')).trim(),
    ("script-src 'self' " + scriptHashes.join(' ')).trim(),
    'report-uri /api/csp-report',
  ].join('; ');
}

// Build once at boot: page filename → its CSP header value. Cached in memory; zero per-request cost.
const pageCsp = {};
for (const f of fs.readdirSync(PUBLIC_DIR).filter((n) => n.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');
  pageCsp[f] = buildCsp(inlineHashes(html, 'script'), inlineHashes(html, 'style'));
}

function cspFor(filename) { return pageCsp[filename]; }

module.exports = { HEADER_NAME, REPORT_ONLY, cspFor, pageCsp };
