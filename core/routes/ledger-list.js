// Cross-platform plan, step 1.3 — the ledger list (categories), its CSV, and the saved custom ledger
// names. The only copy: server.js and public/local-api.js both call register(app, ctx); see
// core/routes/people.js for what `app` and `ctx` are.
import { IMPORT_FAILED, STORAGE_FULL } from '../../request-rules.js';

export function register(app, ctx) {
  const { repo, auth, isStorageFullError, istDateStamp, ledgerIndex } = ctx;

  // Phase 10b — the ledger taxonomy itself (ledger_mains/ledger_subs), user-editable via CSV on the
  // Data Backup page. GET returns the current list for dropdowns; the CSV pair is export/import.
  // ledgerIndex.list() is read per request: refresh() replaces it after an import or a restore.
  app.get('/api/ledgers', auth, (req, res) => {
    res.json({ ledgers: ledgerIndex.list() });
  });
  // The phone ignores these headers (its pages name the file themselves); the dev server sends them.
  app.get('/api/ledgers/csv', auth, (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="plannr-ledger-list-${istDateStamp()}.csv"`);
    res.send(repo.ledgers.toCsv(ledgerIndex.list()));
  });
  // Validate fully -> replace in ONE transaction -> refresh the in-memory list. The pre-import
  // encrypted backup is sequenced by the page, which must call POST /api/backup/export-encrypted and
  // have it succeed before it calls this route: a real design choice for a single-user app, not
  // enforced here.
  app.post('/api/ledgers/csv', auth, async (req, res) => {
    const csvText = typeof req.body.csv === 'string' ? req.body.csv : '';
    if (!csvText.trim()) return res.status(400).json({ error: 'No CSV content received.' });
    const v = await repo.ledgers.validateImport(csvText);
    if (!v.ok) return res.status(400).json({ error: v.error, rowErrors: v.rowErrors });
    // Q11 wording: replaceAll is one transaction (repo.js ledgerReplaceAll), so a failure changed
    // nothing and gets the import text; the cause is logged, not shown.
    try {
      await repo.ledgers.replaceAll(v.mains, v.subs);
    } catch (e) {
      console.error('Ledger list import failed, rolled back:', e);
      return res.status(500).json({ error: isStorageFullError(e) ? STORAGE_FULL : IMPORT_FAILED });
    }
    await ledgerIndex.refresh();
    res.json({ ok: true, ledgers: ledgerIndex.list() });
  });

  // The saved custom LEDGER names, for the debit form's pick-list. Names are saved on first use
  // (cash_out's afterWrite). The 24 built-ins live in ledger_mains/ledger_subs, not here.
  app.get('/api/ledger-customs', auth, async (req, res) => {
    res.json({ customs: await repo.ledgerCustoms.list() });
  });
  // Remove a saved custom name (a typo like "Cemnt" used to be stuck in the list forever). Name in
  // ?name= so any characters survive encoding. Removing an absent name is a no-op 200. Past debits
  // keep their stored ledger_custom_name: this prunes the pick-list only, never rewrites history.
  app.delete('/api/ledger-customs', auth, async (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Which name? Pass it as ?name=…' });
    await repo.ledgerCustoms.remove(name);
    res.json({ ok: true, customs: await repo.ledgerCustoms.list() });
  });
}
