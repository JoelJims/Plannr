// Cross-platform plan, step 1.3 — the in-memory copy of the ledger list (the categories), shared by
// both backends. It used to be two module-level variables in each copy (LEDGERS, LEDGER_BY_CODE)
// plus a refreshLedgers() function.
//
// The list is user-editable (CSV import on the Data Backup page) and a v2 backup restore can bring
// its own, so it is rebuilt on demand rather than frozen once at load. Read list() and byCode() at
// call time: refresh() replaces both after a category import or a restore.

export function createLedgerIndex(repo) {
  let list = [];
  let byCode = new Map();
  function refresh() {
    list = repo.ledgers.list();
    byCode = new Map(list.map((l) => [l.code, l]));
  }
  refresh();
  return {
    list: () => list,     // every ledger, in display order
    byCode: () => byCode, // Map: ledger code -> ledger
    refresh,
  };
}
