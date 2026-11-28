// The release signing passwords come from the environment (or a hidden prompt), never from a file in
// the project. android/app/build.gradle reads them from PLANNR_STORE_PASSWORD and PLANNR_KEY_PASSWORD;
// release-android.js reads them from there or asks for them without echo, and hands them to Gradle
// only through the child process environment: never in argv, never written to disk, never printed.
// keystore.properties keeps only storeFile and keyAlias; a file that still has password lines stops
// the release (see docs/RELEASE.md).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const release = require('../release-android');

const ROOT = path.join(__dirname, '..');
// Key names built from parts and dummy values, so no secret scanner mistakes this for a real file.
const pwKey = (who) => `${who}Pass` + 'word';
const ENV_STORE = 'PLANNR_STORE_PASSWORD';
const ENV_KEY = 'PLANNR_KEY_PASSWORD';

test('build.gradle takes both passwords from the environment, none from keystore.properties', () => {
  const gradle = fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
  assert.doesNotMatch(gradle, /getProperty\(\s*['"](store|key)Password['"]\s*\)/, 'no password read from the properties file');
  assert.match(gradle, /storePassword\s+System\.getenv\(\s*['"]PLANNR_STORE_PASSWORD['"]\s*\)/);
  assert.match(gradle, /keyPassword\s+System\.getenv\(\s*['"]PLANNR_KEY_PASSWORD['"]\s*\)/);
  // storeFile and keyAlias still come from keystore.properties.
  assert.match(gradle, /getProperty\(\s*['"]storeFile['"]\s*\)/);
  assert.match(gradle, /getProperty\(\s*['"]keyAlias['"]\s*\)/);
});

test('passwordLinesIn names the password lines of keystore.properties and never returns a value', () => {
  assert.strictEqual(typeof release.passwordLinesIn, 'function', 'release-android.js exports passwordLinesIn');
  const text = ['# stand-in', `${pwKey('store')}=dummyS1`, 'keyAlias=aliasA3', 'storeFile=../keys/demo.keystore',
    `  ${pwKey('key')} : dummyK2`, `#${pwKey('store')}=commentedOut`, ''].join('\r\n');
  const names = release.passwordLinesIn(text);
  assert.deepStrictEqual(names, [pwKey('store'), pwKey('key')]);
  for (const v of ['dummyS1', 'dummyK2', 'aliasA3', 'commentedOut']) assert.ok(!JSON.stringify(names).includes(v), v);
  assert.deepStrictEqual(release.passwordLinesIn('storeFile=../k.keystore\nkeyAlias=a\n'), []);
});

test('keystore.properties with password lines stops the release, naming the lines but not the values', () => {
  const facts = { signed: true, storeFile: '../keys/demo.keystore', keyPath: '/x/keys/demo.keystore', keyFound: true, bom: false, utf16: false };
  assert.strictEqual(release.signingProblem({ ...facts, allowUnsigned: false, passwordLines: [] }), null);
  const problem = release.signingProblem({ ...facts, allowUnsigned: false, passwordLines: [pwKey('store'), pwKey('key')] });
  assert.ok(problem, 'a file that still holds passwords must stop the release');
  assert.match(problem, new RegExp(pwKey('store')));
  assert.match(problem, /PLANNR_STORE_PASSWORD/);
  assert.match(problem, /remove/i);
});

test('passwordPlan: environment first, then a hidden prompt in a terminal, otherwise stop', () => {
  assert.strictEqual(typeof release.passwordPlan, 'function', 'release-android.js exports passwordPlan');
  const both = { [ENV_STORE]: 'dummyS1', [ENV_KEY]: 'dummyK2' };
  assert.deepStrictEqual(release.passwordPlan({ env: both, interactive: false }), { source: 'environment', missing: [] });
  assert.deepStrictEqual(release.passwordPlan({ env: { [ENV_STORE]: 'dummyS1' }, interactive: true }), { source: 'prompt', missing: [ENV_KEY] });
  const none = release.passwordPlan({ env: {}, interactive: false });
  assert.strictEqual(none.source, null);
  assert.deepStrictEqual(none.missing, [ENV_STORE, ENV_KEY]);
  assert.match(none.problem, /PLANNR_STORE_PASSWORD/);
  assert.match(none.problem, /PLANNR_KEY_PASSWORD/);
  // An empty variable counts as missing.
  assert.deepStrictEqual(release.passwordPlan({ env: { [ENV_STORE]: '', [ENV_KEY]: 'x' }, interactive: false }).missing, [ENV_STORE]);
});

test('the Gradle call carries the passwords in its environment only, never in argv', () => {
  assert.strictEqual(typeof release.gradleInvocation, 'function', 'release-android.js exports gradleInvocation');
  const base = { PATH: '/bin', OTHER: '1' };
  for (const platform of ['win32', 'linux']) {
    const call = release.gradleInvocation(platform, { store: 'dummyS1', key: 'dummyK2' }, base);
    assert.deepStrictEqual(call.args, ['assembleRelease']);
    const argv = JSON.stringify([call.cmd, call.args]);
    assert.ok(!argv.includes('dummyS1') && !argv.includes('dummyK2'), `no password in argv: ${argv}`);
    assert.strictEqual(call.env[ENV_STORE], 'dummyS1');
    assert.strictEqual(call.env[ENV_KEY], 'dummyK2');
    assert.strictEqual(call.env.OTHER, '1');
  }
  assert.ok(!(ENV_STORE in base), 'the base environment is not changed');
  // Unsigned (--allow-unsigned): no password variables are added.
  const unsigned = release.gradleInvocation('linux', null, base);
  assert.ok(!(ENV_STORE in unsigned.env) && !(ENV_KEY in unsigned.env));
});

// The script itself, in a temporary project: a dry run with password lines in keystore.properties
// says it would stop and never prints their values; a real run with no terminal and no variables
// stops before anything changes.
function tempProject(t, propsText) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-pw-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(proj, 'android', 'app'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'keys'));
  fs.writeFileSync(path.join(tmp, 'keys', 'demo.keystore'), 'stand-in, not a real key');
  fs.copyFileSync(path.join(ROOT, 'release-android.js'), path.join(proj, 'release-android.js'));
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }));
  fs.writeFileSync(path.join(proj, 'android', 'app', 'build.gradle'), 'versionCode 1\nversionName "1.0"\n');
  fs.writeFileSync(path.join(proj, 'keystore.properties'), propsText);
  return proj;
}
const cleanEnv = () => { const e = { ...process.env }; delete e[ENV_STORE]; delete e[ENV_KEY]; return e; };

test('dry run: password lines in keystore.properties mean "would stop", with no value printed', (t) => {
  const proj = tempProject(t, `storeFile=../keys/demo.keystore\nkeyAlias=aliasA3\n${pwKey('store')}=dummyS1\n${pwKey('key')}=dummyK2\n`);
  const r = spawnSync(process.execPath, ['release-android.js', '--dry-run'], { cwd: proj, encoding: 'utf8', env: cleanEnv() });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Would stop: .*password/i, r.stdout);
  for (const v of ['dummyS1', 'dummyK2']) assert.ok(!(r.stdout + r.stderr).includes(v), `printed ${v}`);
});

test('real run without a terminal and without the variables stops before the tests and changes nothing', (t) => {
  const proj = tempProject(t, 'storeFile=../keys/demo.keystore\nkeyAlias=aliasA3\n');
  const gradle = path.join(proj, 'android', 'app', 'build.gradle');
  const before = fs.readFileSync(gradle, 'utf8');
  const r = spawnSync(process.execPath, ['release-android.js'], { cwd: proj, encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /PLANNR_STORE_PASSWORD/);
  assert.doesNotMatch(r.stdout, /== 1\/4 Tests ==/);
  assert.strictEqual(fs.readFileSync(gradle, 'utf8'), before);
});

test('dry run with storeFile and keyAlias only says where the passwords will come from', (t) => {
  const proj = tempProject(t, 'storeFile=../keys/demo.keystore\nkeyAlias=aliasA3\n');
  const env = { ...cleanEnv(), [ENV_STORE]: 'dummyS1', [ENV_KEY]: 'dummyK2' };
  const r = spawnSync(process.execPath, ['release-android.js', '--dry-run'], { cwd: proj, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Passwords: from the environment/m, r.stdout);
  assert.doesNotMatch(r.stdout, /Would stop/);
  for (const v of ['dummyS1', 'dummyK2']) assert.ok(!(r.stdout + r.stderr).includes(v), `printed ${v}`);
});
