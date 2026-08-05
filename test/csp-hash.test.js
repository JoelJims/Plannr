// CSP startup hashing (csp.js). The reported risk: buildCsp ALWAYS returns a non-empty policy, so a
// dropped or mis-computed inline hash would keep the existing header tests green while silently
// refusing an inline <script>/<style> in production. This file re-derives every inline hash
// INDEPENDENTLY (its own regex + its own sha256, not csp.js's helpers) and asserts (a) every derived
// token is present in that page's policy and (b) the number of sha256- tokens per directive equals the
// number of inline blocks — so a DROPPED hash fails the count and a MIS-COMPUTED one fails the presence.
//
// This is a pure-module test: it requires csp.js directly (no DB / no HTTP app), which is why it does
// NOT use ./helpers — there is no reachable app seam here, csp.js builds its policy at load from public/.
const csp = require('../csp');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

// Independent re-derivation of what the browser hashes: the inline element's TEXT with newlines
// normalised (CRLF and lone CR -> LF), base64(sha256), wrapped in the CSP 'sha256-…' quote form.
function sha256Token(text) {
  return "'sha256-" + crypto.createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('base64') + "'";
}
// Inline block CONTENTS for a tag; skips <script src=…> (external -> 'self'), same rule the browser uses.
function inlineBlocks(html, tag) {
  const re = new RegExp('<' + tag + '\\b([^>]*)>([\\s\\S]*?)</' + tag + '>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    if (tag === 'script' && /\bsrc\s*=/i.test(m[1] || '')) continue;
    out.push(m[2]);
  }
  return out;
}
// The value of a single CSP directive (e.g. everything after "script-src ").
function directive(policy, name) {
  return policy.split('; ').find((d) => d === name || d.startsWith(name + ' ')) || '';
}
const countSha = (s) => (s.match(/sha256-/g) || []).length;

const htmlFiles = fs.readdirSync(PUBLIC).filter((n) => n.endsWith('.html'));

test('every inline <script>/<style> across public/*.html is hashed into that page\'s CSP (presence + exact count)', () => {
  assert.ok(htmlFiles.length > 0, 'there must be HTML pages to check');
  let totalScript = 0, totalStyle = 0;
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    const policy = csp.cspFor(f);
    assert.ok(policy && typeof policy === 'string', `${f}: must have a CSP policy`);

    const scriptBlocks = inlineBlocks(html, 'script');
    const styleBlocks = inlineBlocks(html, 'style');
    totalScript += scriptBlocks.length; totalStyle += styleBlocks.length;

    // (a) Every independently-computed hash MUST appear in the policy — a mis-computed hash fails here.
    for (const t of scriptBlocks.map(sha256Token)) assert.ok(policy.includes(t), `${f}: script-src is missing inline hash ${t}`);
    for (const t of styleBlocks.map(sha256Token)) assert.ok(policy.includes(t), `${f}: style-src is missing inline hash ${t}`);

    // (b) Per-directive sha256 count MUST equal the inline-block count — a dropped hash fails here even
    // though buildCsp still returns a (shorter) non-empty policy.
    assert.strictEqual(countSha(directive(policy, 'script-src')), scriptBlocks.length, `${f}: script-src sha256 count != inline <script> count`);
    assert.strictEqual(countSha(directive(policy, 'style-src')), styleBlocks.length, `${f}: style-src sha256 count != inline <style> count`);
  }
  // Sanity: the suite is actually exercising real inline content, not silently passing on zero blocks.
  assert.ok(totalScript + totalStyle > 0, 'expected at least one inline block across the pages');
});

test('csp module: enforcing header name + REPORT_ONLY flag in this (unset) process', () => {
  // The test process has PLANNR_CSP_REPORT_ONLY unset, so the loaded module must be in enforcing mode.
  assert.strictEqual(csp.REPORT_ONLY, false);
  assert.strictEqual(csp.HEADER_NAME, 'Content-Security-Policy');
});

// PLANNR_CSP_REPORT_ONLY is read at MODULE LOAD (const REPORT_ONLY = …), so the toggle can only be
// observed in a fresh process — spawn a child that requires csp.js with the env set.
function headerNameWith(reportOnlyValue) {
  const env = Object.assign({}, process.env, { PLANNR_CSP_REPORT_ONLY: reportOnlyValue });
  return execFileSync(process.execPath, ['-e', "process.stdout.write(require('./csp.js').HEADER_NAME)"], { cwd: ROOT, env, encoding: 'utf8' });
}

test('PLANNR_CSP_REPORT_ONLY=1 flips the header name to Content-Security-Policy-Report-Only', () => {
  assert.strictEqual(headerNameWith('1'), 'Content-Security-Policy-Report-Only');
  assert.strictEqual(headerNameWith('0'), 'Content-Security-Policy', 'anything other than "1" stays enforcing');
});
