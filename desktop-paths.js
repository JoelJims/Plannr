// Where the desktop app keeps its data (step 1.4 D2; docs/step-1.4-storage-plan.md §1.3).
//
// The desktop app's database is `plannr.db` in Electron's userData folder, the folder Electron's
// app.getPath('userData') gives: the system's per-user application data folder plus the app's name.
//   - Windows: %APPDATA%\Plannr (C:\Users\<you>\AppData\Roaming\Plannr)
//   - macOS:   ~/Library/Application Support/Plannr
//   - Linux:   $XDG_CONFIG_HOME/Plannr, or ~/.config/Plannr when it is not set (or not absolute,
//              as the XDG Base Directory rules say)
// A plain function of the system, the environment and the home folder, so it can be checked for all
// three systems on any one machine. Nothing calls it yet: it is wired in with Electron (Phase 4),
// which then passes the path to the node-sqlite adapter (db-adapter-node.js).
//
// It never names the dev server's file (data/plannr.db in the project): the desktop app starts empty
// and is filled from a backup file. Node only; not copied to public/.

import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'Plannr';
export const DB_FILE = 'plannr.db';

/**
 * The userData folder for `platform` ('win32' | 'darwin' | 'linux'). Options: { platform, env,
 * homedir, appName }, each defaulting to this machine's. Paths use that system's separators.
 */
export function userDataDir({ platform = process.platform, env = process.env, homedir = os.homedir(), appName = APP_NAME } = {}) {
  if (typeof appName !== 'string' || !appName || /[\\/]/.test(appName) || appName === '.' || appName === '..') {
    throw new TypeError('userDataDir: appName must be a plain folder name.');
  }
  if (typeof homedir !== 'string' || !homedir) throw new TypeError('userDataDir: no home folder.');
  if (platform === 'win32') {
    const p = path.win32;
    const appData = env.APPDATA && p.isAbsolute(env.APPDATA) ? env.APPDATA : p.join(homedir, 'AppData', 'Roaming');
    return p.join(appData, appName);
  }
  if (platform === 'darwin') return path.posix.join(homedir, 'Library', 'Application Support', appName);
  if (platform === 'linux') {
    const p = path.posix;
    const config = env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(homedir, '.config');
    return p.join(config, appName);
  }
  throw new Error(`userDataDir: Plannr's desktop app runs on Windows, macOS and Linux, not on "${platform}".`);
}

/** The desktop app's database file: plannr.db in the userData folder. Same options as userDataDir. */
export function desktopDbPath(options = {}) {
  const dir = userDataDir(options);
  const p = (options.platform || process.platform) === 'win32' ? path.win32 : path.posix;
  return p.join(dir, DB_FILE);
}
