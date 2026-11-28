# Plannr desktop (trial)

**Trial.** This folder is a first, minimal try of the desktop app from
`docs/cross-platform-plan.md` (§4.4 and §5). It is not packaged, not released and not supported.
Nothing outside this folder depends on it.

## What it is

- A minimal Electron app (Electron `45.3.2`, pinned exactly in `desktop/package.json`).
- It shows the same pages as the phone, from `public/`.
- `/api/...` is answered inside the app by the shared core (`core/routes/*`), registered the same
  way as in `server.js` and `public/local-api.js` (`desktop/core-api.js`).
- The data is one SQLite file, `plannr.db`, in Electron's userData folder, through `db.js` and
  `node:sqlite`. It is a new, empty database. The app never opens `data/plannr.db`.

## How to run it

```
cd desktop
npm install
npm start
```

- `npm install` here installs Electron into `desktop/node_modules` only (git-ignored). It does not
  touch the root `node_modules`.
- To use a test folder instead of the real userData folder, set `PLANNR_DESKTOP_USERDATA` to an
  empty folder first. Use this for every test and trial.
- Only one copy runs at a time (single-instance lock), so two windows never open the same file.

## Self-test

The app can test itself. It opens its normal window (the same options, preload and request filter)
and drives the page from the main process with `webContents.executeJavaScript`. There is no remote
debugging port, no IPC and no network. This replaces the Playwright launch, which timed out.

The easy way runs the app twice, from the repository root:

```
node desktop/smoke.js              (makes a new folder in the system temp folder)
node desktop/smoke.js <folder>     (makes a new folder inside <folder>)
```

It prints each step and then `SMOKE PASS` (exit code 0) or `SMOKE FAIL` (exit code 1). The test
folder is kept, and its path is printed. A window opens for about 20 seconds per run.

The two runs, by hand (PowerShell, in `desktop/`, on a new empty folder):

```
$env:PLANNR_DESKTOP_USERDATA = '<absolute path of a new empty folder>'
npx electron . --self-test=write
npx electron . --self-test=verify
```

- `--self-test=write`, in this order:
  1. the window checks (below), the security checks (below) and the link checks (below), on Home;
  2. it opens Cash Inflow, adds an entry with a unique reason through the form, edits it (amount and
     reason, with the "Save changes?" dialog) and checks that the edited row shows and is saved. It
     leaves `plannr-self-test.json` in the folder;
  3. still on Cash Inflow, its own "Back" link must open Cash Flow in the same window
     (`own-page-anchor-opens-in-app`, below);
  4. last, the window itself is sent to `https://plannr-selftest.invalid/` and the request filter
     must cancel it (`ERR_BLOCKED_BY_CLIENT`, not a DNS error). It is last because Chromium then
     shows its error page in another renderer process, and a load back to `app://plannr` after that
     sometimes waited 30 s and failed with `ERR_FAILED`.
- `--self-test=verify` (a restart on the same folder): the same window, security and link checks,
  then the edited entry is still on the Cash Inflow page and in `/api/cash-in`, then Cash Inflow's
  "Back" link, then the request filter check.
- The window checks (`window-shown`): the window is visible, not minimised, its content area has a
  non-zero width and height, it is on `app://plannr/home.html` and not loading, and the page itself
  reports a complete document, a non-zero viewport and the Home navigation visible.
- The security checks: the page has no `require`, `process`, `module` or `Buffer`;
  `window.plannrDesktop` is exactly `{ runtime: 'desktop' }` and frozen; the running window has
  `contextIsolation` and `sandbox` on and `nodeIntegration` off; a page request to
  `https://plannr-selftest.invalid/` fails. `.invalid` never resolves.
- The link checks, in the real window (see "Links" below). In self-test mode the window's
  `openExternal` is a recorder (`linkRecorder()` in `self-test.js`), not `shell.openExternal`, so no
  real browser ever opens; the outside links also go to the `.invalid` address. Each check watches
  every `will-navigate` (and whether the link rules stopped it), the recorder and new windows:
  - `link-https-goes-outside`: a clicked `https://plannr-selftest.invalid/?link` link is stopped,
    the page stays the same document, and the recorder holds exactly that URL;
  - `window-open-https-goes-outside`: `window.open('https://plannr-selftest.invalid/?window-open')`
    answers `null`, no window is made, the page stays, and the recorder holds exactly that URL;
  - `link-file-blocked` and `link-mailto-blocked`: a `file:` and a `mailto:` link change nothing and
    nothing is recorded. Chromium refuses the `file:` link before `will-navigate`, so that step can
    only show that nothing opens, and its detail says so; `test/desktop-links.test.js` proves that
    the rule blocks `file:`;
  - `own-page-button-opens-in-app`: Home's own "Cash flow" button (its script sets `location.href`)
    opens `app://plannr/cash-flow.html` in the same window, the navigation was not stopped, nothing
    is recorded, and the Cash Flow page loads;
  - `own-page-anchor-opens-in-app`, on Cash Inflow after the entry steps: the page's own "Back"
    link, a real `<a class="ci-back" href="/cash-flow.html">` with no target, is clicked and must do
    the same. This is the link that did nothing while every navigation was blocked.
- Each run prints one JSON line, `{ "selfTest": "write"|"verify", "ok": true|false, "steps": [...] }`,
  and exits 0 or 1. It stops at the first failed step.
- The link checks fail when a link rule is broken: with http(s) links let into the window,
  `link-https-goes-outside` fails (the window leaves Home for an error page and nothing is recorded);
  with own pages blocked, `own-page-button-opens-in-app` fails (the window stays on Home), and with
  that step also left out, so the run gets to Cash Inflow, `own-page-anchor-opens-in-app` fails (the
  navigation to Cash Flow is stopped and the window stays on Cash Inflow). These were tried as
  temporary edits (2026-11-28).
- It refuses to start (one JSON line, exit 1, before any window or database) without
  `PLANNR_DESKTOP_USERDATA` set to an absolute path; `write` also needs a new or empty folder, and
  `verify` needs the folder of a `write` run. So it never adds an entry to real data.

## Links

The owner's decision (2026-11-28), in one function, `linkAction(url)` in `security.js`:

| Link | What happens |
|---|---|
| Plannr's own pages, `app://plannr/...` | Open in the app window |
| `http://` and `https://` | Open in the system browser (`shell.openExternal`), never inside the app |
| Everything else | Blocked: `file:`, `javascript:`, `data:`, `blob:`, `mailto:`, `tel:`, `ftp:`, `ws:`, any other scheme, another `app:` host (`app://plannr.evil/`, `app://other/`, `app://plannr:8080/`) and anything that is not a valid absolute URL |

- A link with a user name or password is blocked too (`https://plannr@evil.example/` goes to
  `evil.example`), and so is a URL with spaces or control characters (Chromium's own URLs never have
  them; such a string could be read differently by the program that opens it).
- It applies to `will-navigate` (a click, `location.href = ...`) and `will-redirect`: an own page
  goes ahead; anything else is stopped, and an http(s) link goes to the system browser instead.
- `window.open` and `target="_blank"` never make a second window (the app is one window on one
  database). An own page loads in the same window instead, as a plain link would; this allows
  nothing new, because a page can already go to its own pages with `location.href`. An http(s) link
  goes to the system browser; anything else does nothing.
- The system browser gets the URL as parsed, so what was checked is what opens. If it cannot open,
  the window stays as it is.
- Two other walls stay: the request filter cancels every request that is not `app://plannr/`, and
  every permission is denied, including Electron's `openExternal` permission for links to other
  programs.

## Files

| File | What it does |
|---|---|
| `main.js` | The main process: the `app://plannr` scheme, the window, the request block |
| `core-api.js` | The shared core on `userData/plannr.db`, answered in-process |
| `paths.js` | The path check for `app://plannr/...` (only files inside `public/`) |
| `security.js` | The window options, the request filter, the link rules (`linkAction`), the permission block |
| `preload.cjs` | The preload: one frozen object, `window.plannrDesktop = { runtime: 'desktop' }` |
| `self-test.js` | The self-test mode: the `--self-test` argument, the refusals, the steps, the link recorder |
| `self-test-page.js` | The self-test's page side (run in the window, never served or imported) |
| `smoke.js` | Runs the self-test twice, write then verify (not part of `npm test`) |

## What works

- The window opens `app://plannr/home.html`. The database file is created in userData.
- Every `/api` route of the shared core is registered.
- The node tests (`test/desktop-trial.test.js`, they run without Electron) check:
  - an entry written in one run is read back after a restart;
  - the path check refuses `..`, encoded `..`, backslashes, drive letters and `//`;
  - the preload exposes exactly `window.plannrDesktop` with the key `runtime`;
  - the window's security options;
  - only `app://plannr/` requests load; outside navigation and new windows are refused; permissions
    are denied;
  - the main-process files have no `http`, `https`, `net`, `fetch` or `listen(`.
- The link rules (`test/desktop-links.test.js`, without Electron): the `linkAction` table, and the
  handlers with stand-in window contents and system browser (own pages go ahead, http(s) is stopped
  and opened outside with exactly that URL, `file:`, `javascript:`, `mailto:` and the rest are
  stopped and nothing is opened, window-open always answers deny).
- Links between Plannr's own pages open in the window (Home's "Cash flow" button and Cash Inflow's
  "Back" link, both checked by the self-test).
- The smoke run passes (2026-11-28, Windows 11, Electron 45.3.2): write 19 steps, verify 17 steps.
  So the window opens, adding and editing an entry in it works, the entry is there after a restart,
  and the link rules hold in the real window.
- The node tests for the self-test (`test/desktop-selftest.test.js`, `test/desktop-smoke.test.js`)
  run `main.js` with a stand-in for Electron. They check the refusals, the argument, that the
  self-test window has exactly the normal security options and handlers, that an https link goes to
  `shell.openExternal` in a normal start and to the recorder (never `shell.openExternal`) in
  self-test mode, and that the main process has no remote debugging, inspector, open port or network
  module.
- These desktop tests run in the first pass of `npm test` only (against `server.js`); they do not go
  through `test/helpers.js`, so the phone-code pass does not run them.

## What does not work yet

- The self-test never opens the real system browser (by design). That a normal start hands http(s)
  links to `shell.openExternal` is checked only by the node test with the Electron stand-in; nobody
  has clicked an outside link in a normal window yet. Plannr's pages have no outside links today.
- A `file:` link is stopped by Chromium itself ("Not allowed to load local resource") before
  `will-navigate`, so the self-test shows that it is blocked but not that the link rule blocked it
  (the node tests cover the rule). A `mailto:` link does reach `will-navigate` and is stopped there.
- An own page opened by a `<form target="_blank" method="post">` would load in the same window as a
  plain GET, without the form's data. No Plannr page has such a form.
- Navigations inside sub-frames (`will-frame-navigate`) have no link rule. The pages have no frames;
  the Content Security Policy allows only `app://plannr` frames, and the request filter cancels
  every other address.
- On a busy machine a page load took from 0.4 s to more than 15 s; the self-test waits up to 25 s
  for the Cash Flow page and 30 s per step.
- If `main.js` cannot load, Electron shows an error box and waits. The smoke run then stops after
  its time limit (3 minutes per run) with `SMOKE FAIL`.
- PDF export answers 501 ("not in the desktop trial yet").
- No "Save as" (`saveFile`), so a backup export cannot be saved from the window yet.
- No reminders or notifications.
- The pages run in "dev server" mode (the `X-Plannr-Dev-Server` marker). This stays as it is for
  now (decided 2026-11-25); there is no `desktop` mode in `public/runtime-mode.js`.
- No packaging, installer, icon, code signing or auto-update. `@electron/fuses` is not set.

## Security settings

| Setting | Value |
|---|---|
| `contextIsolation` | `true` |
| `nodeIntegration` (also in workers and sub-frames) | `false` |
| `sandbox` | `true` |
| `webSecurity` | `true` |
| `spellcheck` | `false` (otherwise Electron downloads dictionaries) |
| `webviewTag`, `allowRunningInsecureContent` | `false` |
| Pages | `protocol.handle` on the privileged `app://plannr` scheme. No HTTP server, no open port, no `file://` |
| Requests | `session.webRequest.onBeforeRequest` cancels every request that is not `app://plannr/` |
| Navigation | `will-navigate` and `will-redirect` follow the link rules (own pages in the window, http(s) in the system browser, the rest blocked); `setWindowOpenHandler` always denies a new window |
| Permissions | Every permission request and check is denied |
| Content Security Policy | Sent with every page: only `app://plannr`; inline scripts are allowed because the pages use them |
| Main process | No network calls, no remote debugging, no inspector (tests check the source) |
| Self-test | The same window, options, preload, request filter and link rules; driven with `executeJavaScript`; outside links go to a recorder, never a real browser |
