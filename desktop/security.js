// The desktop trial's security settings (docs/cross-platform-plan.md §5.1), kept apart from main.js
// so the tests can check them without Electron.

/** The BrowserWindow options: Electron's secure defaults, set explicitly. */
export function windowOptions(preloadPath) {
  return {
    width: 1200,
    height: 820,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false, // otherwise Electron downloads dictionaries
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  };
}

/** Only the app's own scheme may load. Everything else (http, https, file, ws, data, ...) is cancelled. */
export const allowRequest = (url) => typeof url === 'string' && url.startsWith('app://plannr/');

// Where a link may go (the owner's decision, 2026-11-28; desktop/README.md, "Links"):
//   'app'      Plannr's own pages (app://plannr/...) open in the app window;
//   'external' http and https links open in the system browser, never inside the app;
//   'block'    everything else: file:, javascript:, data:, blob:, mailto:, tel:, ftp:, ws:, any
//              other scheme, another app: host (app://plannr.evil/, app://other/) and anything that
//              is not a valid absolute URL.
// A link with a user name or password is blocked too, http(s) or app:. The app never makes one, and
// it is a known way to dress up an address (https://plannr@evil.example/ goes to evil.example).
// Chromium hands the handlers canonical URLs, which never hold spaces or control characters; a
// string that does could be read one way here and another way by the program that opens it, so it
// is blocked.
export function linkAction(url) {
  if (typeof url !== 'string' || /[\u0000- \u007f]/.test(url)) return 'block';
  let u;
  try { u = new URL(url); } catch { return 'block'; }
  if (u.username !== '' || u.password !== '') return 'block';
  // u.host includes any port, so app://plannr:8080/ is blocked as well.
  if (u.protocol === 'app:') return u.host === 'plannr' ? 'app' : 'block';
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname !== '' ? 'external' : 'block';
  return 'block';
}

// Hand a link to the system browser. If that fails (no browser, the system refuses), the app window
// stays as it is: the link simply does not open.
function openOutside(openExternal, url) {
  const href = new URL(url).href; // what was checked is what is opened
  try {
    const opening = openExternal(href);
    if (opening && typeof opening.catch === 'function') opening.catch((e) => console.error('Plannr: the link could not be opened in the system browser:', e && e.message));
  } catch (e) {
    console.error('Plannr: the link could not be opened in the system browser:', e && e.message);
  }
}

/**
 * The link rules (linkAction) on a window's contents. `openExternal` opens a URL in the system
 * browser: shell.openExternal in the app, a recorder in the self-test, so no real browser opens there.
 */
export function lockDownContents(contents, { openExternal } = {}) {
  if (typeof openExternal !== 'function') {
    throw new TypeError('lockDownContents needs openExternal (shell.openExternal, or the self-test recorder).');
  }
  // will-navigate (a link click, location.href = ...) and will-redirect: an own page goes ahead in
  // this window; anything else is stopped, and an http(s) link goes to the system browser instead.
  // The URL is on the event; the second argument is Electron's deprecated copy of it.
  const onNavigate = (event, deprecatedUrl) => {
    const url = event && typeof event.url === 'string' ? event.url : deprecatedUrl;
    const action = linkAction(url);
    if (action === 'app') return;
    event.preventDefault();
    if (action === 'external') openOutside(openExternal, url);
  };
  contents.on('will-navigate', onNavigate);
  contents.on('will-redirect', onNavigate);
  // window.open and target=_blank never make a second window: the app is one window on one
  // database (the single-instance lock). An own page loads in the same window instead, so it opens
  // as a plain link would (a page can already go to its own pages with location.href, so this
  // allows nothing new); an http(s) link goes to the system browser; anything else does nothing.
  contents.setWindowOpenHandler(({ url } = {}) => {
    const action = linkAction(url);
    if (action === 'app') {
      // After the handler has answered, so the load does not run inside Chromium's window-open call.
      Promise.resolve().then(() => contents.loadURL(url)).catch((e) => console.error('Plannr: the page could not be opened:', e && e.message));
    } else if (action === 'external') {
      openOutside(openExternal, url);
    }
    return { action: 'deny' };
  });
}

/** Every permission request and check is denied (the trial has no notifications yet). */
export function denyPermissions(session) {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
