// "Send to WhatsApp" and "Send by email" on the Overview PDF (docs/share-and-reminder-pdf-plan.md,
// section 4): the pieces of public/share-pdf.js that need no plugin, and the Overview page's two
// buttons. The plugin calls themselves (ShareTo, MailComposer, Share, Filesystem) and every fallback
// are checked in a browser with recording stand-ins: npm run test:share-pdf (test-ui/ws2c-share.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUBLIC = path.join(__dirname, '..', 'public');
const load = () => import(pathToFileURL(path.join(PUBLIC, 'share-pdf.js')).href);

test('fillSubject fills every {date} and leaves the rest of the subject alone', async () => {
  const { fillSubject } = await load();
  assert.strictEqual(fillSubject('Plannr report – {date}', '2026-11-25'), 'Plannr report – 2026-11-25');
  assert.strictEqual(fillSubject('{date}: site {date}', '2026-01-02'), '2026-01-02: site 2026-01-02');
  assert.strictEqual(fillSubject('No date here', '2026-01-02'), 'No date here');
});

test('localDate is the phone\'s own date, YYYY-MM-DD (not the UTC date)', async () => {
  const { localDate } = await load();
  assert.strictEqual(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.strictEqual(localDate(new Date(2026, 10, 25, 0, 1)), '2026-11-25');
});

test('the offline note shows only when the phone says it is offline, and names where the PDF goes', async () => {
  const { offlineNote } = await load();
  assert.strictEqual(offlineNote('whatsapp', true), '');
  assert.strictEqual(offlineNote('email', undefined), '');
  assert.match(offlineNote('whatsapp', false), /^You're offline: WhatsApp will send it when you're back online\.$/);
  assert.match(offlineNote('email', false), /your mail app will send it/);
  assert.match(offlineNote('sheet', false), /the app you pick will send it/);
});

test('share-pdf.js only opens apps: the plugin methods it calls, and none that sends', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'share-pdf.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const methods = [...code.matchAll(/\b(Filesystem|Share|MailComposer|plugin)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
  assert.deepStrictEqual([...new Set(methods)].sort(),
    ['Filesystem.writeFile', 'MailComposer.canComposeMail', 'MailComposer.composeMail', 'Share.share', 'plugin.whatsapp']);
  assert.doesNotMatch(code, /\.send\w*\(/i);
});

test('overview.html: the two buttons exist, start hidden, and are shown only in the app', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'overview.html'), 'utf8');
  assert.match(src, /<span class="ov-send" id="ovSendRow" hidden>/);
  assert.match(src, /<button type="button" class="ov-send-btn" id="ovSendWaBtn">Send to WhatsApp<\/button>/);
  assert.match(src, /<button type="button" class="ov-send-btn" id="ovSendMailBtn">Send by email<\/button>/);
  const init = src.slice(src.indexOf("const row = $('ovSendRow');"));
  assert.match(init.slice(0, 600), /if \(native\) \{\s*row\.hidden = false;/);
});
