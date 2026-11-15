// Phase 2, Step 7 — npm run release:android (release-android.js): the version bump and the test list.
// The full release (tests + sync + Gradle) is not run here; --dry-run checks the wiring changes nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bumpVersions, nextVersionName, testCommands } = require('../release-android');

const ROOT = path.join(__dirname, '..');
const GRADLE = path.join(ROOT, 'android', 'app', 'build.gradle');
const sample = 'android {\n    defaultConfig {\n        applicationId "com.plannr.app"\n        versionCode 7\n        versionName "1.4"\n    }\n}\n';

test('bumpVersions raises versionCode by one and bumps versionName, touching nothing else', () => {
  const r = bumpVersions(sample);
  assert.deepStrictEqual([r.from, r.to], [{ code: 7, name: '1.4' }, { code: 8, name: '1.5' }]);
  assert.strictEqual(r.text, sample.replace('versionCode 7', 'versionCode 8').replace('"1.4"', '"1.5"'));
});

test('bumpVersions takes an explicit versionName', () => {
  assert.strictEqual(bumpVersions(sample, { versionName: '2.0.0' }).to.name, '2.0.0');
  assert.throws(() => bumpVersions(sample, { versionName: '1.4' }), /already "1.4"/);
});

test('bumpVersions refuses a build.gradle it cannot read safely', () => {
  assert.throws(() => bumpVersions(sample.replace(/\s*versionCode 7/, '')), /exactly one versionCode/);
  assert.throws(() => bumpVersions(sample + '        versionName "9.9"\n'), /exactly one versionName/);
});

test('nextVersionName bumps the last number', () => {
  assert.strictEqual(nextVersionName('1.0'), '1.1');
  assert.strictEqual(nextVersionName('1.2.9'), '1.2.10');
  assert.throws(() => nextVersionName('beta'), /--version-name/);
});

test('the real build.gradle can be bumped', () => {
  const r = bumpVersions(fs.readFileSync(GRADLE, 'utf8'));
  assert.strictEqual(r.to.code, r.from.code + 1);
});

test('the release runs npm test and every UI suite (except test:slow)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['release:android'], 'node release-android.js');
  const cmds = testCommands(pkg).map(([c, a]) => `${c} ${a.join(' ')}`);
  assert.strictEqual(cmds[0], 'npm test');
  const ui = Object.keys(pkg.scripts).filter((k) => k.startsWith('test:') && k !== 'test:slow');
  assert.ok(ui.length >= 10);
  for (const k of ui) assert.ok(cmds.includes(`npm run -s ${k}`), k);
  assert.ok(!cmds.some((c) => c.includes('test:slow')));
});

test('--dry-run shows the plan and changes nothing', () => {
  const before = fs.readFileSync(GRADLE, 'utf8');
  const r = spawnSync(process.execPath, ['release-android.js', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /versionCode \d+ -> \d+/);
  assert.match(r.stdout, /npm run android:sync/);
  assert.match(r.stdout, /Nothing was changed/);
  assert.strictEqual(fs.readFileSync(GRADLE, 'utf8'), before);
});
