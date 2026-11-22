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
// Usage:  npm run release:android                          versionCode +1; versionName 1.0 -> 1.0.0
//                                                          (the first public release), then
//                                                          1.0.0 -> 1.0.1, 1.0.1 -> 1.0.2, ...
//         npm run release:android -- --version-name 1.1.0  choose the versionName
//         npm run release:android -- --dry-run             show what would happen; change nothing
// Without keystore.properties it stops before doing anything: an unsigned APK cannot be installed
// over the app on the phone (add --allow-unsigned to build one anyway, e.g. to test the build).
// The key itself lives outside the project (SETUP.md section 2); keystore.properties' storeFile line
// points to it with a path relative to the project root, so the key folder must be on the same drive
// as the project. If no key file is there, it also stops before doing anything. From
// keystore.properties it reads only that storeFile line.
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

// Version names are MAJOR.MINOR.PATCH (docs/release-plan.md section 2). The first public release is
// 1.0.0 (owner decision, 2026-11-22), so a two-part name gets its patch number: "1.0" -> "1.0.0".
// A three-part name bumps the patch number: "1.0.0" -> "1.0.1", "1.2.9" -> "1.2.10".
// Anything else must be given with --version-name.
function nextVersionName(name) {
  if (/^\d+\.\d+$/.test(name)) return `${name}.0`;
  const m = /^(\d+\.\d+\.)(\d+)$/.exec(name);
  if (!m) throw new Error(`cannot bump versionName "${name}" automatically; pass --version-name`);
  return m[1] + (Number(m[2]) + 1);
}

// Returns { text, from: {code, name}, to: {code, name} } with exactly one versionCode and one
// versionName line rewritten. Throws if either is missing or appears more than once.
function bumpVersions(gradleText, { versionName } = {}) {
  // [ \t] rather than \s, so a match never spans lines and a CRLF line keeps its \r.
  const codeRe = /^([ \t]*versionCode[ \t]+)(\d+)([ \t]*\r?)$/m;
  const nameRe = /^([ \t]*versionName[ \t]+)"([^"]+)"([ \t]*\r?)$/m;
  for (const [re, label] of [[codeRe, 'versionCode'], [nameRe, 'versionName']]) {
    const all = gradleText.match(new RegExp(re.source, 'gm')) || [];
    if (all.length !== 1) throw new Error(`expected exactly one ${label} line in build.gradle, found ${all.length}`);
  }
  const code = Number(codeRe.exec(gradleText)[2]);
  const name = nameRe.exec(gradleText)[2];
  const to = { code: code + 1, name: versionName || nextVersionName(name) };
  if (to.name === name) throw new Error(`versionName is already "${name}"`);
  const text = gradleText.replace(codeRe, `$1${to.code}$3`).replace(nameRe, `$1"${to.name}"$3`);
  return { text, from: { code, name }, to };
}

// The storeFile value from the text of keystore.properties, or null if there is none. That file also
// holds the passwords, so this reads ONLY the storeFile key: no other line or value is returned, kept
// or printed. It follows Java's Properties rules that this file can use (Gradle reads it with
// Properties.load): comment lines start with # or !, the key ends at "=", ":" or a space, a
// backslash escapes the next character, and the last storeFile line wins. Not handled: a value
// split over several lines with a trailing backslash.
function readStoreFile(propertiesText) {
  let value = null;
  for (const raw of String(propertiesText).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/^[ \t\f]+/, '');
    if (line.startsWith('#') || line.startsWith('!')) continue;
    const m = /^storeFile(?:[ \t\f]*[=:]|[ \t\f])[ \t\f]*(.*)$/.exec(line);
    if (!m) continue;
    const unescaped = m[1].replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex, c) =>
      hex ? String.fromCharCode(parseInt(hex, 16)) : ({ t: '\t', n: '\n', r: '\r', f: '\f' }[c] ?? c));
    value = unescaped.trim() || null;
  }
  return value;
}

// Why a release must not go ahead, or null. The facts are passed in, so this can be tested without
// the real files:
//   signed        keystore.properties exists in the project root;
//   storeFile     its storeFile value (readStoreFile), or null;
//   keyPath       storeFile resolved against the project root;
//   keyFound      a file exists at keyPath;
//   allowUnsigned --allow-unsigned was given.
// An unsigned release APK cannot update the installed app, and a keystore.properties that points to
// a missing key makes the Gradle build fail after the version bump.
function signingProblem({ signed, allowUnsigned, storeFile, keyPath, keyFound }) {
  if (!signed) {
    if (allowUnsigned) return null;
    return 'keystore.properties not found in the project root, so the APK would be UNSIGNED and could not be installed over the app on the phone. See SETUP.md section 2. (--allow-unsigned builds one anyway.)';
  }
  // From here on keystore.properties exists, so Gradle WILL try to sign: --allow-unsigned cannot help.
  if (!storeFile) return 'keystore.properties has no storeFile line, so Gradle cannot find the release key. See SETUP.md section 2.';
  // A drive letter with no slash after it ("C:Keys\...") is not absolute, but it is not relative to
  // the project root either, so it is refused too.
  if (path.win32.isAbsolute(storeFile) || path.posix.isAbsolute(storeFile) || /^[A-Za-z]:/.test(storeFile)) {
    return 'The storeFile line in keystore.properties must be a path relative to the project root, with no drive letter (android/app/build.gradle joins it to the project root, so an absolute path never reaches the key). A relative path cannot change drive, so the key folder must be on the same drive as the project: on a PC with only C:, keep the key in C:\\Keys\\plannr\\ and the project under C:\\. See SETUP.md section 2.';
  }
  if (!keyFound) return `The release key is missing: keystore.properties points to ${keyPath} (its storeFile line, relative to the project root), but there is no file there. Put the key back there or correct the storeFile line. See SETUP.md section 2.`;
  return null;
}

// Where keystore.properties says the key is, and whether it is there. Reads only the storeFile line.
// root is the project root: storeFile is resolved against it, never against the current folder,
// because android/app/build.gradle does the same (new File(projectRootDir, storeFile)).
function signingFacts(root) {
  const propsFile = path.join(root, 'keystore.properties');
  const signed = fs.existsSync(propsFile);
  // latin1: the encoding Java's Properties.load uses for this file.
  const storeFile = signed ? readStoreFile(fs.readFileSync(propsFile, 'latin1')) : null;
  const keyPath = storeFile ? path.resolve(root, storeFile) : null;
  const keyFound = keyPath ? Boolean(fs.statSync(keyPath, { throwIfNoEntry: false })?.isFile()) : false;
  return { signed, storeFile, keyPath, keyFound };
}

// The "Signing:" line printed before anything runs. problem is signingProblem's answer. The line
// names the key only when the release can go ahead; otherwise the reason is printed right after it.
function signingLine({ signed, keyPath }, problem) {
  if (!signed) return 'Signing: keystore.properties NOT found.';
  if (problem) return 'Signing: NOT ready. keystore.properties is there, but the release key cannot be used (reason below).';
  return `Signing: release key at ${keyPath} (keystore.properties found).`;
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
  if (i >= 0 && !versionName) throw new Error('--version-name needs a value, e.g. --version-name 1.1.0');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const original = fs.readFileSync(GRADLE_FILE, 'utf8');
  const bump = bumpVersions(original, { versionName });
  const facts = signingFacts(ROOT);
  const { signed } = facts;
  const tests = testCommands(pkg);

  console.log(`Plannr Android release: versionCode ${bump.from.code} -> ${bump.to.code}, versionName ${bump.from.name} -> ${bump.to.name}`);
  const problem = signingProblem({ ...facts, allowUnsigned: argv.includes('--allow-unsigned') });
  console.log(signingLine(facts, problem));
  if (dryRun) {
    if (problem) console.log(`Would stop: ${problem}`);
    console.log('\nDry run — would run, in order:');
    for (const [c, a] of tests) console.log(`  ${c} ${a.join(' ')}`);
    console.log('  (write the new versions to android/app/build.gradle)');
    console.log('  npm run android:sync');
    console.log(`  android/${process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'} assembleRelease`);
    console.log('Nothing was changed.');
    return 0;
  }
  if (problem) { console.error(`\n${problem}\nNothing was changed.`); return 1; }

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

module.exports = { bumpVersions, nextVersionName, testCommands, signingProblem, readStoreFile, signingFacts };
if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(`release:android: ${e.message}`); process.exit(1); }
}
