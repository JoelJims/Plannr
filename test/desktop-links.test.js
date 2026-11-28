// The desktop trial's link rules (desktop/security.js: linkAction and lockDownContents). The owner's
// decision (2026-11-28): links to Plannr's own pages (app://plannr/...) stay in the app; http and
// https links open in the system browser, never inside the app; everything else is blocked.
// These tests run WITHOUT Electron: the window's contents and the system browser are recording
// stand-ins. The real window is checked by the self-test (`node desktop/smoke.js`).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const importSecurity = () => import(pathToFileURL(path.join(__dirname, '..', 'desktop', 'security.js')).href);

const OWN = [
  'app://plannr/home.html',
  'app://plannr/cash-flow.html',
  'app://plannr/cash-inflow.html?from=home#list',
  'app://plannr/',
  'app://plannr/api/cash-in',
];
const OUTSIDE = [
  'https://example.com/',
  'https://example.com/help?q=plannr#top',
  'http://example.com/page',
  'https://example.com:8443/x',
  'https://xn--80ak6aa92e.com/',
];
const BLOCKED = [
  // Another app: host, a port, a user name, no host, another scheme that only looks alike.
  'app://plannr.evil/home.html', 'app://other/home.html', 'app://plannr:8080/home.html',
  'app://user@plannr/home.html', 'app://user:pw@plannr/', 'app:///home.html', 'app:home.html',
  'app://evil.example/?app://plannr/', 'appx://plannr/home.html', 'app2://plannr/',
  // Local files and pages made from script or data.
  'file:///etc/passwd', 'file://server/share/x', 'FILE:///x', 'javascript:alert(1)', 'JavaScript:alert(1)',
  'data:text/html,<b>x</b>', 'blob:app://plannr/0b1c2d3e', 'about:blank', 'vbscript:x',
  // Other programs and protocols.
  'mailto:someone@example.com', 'tel:+911234567890', 'sms:123', 'ftp://example.com/x', 'ws://example.com/',
  'wss://example.com/', 'chrome://settings', 'devtools://devtools/', 'smb://server/share', 'ms-settings:privacy',
  'intent://x#Intent;end', 'view-source:https://example.com/',
  // A user name or password in an http(s) link (https://plannr@evil.example/ goes to evil.example).
  'https://user:pass@example.com/', 'https://user@example.com/', 'http://plannr@evil.example/', 'https://:pw@example.com/',
  // Not a valid absolute URL, or one with spaces or control characters in it.
  '', 'not a url', '/cash-flow.html', 'cash-flow.html', '//example.com/', 'https://', 'http://[::1', 'https://exa mple.com/',
  ' https://example.com/', 'https://example.com/\n', 'https://exa\tmple.com/', 'java\nscript:alert(1)', 'https://example.com/\u0000',
  null, undefined, 42, {}, ['https://example.com/'],
];

test('linkAction: own pages stay in the app, http(s) goes to the system browser, everything else is blocked', async () => {
  const { linkAction } = await importSecurity();
  assert.equal(typeof linkAction, 'function', 'security.js exports linkAction');
  for (const url of OWN) assert.equal(linkAction(url), 'app', `own page: ${url}`);
  for (const url of OUTSIDE) assert.equal(linkAction(url), 'external', `outside link: ${url}`);
  for (const url of BLOCKED) assert.equal(linkAction(url), 'block', `blocked: ${JSON.stringify(url)}`);
});

// The window's contents, as far as lockDownContents uses them: it records the handlers and loads.
function fakeContents() {
  const c = { handlers: {}, openHandler: null, loaded: [] };
  c.on = (event, fn) => { c.handlers[event] = fn; return c; };
  c.setWindowOpenHandler = (fn) => { c.openHandler = fn; };
  c.loadURL = async (url) => { c.loaded.push(url); };
  return c;
}
// Electron's navigation event: the URL is on the event (the second argument is deprecated).
const navEvent = (url) => {
  const e = { url, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; } };
  return e;
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

function lockedDown(lockDownContents, openExternal) {
  const contents = fakeContents();
  const opened = [];
  lockDownContents(contents, { openExternal: openExternal || ((url) => { opened.push(url); return Promise.resolve(); }) });
  return { contents, opened };
}

for (const event of ['will-navigate', 'will-redirect']) {
  test(`${event}: an own page goes ahead; http(s) is stopped and opened outside; anything else is stopped and not opened`, async () => {
    const { lockDownContents } = await importSecurity();
    const { contents, opened } = lockedDown(lockDownContents);
    const handler = contents.handlers[event];
    assert.equal(typeof handler, 'function', `a ${event} handler is set`);

    for (const url of ['app://plannr/cash-flow.html', 'app://plannr/home.html']) {
      const e = navEvent(url);
      handler(e, url);
      assert.equal(e.defaultPrevented, false, `${url} opens in the app window`);
    }
    assert.deepEqual(opened, [], 'an own page never goes to the system browser');

    for (const url of ['https://example.com/help?q=1', 'http://example.com/page']) {
      const e = navEvent(url);
      handler(e); // the current form: the URL only on the event
      assert.equal(e.defaultPrevented, true, `${url} does not load inside the app`);
      assert.deepEqual(opened.splice(0), [url], `${url} goes to the system browser, exactly as given`);
    }

    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:someone@example.com', 'tel:+911234567890',
      'data:text/html,x', 'blob:app://plannr/1', 'ftp://example.com/', 'ws://example.com/', 'app://plannr.evil/home.html',
      'app://other/', 'https://user:pass@example.com/', 'not a url']) {
      const e = navEvent(url);
      handler(e, url);
      assert.equal(e.defaultPrevented, true, `${url} is stopped`);
    }
    await settle();
    assert.deepEqual(opened, [], 'nothing blocked reaches the system browser');
    assert.deepEqual(contents.loaded, [], 'the handler never loads anything itself');
  });
}

test('window.open / target=_blank: never a new window; an own page loads in the same window; http(s) opens outside', async () => {
  const { lockDownContents } = await importSecurity();
  const { contents, opened } = lockedDown(lockDownContents);
  assert.equal(typeof contents.openHandler, 'function', 'a window-open handler is set');

  assert.deepEqual(contents.openHandler({ url: 'app://plannr/cash-flow.html', disposition: 'foreground-tab' }), { action: 'deny' });
  await settle();
  assert.deepEqual(contents.loaded, ['app://plannr/cash-flow.html'], 'the own page loads in the same window');
  assert.deepEqual(opened, []);

  for (const url of ['https://example.com/help', 'http://example.com/']) {
    assert.deepEqual(contents.openHandler({ url, disposition: 'new-window' }), { action: 'deny' }, url);
    assert.deepEqual(opened.splice(0), [url], `${url} goes to the system browser, exactly as given`);
  }

  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:someone@example.com', 'data:text/html,x',
    'about:blank', 'app://plannr.evil/', 'https://user@example.com/', '']) {
    assert.deepEqual(contents.openHandler({ url, disposition: 'new-window' }), { action: 'deny' }, JSON.stringify(url));
  }
  await settle();
  assert.deepEqual(opened, [], 'nothing blocked reaches the system browser');
  assert.deepEqual(contents.loaded, ['app://plannr/cash-flow.html'], 'nothing blocked loads in the window');
});

test('link handlers: a failing system browser does not break the window; openExternal must be passed', async () => {
  const { lockDownContents } = await importSecurity();
  for (const openExternal of [() => { throw new Error('no browser'); }, () => Promise.reject(new Error('no browser'))]) {
    const { contents } = lockedDown(lockDownContents, openExternal);
    const e = navEvent('https://example.com/');
    assert.doesNotThrow(() => contents.handlers['will-navigate'](e));
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(contents.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  }
  await settle(); // a rejected openExternal is handled (an unhandled rejection would fail this file)
  for (const options of [undefined, {}, { openExternal: 'yes' }]) {
    assert.throws(() => lockDownContents(fakeContents(), options), /openExternal/, JSON.stringify(options));
  }
});
