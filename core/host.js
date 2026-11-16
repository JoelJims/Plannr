// The platform services the shared core may call (step 1.4 A4).
//
// The core never imports a platform module (Express, Playwright, Capacitor, node:fs). Whatever has
// to differ between the phone and the desktop reaches it as ctx.host, one object per platform:
//   - server.js builds the dev server's (later the desktop app's);
//   - public/local-api.js builds the phone's.
// Each platform passes its host through checkHost() when it starts, so a missing service fails at
// startup, not in the middle of a request.
//
// The list grows only when a part of step 1.4 needs a service (docs/step-1.4-storage-plan.md §4).

export const HOST_SERVICES = Object.freeze({
  'pdf.render': 'pdf.render(html, { part }) -> Promise<bytes>: render the Overview PDF page (A4). '
    + 'Throws hostError(status, message) when the user should see that exact answer.',
  'snapshot.writeJson': 'snapshot.writeJson(backup) -> Promise<string>: save a safety copy of the '
    + 'current data before a JSON restore replaces it; returns where it went.',
  'now': 'now() -> Date: the current time (A6). The core never reads the clock itself, so a test can '
    + 'fix it; the backup reminder stamps and counts days with it.',
});

// An error whose HTTP status and message the core route passes to the page unchanged, e.g. "the
// server is busy" or "PDF export needs the Android app". `cause` keeps the original error for logs.
export function hostError(status, message, cause) {
  const e = new Error(message);
  e.status = status;
  e.userMessage = message;
  if (cause !== undefined) e.cause = cause;
  return e;
}

export function checkHost(host) {
  const missing = Object.keys(HOST_SERVICES).filter((name) => {
    const fn = name.split('.').reduce((o, key) => (o == null ? undefined : o[key]), host);
    return typeof fn !== 'function';
  });
  if (missing.length) throw new Error(`The platform host is missing: ${missing.join(', ')} (see core/host.js).`);
  return host;
}
