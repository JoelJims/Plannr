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

test('the manifest declares the tools namespace that tools:node needs', () => {
  assert.match(xml, /<manifest\b[^>]*xmlns:tools="http:\/\/schemas\.android\.com\/tools"/);
});
