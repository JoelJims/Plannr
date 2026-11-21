// Step 1.4 D2: the desktop app's data folder and database file on Windows, macOS and Linux
// (desktop-paths.js), checked for all three on any machine. Nothing here opens a database.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { userDataDir, desktopDbPath, APP_NAME, DB_FILE } = require('../desktop-paths.js');

const LIVE_DB = path.resolve(__dirname, '..', 'data', 'plannr.db');

test('the app name and file name', () => {
  assert.strictEqual(APP_NAME, 'Plannr');
  assert.strictEqual(DB_FILE, 'plannr.db');
});

test('Windows: %APPDATA%\\Plannr, or the home folder\'s AppData\\Roaming when APPDATA is missing', () => {
  const home = 'C:\\Users\\Asha';
  assert.strictEqual(userDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\Asha\\AppData\\Roaming' }, homedir: home }), 'C:\\Users\\Asha\\AppData\\Roaming\\Plannr');
  assert.strictEqual(desktopDbPath({ platform: 'win32', env: { APPDATA: 'D:\\Profiles\\Asha\\Roaming' }, homedir: home }), 'D:\\Profiles\\Asha\\Roaming\\Plannr\\plannr.db');
  for (const env of [{}, { APPDATA: '' }, { APPDATA: 'relative\\folder' }]) {
    assert.strictEqual(desktopDbPath({ platform: 'win32', env, homedir: home }), 'C:\\Users\\Asha\\AppData\\Roaming\\Plannr\\plannr.db', JSON.stringify(env));
  }
});

test('macOS: ~/Library/Application Support/Plannr', () => {
  assert.strictEqual(userDataDir({ platform: 'darwin', env: {}, homedir: '/Users/asha' }), '/Users/asha/Library/Application Support/Plannr');
  assert.strictEqual(desktopDbPath({ platform: 'darwin', env: { XDG_CONFIG_HOME: '/tmp/x', APPDATA: 'C:\\x' }, homedir: '/Users/asha' }), '/Users/asha/Library/Application Support/Plannr/plannr.db');
});

test('Linux: $XDG_CONFIG_HOME/Plannr, or ~/.config/Plannr when it is unset or not absolute', () => {
  assert.strictEqual(desktopDbPath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/asha/cfg' }, homedir: '/home/asha' }), '/home/asha/cfg/Plannr/plannr.db');
  for (const env of [{}, { XDG_CONFIG_HOME: '' }, { XDG_CONFIG_HOME: 'cfg' }]) {
    assert.strictEqual(userDataDir({ platform: 'linux', env, homedir: '/home/asha' }), '/home/asha/.config/Plannr', JSON.stringify(env));
  }
});

test('another system, a missing home folder or an app name with a path in it is refused', () => {
  assert.throws(() => userDataDir({ platform: 'android', env: {}, homedir: '/x' }), /Windows, macOS and Linux, not on "android"/);
  assert.throws(() => userDataDir({ platform: 'linux', env: {}, homedir: '' }), /no home folder/);
  for (const appName of ['', '..', '.', 'a/b', 'a\\b', 7]) {
    assert.throws(() => userDataDir({ platform: 'linux', env: {}, homedir: '/x', appName }), /plain folder name/, String(appName));
  }
});

test('on this machine it is a folder of its own, never the dev server\'s data/plannr.db', () => {
  const p = desktopDbPath();
  assert.ok(path.isAbsolute(p));
  assert.strictEqual(path.basename(p), 'plannr.db');
  assert.strictEqual(path.basename(path.dirname(p)), 'Plannr');
  assert.notStrictEqual(path.resolve(p).toLowerCase(), LIVE_DB.toLowerCase());
  assert.ok(!path.resolve(p).toLowerCase().startsWith(path.resolve(__dirname, '..').toLowerCase() + path.sep), 'outside the project folder');
});
