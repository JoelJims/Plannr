// Review finding S7 (2026-11-21, decided): the APK asked for USE_BIOMETRIC and USE_FINGERPRINT,
// added by the storage plugin's androidx.biometric dependency. Plannr never asks for a fingerprint
// or a face, so the app's manifest removes both from the merged manifest (tools:node="remove").
// The merged manifest only exists after a Gradle build; the APK itself was checked with
// `aapt dump permissions` when this changed. This test keeps the removal from being lost.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const xml = fs.readFileSync(MANIFEST, 'utf8');
const usesPermission = (name) => [...xml.matchAll(/<uses-permission\b[^>]*>/g)].map((m) => m[0])
  .filter((tag) => new RegExp(`android:name="android\\.permission\\.${name}"`).test(tag));

for (const name of ['USE_BIOMETRIC', 'USE_FINGERPRINT']) {
  test(`AndroidManifest.xml removes ${name} (no biometric prompt anywhere in Plannr)`, () => {
    const tags = usesPermission(name);
    assert.strictEqual(tags.length, 1, `exactly one <uses-permission> for ${name}`);
    assert.match(tags[0], /tools:node="remove"/, `${name} must be removed, not requested`);
  });
}

// #13, emulator check of 2026-11-28: in airplane mode the "You're offline" note on Send to WhatsApp /
// Send by email never showed, because navigator.onLine stayed true. Android's WebView tracks the
// network, and so navigator.onLine, only when the app holds ACCESS_NETWORK_STATE. It is a normal
// permission: granted at install, no prompt, and it only lets the app see whether it is online.
test('AndroidManifest.xml requests ACCESS_NETWORK_STATE (the WebView needs it for navigator.onLine)', () => {
  const tags = usesPermission('ACCESS_NETWORK_STATE');
  assert.strictEqual(tags.length, 1, 'exactly one <uses-permission> for ACCESS_NETWORK_STATE');
  assert.doesNotMatch(tags[0], /tools:node=/, 'requested, not removed or replaced');
});

test('the manifest declares the tools namespace that tools:node needs', () => {
  assert.match(xml, /<manifest\b[^>]*xmlns:tools="http:\/\/schemas\.android\.com\/tools"/);
});
