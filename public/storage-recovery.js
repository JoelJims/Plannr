// The recovery screen (step 1.4 C9; docs/step-1.4-storage-plan.md §2.2, §2.4). Shown instead of the
// page when the marker says the data is in its file but the file is missing or fails quick_check.
// Nothing is changed until you pick one of the two ways out:
//   - "Use the old copy as it was on <date>" (only while the old localStorage copy is kept): after a
//     confirmation, the damaged file is renamed aside (kept) and the marker switches back to
//     localStorage (core/storage-move.js useOldCopy()). Entries made since the move are not in it.
//   - "Restore an encrypted backup": the backup is decrypted and checked, the damaged file is renamed
//     aside, and the backup becomes the database file. The marker stays native-v1.
// The page's own script never runs (local-bootstrap.js stops after this); a reload starts over.

import { useOldCopy, MoveError } from './core/storage-move.js';
import { openCapacitorAdapter } from './db-adapter-capacitor.js';
import { MAIN_NAME, phonePlugins } from './storage-native.js';

const dayText = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'the day of the move' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
};

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

/** Restore an encrypted backup into a new database file (the damaged one is kept aside). */
export async function restoreIntoFile({ host, plugins, encBytes, passphrase }) {
  const { decrypt, looksLikeSqlite } = await import('./backup-crypto.js');
  const { imageUserVersion } = await import('./local-snapshot.js');
  const { SCHEMA_VERSION } = await import('./db.js');
  const plain = await decrypt(encBytes, passphrase); // a wrong passphrase throws here, before anything changes
  if (!looksLikeSqlite(plain)) throw new Error('The file opened, but it is not a Plannr database.');
  if (imageUserVersion(plain) > SCHEMA_VERSION) throw new Error('This backup was made by a newer version of Plannr. Update Plannr, then restore it.');
  let setAside = null;
  if (await host.main.exists()) setAside = await host.main.setAside(new Date().toISOString());
  const a = await openCapacitorAdapter({ ...plugins, name: MAIN_NAME }); // a new, empty file
  try { await a.replaceWith(plain); } finally { await a.close(); }
  return { setAside };
}

export async function showRecoveryScreen(choice, { reload = () => location.reload() } = {}) {
  const { host, reason, marker } = choice;
  const plugins = await phonePlugins(window.__plannrTestPlugins);
  const since = (marker && marker.oldCopy && marker.oldCopy.since) || (marker && marker.movedAt);
  const oldCopyKept = !(marker && marker.oldCopy && marker.oldCopy.kept === false) && (await host.local.exists());

  const status = el('p', { role: 'status', 'aria-live': 'polite', id: 'recovery-status' });
  const say = (text) => { status.textContent = text; };

  const useOld = oldCopyKept ? el('button', { type: 'button', id: 'recovery-use-old', text: `Use the old copy as it was on ${dayText(since)}` }) : null;
  if (useOld) {
    useOld.addEventListener('click', async () => {
      const ask = await useOldCopy(host).catch((e) => e);
      const question = ask instanceof MoveError && ask.step === 'confirm' ? ask.message : null;
      if (!question) { say(ask && ask.message ? ask.message : 'That did not work.'); return; }
      if (!window.confirm(question)) return;
      useOld.disabled = true;
      try {
        await useOldCopy(host, { confirmed: true });
        say('Switched to the old copy. Opening it…');
        reload();
      } catch (e) {
        useOld.disabled = false;
        say(e && e.message ? e.message : String(e));
      }
    });
  }

  const file = el('input', { type: 'file', id: 'recovery-file', accept: '.enc,.plbk,application/octet-stream' });
  const pass = el('input', { type: 'password', id: 'recovery-passphrase', autocomplete: 'off' });
  const restore = el('button', { type: 'button', id: 'recovery-restore', text: 'Restore this backup' });
  restore.addEventListener('click', async () => {
    const f = file.files && file.files[0];
    if (!f) { say('Choose your encrypted backup file first.'); return; }
    if (!pass.value) { say('Enter the passphrase this backup was saved with.'); return; }
    restore.disabled = true;
    say('Restoring…');
    try {
      await restoreIntoFile({ host, plugins, encBytes: new Uint8Array(await f.arrayBuffer()), passphrase: pass.value });
      say('Restored. Opening it…');
      reload();
    } catch (e) {
      restore.disabled = false;
      say(e && e.message ? e.message : String(e));
    }
  });

  const box = el('main', { id: 'storage-recovery', style: 'margin:16px;padding:16px;border:2px solid #b00020;border-radius:8px;background:#fff4f4;color:#3b0010;font:16px/1.5 system-ui,sans-serif;max-width:40rem' },
    el('h1', { style: 'font-size:1.3rem;margin:0 0 .5rem', text: 'Plannr cannot open your data file' }),
    el('p', { text: reason === 'missing'
      ? 'The file that holds your data is missing. Nothing has been changed.'
      : 'The file that holds your data is damaged. Nothing has been changed.' }),
    useOld ? el('section', {},
      el('h2', { style: 'font-size:1.1rem', text: 'Use the old copy' }),
      el('p', { text: `Your data as it was when it was moved, on ${dayText(since)}. Anything entered after that is not in it.${reason === 'missing' ? '' : ' The damaged file is kept.'}` }),
      useOld) : null,
    el('section', {},
      el('h2', { style: 'font-size:1.1rem', text: 'Restore an encrypted backup' }),
      el('label', { for: 'recovery-file', text: 'Backup file ' }), file, el('br'),
      el('label', { for: 'recovery-passphrase', text: 'Passphrase ' }), pass, el('br'),
      restore),
    status);
  const show = () => { document.body.replaceChildren(box); };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
}
