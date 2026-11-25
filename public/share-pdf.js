// Hands an Overview PDF to Android (docs/share-and-reminder-pdf-plan.md). Moved out of
// overview.html downloadPdf() unchanged: write the PDF to the app's cache, then open the normal
// share sheet. Nothing here sends anything: the user picks where the PDF goes and taps Send there.
// Phase 6a: the WebView doesn't support the Web Share API's `files` member, and a plain
// <a download> click is a dead end there, so Capacitor's own Filesystem+Share is the ONLY real
// delivery path natively. A failure here is reported directly through `msg`.

export const errText = (err) => (err && err.message) ? err.message : String(err);

// withTimeout turns a stuck native call (no throw, no resolve — indistinguishable from success
// mid-flight) into a real, visible error after a bounded wait.
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// @capacitor/filesystem's writeFile *declares* data: string | Blob, but on-device a raw Blob
// failed native validation ("the 'writeFile' input parameters aren't valid") — a Blob isn't
// JSON-serializable across the bridge, so nothing meaningful was actually crossing it. Per the
// plugin's own docs, omitting `encoding` means data is read as base64 — so convert here instead.
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Could not read the PDF data.'));
    reader.readAsDataURL(blob);
  });
}

// The share sheet (today's path). `msg` is the page's message box ({ show(text, kind) }).
export async function sharePdfSheet({ blob, fname, msg }) {
  try {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const base64Data = await blobToBase64(blob);
    const written = await withTimeout(Filesystem.writeFile({ path: fname, data: base64Data, directory: Directory.Cache }), 20000, 'Writing the PDF file');
    // Both `url` and `files` set to the same file:// URI — some Android/OEM combinations have
    // only honoured one or the other for attaching an actual file (vs. sharing a link).
    // No timeout here: Share.share() resolves only once the user has chosen where the PDF goes,
    // which can take any length of time (a 20 s timeout reported failure while the sheet was
    // still open — seen on the emulator, Phase 2 Step 9). Closing the sheet is not an error.
    await Share.share({ url: written.uri, files: [written.uri], title: 'Plannr', dialogTitle: 'Share report' });
  } catch (err) {
    if (/cancel/i.test(errText(err))) msg.show('PDF not shared: the share sheet was closed. Tap the button again to share it.', 'info');
    else msg.show('Generated the PDF but could not share it: ' + errText(err), 'error');
  }
}
