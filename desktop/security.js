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

/** No navigation away from the page and no new windows. */
export function lockDownContents(contents) {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Every permission request and check is denied (the trial has no notifications yet). */
export function denyPermissions(session) {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
