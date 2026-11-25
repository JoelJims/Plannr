// The desktop trial's self-test mode (desktop/README.md, "Self-test"). It replaces the Playwright
// launch, which times out on some machines.
//
//   electron desktop --self-test=write    (with PLANNR_DESKTOP_USERDATA = a new or empty test folder)
//   electron desktop --self-test=verify   (the same folder, after the write run)
//
// main.js opens its normal window (the same options, preload and request filter) and then hands it
// to runSelfTest(), which drives the page in-process with webContents.executeJavaScript: no remote
// debugging port, no IPC, no network. The page side is desktop/self-test-page.js. Each run prints one
// JSON line, { "selfTest": "write"|"verify", "ok": true|false, "steps": [...] }, and exits 0 or 1.
// This module does not import Electron, so the node tests can load it.
import fs from 'node:fs';
import path from 'node:path';

const MODES = ['write', 'verify'];
/** The file a write run leaves in the test folder; a verify run needs it. */
export const SELF_TEST_MARKER = 'plannr-self-test.json';
/** An address that can never resolve (.invalid, RFC 6761). The request filter must cancel it. */
const OUTSIDE = 'https://plannr-selftest.invalid/';
const PAGE_CODE = fs.readFileSync(path.join(import.meta.dirname, 'self-test-page.js'), 'utf8');
const STEP_MS = 30000;
const TOTAL_MS = 150000;

/** process.argv -> { mode: null } (no self-test) | { mode: 'write'|'verify' } | { error }. */
export function parseSelfTest(argv) {
  const found = (argv || []).map(String).filter((a) => a === '--self-test' || a.startsWith('--self-test='));
  if (!found.length) return { mode: null };
  const value = found[0].slice('--self-test='.length);
  if (found.length > 1 || !MODES.includes(value)) {
    return { error: `Use --self-test=write or --self-test=verify, once (got: ${found.join(' ')}).` };
  }
  return { mode: value };
}

/** Why this self-test may not run (a message), or null. A normal start (mode null) is never refused. */
export function selfTestRefusal({ mode, env }) {
  if (!mode) return null;
  const dir = env && env.PLANNR_DESKTOP_USERDATA;
  if (!dir || !path.isAbsolute(dir)) {
    return 'The self-test needs PLANNR_DESKTOP_USERDATA set to the absolute path of a test folder. It never runs on the real userData folder.';
  }
  try {
    if (mode === 'write') {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) return `--self-test=write needs a new or empty test folder; this one is not empty: ${dir}`;
    } else if (!fs.existsSync(path.join(dir, SELF_TEST_MARKER))) {
      return `--self-test=verify needs the folder of a --self-test=write run (${SELF_TEST_MARKER} is missing): ${dir}`;
    }
  } catch (e) {
    return `The test folder cannot be read: ${e.message}`;
  }
  return null;
}

/** The one line a self-test run prints. */
export const selfTestLine = (result) => `${JSON.stringify(result)}\n`;

const withTimeout = (promise, ms, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
};

/** Drive the open window (home.html loaded). -> { selfTest, ok, steps: [{ name, ok, detail }] } */
export async function runSelfTest({ mode, win, userData }) {
  const steps = [];
  const wc = win.webContents;
  const page = (op, arg = null) =>
    wc.executeJavaScript(`(() => {\n${PAGE_CODE}\nreturn selfTestPage(${JSON.stringify(op)}, ${JSON.stringify(arg)});\n})()`);
  // One step: { ok, detail } from fn. The run stops at the first step that fails.
  const step = async (name, fn) => {
    let r;
    try { r = await withTimeout(Promise.resolve().then(fn), STEP_MS, name); } catch (e) { r = { ok: false, detail: String((e && e.message) || e) }; }
    if (!r || typeof r !== 'object') r = { ok: false, detail: `no answer from the page (${JSON.stringify(r)})` };
    steps.push(r.detail === undefined ? { name, ok: r.ok === true } : { name, ok: r.ok === true, detail: r.detail });
    if (r.ok !== true) throw new Error(`step failed: ${name}`);
    return r;
  };
  const markerFile = path.join(userData, SELF_TEST_MARKER);

  const run = async () => {
    // The security settings, as the running app has them.
    await step('page-ready', () => page('ready'));
    await step('no-node-in-page', () => page('no-node'));
    await step('preload-is-only-plannrDesktop', () => page('preload'));
    await step('web-preferences', () => {
      const p = typeof wc.getLastWebPreferences === 'function' ? wc.getLastWebPreferences() : null;
      const seen = p && { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration };
      return { ok: !!p && p.contextIsolation === true && p.sandbox === true && p.nodeIntegration === false, detail: seen };
    });
    await step('page-request-outside-blocked', () => page('outside'));
    // The window itself is sent to the outside address. The request filter (onBeforeRequest) must
    // cancel it: Chromium then fails the load with ERR_BLOCKED_BY_CLIENT, not a DNS error.
    await step('request-filter-cancels-outside', async () => {
      try {
        await wc.loadURL(OUTSIDE);
        return { ok: false, detail: 'the outside address loaded' };
      } catch (e) {
        return { ok: e.code === 'ERR_BLOCKED_BY_CLIENT', detail: `${e.code || ''} ${e.errno || ''}`.trim() || String(e.message) };
      }
    });
    await step('open-cash-inflow', async () => {
      await wc.loadURL('app://plannr/cash-inflow.html');
      return page('cash-inflow');
    });

    if (mode === 'write') {
      const tag = `Plannr self-test ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const entry = { prefix: tag, reason: `${tag} (edited)`, gone: `${tag} (added)`, amountPaise: 234575, amountText: '2,345.75' };
      await step('add-entry', () => page('add', { amount: '1234.50', reason: entry.gone }));
      await step('edit-entry', () => page('edit', { from: entry.gone, amount: '2345.75', reason: entry.reason }));
      await step('edit-shows', () => page('shows', entry));
      await step('marker', () => {
        fs.writeFileSync(markerFile, JSON.stringify(entry));
        return { ok: true, detail: SELF_TEST_MARKER };
      });
    } else {
      let entry;
      await step('marker', () => {
        entry = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        return { ok: typeof entry.reason === 'string' && typeof entry.prefix === 'string', detail: SELF_TEST_MARKER };
      });
      await step('edited-entry-after-restart', () => page('shows', entry));
    }
    return true;
  };

  let timer;
  const finished = await Promise.race([
    run().catch(() => false),
    new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), TOTAL_MS); }),
  ]);
  clearTimeout(timer);
  if (finished === 'timeout') steps.push({ name: 'timeout', ok: false, detail: `the self-test did not finish in ${TOTAL_MS / 1000} s` });
  return { selfTest: mode, ok: finished === true && steps.every((s) => s.ok), steps };
}
