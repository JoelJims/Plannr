// Cross-platform plan, step 1.3 — the in-memory copy of the ledger list (the categories), shared by
// both backends. It used to be two module-level variables in each copy (LEDGERS, LEDGER_BY_CODE)
// plus a refreshLedgers() function.
//
// The list is user-editable (CSV import on the Data Backup page) and a v2 backup restore can bring
// its own, so it is rebuilt on demand rather than frozen once at load. Read list() and byCode() at
// call time: refresh() replaces both after a category import or a restore.
//
// Step 1.4 B10: refresh() reads through the async database interface, so it returns a Promise and
// the index starts empty. Each backend runs the first refresh() as its request queue's first job
// (server.js, public/local-api.js), so no request can read the index before it is filled. Reading
// it before that first refresh() finished is a start-up bug, and throws rather than answering with
// no categories.

export function createLedgerIndex(repo) {
  let list = null;
  let byCode = null;
  const filled = (v) => {
    if (v === null) throw new Error('ledgerIndex: read before its first refresh() finished (see core/ledger-index.js).');
    return v;
  };
  async function refresh() {
    const next = await repo.ledgers.list();
    list = next;
    byCode = new Map(next.map((l) => [l.code, l]));
  }
  return {
    list: () => filled(list),     // every ledger, in display order
    byCode: () => filled(byCode), // Map: ledger code -> ledger
    refresh,
  };
}
