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

- `--self-test=write`: checks the security settings (below), opens Cash Inflow, adds an entry with a
  unique reason through the form, edits it (amount and reason, with the "Save changes?" dialog) and
  checks that the edited row shows and is saved. It leaves `plannr-self-test.json` in the folder.
- `--self-test=verify` (a restart on the same folder): the same security checks, then the edited
  entry is still on the Cash Inflow page and in `/api/cash-in`.
- The security checks: the page has no `require`, `process`, `module` or `Buffer`;
  `window.plannrDesktop` is exactly `{ runtime: 'desktop' }` and frozen; the running window has
  `contextIsolation` and `sandbox` on and `nodeIntegration` off; a page request to
  `https://plannr-selftest.invalid/` fails; and the window itself sent to that address is cancelled
  by the request filter (`ERR_BLOCKED_BY_CLIENT`, not a DNS error). `.invalid` never resolves.
- Each run prints one JSON line, `{ "selfTest": "write"|"verify", "ok": true|false, "steps": [...] }`,
  and exits 0 or 1. It stops at the first failed step.
- It refuses to start (one JSON line, exit 1, before any window or database) without
  `PLANNR_DESKTOP_USERDATA` set to an absolute path; `write` also needs a new or empty folder, and
  `verify` needs the folder of a `write` run. So it never adds an entry to real data.

## Files

| File | What it does |
|---|---|
| `main.js` | The main process: the `app://plannr` scheme, the window, the request block |
| `core-api.js` | The shared core on `userData/plannr.db`, answered in-process |
| `paths.js` | The path check for `app://plannr/...` (only files inside `public/`) |
| `security.js` | The window options, the request filter, the navigation and permission blocks |
| `preload.cjs` | The preload: one frozen object, `window.plannrDesktop = { runtime: 'desktop' }` |
| `self-test.js` | The self-test mode: the `--self-test` argument, the refusals, the steps |
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
  - only `app://plannr/` requests load; navigation, new windows and permissions are refused;
  - the main-process files have no `http`, `https`, `net`, `fetch` or `listen(`.
- The smoke run passes (2026-11-25, Windows 11, Electron 45.3.2): write 11 steps, verify 9 steps.
  So adding and editing an entry in the window works, and the entry is there after a restart.
- The node tests for the self-test (`test/desktop-selftest.test.js`, `test/desktop-smoke.test.js`)
  run `main.js` with a stand-in for Electron. They check the refusals, the argument, that the
  self-test window has exactly the normal security options and handlers, and that the main process
  has no remote debugging, inspector, open port or network module.

## What does not work yet

- **Links between pages do not open.** The `will-navigate` block stops every navigation the page
  starts, `app://plannr/` links too. Checked with the self-test window: a click on the
  `/cash-flow.html` link on the Cash Inflow page stays on Cash Inflow. The self-test opens its pages
  from the main process instead. Letting `app://plannr/` links through is a security-settings
  change, so it waits for a decision.
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
| Navigation | `will-navigate` and `will-redirect` are blocked; `setWindowOpenHandler` denies |
| Permissions | Every permission request and check is denied |
| Content Security Policy | Sent with every page: only `app://plannr`; inline scripts are allowed because the pages use them |
| Main process | No network calls, no remote debugging, no inspector (tests check the source) |
| Self-test | The same window, options, preload and request filter; driven with `executeJavaScript` |
