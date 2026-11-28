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
// In self-test mode main.js gives the window linkRecorder() instead of shell.openExternal, so the
// link checks never open a real browser.
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
const TOTAL_MS = 170000; // below smoke.js's 180 s per run, so a slow run still prints its steps
const HOME = 'app://plannr/home.html';
// The link checks (security.js linkAction). The outside links go to the .invalid address, so even if
// the recorder were not in place, no real site could open.
// The own-page links both go to Cash Flow: Home's "Cash flow" button (its script sets location.href)
// and Cash Inflow's "Back" link, a real <a href="/cash-flow.html">.
const LINKS = {
  own: { url: 'app://plannr/cash-flow.html', selector: 'h1', text: 'Cash Flow' },
  ownButton: '.home-nav .navbtn[data-href="/cash-flow.html"]',
  ownAnchor: { selector: 'a.ci-back', href: '/cash-flow.html' },
  https: `${OUTSIDE}?link`,
  windowOpen: `${OUTSIDE}?window-open`,
  file: 'file:///plannr-self-test-blocked.txt',
  mailto: 'mailto:self-test@plannr-selftest.invalid',
};

/**
 * Stands in for shell.openExternal in self-test mode (main.js): it records the URL and opens
 * nothing, so the self-test can follow outside links without a real browser ever opening.
 */
export function linkRecorder() {
  const opened = [];
  return { opened, open: async (url) => { opened.push(String(url)); } };
}

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Poll check() until it answers truthy or ms pass. -> the answer, or null. */
async function waitUntil(check, ms, every = 100) {
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = check(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - start > ms) return null;
    await sleep(every);
  }
}

/**
 * Drive the open window (home.html loaded). -> { selfTest, ok, steps: [{ name, ok, detail }] }
 * `outsideLinks` is main.js's linkRecorder(): the window's openExternal in self-test mode. Without it
 * the link steps fail before any outside link is followed.
 */
export async function runSelfTest({ mode, win, userData, outsideLinks }) {
  const steps = [];
  const wc = win.webContents;
  // Every navigation the page starts, with whether the link rules stopped it. This listener comes
  // after the one lockDownContents set when the window was made, so defaultPrevented is its answer.
  const navigations = [];
  wc.on('will-navigate', (event) => navigations.push({ url: event.url, prevented: event.defaultPrevented }));
  const newWindows = [];
  wc.on('did-create-window', (_child, details) => newWindows.push(details && details.url));
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

  // One outside or blocked link, followed on the home page: the page clicks it (or calls window.open)
  // and must stay where it is, the same document, with only `expectOpened` sent to openExternal.
  const mark = `self-test-${Date.now().toString(36)}`;
  const followOutsideOrBlocked = async (op, url, expectOpened) => {
    const fromNav = navigations.length;
    const fromOpened = outsideLinks.opened.length;
    const clicked = await page(op, { url, mark });
    if (!clicked || clicked.ok !== true) return { ok: false, detail: { page: clicked && clicked.detail } };
    // An outside link: wait for it to reach openExternal. A blocked one: give the window time to
    // (wrongly) navigate or open something.
    if (expectOpened.length) await waitUntil(() => outsideLinks.opened.length > fromOpened, 10000);
    else await waitUntil(() => navigations.slice(fromNav).some((n) => n.url === url), 3000);
    await sleep(500);
    const stayed = await page('same-page', { mark, url: HOME });
    const seen = {
      opened: outsideLinks.opened.slice(fromOpened),
      navigations: navigations.slice(fromNav),
      url: wc.getURL(),
      page: clicked.detail,
      samePage: stayed && stayed.detail,
      newWindows: newWindows.length,
    };
    const ok = JSON.stringify(seen.opened) === JSON.stringify(expectOpened)
      && seen.navigations.every((n) => n.prevented === true)
      && seen.url === HOME && !!stayed && stayed.ok === true && newWindows.length === 0;
    return { ok, detail: seen };
  };

  // One of the page's own controls that goes to an own page (op 'click-button' or 'click-anchor'):
  // the window must go to Cash Flow itself, with the navigation not stopped, nothing sent to
  // openExternal, and the Cash Flow page loaded.
  const followOwnPage = async (op, arg) => {
    const fromNav = navigations.length;
    const fromOpened = outsideLinks.opened.length;
    const clicked = await page(op, arg);
    if (!clicked || clicked.ok !== true) return { ok: false, detail: { page: clicked && clicked.detail } };
    // A page load took from 0.4 s to more than 15 s on a busy machine; the step's own limit is 30 s.
    const arrived = await waitUntil(() => wc.getURL() === LINKS.own.url && !wc.isLoading(), 25000);
    const at = arrived ? await page('loaded', { selector: LINKS.own.selector, text: LINKS.own.text }) : null;
    const seen = {
      clicked: clicked.detail, url: wc.getURL(), navigations: navigations.slice(fromNav),
      opened: outsideLinks.opened.slice(fromOpened), newWindows: newWindows.length, page: at && at.detail,
    };
    const ok = !!arrived && !!at && at.ok === true && at.detail.url === LINKS.own.url && seen.opened.length === 0
      && seen.navigations.some((n) => n.url === LINKS.own.url && n.prevented === false) && newWindows.length === 0;
    return { ok, detail: seen };
  };

  const run = async () => {
    // The security settings, as the running app has them.
    await step('page-ready', () => page('ready'));
    // The window is really there: shown, not minimised, a non-zero size, the home page loaded.
    await step('window-shown', async () => {
      const shown = await waitUntil(() => win.isVisible(), 10000);
      const bounds = win.getContentBounds();
      const at = await page('loaded', { selector: '.home-nav' });
      const seen = {
        visible: win.isVisible(), minimized: win.isMinimized(), width: bounds.width, height: bounds.height,
        url: wc.getURL(), loading: wc.isLoading(), page: at && at.detail,
      };
      const ok = !!shown && !seen.minimized && bounds.width > 0 && bounds.height > 0 && seen.url === HOME && !seen.loading
        && !!at && at.ok === true && at.detail.url === HOME;
      return { ok, detail: seen };
    });
    await step('no-node-in-page', () => page('no-node'));
    await step('preload-is-only-plannrDesktop', () => page('preload'));
    await step('web-preferences', () => {
      const p = typeof wc.getLastWebPreferences === 'function' ? wc.getLastWebPreferences() : null;
      const seen = p && { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration };
      return { ok: !!p && p.contextIsolation === true && p.sandbox === true && p.nodeIntegration === false, detail: seen };
    });
    await step('page-request-outside-blocked', () => page('outside'));

    // The link rules (security.js linkAction), in the real window, on the home page.
    await step('link-recorder-in-place', () => ({
      ok: !!outsideLinks && Array.isArray(outsideLinks.opened) && outsideLinks.opened.length === 0,
      detail: outsideLinks ? 'outside links go to the recorder, not a browser' : 'no recorder: the outside links are not followed',
    }));
    await step('link-https-goes-outside', () => followOutsideOrBlocked('click-link', LINKS.https, [LINKS.https]));
    await step('window-open-https-goes-outside', () => followOutsideOrBlocked('window-open', LINKS.windowOpen, [LINKS.windowOpen]));
    // Chromium itself refuses a file: link on an app:// page ("Not allowed to load local resource")
    // before will-navigate, so the link rules never see it: this step can only show that nothing
    // opens. test/desktop-links.test.js proves that the rule blocks file:.
    await step('link-file-blocked', async () => {
      const r = await followOutsideOrBlocked('click-link', LINKS.file, []);
      if (r.detail && Array.isArray(r.detail.navigations)) {
        r.detail.note = r.detail.navigations.length === 0
          ? 'Chromium refused the file: link before will-navigate, so this step shows only that nothing opens; test/desktop-links.test.js proves the link rule blocks file:'
          : 'the file: link reached will-navigate';
      }
      return r;
    });
    await step('link-mailto-blocked', () => followOutsideOrBlocked('click-link', LINKS.mailto, []));
    // An own page: the Home page's own "Cash flow" button (location.href) opens Cash Flow in the same
    // window. The real <a href> link is checked on Cash Inflow, below.
    await step('own-page-button-opens-in-app', () => followOwnPage('click-button', { selector: LINKS.ownButton }));

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

    // An own page through a real <a href>: Cash Inflow's "Back" link, <a class="ci-back"
    // href="/cash-flow.html">, opens Cash Flow in the same window. This is the link that did nothing
    // while every navigation was blocked. It runs here, on the Cash Inflow page the steps above
    // used, so it costs no extra page load.
    await step('own-page-anchor-opens-in-app', () => followOwnPage('click-anchor', LINKS.ownAnchor));

    // Last: the window itself is sent to the outside address. The request filter (onBeforeRequest)
    // must cancel it: Chromium then fails the load with ERR_BLOCKED_BY_CLIENT, not a DNS error.
    // It runs last because Chromium then shows its error page in another renderer process, and a
    // load back to app://plannr after it sometimes waited 30 s and failed with ERR_FAILED.
    await step('request-filter-cancels-outside', async () => {
      try {
        await wc.loadURL(OUTSIDE);
        return { ok: false, detail: 'the outside address loaded' };
      } catch (e) {
        return { ok: e.code === 'ERR_BLOCKED_BY_CLIENT', detail: `${e.code || ''} ${e.errno || ''}`.trim() || String(e.message) };
      }
    });
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
