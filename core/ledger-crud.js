// Cross-platform plan, step 1.3 — the shared list/add/edit/delete routes for the ledger tables
// (cash_in, cash_out, loans, contractor payments), plus Save All's batch route. The only copy:
// server.js and public/local-api.js both call createLedgerCrud(app, ctx) and register each table
// through the makeLedgerCrud it returns. See core/routes/people.js for what `app` and `ctx` are.
//
// Every behaviour that differs between tables (SQL, columns, validation, response keys, error text)
// comes in through opts, so each table's routes keep their exact paths, JSON shapes, status codes
// and messages.

import { SAVE_FAILED, STORAGE_FULL } from '../request-rules.js'; // Q11: "Couldn't save – try again." and the owner's storage-full text

// Save All's per-request row cap: a clear error instead of the body-size limit's. About 700 rows fit
// in the 256 KB batch body limit (request-rules.js); 500 is a comfortable ceiling for one ledger.
export const BATCH_MAX_ROWS = 500;

export function createLedgerCrud(app, ctx) {
  const { repo, transaction, auth, isStorageFullError, logError, parseLedgerFilters } = ctx;
  const LEDGER_CRUDS = {}; // table -> its repo.crud runners; the PDF's cash_out rows reuse them

  function makeLedgerCrud(opts) {
    const { basePath, table, select, listWhere, byIdWhere, shape, columns, validate, listKey, itemKey, notFoundMsg, invalidIdMsg, auditField, finalize, afterWrite, alias } = opts;
    // ALL SQL for this table is built by repo.crud. Handlers never touch the raw table.
    //  · finalize(values, { req, id, existing }): after validate, before the write; may change values
    //    and/or return { error, status } to reject (e.g. the one-service-one-offset 409 guard).
    //  · validate and finalize may be async; both are awaited (step 1.4 B11).
    //  · afterWrite(values, { req, id }): after a successful create/edit (e.g. save a custom name);
    //    awaited (step 1.4 B10: it may write through the async interface).
    //  · auditField: when an EDIT changes this raw column (by_user_id), log old -> new.
    const rc = repo.crud({ table, select, listWhere, byIdWhere, columns, alias: alias || '', searchCols: opts.searchCols || null });
    LEDGER_CRUDS[table] = rc;
    const orderedVals = (values) => columns.map((c) => values[c]); // column values in declared order

    app.get(basePath, auth, async (req, res) => {
      // When a table opts into search (cash_out), ?q/start/end/min/max/ledger/subledger filter the list
      // in SQL. No params: all live rows, as for every other table. `total` is the unfiltered live
      // count ("N of M", and the add form's next Sl.No, which must not shrink when a filter hides rows).
      if (opts.searchCols) {
        const f = parseLedgerFilters(req);
        if (f.error) return res.status(400).json({ error: f.error });
        const rows = await rc.search(f.filters);
        return res.json({ [listKey]: rows.map(shape), total: await rc.liveCount(), filtered: f.active });
      }
      res.json({ [listKey]: (await rc.list()).map(shape) });
    });

    app.post(basePath, auth, async (req, res) => {
      const v = await validate(req);
      if (v.error) return res.status(400).json({ error: v.error });
      if (finalize) { const f = await finalize(v.values, { req, id: null, existing: null }); if (f && f.error) return res.status(f.status || 400).json({ error: f.error }); }
      // Q14: the row and afterWrite's write (a custom name) are one transaction, so a failure in the
      // second leaves nothing saved and a retry cannot save the row twice.
      let info;
      await transaction(async () => {
        info = await rc.insert(orderedVals(v.values));
        if (afterWrite) await afterWrite(v.values, { req, id: Number(info.lastInsertRowid) });
      });
      res.status(201).json({ ok: true, [itemKey]: shape(await rc.getById(info.lastInsertRowid)) });
    });

    app.put(`${basePath}/:id`, auth, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || !(await rc.existsLive(id))) return res.status(404).json({ error: notFoundMsg });
      // The existing row, for the audit old value and finalize's `existing`.
      const existing = (finalize || afterWrite || auditField) ? await rc.fullRow(id) : null;
      const oldVal = auditField ? (existing ? existing[auditField] : undefined) : undefined;
      const v = await validate(req, oldVal);
      if (v.error) return res.status(400).json({ error: v.error });
      if (finalize) { const f = await finalize(v.values, { req, id, existing }); if (f && f.error) return res.status(f.status || 400).json({ error: f.error }); }
      if (auditField && oldVal !== v.values[auditField]) console.warn(`[audit] ${table} id=${id}: ${auditField} ${oldVal} -> ${v.values[auditField]} (attribution changed on edit)`);
      await transaction(async () => { // Q14: the edit and afterWrite's write together, or neither
        await rc.update(id, orderedVals(v.values));
        if (afterWrite) await afterWrite(v.values, { req, id });
      });
      res.json({ ok: true, [itemKey]: shape(await rc.getById(id)) });
    });

    app.delete(`${basePath}/:id`, auth, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: invalidIdMsg });
      const info = await rc.softDelete(id);
      if (info.changes === 0) return res.status(404).json({ error: notFoundMsg });
      res.json({ ok: true });
    });

    // Save All in ONE round trip, for tables that opt in (cash_out). Validates EVERY row first, then
    // writes only the valid rows in a single transaction, and answers per row, so "saved 19, held
    // back 1" survives: invalid or missing rows are left untouched and reported one by one. The
    // attribution audit line logs per changed by_user_id, and a stored NULL by_user_id round-trips
    // through validate(oldVal).
    if (opts.batch) {
      app.post(`${basePath}/batch`, auth, async (req, res) => {
        const rows = req.body && Array.isArray(req.body.rows) ? req.body.rows : null;
        if (!rows) return res.status(400).json({ error: 'Expected a { rows: [...] } array.' });
        if (rows.length > BATCH_MAX_ROWS) return res.status(413).json({ error: `Too many rows in one save (${rows.length}); the maximum is ${BATCH_MAX_ROWS}. Save in smaller batches.` });

        // 1) Validate every row before any write. Missing or invalid rows are recorded, not written.
        const results = new Array(rows.length);
        const toWrite = []; // { i, id, values, oldVal } for the rows that passed
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const id = Number(row && row.id);
          if (!Number.isInteger(id) || !(await rc.existsLive(id))) { results[i] = { id: row && row.id, ok: false, error: notFoundMsg }; continue; }
          const existing = (finalize || auditField) ? await rc.fullRow(id) : null;
          const oldVal = auditField ? (existing ? existing[auditField] : undefined) : undefined;
          const v = await validate({ body: row }, oldVal);
          if (v.error) { results[i] = { id, ok: false, error: v.error }; continue; }
          if (finalize) { const f = await finalize(v.values, { req, id, existing }); if (f && f.error) { results[i] = { id, ok: false, error: f.error }; continue; } }
          toWrite.push({ i, id, values: v.values, oldVal });
        }

        // 2) Write only the valid rows, in one transaction (db.js transaction(): any error rolls back
        //    every row and is passed on). repo's statements run on the same connection, inside it.
        try {
          await transaction(async () => {
            for (const w of toWrite) {
              await rc.update(w.id, orderedVals(w.values));
              if (afterWrite) await afterWrite(w.values, { req, id: w.id }); // Q14: inside the same transaction
            }
          });
        } catch (e) {
          logError(`${table} batch write failed, rolled back:`, e);
          if (isStorageFullError(e)) return res.status(500).json({ error: STORAGE_FULL });
          return res.status(500).json({ error: SAVE_FAILED }); // Q11: rolled back, so no row was changed
        }

        // 3) Audit each attribution change and shape the saved rows.
        for (const w of toWrite) {
          if (auditField && w.oldVal !== w.values[auditField]) console.warn(`[audit] ${table} id=${w.id}: ${auditField} ${w.oldVal} -> ${w.values[auditField]} (attribution changed on edit)`);
          results[w.i] = { id: w.id, ok: true, [itemKey]: shape(await rc.getById(w.id)) };
        }
        res.json({ results, saved: toWrite.length, failed: rows.length - toWrite.length });
      });
    }
  }

  return { makeLedgerCrud, LEDGER_CRUDS };
}
