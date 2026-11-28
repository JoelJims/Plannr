// desktop/smoke.js: the two-run smoke (--self-test=write, then --self-test=verify on the same fresh
// folder). These tests run WITHOUT Electron: smoke() takes the process runner as an argument, and a
// recording stand-in answers for the app. The real run is `node desktop/smoke.js` (desktop/README.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DESKTOP = path.join(__dirname, '..', 'desktop');
const SMOKE = path.join(DESKTOP, 'smoke.js');

const line = (selfTest, ok) => JSON.stringify({ selfTest, ok, steps: [{ name: 'page-ready', ok }] });
// A stand-in for spawnSync: answers each run from `answers` (by mode) and records the calls.
function fakeRunner(answers) {
  const calls = [];
  const run = (exe, args, options) => {
    const mode = (args.find((a) => a.startsWith('--self-test=')) || '').slice('--self-test='.length);
    calls.push({ exe, args, userData: options.env.PLANNR_DESKTOP_USERDATA, env: options.env, timeout: options.timeout });
    return answers[mode] || { status: 1, stdout: '', stderr: 'no answer' };
  };
  return { run, calls };
}

test('smoke.js: the self-test runs, not Playwright; no outside address, no debugging switch (source)', () => {
  const src = fs.readFileSync(SMOKE, 'utf8');
  assert.doesNotMatch(src, /playwright|_electron|example\.com/i, 'the old Playwright harness and its outside address are gone');
  assert.doesNotMatch(src, /remote-debugging|--inspect|\bfetch\s*\(|['"](node:)?(http|https|net)['"]/);
  assert.match(src, /'--self-test=write'/);
  assert.match(src, /'--self-test=verify'/);
  assert.match(src, /'node_modules', 'electron'/, 'the Electron binary from desktop/node_modules');
});

test('smoke(): write then verify on one fresh folder under the given parent; PASS only when both pass', async () => {
  assert.doesNotMatch(fs.readFileSync(SMOKE, 'utf8'), /playwright/i, 'smoke.js no longer runs Playwright at import');
  const { smoke, ELECTRON } = await import(pathToFileURL(SMOKE).href);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-smoke-test-'));
  try {
    const good = fakeRunner({
      write: { status: 0, stdout: `[db] something\n${line('write', true)}\n`, stderr: '' },
      verify: { status: 0, stdout: `\r\n${line('verify', true)}\r\n`, stderr: '' },
    });
    const env = { ...process.env, PLANNR_DB: 'D:/never/plannr.db', ELECTRON_RUN_AS_NODE: '1', PLANNR_DESKTOP_USERDATA: 'D:/never' };
    const r = smoke({ parent, run: good.run, env });
    assert.equal(r.pass, true, JSON.stringify(r));
    assert.equal(good.calls.length, 2);
    assert.deepEqual(good.calls.map((c) => c.args), [[DESKTOP, '--self-test=write'], [DESKTOP, '--self-test=verify']]);
    for (const c of good.calls) {
      assert.equal(c.exe, ELECTRON);
      assert.equal(c.userData, r.userData, 'both runs use the same folder');
      assert.equal(c.env.PLANNR_DB, undefined, 'PLANNR_DB is not passed on');
      assert.equal(c.env.ELECTRON_RUN_AS_NODE, undefined, 'Electron runs as an app, not as node');
      assert.ok(c.timeout > 0, 'each run has a time limit');
    }
    assert.equal(path.dirname(r.userData), parent, 'the folder is inside the given parent');
    assert.ok(fs.statSync(r.userData).isDirectory());
    assert.equal(fs.readdirSync(r.userData).length, 0, 'the folder was new and empty (the stand-in wrote nothing)');
    assert.deepEqual(r.runs.map((x) => [x.mode, x.ok]), [['write', true], ['verify', true]]);

    const second = smoke({ parent, run: fakeRunner({ write: { status: 0, stdout: line('write', true) }, verify: { status: 0, stdout: line('verify', true) } }).run, env });
    assert.notEqual(second.userData, r.userData, 'every smoke run gets a fresh folder');

    // Failures: the write run fails (verify is not run), a run says ok but exits 1, a run prints
    // no line, the line is for the other mode.
    const cases = [
      [{ write: { status: 1, stdout: line('write', false) } }, 1],
      [{ write: { status: 1, stdout: line('write', true) } }, 1],
      [{ write: { status: 0, stdout: 'nothing' } }, 1],
      [{ write: { status: 0, stdout: line('verify', true) } }, 1],
      [{ write: { status: 0, stdout: line('write', true) }, verify: { status: 0, stdout: line('verify', false) } }, 2],
      [{ write: { status: 0, stdout: line('write', true) }, verify: { status: null, stdout: '', error: new Error('spawnSync ETIMEDOUT') } }, 2],
    ];
    for (const [answers, expectedCalls] of cases) {
      const f = fakeRunner(answers);
      const out = smoke({ parent, run: f.run, env });
      assert.equal(out.pass, false, JSON.stringify(answers));
      assert.equal(f.calls.length, expectedCalls, `runs made for ${JSON.stringify(answers)}`);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
