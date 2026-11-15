// Which backend answers the screens' /api requests (Phase 2, Step 6):
//   'local'  — the in-app database through the fetch shim (public/local-api.js). This is the phone
//              app, and also local-server.js, which serves public/ the way the app sees it.
//   'server' — the desktop dev server (server.js). Development and tests only.
//
// The rule, in order:
//   1. Inside the Capacitor app (a native platform) it is ALWAYS 'local'. No probe is made at all,
//      so nothing a web server could send can ever switch the phone away from its own data.
//   2. In a plain browser it is 'server' only if the page itself came from server.js, which marks
//      every response with the header below. Anything else — local-server.js, any static host —
//      is 'local'.
// Before Step 6 the switch was "the page has an ETag" (express.static sets one by default), which a
// future WebView or static host could also send; this explicit marker cannot be sent by accident.
//
// No static imports, so Node tests can load it directly (test/runtime-mode.test.js).

export const DEV_SERVER_HEADER = 'x-plannr-dev-server';

export function decideMode({ isNative, probeHeaders }) {
  if (isNative) return 'local';
  const marker = probeHeaders && typeof probeHeaders.get === 'function' ? probeHeaders.get(DEV_SERVER_HEADER) : null;
  return marker === '1' ? 'server' : 'local';
}

// The probe: a HEAD request for the current page (it always exists, in both modes, so the browser
// never logs a failed request). Skipped entirely inside the app.
export async function detectMode({ isNative, path, fetchImpl = fetch }) {
  if (isNative) return decideMode({ isNative: true });
  const probe = await fetchImpl(path, { method: 'HEAD' }).catch(() => null);
  return decideMode({ isNative: false, probeHeaders: probe && probe.headers });
}
