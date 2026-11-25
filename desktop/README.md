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

## Files

| File | What it does |
|---|---|
| `main.js` | The main process: the `app://plannr` scheme, the window, the request block |
| `core-api.js` | The shared core on `userData/plannr.db`, answered in-process |
| `paths.js` | The path check for `app://plannr/...` (only files inside `public/`) |
| `security.js` | The window options, the request filter, the navigation and permission blocks |
| `preload.cjs` | The preload: one frozen object, `window.plannrDesktop = { runtime: 'desktop' }` |
| `smoke.js` | A two-run smoke test with Playwright (not part of `npm test`) |

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

## What does not work yet

- **The smoke run does not finish.** `smoke.js` times out in Playwright's `electron.launch` (30 s)
  before the first window. A two-line Electron app with no Plannr code (CommonJS or ES module) times
  out the same way, so the cause is Playwright `1.61.1` with Electron `45.3.2`, not this app. Not
  checked yet: adding and editing an entry in
  the window, and seeing it after a restart. (The node tests check the same thing without a window.)
- PDF export answers 501 ("not in the desktop trial yet").
- No "Save as" (`saveFile`), so a backup export cannot be saved from the window yet.
- No reminders or notifications.
- The pages run in "dev server" mode (the `X-Plannr-Dev-Server` marker). A `desktop` mode in
  `public/runtime-mode.js` comes later.
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
| Main process | No network calls (a test checks the source) |
