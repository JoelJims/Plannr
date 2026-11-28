// The desktop trial's smoke run (not part of `npm test`: it needs the Electron binary in
// desktop/node_modules). It starts the app twice with its self-test (self-test.js):
//
//   node desktop/smoke.js [parent-folder]
//
// Run 1, --self-test=write: the window is shown at a real size with Home loaded, the security
// settings as the page sees them, the link rules in the window (outside links reach a recorder, never
// a browser), a Cash Inflow entry is added and edited through the form, the edit shows, and the
// window sent to an outside address is cancelled.
// Run 2, --self-test=verify (a restart on the same folder): the same checks, and the edited entry is
// still there.
// Both runs use one new, empty folder made inside parent-folder (default: the system temp folder)
// as PLANNR_DESKTOP_USERDATA. The folder is kept and its path printed. Exit code 0 = PASS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ELECTRON = path.join(import.meta.dirname, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const RUN_MS = 180000;

/** One run's answer: ok only with exit code 0 and exactly one JSON line for this mode with ok: true. */
export function readRun(mode, r) {
  const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => l.startsWith('{"selfTest"'));
  let result = null;
  try { result = lines.length === 1 ? JSON.parse(lines[0]) : null; } catch { result = null; }
  const ok = !r.error && r.status === 0 && !!result && result.selfTest === mode && result.ok === true;
  const out = { mode, ok, status: r.status, result };
  if (r.error) out.error = String(r.error.message || r.error);
  if (!ok) out.stderr = String(r.stderr || '').slice(-2000);
  return out;
}

/** Write, then verify, on one fresh folder. `run` is spawnSync (the tests pass a stand-in). */
export function smoke({ parent = os.tmpdir(), run = spawnSync, env = process.env } = {}) {
  fs.mkdirSync(parent, { recursive: true });
  const userData = fs.mkdtempSync(path.join(path.resolve(parent), 'plannr-smoke-'));
  const childEnv = { ...env, PLANNR_DESKTOP_USERDATA: userData };
  delete childEnv.PLANNR_DB;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const runs = [];
  for (const [mode, arg] of [['write', '--self-test=write'], ['verify', '--self-test=verify']]) {
    const r = run(ELECTRON, [import.meta.dirname, arg], { env: childEnv, encoding: 'utf8', timeout: RUN_MS, cwd: import.meta.dirname });
    runs.push(readRun(mode, r));
    if (!runs[runs.length - 1].ok) break;
  }
  return { pass: runs.length === 2 && runs.every((x) => x.ok), userData, runs };
}

const isMain = import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);
if (isMain) {
  if (!fs.existsSync(ELECTRON)) {
    console.error(`Electron is not installed here: ${ELECTRON}\nRun npm install in desktop/ first.`);
    process.exit(2);
  }
  const out = smoke({ parent: process.argv[2] || os.tmpdir() });
  console.log(`userData: ${out.userData}`);
  for (const r of out.runs) {
    console.log(`${r.mode}: ${r.ok ? 'ok' : 'FAILED'} (exit ${r.status})`);
    for (const s of (r.result && r.result.steps) || []) console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.ok ? '' : ` - ${JSON.stringify(s.detail)}`}`);
    if (!r.ok && r.error) console.log(`  error: ${r.error}`);
    if (!r.ok && r.stderr) console.log(`  stderr (end):\n${r.stderr}`);
  }
  console.log(out.pass ? 'SMOKE PASS' : 'SMOKE FAIL');
  process.exit(out.pass ? 0 : 1);
}
