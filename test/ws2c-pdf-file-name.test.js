// The Overview PDF's file name carries the phone's own (local) date, the same date as the email
// subject's {date} (owner's decision for the Send buttons, docs/share-and-reminder-pdf-plan.md).
// The name used to take the UTC date (toISOString), which in India is a day behind between 00:00
// and 05:30: a PDF made at 01:30 on 26 November was named for the 25th while its subject said the 26th.
//
// A time zone only applies to a Node process that starts with it, so each case runs in a child
// process with TZ set and "now" fixed. The child runs the real code: the Overview page's own
// file-name statement (public/overview.html), the subject from public/share-pdf.js, and the PDF route
// (core/routes/pdf.js, which on the phone runs on the phone itself). The last case runs a whole send
// with a clock that passes midnight after its first read: the page reads the clock once per send.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The child: fixes "now", then answers what each piece of code makes of it, as JSON.
const CHILD = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { root, now } = JSON.parse(process.env.PLANNR_PDF_NAME_CASE);
const url = (rel) => pathToFileURL(path.join(root, rel)).href;
const RealDate = Date;
const NOW = RealDate.parse(now);
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
};
const out = { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
const d = new Date();
out.utcDate = d.toISOString().slice(0, 10);
out.localDay = d.getDate();

let helper = null;
try { helper = await import(url('core/local-date.js')); } catch (e) { out.helperError = e.code || e.message; }

// The page's own statement that names the file, run as it is written (now: the page's one clock read).
const page = fs.readFileSync(path.join(root, 'public', 'overview.html'), 'utf8');
const m = /const fname = ([^;\n]+);/.exec(page);
out.pageStatement = m ? m[1] : null;
try { out.pageName = m ? new Function('part', 'overviewPdfName', 'now', 'return ' + m[1] + ';')('full', helper && helper.overviewPdfName, new Date()) : null; }
catch (e) { out.pageError = e.message; }

const share = await import(url('public/share-pdf.js'));
out.subject = share.fillSubject(share.DEFAULT_SUBJECT, share.localDate());
// share-pdf.js reaches the helper through public/core/, the synced copy of core/ (sync-public-modules.js).
try { out.subjectUsesHelper = share.localDate === (await import(url('public/core/local-date.js'))).localDateStamp; }
catch { out.subjectUsesHelper = false; }

const { register } = await import(url('core/routes/pdf.js'));
const { istDateStamp } = await import(url('core/ist-date.js'));
const routes = {};
register({ get: (p, ...h) => { routes[p] = h[h.length - 1]; } }, {
  auth: (req, res, next) => next(), exclusive: (fn) => fn(), istDateStamp, logError: () => {},
  readPdfQuery: () => ({ part: 'full', theme: 'light', range: {} }),
  overviewPdfHtml: () => '<html></html>',
  host: { pdf: { render: async () => new Uint8Array([37, 80, 68, 70]) } },
});
const headers = {};
const res = { setHeader: (k, v) => { headers[k] = v; }, status() { return this; }, json(b) { out.routeError = b; }, send() {} };
await routes['/api/overview/pdf']({ query: {} }, res, () => {});
out.routeName = (/filename="([^"]+)"/.exec(headers['Content-Disposition'] || '') || [])[1] || null;

process.stdout.write(JSON.stringify(out));
`;

// The second child: one whole send, run as the page runs it. It runs the Overview page's own
// downloadPdf (public/overview.html, as written) with the real public/share-pdf.js and
// core/local-date.js (its synced copy in public/core/, which the page imports as /core/local-date.js);
// the app's plugins are recording stand-ins (a module hook), and so are the
// page's helpers around downloadPdf. The clock says 23:59:59 on 25 November (India) the first time
// it is read and 00:00:01 on the 26th every time after, so a send that reads it twice gives the file
// name and the email subject two different dates.
const SEND_CHILD = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';
const { root, first, later } = JSON.parse(process.env.PLANNR_PDF_NAME_CASE);

// The app's plugins, recording what they are handed into globalThis.__native.
const PLUGINS = {
  '@capacitor/core': 'export const Capacitor = { isNativePlatform: () => true };'
    + ' export const registerPlugin = () => ({ whatsapp: async (o) => { globalThis.__native.push({ call: "ShareTo.whatsapp", path: o.path }); return { opened: true }; } });',
  '@capacitor/filesystem': 'export const Directory = { Cache: "CACHE" };'
    + ' export const Filesystem = { writeFile: async (o) => { globalThis.__native.push({ call: "Filesystem.writeFile", path: o.path }); return { uri: "file:///cache/" + o.path }; } };',
  '@capacitor/share': 'export const Share = { share: async (o) => { globalThis.__native.push({ call: "Share.share", url: o.url }); return {}; } };',
  '@capawesome/capacitor-mail-composer': 'export const MailComposer = { canComposeMail: async () => ({ canCompose: true }),'
    + ' composeMail: async (o) => { globalThis.__native.push({ call: "MailComposer.composeMail", subject: o.subject }); } };',
};
// The page's own "/..." imports come from the app's web root, public/.
const WEB_ROOT = pathToFileURL(path.join(root, 'public') + path.sep).href;
const HOOKS = 'const PLUGINS = ' + JSON.stringify(PLUGINS) + '; const WEB_ROOT = ' + JSON.stringify(WEB_ROOT) + ';'
  + ' export async function resolve(spec, ctx, next) {'
  + '   if (Object.hasOwn(PLUGINS, spec)) return { url: "data:text/javascript," + encodeURIComponent(PLUGINS[spec]), shortCircuit: true };'
  + '   if (spec.startsWith("/") && !spec.startsWith("//")) return { url: new URL(spec.slice(1), WEB_ROOT).href, shortCircuit: true };'
  + '   return next(spec, ctx);'
  + ' }';
register('data:text/javascript,' + encodeURIComponent(HOOKS));
globalThis.FileReader = class { readAsDataURL() { this.result = 'data:application/pdf;base64,JVBERg=='; queueMicrotask(() => this.onload()); } };

// The clock: 'first' at the first read, 'later' at every read after it.
const RealDate = Date;
const FIRST = RealDate.parse(first);
const LATER = RealDate.parse(later);
let reads = 0;
const tick = () => (reads++ === 0 ? FIRST : LATER);
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(tick()); }
  static now() { return tick(); }
};
const out = { firstDay: new RealDate(FIRST).getDate(), laterDay: new RealDate(LATER).getDate() };

// The page's downloadPdf, as written, with stand-ins for what it uses from the rest of the page.
const page = fs.readFileSync(path.join(root, 'public', 'overview.html'), 'utf8');
const start = page.indexOf('async function downloadPdf(');
const end = page.indexOf("$('ovPdfBtn').addEventListener", start);
if (start < 0 || end < 0) throw new Error('downloadPdf was not found in public/overview.html');
const messages = [];
const buttons = {};
const deps = {
  window: { PlannrUI: { choiceModal: async () => 'light' } },
  $: (id) => (buttons[id] ||= { id, disabled: false }),
  ovMsg: { clear() {}, show(text, kind) { messages.push(kind + ': ' + text); } },
  withTimeout: (p) => p,
  fetch: async () => ({ ok: true, status: 200, blob: async () => new Blob(['%PDF'], { type: 'application/pdf' }) }),
  pdfRangeQuery: () => '',
  errText: (err) => (err && err.message) ? err.message : String(err),
  readShareSettings: async () => ({ emailTo: [], emailSubject: 'Plannr report – {date}' }),
};
const downloadPdf = new Function(...Object.keys(deps), page.slice(start, end) + '\nreturn downloadPdf;')(...Object.values(deps));

for (const target of ['email', 'whatsapp', 'sheet']) {
  reads = 0;
  globalThis.__native = [];
  messages.length = 0;
  await downloadPdf('full', target);
  out[target] = { reads, native: globalThis.__native, messages: [...messages] };
}
process.stdout.write(JSON.stringify(out));
`;

function runChild(src, timeZone, kase) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TZ: timeZone, PLANNR_PDF_NAME_CASE: JSON.stringify({ root: ROOT, ...kase }) },
  });
  assert.strictEqual(r.status, 0, `the child process failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const runIn = (timeZone, now) => runChild(CHILD, timeZone, { now });
const dateIn = (name) => (/(\d{4}-\d{2}-\d{2})/.exec(name || '') || [])[1];

test('India, 01:30 on 26 November (20:00 UTC on the 25th): every PDF file name says 2026-11-26, like the email subject', () => {
  const out = runIn('Asia/Kolkata', '2026-11-25T20:00:00Z');
  // Without this the case would prove nothing: the child really is at 01:30 on the 26th.
  assert.ok(out.utcDate === '2026-11-25' && out.localDay === 26, `the time zone did not apply in the child: ${JSON.stringify(out)}`);
  assert.strictEqual(out.subject, 'Plannr report – 2026-11-26', 'the email subject\'s {date} is the phone\'s date');
  assert.strictEqual(out.pageName, 'plannr-overview-full-2026-11-26.pdf',
    `the Overview page names the PDF with the local date (its statement: ${out.pageStatement})`);
  assert.strictEqual(dateIn(out.pageName), dateIn(out.subject), 'the file name and the subject carry the same date');
  assert.strictEqual(out.routeName, 'plannr-overview-full-2026-11-26.pdf', 'the PDF route\'s file name uses the local date');
});

test('a phone set to New York, 15:00 on 25 November (01:30 on the 26th in India): the names follow the phone, not India', () => {
  const out = runIn('America/New_York', '2026-11-25T20:00:00Z');
  assert.ok(out.utcDate === '2026-11-25' && out.localDay === 25, `the time zone did not apply in the child: ${JSON.stringify(out)}`);
  assert.strictEqual(out.subject, 'Plannr report – 2026-11-25');
  assert.strictEqual(out.pageName, 'plannr-overview-full-2026-11-25.pdf');
  assert.strictEqual(out.routeName, 'plannr-overview-full-2026-11-25.pdf', 'the PDF route\'s file name uses the local date, not the IST date');
});

test('one helper: core/local-date.js names every Overview PDF, and the subject\'s {date} comes from it too', () => {
  const out = runIn('Asia/Kolkata', '2026-11-25T20:00:00Z');
  assert.ok(!out.helperError, `core/local-date.js could not be loaded: ${out.helperError}`);
  assert.match(out.pageStatement || '', /^overviewPdfName\(part, now\)$/, 'overview.html builds the name with overviewPdfName, from its one clock read');
  assert.ok(out.subjectUsesHelper, 'share-pdf.js\'s localDate (the subject\'s {date}) is core/local-date.js\'s localDateStamp');
  // No other copy of a dated Overview PDF name, and no UTC date in the code that names it.
  for (const rel of ['public/overview.html', 'public/share-pdf.js', 'public/local-api.js', 'core/routes/pdf.js', 'core/overview-pdf.js', 'server.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /plannr-overview-\$\{[^}]+\}-/, `${rel} builds its own dated PDF name`);
  }
  assert.doesNotMatch(read('public/overview.html'), /toISOString\(\)\.slice\(0, 10\)/, 'overview.html still uses the UTC date');
  assert.match(read('core/routes/pdf.js'), /overviewPdfName\(part\)/, 'the PDF route names the file with overviewPdfName');
});

test('one clock read per send: a send at 23:59:59 names the PDF and fills the subject with the same date, though midnight passes before the subject is made', () => {
  const out = runChild(SEND_CHILD, 'Asia/Kolkata', { first: '2026-11-25T18:29:59Z', later: '2026-11-25T18:30:01Z' });
  // Without this the case would prove nothing: the clock really crosses midnight in the child.
  assert.ok(out.firstDay === 25 && out.laterDay === 26, `the clock does not cross midnight in the child: ${JSON.stringify(out)}`);
  const NAME = 'plannr-overview-full-2026-11-25.pdf';
  const calls = (sent, call) => sent.native.filter((c) => c.call === call);

  const email = out.email;
  assert.deepStrictEqual(email.messages.filter((m) => m.startsWith('error')), [], 'Send by email showed an error');
  const written = calls(email, 'Filesystem.writeFile').map((c) => c.path);
  const subjects = calls(email, 'MailComposer.composeMail').map((c) => c.subject);
  assert.ok(written.length === 1 && subjects.length === 1, `Send by email did not write one file and open the mail app once: ${JSON.stringify(email)}`);
  assert.strictEqual(dateIn(written[0]), dateIn(subjects[0]),
    `the file name and the email subject carry the same date (file ${written[0]}, subject "${subjects[0]}")`);
  assert.deepStrictEqual({ file: written[0], subject: subjects[0] }, { file: NAME, subject: 'Plannr report – 2026-11-25' },
    'both carry the date of the one clock read, 25 November');
  assert.strictEqual(email.reads, 1, 'Send by email reads the clock once');

  for (const [target, call] of [['whatsapp', 'ShareTo.whatsapp'], ['sheet', 'Share.share']]) {
    const sent = out[target];
    assert.deepStrictEqual(sent.messages.filter((m) => m.startsWith('error')), [], `${target}: an error was shown`);
    assert.strictEqual(calls(sent, call).length, 1, `${target}: ${call} was not called once: ${JSON.stringify(sent)}`);
    assert.deepStrictEqual(calls(sent, 'Filesystem.writeFile').map((c) => c.path), [NAME], `${target}: the PDF's file name`);
    assert.strictEqual(sent.reads, 1, `${target}: the clock is read once`);
  }
});
