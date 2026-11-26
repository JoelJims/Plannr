// Step 1.4 C10: the storage move on the Data Backup page (docs/step-1.4-storage-plan.md §2, §2.4, §2.5).
//
// It runs only in a build that has the phone's two storage plugins (local-bootstrap.js sets
// window.__plannrStorage.native). In the browser preview, under the desktop server and on an older
// APK the section stays hidden and nothing here touches any file.
//   On localStorage:  "Move to the new storage", with the passphrase of the step-1 encrypted backup;
//                     after an interruption, "Continue" or "Not now".
//   On the file:      what the check found, and the old copy: "Delete the old copy", "Move data back".
//                     Q12: until you confirm the move ("Confirm the move"), a note says the safety copy
//                     from before the move is kept; after that it goes in the normal snapshot rotation.
// While a move runs, an overlay ("Moving your data…") covers the page and everything behind it is
// inert: nothing can be edited. After a switch either way the page reloads, so the app opens the copy
// the marker file names (storage-native.js chooseStorage()).
//
// The page hands in its own helpers (initMovePanel(deps)): the step-1 backup is saved by the same
// saveFile() as "Download encrypted backup" (the same proof that the file was written, the same
// "mark exported"), and confirmed like the Ledger List import's safety backup.

import { moveToFile, moveBack, deleteOldCopy, confirmMove, moveConfirmed, MoveError, sha256Hex, MB, MARKER_NATIVE, MARKER_LOCAL } from './core/storage-move.js';
import { summaryText } from './core/storage-check.js';
import { makePhoneHost, phonePlugins, PROGRESS_KEY } from './storage-native.js';
import { dbAdapter } from './db.js';
import { openKvvfsAdapter } from './db-adapter-kvvfs.js';
import { exportSnapshotBytes } from './local-snapshot.js';

export const STEP_TEXT = {
  space: 'Check the free space',
  backup: 'Save the encrypted backup',
  snapshot: 'Save a safety copy on the phone',
  write: 'Write the new file',
  check: 'Check every table against your data',
  place: 'Put the file in place',
  switch: 'Switch to the new file',
};
export const BACK_STEP_TEXT = {
  size: 'Check the size and the free space',
  snapshot: 'Save safety copies of both',
  write: 'Write your data into the old storage',
  check: 'Check every table',
  switch: 'Switch back',
};
// "Not now" hides the prompt for this session only; the progress record stays, so "Continue" later
// can still skip the backup if the data has not changed.
export const NOT_NOW_KEY = 'plannr-move-not-now';

const $ = (id) => document.getElementById(id);
const mbText = (bytes) => `${(Math.ceil((Number(bytes) / MB) * 10) / 10).toFixed(1)} MB`;
const dayText = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'an earlier day' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
};
const readJson = (key) => { try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const show = (el, on) => { el.hidden = !on; };

// ---- The overlay: shown while a move runs; the rest of the page is inert -----------------------------

let inerted = [];
const guard = (e) => { e.preventDefault(); e.returnValue = ''; };
function busy(title, steps) {
  $('moveOverlayTitle').textContent = title;
  const list = $('moveSteps');
  list.replaceChildren(...Object.entries(steps).map(([name, text]) => {
    const li = document.createElement('li');
    li.dataset.step = name;
    li.textContent = text;
    return li;
  }));
  $('moveOverlayMsg').textContent = '';
  $('moveOverlayMsg').className = 'msg';
  // Everything but the overlay and the confirmation dialogs (step 1 asks one) stops taking input.
  inerted = [...document.body.children].filter((el) => el.id !== 'moveOverlay' && !el.classList.contains('pl-confirm-backdrop') && !el.inert);
  for (const el of inerted) el.inert = true;
  show($('moveOverlay'), true);
  window.addEventListener('beforeunload', guard);
  $('moveOverlayTitle').focus();
}
function stepNow(name) {
  let seen = false;
  for (const li of $('moveSteps').children) {
    if (li.dataset.step === name) { seen = true; li.dataset.state = 'now'; li.setAttribute('aria-current', 'step'); }
    else { li.dataset.state = seen ? '' : 'done'; li.removeAttribute('aria-current'); }
  }
}
function idle() {
  window.removeEventListener('beforeunload', guard);
  for (const el of inerted) el.inert = false;
  inerted = [];
  show($('moveOverlay'), false);
}
// At once: until the reload, the page's database connection is still the copy it started on.
function reloadNow() {
  window.removeEventListener('beforeunload', guard);
  location.reload();
}

// ---- The host: storage-native.js, with this page's backup and the data in use ------------------------

// The move's source on localStorage: db.js's own connection for the reads (the checks), and the same
// export the encrypted backup uses (local-snapshot.js, sqlite3_js_db_export) for the bytes.
function kvvfsSource() {
  const live = dbAdapter();
  return {
    get: (sql, params) => live.get(sql, params),
    all: (sql, params) => live.all(sql, params),
    exportBytes: async () => exportSnapshotBytes(),
  };
}

async function hostFor(storage, backup) {
  const plugins = await phonePlugins(window.__plannrTestPlugins);
  return makePhoneHost({
    plugins,
    localStorage: window.localStorage,
    backup,
    source: storage.use === 'localstorage' ? kvvfsSource() : null,
    file: storage.use === 'native' ? dbAdapter() : null,
    lastEncryptedBackupAt: async () => {
      const r = await fetch('/api/backup/reminder');
      if (!r.ok) return null;
      return (await r.json()).lastExportAt || null;
    },
    kvvfs: openKvvfsAdapter,
  });
}

// ---- Q12: the confirm step (built here; the page's own markup is not changed) --------------------------

// A note and a "Confirm the move" button, under what the check found.
function confirmPanel() {
  if ($('moveConfirm')) return;
  const box = document.createElement('div');
  box.id = 'moveConfirm';
  const note = document.createElement('p');
  note.id = 'moveConfirmText';
  note.tabIndex = -1; // the focus goes here once the button is gone
  const actions = document.createElement('div');
  actions.id = 'moveConfirmActions';
  actions.className = 'mv-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'moveConfirmBtn';
  btn.className = 'btn primary';
  btn.textContent = 'Confirm the move';
  actions.append(btn);
  box.append(note, actions);
  $('moveDoneText').after(box);
}

function confirmText(marker) {
  if (moveConfirmed(marker)) {
    return `Move confirmed on ${dayText(marker.safetyCopy.confirmedAt)}. The safety copy from before the move now goes in the normal rotation of safety copies: Plannr keeps the newest 3.`;
  }
  const c = marker.check;
  const what = c && Number.isFinite(Number(c.tables)) && Number.isFinite(Number(c.rows))
    ? `your data (${c.tables} tables, ${Number(c.rows).toLocaleString('en-IN')} rows)` : 'your data';
  return `Not confirmed yet. On ${dayText(marker.movedAt)} ${what} was moved into its own file on this phone. A safety copy from before the move is kept on this phone until you confirm the move. Check that your entries look right, then confirm.`;
}

/** Step 1 needs a new backup unless an interrupted move already saved one of exactly this data. */
async function backupNeeded() {
  const p = readJson(PROGRESS_KEY);
  if (!p || !Array.isArray(p.done) || !p.done.includes('snapshot') || !p.checksum) return true;
  return p.checksum !== (await sha256Hex(await exportSnapshotBytes()));
}

export async function initMovePanel(deps) {
  const { makeMsg, confirmModal, saveFile, newPassphraseProblem, today, errText } = deps;
  const storage = window.__plannrStorage;
  if (!storage || !storage.native) return; // no storage plugins: nothing to move
  const section = $('moveSection');
  const msg = makeMsg($('moveMsg'));
  const overlayMsg = makeMsg($('moveOverlayMsg'));
  section.hidden = false;

  // ---- On localStorage: the move ----------------------------------------------------------------------
  if (storage.use === 'localstorage') {
    const marker = storage.marker || null;
    $('moveTag').textContent = 'Old storage';
    show($('moveStart'), true);
    if (marker && marker.storage === MARKER_LOCAL && marker.emergency) {
      $('moveStateText').textContent = `Plannr went back to the old copy on ${dayText(marker.at)} because the database file was ${marker.file && marker.file.reason === 'damaged' ? 'damaged' : 'missing'}.${marker.file && marker.file.setAside ? ' The damaged file is kept aside.' : ''}`;
    } else if (marker && marker.storage === MARKER_LOCAL && marker.movedBackAt) {
      $('moveStateText').textContent = `Your data was moved back to the old storage on ${dayText(marker.movedBackAt)}. The database file is kept.`;
    }
    const interrupted = storage.prompt === 'interrupted' || !!readJson(PROGRESS_KEY);
    let notNow = false;
    try { notNow = sessionStorage.getItem(NOT_NOW_KEY) === '1'; } catch { /* no sessionStorage */ }
    show($('moveInterrupted'), interrupted && !notNow);

    const pass = $('movePass');
    const pass2 = $('movePass2');
    const run = async (button) => {
      msg.clear();
      let needBackup;
      try { needBackup = await backupNeeded(); } catch { needBackup = true; }
      if (needBackup) {
        const problem = newPassphraseProblem(pass.value, pass2.value);
        if (problem) { msg.show(`${problem} The move starts with an encrypted backup of your data.`, 'error'); pass.focus(); return; }
      }
      const passphrase = pass.value;
      const fname = `plannr-backup-${today()}.db.enc`;
      const backup = async () => {
        const res = await fetch('/api/backup/export-encrypted', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(`The encrypted backup could not be made: ${d.error || 'error ' + res.status}`);
        }
        await saveFile(await res.blob(), fname, 'Save the backup before the move', overlayMsg);
        const gotIt = await confirmModal({
          title: 'Confirm you have the backup',
          message: `"${fname}" was just saved. Before your data moves, confirm you actually have this file: check where it was saved or shared to. If you're not sure, cancel and look first.`,
          confirmLabel: 'I have the backup — continue',
        });
        if (!gotIt) throw Object.assign(new Error('the backup was not confirmed'), { notConfirmed: true });
      };
      button.disabled = true;
      busy('Moving your data…', STEP_TEXT);
      try {
        const host = await hostFor(storage, backup);
        const res = await moveToFile(host, { onStep: (i, name) => stepNow(name) });
        stepNow('');
        overlayMsg.show(`Done. ${summaryText(res.summary)} Plannr is reopening on the new storage…`, 'success');
        pass.value = '';
        pass2.value = '';
        reloadNow();
      } catch (err) {
        idle();
        button.disabled = false;
        if (err && (err.cancelled || err.notConfirmed)) {
          msg.show('The move did not start: the encrypted backup was not saved and confirmed. Nothing was changed.', 'info');
        } else if (err instanceof MoveError) {
          msg.show(`${err.message}${err.step === 'space' ? '' : ' Your data is still in the old storage, unchanged.'}`, 'error');
        } else {
          msg.show(`The move stopped: ${errText(err)}. Your data is still in the old storage, unchanged.`, 'error');
        }
      }
    };
    $('moveBtn').addEventListener('click', () => run($('moveBtn')));
    $('moveContinueBtn').addEventListener('click', () => { show($('moveInterrupted'), false); run($('moveBtn')); });
    $('moveNotNowBtn').addEventListener('click', () => {
      try { sessionStorage.setItem(NOT_NOW_KEY, '1'); } catch { /* shown again next time */ }
      show($('moveInterrupted'), false);
      msg.show('Plannr keeps working on the old storage. You can move your data any time from here.', 'info');
    });
    return;
  }

  // ---- On the file: the result and the old copy ------------------------------------------------------
  if (storage.use !== 'native') return;
  $('moveTag').textContent = 'New storage';
  show($('oldCopyPanel'), true);
  confirmPanel();
  const host = await hostFor(storage, null);
  const render = async () => {
    const marker = (await host.marker.read()) || storage.marker || {};
    const check = marker.check ? ` ${summaryText(marker.check)}` : '';
    $('moveDoneText').textContent = `Your data is in its own file on this phone since ${dayText(marker.movedAt)}.${check}`;
    const kept = marker.storage === MARKER_NATIVE && !(marker.oldCopy && marker.oldCopy.kept === false) && (await host.local.exists());
    $('oldCopyText').textContent = kept
      ? `Old copy kept (from ${dayText((marker.oldCopy && marker.oldCopy.since) || marker.movedAt)}${marker.oldCopy && marker.oldCopy.bytes ? ', ' + mbText(marker.oldCopy.bytes) : ''}). Nothing deletes it unless you do.`
      : `The old copy was deleted${marker.oldCopy && marker.oldCopy.deletedAt ? ' on ' + dayText(marker.oldCopy.deletedAt) : ''}.`;
    show($('deleteOldCopyBtn'), kept);
    $('moveConfirmText').textContent = confirmText(marker);
    // .mv-actions sets display: flex, which would override the hidden attribute: hide it by style.
    $('moveConfirmActions').style.display = moveConfirmed(marker) ? 'none' : '';
  };
  await render();

  // Q12: "Confirm the move". Asks first; then the safety copy goes in the normal rotation.
  $('moveConfirmBtn').addEventListener('click', async () => {
    msg.clear();
    const btn = $('moveConfirmBtn');
    btn.disabled = true;
    let confirmedNow = false;
    try {
      try {
        await confirmMove(host, { confirmed: false });
        confirmedNow = true; // it was already confirmed
        msg.show('The move is already confirmed.', 'info');
      } catch (err) {
        if (!(err instanceof MoveError) || err.step !== 'confirm') throw err;
        const ok = await confirmModal({ title: 'Confirm the move?', message: err.message, confirmLabel: 'Confirm the move' });
        if (!ok) { msg.show('Not confirmed. The safety copy from before the move is kept.', 'info'); return; }
        await confirmMove(host, { confirmed: true });
        confirmedNow = true;
        msg.show('The move is confirmed. The safety copy from before the move now goes in the normal rotation.', 'success');
      }
    } catch (err) {
      msg.show(err instanceof MoveError ? err.message : `The move could not be confirmed: ${errText(err)}`, 'error');
    } finally {
      btn.disabled = false;
      await render();
      // Once confirmed the button is gone, so the focus goes to the note; otherwise back to the button.
      (confirmedNow ? $('moveConfirmText') : btn).focus();
    }
  });

  $('deleteOldCopyBtn').addEventListener('click', async () => {
    msg.clear();
    const btn = $('deleteOldCopyBtn');
    btn.disabled = true;
    try {
      try {
        await deleteOldCopy(host, { confirmed: false });
      } catch (err) {
        if (!(err instanceof MoveError) || err.step !== 'confirm') throw err;
        const ok = await confirmModal({ title: 'Delete the old copy?', message: err.message, confirmLabel: 'Delete the old copy' });
        if (!ok) { msg.show('The old copy is kept.', 'info'); return; }
        const res = await deleteOldCopy(host, { confirmed: true });
        msg.show(`The old copy was deleted${res.freedBytes ? ` (${mbText(res.freedBytes)} freed)` : ''}.`, 'success');
      }
    } catch (err) {
      msg.show(err instanceof MoveError ? err.message : `The old copy could not be deleted: ${errText(err)}`, 'error');
    } finally {
      btn.disabled = false;
      await render();
    }
  });

  $('moveBackBtn').addEventListener('click', async () => {
    msg.clear();
    const btn = $('moveBackBtn');
    btn.disabled = true;
    try {
      // Without the confirmation moveBack() only checks: the size and the free space come before the
      // question, so nothing is asked that cannot be done. Its last refusal is the question itself.
      try {
        await moveBack(host, { confirmed: false });
      } catch (err) {
        if (!(err instanceof MoveError) || err.step !== 'confirm') throw err;
      }
      const ok = await confirmModal({
        title: 'Move your data back?',
        message: 'Your current data replaces the old copy in the old storage (a safety copy of the old copy is saved first). The database file is kept. Plannr then reopens on the old storage.',
        confirmLabel: 'Move data back',
      });
      if (!ok) { msg.show('Nothing was changed.', 'info'); return; }
      busy('Moving your data back…', BACK_STEP_TEXT);
      try {
        const res = await moveBack(host, { confirmed: true, onStep: (name) => stepNow(name) });
        stepNow('');
        overlayMsg.show(`Done. ${summaryText(res.summary)} Plannr is reopening on the old storage…`, 'success');
        reloadNow();
      } catch (err) {
        idle();
        throw err;
      }
    } catch (err) {
      msg.show(err instanceof MoveError ? err.message : `Moving back stopped: ${errText(err)}. You stay on the new storage, unchanged.`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
