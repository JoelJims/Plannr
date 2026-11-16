// The JSON backup routes, shared by the phone and the dev server (step 1.4 A7).
//
// What a backup contains, how it is checked and how it is restored is backup-format.js (Phase 2,
// Step 1). This file is the two routes around it:
//   - GET /api/backup/export: the backup as JSON. Contacts (Gmail and WhatsApp numbers) are left out
//     unless the user opts in on the Data page (?includeContacts=1), so a shared backup carries no
//     personal data by default.
//   - POST /api/backup/import: REPLACE, made safe. Check the file fully, then save a safety copy of
//     the current data through ctx.host.snapshot.writeJson (core/host.js: a file beside the DB on
//     the dev server, the app's data folder on the phone), then replace all ledger data in ONE
//     transaction, keeping ids and foreign keys. Nothing is deleted before the new data is proven
//     valid, and any error rolls back.
//
// The encrypted whole-database backup is a different thing. It stays with each platform until the
// database adapter can export and replace its own bytes (docs/step-1.4-storage-plan.md §4, stage B).

import * as backupFormat from '../../backup-format.js';
import { parseIsoDate } from '../parsers.js';

export function register(app, ctx) {
  const { auth, db, host, logError, isStorageFullError, storageFull, ledgerIndex, CUSTOM_CODE } = ctx;

  // Fails at startup if a table the import replaces is missing from the list it owns.
  backupFormat.assertImportOwnershipComplete(db);

  // ledgerIndex.byCode() is read at call time: ledgerIndex.refresh() replaces it after a restore.
  const check = (data) => backupFormat.validateBackup(data, { liveLedgerByCode: ledgerIndex.byCode(), customCode: CUSTOM_CODE, parseIsoDate });

  app.get('/api/backup/export', auth, (req, res) => {
    const includeContacts = req.query.includeContacts === '1';
    const backup = backupFormat.buildBackup(db, { includeContacts });
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
      snapshot = await host.snapshot.writeJson(backupFormat.buildBackup(db, { includeContacts: true }));
    } catch (e) {
      logError('Backup snapshot failed:', e);
      return res.status(500).json({ error: 'Could not write the safety snapshot, so the import was aborted — your current data is unchanged.' });
    }

    // 3. Replace in one transaction. Any error rolls back: the current data is unchanged.
    let result;
    try {
      result = backupFormat.applyBackup(db, req.body);
    } catch (e) {
      logError('Backup import failed, rolled back:', e);
      if (isStorageFullError(e)) return res.status(500).json({ error: storageFull('the import did not go through.'), snapshot });
      return res.status(500).json({ error: 'The import failed and was rolled back — your current data is unchanged. The file may be internally inconsistent.', snapshot });
    }
    ledgerIndex.refresh(); // a v2 backup may have brought its own categories

    res.json({ ok: true, imported: result.imported, remappedUsers: result.remappedUsers, snapshot });
  });
}
