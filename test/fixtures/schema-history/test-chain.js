// A made-up chain of numbered upgrade steps (v3..v5) for the B4 tests, written twice: in the OLD step
// style (up(db), synchronous, as before B4) and the NEW one (async up(tx)). Both run the same SQL, so
// the old and new runners can be compared. failAt: that step does its writes, then throws.
'use strict';
const STEPS = [
  { version: 3, name: 'add cash_out.receipt_note', sql: [
    ["ALTER TABLE cash_out ADD COLUMN receipt_note TEXT NOT NULL DEFAULT ''"],
  ] },
  { version: 4, name: 'receipts table, one per live outflow', sql: [
    ['CREATE TABLE receipt (id INTEGER PRIMARY KEY AUTOINCREMENT, cash_out_id INTEGER NOT NULL REFERENCES cash_out(id), note TEXT NOT NULL)'],
    ["INSERT INTO receipt (cash_out_id, note) SELECT id, 'receipt for ' || id FROM cash_out WHERE deleted_at IS NULL ORDER BY id"],
  ] },
  { version: 5, name: 'mark outflows that have a receipt', sql: [
    ["UPDATE cash_out SET receipt_note = ? WHERE id IN (SELECT cash_out_id FROM receipt)", ['has a receipt — रसीद']],
    ["INSERT INTO settings (key, value) VALUES ('test_chain_marker', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ['5']],
  ] },
];

const failure = (v) => new Error(`test step v${v} failed on purpose`);

function chain({ style, failAt = null, upTo = 5 }) {
  return STEPS.filter((s) => s.version <= upTo).map((s) => ({
    version: s.version,
    name: s.name,
    up: style === 'sync'
      ? (db) => {
        for (const [sql, params] of s.sql) params ? db.prepare(sql).run(...params) : db.exec(sql);
        if (s.version === failAt) throw failure(s.version);
      }
      : async (tx) => {
        for (const [sql, params] of s.sql) params ? await tx.run(sql, params) : await tx.exec(sql);
        if (s.version === failAt) throw failure(s.version);
      },
  }));
}

module.exports = { chain, STEPS };
