#!/usr/bin/env node
// npm run release:android — build an Android release APK that can be installed OVER the old app.
// Phase 2, Step 7. The full checklist (back up the phone first, install, check the data) is in
// docs/RELEASE.md; this script does the build part, in this order:
//   1. runs every test: `npm test` and every `npm run test:*` UI suite except test:slow — stops at
//      the first failure, before anything is changed;
//   2. bumps versionCode (+1) and versionName in android/app/build.gradle (Android only installs an
//      update with a higher versionCode);
//   3. runs `npm run android:sync` (copies public/ into the Android project);
//   4. builds the release APK with Gradle (signed with the release key if keystore.properties is
//      present; the key never leaves the machine and is never printed).
// If the sync or the build fails, build.gradle is put back as it was.
//
// Usage:  npm run release:android                        versionName 1.0 -> 1.1, versionCode +1
//         npm run release:android -- --version-name 2.0  choose the versionName
//         npm run release:android -- --dry-run           show what would happen; change nothing
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = __dirname;
const GRADLE_FILE = path.join(ROOT, 'android', 'app', 'build.gradle');
const APK = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'Plannr.apk');

// Every test command, in the order the full suite runs them.
function testCommands(pkg) {
  const ui = Object.keys(pkg.scripts).filter((k) => k.startsWith('test:') && k !== 'test:slow');
  return [['npm', ['test']], ...ui.map((k) => ['npm', ['run', '-s', k]])];
}

// "1.0" -> "1.1", "1.2.9" -> "1.2.10"; anything else must be given with --version-name.
function nextVersionName(name) {
  const m = /^(.*?)(\d+)$/.exec(name);
  if (!m) throw new Error(`cannot bump versionName "${name}" automatically; pass --version-name`);
  return m[1] + (Number(m[2]) + 1);
}

// Returns { text, from: {code, name}, to: {code, name} } with exactly one versionCode and one
// versionName line rewritten. Throws if either is missing or appears more than once.
function bumpVersions(gradleText, { versionName } = {}) {
  const codeRe = /^(\s*versionCode\s+)(\d+)\s*$/m;
  const nameRe = /^(\s*versionName\s+)"([^"]+)"\s*$/m;
  for (const [re, label] of [[codeRe, 'versionCode'], [nameRe, 'versionName']]) {
    const all = gradleText.match(new RegExp(re.source, 'gm')) || [];
    if (all.length !== 1) throw new Error(`expected exactly one ${label} line in build.gradle, found ${all.length}`);
  }
  const code = Number(codeRe.exec(gradleText)[2]);
  const name = nameRe.exec(gradleText)[2];
  const to = { code: code + 1, name: versionName || nextVersionName(name) };
  if (to.name === name) throw new Error(`versionName is already "${name}"`);
  const text = gradleText.replace(codeRe, `$1${to.code}`).replace(nameRe, `$1"${to.name}"`);
  return { text, from: { code, name }, to };
}

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  return r.status === 0;
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const i = argv.indexOf('--version-name');
  const versionName = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && !versionName) throw new Error('--version-name needs a value, e.g. --version-name 1.1');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const original = fs.readFileSync(GRADLE_FILE, 'utf8');
  const bump = bumpVersions(original, { versionName });
  const signed = fs.existsSync(path.join(ROOT, 'keystore.properties'));
  const tests = testCommands(pkg);

  console.log(`Plannr Android release: versionCode ${bump.from.code} -> ${bump.to.code}, versionName ${bump.from.name} -> ${bump.to.name}`);
  console.log(signed ? 'Signing: release key (keystore.properties found).' : 'WARNING: keystore.properties not found — the APK will be UNSIGNED and cannot be installed over the existing app.');
  if (dryRun) {
    console.log('\nDry run — would run, in order:');
    for (const [c, a] of tests) console.log(`  ${c} ${a.join(' ')}`);
    console.log('  (write the new versions to android/app/build.gradle)');
    console.log('  npm run android:sync');
    console.log(`  android/${process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'} assembleRelease`);
    console.log('Nothing was changed.');
    return 0;
  }

  console.log('\n== 1/4 Tests ==');
  for (const [c, a] of tests) {
    if (!run(c, a)) { console.error(`\nTests failed (${c} ${a.join(' ')}). Nothing was changed; no release built.`); return 1; }
  }

  console.log('\n== 2/4 Version bump ==');
  fs.writeFileSync(GRADLE_FILE, bump.text);
  console.log(`android/app/build.gradle: versionCode ${bump.to.code}, versionName "${bump.to.name}"`);
  const restore = (why) => { fs.writeFileSync(GRADLE_FILE, original); console.error(`\n${why} build.gradle was put back to versionCode ${bump.from.code}.`); return 1; };

  console.log('\n== 3/4 android:sync ==');
  if (!run('npm', ['run', 'android:sync'])) return restore('android:sync failed.');

  console.log('\n== 4/4 Release build ==');
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  if (!run(gradlew, ['assembleRelease'], { cwd: path.join(ROOT, 'android') })) return restore('The Gradle release build failed.');

  console.log(`\nDone: ${path.relative(ROOT, APK)} (versionCode ${bump.to.code}, versionName ${bump.to.name}${signed ? ', signed' : ', UNSIGNED'}).`);
  console.log('Next: commit the version bump, then follow docs/RELEASE.md (export a backup on the phone BEFORE installing).');
  return 0;
}

module.exports = { bumpVersions, nextVersionName, testCommands };
if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(`release:android: ${e.message}`); process.exit(1); }
}
