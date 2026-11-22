// Phase 2, Step 7 — npm run release:android (release-android.js): the version bump and the test list.
// The full release (tests + sync + Gradle) is not run here; --dry-run checks the wiring changes nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bumpVersions, nextVersionName, testCommands, signingProblem, readStoreFile, signingFacts } = require('../release-android');

const ROOT = path.join(__dirname, '..');
const GRADLE = path.join(ROOT, 'android', 'app', 'build.gradle');
const sample = 'android {\n    defaultConfig {\n        applicationId "com.plannr.app"\n        versionCode 7\n        versionName "1.4"\n    }\n}\n';

test('bumpVersions raises versionCode by one and bumps versionName, touching nothing else', () => {
  const r = bumpVersions(sample);
  assert.deepStrictEqual([r.from, r.to], [{ code: 7, name: '1.4' }, { code: 8, name: '1.4.0' }]);
  assert.strictEqual(r.text, sample.replace('versionCode 7', 'versionCode 8').replace('"1.4"', '"1.4.0"'));
  const next = bumpVersions(r.text);
  assert.deepStrictEqual([next.from, next.to], [{ code: 8, name: '1.4.0' }, { code: 9, name: '1.4.1' }]);
});

test('bumpVersions keeps Windows line endings', () => {
  const crlf = sample.replace(/\n/g, '\r\n');
  assert.strictEqual(bumpVersions(crlf).text, bumpVersions(sample).text.replace(/\n/g, '\r\n'));
});

test('bumpVersions takes an explicit versionName', () => {
  assert.strictEqual(bumpVersions(sample, { versionName: '2.0.0' }).to.name, '2.0.0');
  assert.throws(() => bumpVersions(sample, { versionName: '1.4' }), /already "1.4"/);
});

test('bumpVersions refuses a build.gradle it cannot read safely', () => {
  assert.throws(() => bumpVersions(sample.replace(/\s*versionCode 7/, '')), /exactly one versionCode/);
  assert.throws(() => bumpVersions(sample + '        versionName "9.9"\n'), /exactly one versionName/);
});

// Owner decision (2026-11-22): the first public versionName is 1.0.0. So the plain release command
// turns today's two-part "1.0" into "1.0.0"; after that it bumps the last (patch) number.
test('nextVersionName: "1.0" becomes "1.0.0" (the first public release), then the patch number goes up', () => {
  assert.strictEqual(nextVersionName('1.0'), '1.0.0');
  assert.strictEqual(nextVersionName('2.3'), '2.3.0');
  assert.strictEqual(nextVersionName('1.0.0'), '1.0.1');
  assert.strictEqual(nextVersionName('1.2.9'), '1.2.10');
  for (const odd of ['beta', '1', '1.0.0.1', '1.0-rc1', '1.0.0-beta']) assert.throws(() => nextVersionName(odd), /--version-name/, odd);
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

// The key lives outside the project (SETUP.md section 2). keystore.properties' storeFile line points
// to it with a path relative to the project root. These facts stand in for the real files.
const KEY_REL = '../../Keys/demo/demo-release.keystore';
const KEY_ABS = path.resolve(ROOT, KEY_REL);
const keyFacts = (over) => ({ signed: true, allowUnsigned: false, storeFile: KEY_REL, keyPath: KEY_ABS, keyFound: true, ...over });

test('no release without the signing key, unless --allow-unsigned', () => {
  assert.strictEqual(signingProblem(keyFacts()), null);
  assert.match(signingProblem({ signed: false, allowUnsigned: false }), /UNSIGNED/);
  assert.strictEqual(signingProblem({ signed: false, allowUnsigned: true }), null);
});

test('keystore.properties is there but the key file it points to is missing: stop, and name the path', () => {
  const problem = signingProblem(keyFacts({ keyFound: false }));
  assert.ok(problem, 'a missing key file must stop the release');
  assert.ok(problem.includes(KEY_ABS), `the message names the expected path: ${problem}`);
  assert.match(problem, /SETUP\.md section 2/);
  // --allow-unsigned does not help: Gradle still tries to sign with the missing key and fails.
  assert.ok(signingProblem(keyFacts({ keyFound: false, allowUnsigned: true })));
});

test('keystore.properties without a storeFile line, or with an absolute one, stops the release', () => {
  assert.match(signingProblem(keyFacts({ storeFile: null, keyPath: null, keyFound: false })), /storeFile/);
  // build.gradle joins storeFile to the project root, so an absolute path never reaches the key. A
  // path with a drive letter but no slash after it ("C:Keys\...") is not relative to the project root
  // either. A relative path cannot change drive, so the message says the key must be on the same drive.
  const notRelative = ['D:\\Keys\\demo\\demo-release.keystore', '/keys/demo-release.keystore',
    'C:Keys\\demo\\demo-release.keystore', 'c:../Keys/demo/demo-release.keystore'];
  for (const abs of notRelative) {
    const problem = signingProblem(keyFacts({ storeFile: abs }));
    assert.match(problem, /relative to the project root/, abs);
    assert.match(problem, /same drive/, abs);
  }
});

test('readStoreFile returns the storeFile value and nothing else from keystore.properties', () => {
  // The other entries hold the passwords. Their key names are built from parts, and the dummy values
  // are short, so no secret scanner mistakes this sample for a real file.
  const pw = (who) => `${who}Pass` + 'word';
  const text = ['# release signing', '#storeFile=commented/out.keystore', 'storeFileOld=old.keystore',
    `storeFile = ${KEY_REL}`, `${pw('store')}=abc`, 'keyAlias=alias1', `${pw('key')}=xyz`, ''].join('\r\n');
  const value = readStoreFile(text);
  assert.strictEqual(value, KEY_REL);
  assert.strictEqual(typeof value, 'string');
  for (const other of ['abc', 'xyz', 'alias1', 'keyAlias', 'old.keystore', 'commented', '\n']) assert.ok(!value.includes(other), other);
  // The other separators Java's Properties allows, an escaped backslash, and no storeFile at all.
  assert.strictEqual(readStoreFile('  storeFile: a/b.keystore\n'), 'a/b.keystore');
  assert.strictEqual(readStoreFile('storeFile ..\\\\k.keystore\n'), '..\\k.keystore');
  assert.strictEqual(readStoreFile(`keyAlias=demo\n${pw('store')}=abc\n`), null);
  assert.strictEqual(readStoreFile('storeFile=\n'), null);
});

// A temporary folder laid out like the real thing: <tmp>/proj is the project root and <tmp>/keys
// holds the key, so keystore.properties says storeFile=../keys/demo.keystore. Removed after the test.
function tempProject(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-signing-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const proj = path.join(tmp, 'proj');
  const keyPath = path.join(tmp, 'keys', 'demo.keystore');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  return { tmp, proj, keyPath, props: path.join(proj, 'keystore.properties') };
}
// Stand-ins for the password lines. Their key names are built from parts and the values are dummies,
// so no secret scanner mistakes this for a real file.
const pwKey = (who) => `${who}Pass` + 'word';

// signingFacts is the only code that reads the real keystore.properties and looks for the key file.
// The test runs from the project checkout, not from <tmp>/proj, so a storeFile resolved against the
// current folder instead of the project root would point somewhere else and fail here.
test('signingFacts resolves storeFile against the project root, checks the key file, and keeps no other value', (t) => {
  const { proj, keyPath, props } = tempProject(t);
  fs.writeFileSync(props, ['# stand-in', `${pwKey('store')}=dummyS1`, 'keyAlias=aliasA3',
    'storeFile=../keys/demo.keystore', `${pwKey('key')}=dummyK2`, ''].join('\r\n'));
  fs.writeFileSync(keyPath, 'stand-in, not a real key');
  assert.notStrictEqual(path.resolve('../keys/demo.keystore'), keyPath, 'the current folder must not be <tmp>/proj');

  const facts = signingFacts(proj);
  assert.deepStrictEqual(facts, { signed: true, storeFile: '../keys/demo.keystore', keyPath, keyFound: true, bom: false });
  for (const other of ['dummyS1', 'dummyK2', 'aliasA3', 'keyAlias', 'stand-in']) {
    assert.ok(!JSON.stringify(facts).includes(other), `signingFacts must not return "${other}"`);
  }
  assert.strictEqual(signingProblem({ ...facts, allowUnsigned: false }), null);

  fs.rmSync(keyPath);
  assert.deepStrictEqual(signingFacts(proj), { signed: true, storeFile: '../keys/demo.keystore', keyPath, keyFound: false, bom: false });
  fs.mkdirSync(keyPath); // a folder with the key's name is not a key file
  assert.strictEqual(signingFacts(proj).keyFound, false);
  fs.rmSync(props);
  assert.deepStrictEqual(signingFacts(proj), { signed: false, storeFile: null, keyPath: null, keyFound: false, bom: false });
});

// Windows PowerShell 5.1 saves "UTF-8" files with a byte-order mark (BOM). Gradle reads
// keystore.properties as Latin-1, so the BOM becomes part of the first entry's name and Gradle cannot
// read that entry. The script must say so, not "no storeFile line" when the owner can see one.
test('a keystore.properties saved with a UTF-8 byte-order mark gets its own message', (t) => {
  const p = tempProject(t);
  fs.writeFileSync(p.keyPath, 'stand-in, not a real key');
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  const problemFor = (text, withBom) => {
    fs.writeFileSync(p.props, withBom ? Buffer.concat([BOM, Buffer.from(text)]) : text);
    return signingProblem({ ...signingFacts(p.proj), allowUnsigned: false });
  };
  const first = problemFor('storeFile=../keys/demo.keystore\nkeyAlias=aliasA3\n', true);
  assert.match(first, /starts with a UTF-8 byte-order mark/);
  assert.match(first, /Gradle cannot read its first entry/);
  assert.match(first, /Save it without one/);
  assert.match(first, /SETUP\.md section 2/);
  assert.doesNotMatch(first, /no storeFile line/);
  // With storeFile further down, Gradle still loses the first entry (here the alias): stop too.
  assert.match(problemFor('keyAlias=aliasA3\nstoreFile=../keys/demo.keystore\n', true), /byte-order mark/);
  // The same lines without a BOM are fine.
  assert.strictEqual(problemFor('storeFile=../keys/demo.keystore\nkeyAlias=aliasA3\n', false), null);
});

// Runs a copy of release-android.js with --dry-run in <tmp>/proj, next to a small package.json, the
// sample build.gradle and the given keystore.properties. Returns what it printed.
function dryRunIn({ proj, props }, propsContent) {
  fs.copyFileSync(path.join(ROOT, 'release-android.js'), path.join(proj, 'release-android.js'));
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: { test: 'node run-tests.js' } }));
  fs.mkdirSync(path.join(proj, 'android', 'app'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'android', 'app', 'build.gradle'), sample);
  fs.writeFileSync(props, propsContent);
  const r = spawnSync(process.execPath, ['release-android.js', '--dry-run'], { cwd: proj, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

// The "Signing:" line comes before the reason the release stops. It must not say the key is fine
// when the release is about to stop: for example for an absolute storeFile that points at a real file.
test('the Signing: line names the key only when the release can go ahead', (t) => {
  const p = tempProject(t);
  fs.writeFileSync(p.keyPath, 'stand-in, not a real key');

  const ready = dryRunIn(p, 'storeFile=../keys/demo.keystore\n');
  assert.ok(ready.includes(`Signing: release key at ${p.keyPath} (keystore.properties found).`), ready);
  assert.doesNotMatch(ready, /Would stop/);

  const absolute = p.keyPath.split(path.sep).join('/'); // a real file, but refused
  const refused = dryRunIn(p, `storeFile=${absolute}\n`);
  assert.match(refused, /Would stop: The storeFile line in keystore\.properties must be a path relative/);
  assert.doesNotMatch(refused, /release key at/);
  assert.match(refused, /^Signing: NOT ready/m);

  fs.rmSync(p.keyPath);
  const missing = dryRunIn(p, 'storeFile=../keys/demo.keystore\n');
  assert.match(missing, /Would stop: The release key is missing/);
  assert.match(missing, /^Signing: NOT ready/m);
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
