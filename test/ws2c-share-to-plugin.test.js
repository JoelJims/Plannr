// "Send to WhatsApp" (docs/share-and-reminder-pdf-plan.md, section 7): a small local Android plugin,
// ShareToPlugin.java, hands the PDF to WhatsApp (then WhatsApp Business) with ACTION_SEND and the
// FileProvider URI, and answers "not installed" instead of failing, so the page can fall back to the
// share sheet. It never sends: WhatsApp opens and the user taps Send. These checks read the sources
// (the Java is compiled by Gradle, not by the node tests).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.join(__dirname, '..', 'android', 'app', 'src', 'main');
const read = (...p) => fs.readFileSync(path.join(MAIN, ...p), 'utf8');
const JAVA = ['java', 'com', 'plannr', 'app'];

test('ShareToPlugin.java: ACTION_SEND of the PDF to com.whatsapp, then com.whatsapp.w4b', () => {
  const src = read(...JAVA, 'ShareToPlugin.java');
  assert.match(src, /@CapacitorPlugin\(name = "ShareTo"\)/);
  assert.match(src, /Intent\.ACTION_SEND\b/);
  assert.match(src, /setType\("application\/pdf"\)/);
  assert.match(src, /FileProvider\.getUriForFile\(/);
  assert.match(src, /getPackageName\(\) \+ "\.fileprovider"/, 'the authority the manifest registers: ${applicationId}.fileprovider');
  assert.match(src, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(src, /\{ "com\.whatsapp", "com\.whatsapp\.w4b" \}/, 'WhatsApp first, then WhatsApp Business');
  assert.match(src, /setPackage\(pkg\)/);
  assert.match(src, /"not-installed"/, 'answers "not installed" so the page falls back to the share sheet');
  assert.doesNotMatch(src, /ACTION_SENDTO|sendBroadcast|jid/i, 'never addresses or sends a message itself');
});

test('MainActivity registers ShareToPlugin before the bridge starts, like PlannrStoragePlugin', () => {
  const src = read(...JAVA, 'MainActivity.java');
  const reg = src.indexOf('registerPlugin(ShareToPlugin.class);');
  assert.ok(reg > 0, 'registerPlugin(ShareToPlugin.class)');
  assert.ok(reg < src.indexOf('super.onCreate('), 'registered before super.onCreate');
});

test('AndroidManifest.xml: <queries> for both WhatsApp packages (Android 11+ package visibility)', () => {
  const src = read('AndroidManifest.xml');
  const q = (src.match(/<queries>([\s\S]*?)<\/queries>/) || [])[1] || '';
  assert.match(q, /<package android:name="com\.whatsapp" \/>/);
  assert.match(q, /<package android:name="com\.whatsapp\.w4b" \/>/);
});
