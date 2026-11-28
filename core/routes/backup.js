// The JSON backup routes, shared by the phone and the dev server (step 1.4 A7).
//
// What a backup contains, how it is checked and how it is restored is backup-format.js (Phase 2,
// Step 1). This file is the two routes around it:
//   - GET /api/backup/export: the backup as JSON. Contacts (Gmail and WhatsApp numbers) are left out
//     unless the user opts in on the Data page (?includeContacts=1), so a shared backup carries no
//     personal data by default.
//   - POST /api/backup/import: REPLACE, made safe. Check the file fully (with every amount within the
//     typed amounts' limits, Q10: one over refuses the whole file and names it), then save a safety copy of
//     the current data through ctx.host.snapshot.writeJson (core/host.js: a file beside the DB on
//     the dev server, the app's data folder on the phone), then replace all ledger data in ONE
//     transaction, keeping ids and foreign keys. Nothing is deleted before the new data is proven
//     valid, and any error rolls back.
//
//
// The encrypted whole-database backup (Phase 7; here since step 1.4 C11, plan §4):
//   - POST /api/backup/export-encrypted: the passphrase checked, the whole database
//     (host.database.exportBytes) encrypted (host.crypto.encrypt, PLBK version 1).
//   - POST /api/backup/import-encrypted: decrypt, check it is a SQLite file, save a whole-database
//     safety copy (host.snapshot.writeDatabase), replace (host.database.restore), refresh the
//     category list. No safety copy, no restore. A platform without database.restore answers 501
//     with a message that says what to do instead (the phone and the dev server have it since step
//     1.4 D1).

import * as backupFormat from '../../backup-format.js';
import { parseIsoDate, base64ToBytes, MAX_AMOUNT_PAISE, MAX_TOTAL_PAISE, fmtRs } from '../parsers.js';
import { MIN_PASSPHRASE_LEN, looksLikeSqlite } from '../backup-crypto.js';
import { hostService } from '../host.js';
import { RESTORE_FILE_LIMITS, backupSizeNote } from '../../request-rules.js';

export const RESTORE_UNAVAILABLE = 'Restoring from an encrypted backup isn’t available when Plannr is running as a hosted server. Use the Android app to restore an encrypted backup, or restore this server from the plain JSON backup instead.';

export function register(app, ctx) {
  const { auth, adapter, atStart, host, logError, isStorageFullError, storageFull, ledgerIndex, CUSTOM_CODE } = ctx;

  // Fails the start if a table the import replaces is missing from the list it owns (a start job:
  // it reads the schema through the async interface, ahead of any request; step 1.4 B13).
  atStart(() => backupFormat.assertImportOwnershipComplete(adapter));

  // ledgerIndex.byCode() is read at call time: ledgerIndex.refresh() replaces it after a restore.
  // Q10: the amount limits are the typed amounts' own (core/parsers.js), so an import cannot bring in
  // an amount the app would refuse to save.
  const check = (data) => backupFormat.validateBackup(data, {
    liveLedgerByCode: ledgerIndex.byCode(), customCode: CUSTOM_CODE, parseIsoDate,
    maxEntryPaise: MAX_AMOUNT_PAISE, maxTotalPaise: MAX_TOTAL_PAISE, fmtRs,
  });

  app.get('/api/backup/export', auth, async (req, res) => {
    const includeContacts = req.query.includeContacts === '1';
    const backup = await backupFormat.buildBackup(adapter, { includeContacts });
    // A download name for the dev server's browser; the phone saves the file itself.
    res.setHeader('Content-Disposition', `attachment; filename="plannr-backup-${backup.exportedAt.slice(0, 10)}.json"`);
    res.json(backup);
  });

  app.post('/api/backup/import', auth, async (req, res) => {
    // 1. Check: refuse before changing anything.
    const v = check(req.body);
    if (v.error) return res.status(400).json({ error: v.error });

    // 2. Safety copy of the current data first (with contacts: it stays on this device).
    let snapshot;
    try {
      snapshot = await host.snapshot.writeJson(await backupFormat.buildBackup(adapter, { includeContacts: true }));
    } catch (e) {
      logError('Backup snapshot failed:', e);
      return res.status(500).json({ error: 'Could not write the safety snapshot, so the import was aborted — your current data is unchanged.' });
    }

    // 3. Replace in one transaction. Any error rolls back: the current data is unchanged.
    let result;
    try {
      result = await backupFormat.applyBackup(adapter, req.body);
    } catch (e) {
      logError('Backup import failed, rolled back:', e);
      if (isStorageFullError(e)) return res.status(500).json({ error: storageFull('the import did not go through.'), snapshot });
      return res.status(500).json({ error: 'The import failed and was rolled back — your current data is unchanged. The file may be internally inconsistent.', snapshot });
    }
    await ledgerIndex.refresh(); // a v2 backup may have brought its own categories

    res.json({ ok: true, imported: result.imported, remappedUsers: result.remappedUsers, snapshot });
  });

  // F14: after an export, the Data Backup page asks whether a file of this size is getting near what
  // a restore takes (request-rules.js backupSizeNote). -> { note: string|null }.
  app.get('/api/backup/size-note', auth, (req, res) => {
    const kind = String(req.query.kind || '');
    const bytes = /^\d+$/.test(String(req.query.bytes || '')) ? Number(req.query.bytes) : NaN;
    if (!Object.hasOwn(RESTORE_FILE_LIMITS, kind) || !Number.isSafeInteger(bytes)) return res.status(400).json({ error: 'Invalid request.' });
    res.json({ note: backupSizeNote(kind, bytes) });
  });

  app.post('/api/backup/export-encrypted', auth, async (req, res) => {
    const passphrase = req.body && typeof req.body.passphrase === 'string' ? req.body.passphrase : '';
    if (!passphrase) return res.status(400).json({ error: 'Enter a passphrase to encrypt this backup.' });
    if ([...passphrase].length < MIN_PASSPHRASE_LEN) return res.status(400).json({ error: `Use a passphrase of at least ${MIN_PASSPHRASE_LEN} characters. A short one can be guessed by anyone who gets the file.` });
    try {
      const plain = await host.database.exportBytes();
      const enc = await host.crypto.encrypt(plain, passphrase);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(enc);
    } catch (e) {
      logError('Encrypted export failed:', e);
      res.status(500).json({ error: 'Could not build the encrypted backup: ' + e.message });
    }
  });

  app.post('/api/backup/import-encrypted', auth, async (req, res) => {
    const restore = hostService(host, 'database.restore');
    if (!restore) return res.status(501).json({ error: RESTORE_UNAVAILABLE });
    const passphrase = req.body && typeof req.body.passphrase === 'string' ? req.body.passphrase : '';
    const dataBase64 = req.body && typeof req.body.dataBase64 === 'string' ? req.body.dataBase64 : '';
    if (!passphrase) return res.status(400).json({ error: 'Enter the passphrase this backup was encrypted with.' });
    if (!dataBase64) return res.status(400).json({ error: 'Choose an encrypted backup file first.' });

    let encBytes;
    try {
      encBytes = base64ToBytes(dataBase64);
    } catch {
      return res.status(400).json({ error: 'That file could not be read — choose a Plannr encrypted backup (.db.enc).' });
    }

    // 1. Decrypt and check: refuse before changing anything.
    let plain;
    try {
      plain = await host.crypto.decrypt(encBytes, passphrase);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (!looksLikeSqlite(plain)) {
      return res.status(400).json({ error: 'Decryption succeeded but the result does not look like a SQLite database — the file may be corrupt.' });
    }

    // 2. A whole-database copy of the current data first. No copy, no restore.
    let snapshot = null;
    try {
      snapshot = await host.snapshot.writeDatabase();
    } catch (e) {
      logError('Pre-restore snapshot failed:', e);
      return res.status(500).json({ error: 'Could not write the safety snapshot, so the restore was not started — your current data is unchanged.' });
    }

    // 3. Replace, all or nothing (S3/Q6): checked before anything is replaced (a newer backup is
    //    refused unchanged), and if a check after the replace fails, the data from just before it is
    //    put back (db.js undoFailedRestore). So every failure leaves the data as it was, except the
    //    one where putting it back failed too: then the safety copy from step 2 is the way back.
    try {
      await restore(plain);
    } catch (e) {
      logError('Encrypted import failed:', e);
      if (e && e.code === 'BACKUP_TOO_NEW') return res.status(400).json({ error: e.message });
      if (e && e.code === 'RESTORE_UNDO_FAILED') {
        return res.status(500).json({
          error: `The restore failed, and putting your data back failed too. Make no changes: restore the safety copy${snapshot ? ` (${snapshot})` : ''} or your latest backup. ${e.message}`,
          snapshot,
        });
      }
      const cause = e && e.code === 'RESTORE_UNDONE' ? e.cause : e;
      if (isStorageFullError(cause)) return res.status(500).json({ error: storageFull('the restore did not go through, and nothing was changed.'), snapshot });
      return res.status(500).json({ error: `This backup could not be restored. Nothing was changed: your data is as it was before. Reason: ${cause && cause.message}`, snapshot });
    }
    await ledgerIndex.refresh(); // the restored database has its own categories
    res.json({ ok: true, snapshot });
  });
}
