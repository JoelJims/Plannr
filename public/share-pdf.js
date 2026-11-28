// Hands an Overview PDF to Android (docs/share-and-reminder-pdf-plan.md): write the PDF to the
// app's cache, then open the share sheet (Download PDF), WhatsApp (Send to WhatsApp) or the mail app
// (Send by email). Nothing here sends anything: the user picks where the PDF goes and taps Send there.
// When WhatsApp or a mail app is missing, or its plugin fails, the share sheet opens instead and the
// page says why.
// Phase 6a: the WebView doesn't support the Web Share API's `files` member, and a plain
// <a download> click is a dead end there, so Capacitor's own Filesystem+Share is the ONLY real
// delivery path natively. A failure here is reported directly through `msg`.

import { localDateStamp } from './core/local-date.js';

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

// Writes the PDF to the app's cache folder and answers its file:// URI.
export async function writePdfToCache({ blob, fname }) {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const base64Data = await blobToBase64(blob);
  const written = await withTimeout(Filesystem.writeFile({ path: fname, data: base64Data, directory: Directory.Cache }), 20000, 'Writing the PDF file');
  return written.uri;
}

// The share sheet (Download PDF, and every fallback). `msg` is the page's message box
// ({ show(text, kind) }). A fallback passes the file it already wrote (`uri`) and the reason the
// sheet opened instead (`note`), which is shown first and kept in front of any later message.
export async function sharePdfSheet({ blob, fname, msg, uri = null, note = '' }) {
  const said = (text) => (note ? note + ' ' + text : text);
  try {
    const { Share } = await import('@capacitor/share');
    const fileUri = uri || await writePdfToCache({ blob, fname });
    if (note) msg.show(note, 'info');
    // Both `url` and `files` set to the same file:// URI — some Android/OEM combinations have
    // only honoured one or the other for attaching an actual file (vs. sharing a link).
    // No timeout here: Share.share() resolves only once the user has chosen where the PDF goes,
    // which can take any length of time (a 20 s timeout reported failure while the sheet was
    // still open — seen on the emulator, Phase 2 Step 9). Closing the sheet is not an error.
    await Share.share({ url: fileUri, files: [fileUri], title: 'Plannr', dialogTitle: 'Share report' });
  } catch (err) {
    if (/cancel/i.test(errText(err))) msg.show(said('PDF not shared: the share sheet was closed. Tap the button again to share it.'), 'info');
    else msg.show(said('Generated the PDF but could not share it: ' + errText(err)), 'error');
  }
}

// Today's date on this phone, YYYY-MM-DD: what {date} in the email subject becomes. The same helper
// dates the PDF's file name (overviewPdfName), so the subject and the file always agree.
export const localDate = localDateStamp;

// The subject from the "Sending PDFs" settings, with every {date} filled in.
export function fillSubject(subject, date) {
  return String(subject || '').split('{date}').join(date);
}

// Offline the PDF is still made and handed over; the app it goes to sends it later. A short note
// says so. `online` is navigator.onLine (false only when the phone knows it is offline).
const OFFLINE_NOTES = {
  whatsapp: "You're offline: WhatsApp will send it when you're back online.",
  email: "You're offline: your mail app will send it when you're back online.",
  sheet: "You're offline: the app you pick will send it when you're back online.",
};
export function offlineNote(kind, online) {
  return online === false ? OFFLINE_NOTES[kind] : '';
}
const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
const sentence = (...parts) => parts.filter(Boolean).join(' ');

// ShareToPlugin.java, registered by MainActivity. Only ever asked for on the phone. Capacitor's
// plugin object answers every name, `then` too, as a native method, so it must never be awaited or
// returned from an async function: that calls "ShareTo.then()" on the phone, which fails and never
// settles (seen on the emulator). It is handed over inside a plain object instead.
let shareToBox = null;
async function shareTo() {
  if (!shareToBox) shareToBox = { plugin: (await import('@capacitor/core')).registerPlugin('ShareTo') };
  return shareToBox;
}

// Send to WhatsApp: WhatsApp (then WhatsApp Business) opens with the PDF attached; the user picks
// the chat and taps Send there. Not installed, or the plugin fails: the share sheet, saying why.
export async function sendPdfToWhatsApp({ blob, fname, msg, online = isOnline() }) {
  let uri;
  try { uri = await writePdfToCache({ blob, fname }); }
  catch (err) { msg.show('Generated the PDF but could not save it for WhatsApp: ' + errText(err), 'error'); return; }
  let reason;
  try {
    const { plugin } = await shareTo();
    const r = await withTimeout(plugin.whatsapp({ path: uri }), 20000, 'Opening WhatsApp');
    if (r && r.opened) {
      msg.show(sentence('WhatsApp opened with the PDF attached. Pick the chat and tap Send there.', offlineNote('whatsapp', online)), 'success');
      return;
    }
    reason = r && r.reason === 'not-installed'
      ? 'WhatsApp is not installed, so the share sheet opened instead.'
      : `Could not open WhatsApp (${(r && r.reason) || 'no answer'}), so the share sheet opened instead.`;
  } catch (err) {
    reason = `Could not open WhatsApp (${errText(err)}), so the share sheet opened instead.`;
  }
  await sharePdfSheet({ blob, fname, msg, uri, note: sentence(reason, offlineNote('sheet', online)) });
}

// The subject when the settings could not be read (the same default as core/routes/notification-times.js).
export const DEFAULT_SUBJECT = 'Plannr report – {date}';

// Send by email: the mail app opens with To and Subject from the "Sending PDFs" settings and the
// PDF attached; the user checks it and taps Send there. `settings` is GET /api/share-settings, or
// null when it could not be read (then To stays empty, and the page says so). `now` is the moment the
// page named the PDF (fname), so the subject's {date} is the file name's date even if midnight passes
// in between. No mail app, or the plugin fails: the share sheet, saying why.
export async function sendPdfByEmail({ blob, fname, msg, settings, online = isOnline(), now = new Date() }) {
  let uri;
  try { uri = await writePdfToCache({ blob, fname }); }
  catch (err) { msg.show('Generated the PDF but could not save it for email: ' + errText(err), 'error'); return; }
  let reason;
  try {
    const { MailComposer } = await import('@capawesome/capacitor-mail-composer');
    const can = await withTimeout(MailComposer.canComposeMail(), 20000, 'Looking for a mail app');
    if (can && can.canCompose) {
      const s = settings || {};
      // No timeout: on Android composeMail() resolves only when the user leaves the mail app.
      await MailComposer.composeMail({
        to: Array.isArray(s.emailTo) ? s.emailTo : [],
        subject: fillSubject(s.emailSubject || DEFAULT_SUBJECT, localDate(now)),
        attachments: [{ path: uri }],
      });
      msg.show(sentence('Your mail app opened with the PDF attached. It is sent only when you tap Send there.',
        settings ? '' : 'The "Sending PDFs" settings could not be read, so To was left empty.',
        offlineNote('email', online)), 'success');
      return;
    }
    reason = 'No mail app is set up on this phone, so the share sheet opened instead.';
  } catch (err) {
    reason = `Could not open the mail app (${errText(err)}), so the share sheet opened instead.`;
  }
  await sharePdfSheet({ blob, fname, msg, uri, note: sentence(reason, offlineNote('sheet', online)) });
}
