// Database setup for Plannr.
//
// Phase 4c: this file is an ES module and picks its SQLite engine at load time — node:sqlite under
// Node (synchronous, exactly as before; every existing `require('./db')` consumer keeps working with
// zero changes), or db-engine.js (the WASM/kvvfs adapter, Phase 4b) in a browser. Both engines expose
// the same DatabaseSync surface (Phase 4a's audit: new DatabaseSync(path[, opts]), .exec(),
// .prepare().get()/.all()/.run(), .close()) — that's what makes swapping the engine below safe.
//
// node:fs / node:path / node:sqlite are imported statically (named imports) so the Node path stays
// fully synchronous. A real browser can't resolve those three specifiers at all — whatever browser
// entry point eventually loads this file needs an import map mapping all three to
// node-builtins-browser-stub.js (see that file's header for the exact snippet). The code paths that
// would use the stubbed fs/path/DatabaseSync are never reached when isNode is false below.
//
// The browser path is async — db-engine.js's own WASM bootstrap is unconditionally async (see its
// header). `ready()` below is the seam: under Node it's a no-op (db is already open by the time this
// module finishes loading, synchronously, as today); under a browser it's what a caller MUST await
// before using `db`/`init` — see `ready()`'s own comment.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { LEDGERS as SEED_LEDGERS } from './ledgers.js';

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

const DATA_DIR = isNode ? join(import.meta.dirname, 'data') : '';
// Browser: DB_PATH is never used for anything real — db-engine.js's DatabaseSync ignores its `path`
// argument (kvvfs has exactly one persistent slot; see that file's header) — so any placeholder works.
export const DB_PATH = isNode ? (process.env.PLANNR_DB || join(DATA_DIR, 'plannr.db')) : 'plannr';

function openDb(EngineDatabaseSync) {
  const d = new EngineDatabaseSync(DB_PATH);
  // Phase 4a (WASM SQLite port prep): DELETE, not WAL. A WAL-stamped file cannot be opened at all by
  // the WASM SQLite build this app is moving to (confirmed empirically in Spike A2 — SQLITE_CANTOPEN;
  // no shared-memory/multi-process primitives in that sandbox). Single-process, single-user desktop/
  // mobile app has no concurrency need WAL was buying us anyway.
  d.exec('PRAGMA journal_mode = DELETE');
  d.exec('PRAGMA foreign_keys = ON'); // enforce foreign keys
  return d;
}

export let db;
let readyPromise = null;

if (isNode) {
  mkdirSync(DATA_DIR, { recursive: true }); // make sure the folder for the database file exists
  db = openDb(NodeDatabaseSync);
}

/**
 * Must be awaited before the first use of `db`/`init` in a browser. A no-op under Node — db is
 * already open by the time this module finishes loading (see above), so no existing Node consumer
 * (server.js, the test suite, reset-db.js, seed-demo.js) needs to call this.
 *
 * Note for whoever builds the browser entry point: repo.js prepares its cached statements against
 * `db` at ITS OWN module top level (eager, on import) — same as it always has. That means repo.js must
 * be imported (e.g. via a dynamic `import('./repo.js')`) only AFTER this `ready()` resolves, not just
 * before its functions are first called. repo.js's internals are unchanged from before this phase.
 */
export function ready() {
  if (db) return Promise.resolve();
  if (!readyPromise) {
    readyPromise = import('./db-engine.js').then(async (engine) => {
      await engine.ready();
      db = openDb(engine.DatabaseSync);
    });
  }
  return readyPromise;
}

// Schema-version marker: stamped at the END of init() once all migrations succeed. It lets a
// DESTRUCTIVE, presence-keyed migration be gated so it runs ONLY on a pre-marker DB and can never
// re-fire if the exact column shape it keys on recurs later — the failure mode where a rebuild keyed
// on "does column X exist?" wrongly re-runs after some later, unrelated change recreates column X, and
// a re-run of a create-copy-swap rebuild risks data. Bump this + gate the new step on
// `userVersion < N` when a future migration needs the same protection.
const SCHEMA_VERSION = 2; // v2 = Phase 2 Step 2a: the tenant_id dimension is dropped back off (see the
                          // `userVersion < 2` migration near the end of init()).

export function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL COLLATE NOCASE UNIQUE,
      display_name  TEXT    NOT NULL,
      password_hash TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Phase 8d: a fresh local/offline database has this table just-created and otherwise empty.
  // getOwner() (server.js and local-api.js both) assumes a row already exists — every server.js
  // deployment has had one since some now-removed registration step, long before this check existed,
  // so this is a no-op there. A brand-new Capacitor install has no such history, so seed exactly one
  // default owner the first time the table is empty.
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)')
      .run('owner', 'Owner', 'local-single-user-no-auth');
  }

  // Services phase — contract_services RETURNS (dropped in Phase 5C). If a PRE-Phase-5 database still
  // carries the OLD-shaped contract_services (detected by the absence of the new tenant_id column),
  // drop it HERE, BEFORE the ledger CREATE block below recreates it in the new shape — otherwise the
  // old table would shadow the new CREATE (IF NOT EXISTS). foreign_keys OFF because an ancient cash_out
  // may still carry the old contract_service_id FK into it (that FK is dropped by the Phase 5B rebuild
  // further down). No-op on the live/fresh DBs (contract_services absent, or already the new shape).
  //
  // BUG FIX: also version-gated (userVersion0 < 2, read fresh here since this runs before init()'s
  // main userVersion read further down). Absence of tenant_id alone is NOT a safe signal any more:
  // Step 2a (further below) deliberately drops tenant_id from contract_services once collapsed, and
  // without this gate, every boot after the first would misread that as "pre-Phase-5 shape", DROP the
  // table outright (losing every row), and recreate it empty WITH tenant_id — which then never gets
  // stripped again because Step 2a itself is version-gated and won't re-fire. Caught by booting the
  // real db.js against one persistent file across two separate processes (not a fresh temp DB each
  // time) — a second `contract_services` row silently vanished and tenant_id came back.
  {
    const userVersion0 = db.prepare('PRAGMA user_version').get().user_version;
    const cs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contract_services'").get();
    if (cs && userVersion0 < 2) {
      const hasTenant = db.prepare('PRAGMA table_info(contract_services)').all().some((c) => c.name === 'tenant_id');
      if (!hasTenant) {
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('DROP INDEX IF EXISTS idx_cash_out_contract_service_id');
        db.exec('DROP TABLE contract_services');
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Ledger / cost-tracking tables. Each has a live UI page and API routes (Overview,
  // Money Debited, Cash Inflow, Loans, Contract Details, Contractor Payments, Data Backup).
  //
  // MONEY: every *_paise column below stores an INTEGER number of paise
  // (₹1 = 100 paise). Money is NEVER stored as a float — integer paise avoids
  // float-rounding bugs. (Formatting to ₹ is a later display concern.)
  //
  // Transactional tables carry a nullable `deleted_at TEXT` for soft-delete
  // (NULL = live row). All statements are IF NOT EXISTS, so this is safe to run
  // against an existing database — users/sessions and their data are untouched.
  // ---------------------------------------------------------------------------
  db.exec(`
    -- 1. contract: EXACTLY ONE live contract (Phase 5D). At most one row with deleted_at IS NULL
    --    is allowed — enforced in the DATABASE by the partial unique index idx_contract_single_live
    --    (created at the end of init), not by app code. Soft-deleted rows may coexist with the one
    --    live row (the Recycle Bin). The old multi-contract list and the per-contract
    --    contract_services table were both removed in Phase 5 (contract_services dropped child-first
    --    after cash_out lost its FK). price_of_contract_paise is the REQUIRED stated amount that dues
    --    math starts from; contract_end_date is the optional "date ends". ledger_* is a HEADLINE
    --    CATEGORY tag for the whole contract.
    CREATE TABLE IF NOT EXISTS contract (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      contractor_name         TEXT,
      area_of_work            TEXT,             -- Phase 2: required on new writes
      ledger_code             TEXT,             -- headline category: fixed code (e.g. '5.0'), 'CUSTOM', or NULL
      subledger_code          TEXT,             -- fixed sub code, 'CUSTOM', or NULL (none)
      ledger_custom_name      TEXT,             -- typed ledger name when ledger_code = 'CUSTOM'
      subledger_custom_name   TEXT,             -- typed sub-ledger name when subledger_code = 'CUSTOM'
      amount_paise            INTEGER,          -- OPTIONAL free-form amount, paise (₹1=100) or NULL
      price_of_contract_paise INTEGER,          -- REQUIRED stated amount, paise (dues math starts here)
      contract_end_date       TEXT,             -- OPTIONAL 'date ends', ISO 'YYYY-MM-DD' or NULL
      date_signed             TEXT,             -- Phase 2: required, ISO 'YYYY-MM-DD'
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at              TEXT,             -- soft-delete: NULL = live
      tenant_id               INTEGER NOT NULL REFERENCES users(id), -- Tenancy Phase 2: owning household (a users.id)
      company                 TEXT              -- Services phase (Part F): OPTIONAL company/firm; presentation only, never in dues math
    );

    -- 1b. contract_payment_dates: a contract's SCHEDULED payment dates (0..many). The live
    --     Contractor Payments page offers these as the date-of-payment dropdown for a payment.
    --     Hard-cascades if a contract row is ever hard-deleted (contracts are soft-deleted in
    --     practice, so it persists).
    CREATE TABLE IF NOT EXISTS contract_payment_dates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
      pay_date    TEXT    NOT NULL,             -- ISO 'YYYY-MM-DD' scheduled payment date
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      tenant_id   INTEGER NOT NULL REFERENCES users(id) -- Tenancy Phase 2: owning household (mirrors the parent contract's tenant)
    );

    -- 2b. contractor_payments: money PAID to a contractor, tied to a specific
    --     contract (Phase 3). Replaces the old design where contractor spend was a
    --     cash_out row (removed in Phase 1). Ledger fields are an OPTIONAL DISPLAY tag (same
    --     'CUSTOM' convention as cash_out) and do NOT drive dues math — CONFIRMED still true under
    --     Option C: owed = stated − Σ amount_paise (payments) − Σ cash_out.contract_stated_paise
    --     (the reimbursement offset). A payment's ledger tag only feeds the pie/Spending-by-Ledger
    --     rollup, never the owed balance.
    CREATE TABLE IF NOT EXISTS contractor_payments (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id           INTEGER NOT NULL REFERENCES contract(id), -- required parent contract
      pay_date              TEXT    NOT NULL,   -- ISO 'YYYY-MM-DD' date of payment
      amount_paise          INTEGER NOT NULL,   -- paise (₹1=100); amount paid, > 0
      ledger_code           TEXT,               -- OPTIONAL tag: fixed code, 'CUSTOM', or NULL
      subledger_code        TEXT,               -- fixed sub code, 'CUSTOM', or NULL
      ledger_custom_name    TEXT,               -- typed ledger name when ledger_code = 'CUSTOM'
      subledger_custom_name TEXT,               -- typed sub name when subledger_code = 'CUSTOM'
      phase                 INTEGER,            -- OPTIONAL positive whole number (>=1)
      subpart               TEXT,               -- OPTIONAL single lowercase letter a-z
      remarks               TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at            TEXT,               -- soft-delete: NULL = live
      tenant_id             INTEGER NOT NULL REFERENCES users(id) -- Tenancy Phase 2: owning household (a users.id)
    );

    -- 2c. contract_services: a contract's line-item services (Services phase, Part A). RETURNS after
    --     Phase 5 dropped it, but NOT as a second offset mechanism: its ONLY job is to supply the
    --     number that goes in cash_out.contract_stated_paise (the Option C reimbursement offset). A
    --     service is a NAME and an OPTIONAL price. Services need NOT sum to the contract total —
    --     price_of_contract_paise stays the single source of truth for owed; services are informational
    --     (the remainder line, Part B) and a pick-list for the debit form (Part C). Soft-delete.
    --     Hard-cascades if the parent contract is ever hard-deleted (contracts are soft-deleted in
    --     practice). Only PRICED, live services can be linked from a debit.
    CREATE TABLE IF NOT EXISTS contract_services (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,             -- service name (required)
      price_paise INTEGER,                      -- OPTIONAL price, paise (₹1=100); NULL = unpriced (can't be picked on a debit)
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at  TEXT,                         -- soft-delete: NULL = live
      tenant_id   INTEGER NOT NULL REFERENCES users(id) -- Services phase: owning household (mirrors the parent contract's tenant)
    );

    -- 3. cash_in: money credited / cash inflow. (Sl.No is NOT stored — it is a
    --    display row number derived from ordering at query time.)
    CREATE TABLE IF NOT EXISTS cash_in (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise INTEGER NOT NULL,            -- paise (₹1=100)
      tx_date      TEXT,                         -- Phase 4C: user-chosen inflow date, ISO 'YYYY-MM-DD' (mirrors cash_out.tx_date; required on new writes)
      by_type      TEXT    NOT NULL,            -- 'user' | 'relative' | 'custom'
      by_user_id   INTEGER REFERENCES users(id),-- set when by_type='user'
      by_label     TEXT,                        -- custom/relative display text when not a user
      reason       TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at   TEXT,                        -- soft-delete: NULL = live
      tenant_id    INTEGER NOT NULL REFERENCES users(id) -- Tenancy Phase 2: owning household (a users.id)
    );

    -- 4. cash_out: money debited / cash outflow. Carries an Included/Extra
    --    contract_scope tag.
    CREATE TABLE IF NOT EXISTS cash_out (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise        INTEGER NOT NULL,      -- paise (₹1=100); actual amount spent
      tx_date             TEXT,                  -- user-chosen transaction date, ISO 'YYYY-MM-DD' (required on new writes; see Phase 1)
      by_type             TEXT    NOT NULL,      -- 'user' | 'custom' (legacy 'contractor' possible but NO LONGER WRITTEN; verified 0 in the live DB — all 11 rows are 'user')
      by_user_id          INTEGER REFERENCES users(id),
      by_label            TEXT,
      ledger_code         TEXT    NOT NULL,      -- e.g. '4.2' (fixed 23-ledger list), or 'CUSTOM'
      subledger_code      TEXT,                  -- fixed sub code, 'CUSTOM', or NULL (none)
      ledger_custom_name    TEXT,                -- typed ledger name when ledger_code = 'CUSTOM'
      subledger_custom_name TEXT,                -- typed sub-ledger name when subledger_code = 'CUSTOM'
      reason              TEXT,
      contract_scope      TEXT    NOT NULL,      -- 'included' | 'extra'
      contract_stated_paise INTEGER,             -- Phase 5E (Option C): when contract_scope='included',
                                                 -- the contract's STATED amount for this item (paise) — the
                                                 -- reimbursement offset against dues. NULL when 'extra'.
      phase               INTEGER,               -- OPTIONAL: a positive whole number (>=1), or NULL
      subpart             TEXT,                  -- OPTIONAL: a single lowercase letter a-z, or NULL
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at          TEXT,                  -- soft-delete: NULL = live
      tenant_id           INTEGER NOT NULL REFERENCES users(id), -- Tenancy Phase 2: owning household (a users.id)
      -- Services phase (Part C/D): the contract_services row this debit's contract_stated_paise was
      -- sourced from — provenance, and the key for the ONE-SERVICE-ONE-OFFSET guard. NULL when the
      -- debit is 'extra' or the stated amount was typed manually. A partial UNIQUE index
      -- (idx_cash_out_service_live, WHERE deleted_at IS NULL) enforces that at most one LIVE debit
      -- links any given service, so a single substitution can never offset dues twice.
      contract_service_id INTEGER REFERENCES contract_services(id)
    );

    -- 5. loans: one-time loan record. NO EMI/repayment logic. interest_rate is INFORMATIONAL only
    --    (drives no calculation). Interest actually PAID is recorded as an ordinary cash_out row under
    --    ledger 22.0, sub-ledger 22.5 (Loan interest) — see ledger_mains/ledger_subs — so it counts in spend.
    CREATE TABLE IF NOT EXISTS loans (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise  INTEGER,                     -- paise (₹1=100)
      bank_name     TEXT,
      interest_rate REAL,                        -- annual percentage rate (a rate, not money); informational
      tenure        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at    TEXT,                        -- soft-delete: NULL = live
      tenant_id     INTEGER NOT NULL REFERENCES users(id) -- Tenancy Phase 2: owning household (a users.id)
    );

    -- 6. settings: a tiny key/value store for app-wide options (currently just
    --    the optional overall budget). Least-intrusive place for a single value;
    --    NULL value = unset. Safe to run against an existing DB (IF NOT EXISTS).
    CREATE TABLE IF NOT EXISTS settings (
      -- Per-tenant key/value via a COMPOSITE primary key. tenant_id is a scoping integer (a users.id;
      -- 0 is RESERVED for global, non-account rows). Deliberately NO foreign key: settings is a config
      -- store; the global sentinel (0) has no user row, and a setting must survive account deletion
      -- without an orphan-FK error. COMPOSITE key rather than NAMESPACED keys so a value can still be
      -- read by key ALONE (WHERE key = ?) with no tenant filter; namespacing would bury the tenant
      -- inside the key and force every read to become tenant-aware. Writes UPSERT on (tenant_id, key).
      tenant_id INTEGER NOT NULL,
      key       TEXT    NOT NULL,
      value     TEXT,
      PRIMARY KEY (tenant_id, key)
    );

    -- 6b. ledger_customs: a PER-USER saved list of custom ledger names (Services phase, Part E).
    --     ledger_custom_name on a cash_out row is free text, so customs were never reusable; this
    --     makes a typed name selectable again after first use. Unlike the household ledger tables,
    --     this list is genuinely PER-USER and its read endpoint IS filtered by the caller (a personal
    --     pick-list, not shared household data) — so it does not leak in the isolation harness.
    CREATE TABLE IF NOT EXISTS ledger_customs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES users(id), -- the owning user (per-user list)
      name       TEXT    NOT NULL,                       -- the custom ledger name
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 6c. ledger_mains / ledger_subs (Phase 10b): the fixed ledger taxonomy, now user-editable via
    --     CSV export/import on the Data Backup page instead of hardcoded in ledgers.js. "code" IS the
    --     identity (no separate internal id) — a row's code is what cash_out/contract/
    --     contractor_payments store and what a re-import matches against, so a rename (same code, new
    --     name) never orphans historical spend. sort_order preserves display/CSV-export order
    --     (defaults to seed/import order; not alphabetical). ledgers.js now supplies only the SEED
    --     rows inserted below the first time this table is empty — see init()'s seeding step and that
    --     file's own header.
    CREATE TABLE IF NOT EXISTS ledger_mains (
      code       TEXT PRIMARY KEY,
      name       TEXT    NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ledger_subs (
      code       TEXT PRIMARY KEY,
      main_code  TEXT NOT NULL REFERENCES ledger_mains(code),
      name       TEXT    NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_subs_main_code ON ledger_subs(main_code);

    -- Indexes later phases will need (minimal + sensible).
    CREATE INDEX IF NOT EXISTS idx_cash_out_ledger_code         ON cash_out(ledger_code);
    CREATE INDEX IF NOT EXISTS idx_cash_in_by_user_id           ON cash_in(by_user_id);
    -- Phase 6C: idx_cash_{out,in}_deleted_at were REMOVED. deleted_at is NULL for ~every row, so
    -- an index on it is non-selective (can't narrow WHERE deleted_at IS NULL) — and worse, the
    -- planner CHOSE idx_cash_out_deleted_at over the effective idx_cash_out_txdate_live for the
    -- range query, degrading it to a full deleted_at search + tx_date scan (proved by EXPLAIN).
    -- Dropping them lets the range query use the partial date index; the list queries full-scan,
    -- which is correct (they read every live row anyway). The DROP for existing DBs is at init end.
    CREATE INDEX IF NOT EXISTS idx_contract_payment_dates_cid   ON contract_payment_dates(contract_id);
    CREATE INDEX IF NOT EXISTS idx_contractor_payments_cid      ON contractor_payments(contract_id);
    -- Services phase: FK lookup for a contract's services, and a per-user uniqueness guard so the
    -- saved custom-name list never stores a duplicate for the same user.
    CREATE INDEX IF NOT EXISTS idx_contract_services_cid         ON contract_services(contract_id);
    -- idx_ledger_customs_name (name-only, post-collapse) is created unconditionally inside the
    -- Step 2a migration below — never here, so a second boot never tries to recreate the OLD
    -- (tenant_id, name) index against a column that Step 2a has already dropped.
    -- Phase 6C partial date indexes (idx_cash_out_txdate_live / _paydate_live) and the Services-phase
    -- idx_cash_out_service_live are created at the END of init() (after the cash_out rebuild + the
    -- contract_service_id ADD COLUMN), so a rebuild can't drop them and the column always exists first.
  `);

  // Phase 10b — seed ledger_mains/ledger_subs from ledgers.js the first time they're empty (a fresh
  // install, or an upgrade from a pre-10b database). Presence-keyed, not version-gated: once a
  // household has edited the taxonomy via CSV import, the table is never empty again, so this can
  // never re-fire and stomp an edit — it only ever runs once, on a genuinely empty table.
  if (!db.prepare('SELECT 1 FROM ledger_mains LIMIT 1').get()) {
    const insMain = db.prepare('INSERT INTO ledger_mains (code, name, sort_order) VALUES (?, ?, ?)');
    const insSub = db.prepare('INSERT INTO ledger_subs (code, main_code, name, sort_order) VALUES (?, ?, ?, ?)');
    // Phase 12: these ~190 inserts were each their own autocommit transaction (a journal
    // create/fsync/delete per row under DELETE journal mode) — 0.5-1.1s on a fresh install, the very
    // first thing a new user waits on. One transaction for the whole seed: same rows, same order, same
    // end state, ~7-12ms instead.
    db.exec('BEGIN');
    try {
      let order = 0;
      for (const L of SEED_LEDGERS) {
        insMain.run(L.code, L.name, order++);
        for (const s of L.subLedgers) insSub.run(s.code, L.code, s.name, order++);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // Idempotent migration: add the custom ledger/sub-ledger name columns to
  // cash_out for databases created before they existed (fresh DBs already have
  // them from the CREATE above). ALTER ADD COLUMN appends a nullable TEXT column;
  // existing rows get NULL — no data is altered.
  const cashOutCols = db.prepare('PRAGMA table_info(cash_out)').all().map((c) => c.name);
  for (const col of ['ledger_custom_name', 'subledger_custom_name']) {
    if (!cashOutCols.includes(col)) db.exec(`ALTER TABLE cash_out ADD COLUMN ${col} TEXT`);
  }

  // Idempotent migration: add contract_end_date to contract for databases
  // created before it existed (fresh DBs already have it from the CREATE above).
  // Nullable TEXT; existing rows get NULL — no data is altered.
  const contractCols = db.prepare('PRAGMA table_info(contract)').all().map((c) => c.name);
  if (!contractCols.includes('contract_end_date')) {
    db.exec('ALTER TABLE contract ADD COLUMN contract_end_date TEXT');
  }

  // Idempotent migration (Phase 2): contract becomes a multi-row list — add the new
  // per-contract columns + soft-delete. ALTER ADD COLUMN appends nullable columns;
  // existing rows get NULL (the DB is empty at this phase, so there is no data to
  // lose; this also stays correct for a pre-existing single-contract row).
  // SHAPE DETECTED: "column absent" ⇒ "add it". This is presence-keyed like the guards above, but
  // ADDITIVE-ONLY — the worst a wrong-fire can do is skip or add a NULL column; it can never drop or
  // overwrite. So, unlike the destructive cash_out rebuild, it stays safe as a pure presence key and
  // deliberately needs NO version gate (a legitimately re-absent column SHOULD be re-added).
  const contractColsP2 = db.prepare('PRAGMA table_info(contract)').all().map((c) => c.name);
  for (const [col, type] of [
    ['area_of_work', 'TEXT'], ['ledger_code', 'TEXT'], ['subledger_code', 'TEXT'],
    ['ledger_custom_name', 'TEXT'], ['subledger_custom_name', 'TEXT'],
    ['amount_paise', 'INTEGER'], ['date_signed', 'TEXT'], ['deleted_at', 'TEXT'],
  ]) {
    if (!contractColsP2.includes(col)) db.exec(`ALTER TABLE contract ADD COLUMN ${col} ${type}`);
  }

  // Migration: cash_out phase/subpart are SIMPLE SCALARS — phase is a positive whole
  // number (INTEGER >=1 or NULL) and subpart is a single lowercase letter (TEXT
  // 'a'..'z' or NULL). An EARLIER version stored them as a '1'..'4' / 'a'..'c' + 'CUSTOM'
  // sentinel design with phase_custom_name / subpart_custom_name columns. If that old
  // shape is present (detected by phase_custom_name), rebuild cash_out to the new shape:
  // SQLite can't retype or drop columns in place, so use the standard create-copy-swap
  // rebuild inside a transaction — preserving every OTHER column, id, foreign key and
  // soft-delete state EXACTLY, and mapping any value that doesn't fit the new rule
  // (e.g. 'CUSTOM', a non-integer, or a multi-char subpart) to NULL. Fresh DBs already
  // have the final shape from the CREATE above. STORED ONLY: a POSSIBLE future Overview
  // "by phase" view could group on them — they never affect any Overview total.
  // UNAMBIGUOUS GUARD (Phase 11B): presence of phase_custom_name ALONE is NOT a safe key — if that
  // column were ever re-added for a new purpose this DESTRUCTIVE rebuild would re-fire and null live
  // data (exactly the Phase-5B landmine, where a re-added contract_service_id re-armed a presence-only
  // guard). So it is ALSO gated on the schema-version marker: the rebuild runs ONLY on a DB that
  // predates the marker (user_version 0). init() stamps user_version = SCHEMA_VERSION on success, so
  // no later re-add of the column can re-trigger it. Read the marker BEFORE any migration changes it.
  const userVersion = db.prepare('PRAGMA user_version').get().user_version;
  const coCols = db.prepare('PRAGMA table_info(cash_out)').all().map((c) => c.name);
  if (userVersion === 0 && (coCols.includes('phase_custom_name') || coCols.includes('subpart_custom_name'))) {
    db.exec('PRAGMA foreign_keys = OFF'); // standard rebuild guard (nothing references cash_out anyway)
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE cash_out_rebuild (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        amount_paise        INTEGER NOT NULL,
        by_type             TEXT    NOT NULL,
        by_user_id          INTEGER REFERENCES users(id),
        by_label            TEXT,
        ledger_code         TEXT    NOT NULL,
        subledger_code      TEXT,
        ledger_custom_name    TEXT,
        subledger_custom_name TEXT,
        reason              TEXT,
        contract_scope      TEXT    NOT NULL,
        phase               INTEGER,
        subpart             TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at          TEXT
      )`);
      db.exec(`INSERT INTO cash_out_rebuild
        (id, amount_paise, by_type, by_user_id, by_label, ledger_code, subledger_code,
         ledger_custom_name, subledger_custom_name, reason, contract_scope,
         phase, subpart, created_at, updated_at, deleted_at)
        SELECT id, amount_paise, by_type, by_user_id, by_label, ledger_code, subledger_code,
               ledger_custom_name, subledger_custom_name, reason, contract_scope,
               CASE WHEN phase GLOB '[1-9]*' AND phase NOT GLOB '*[^0-9]*' THEN CAST(phase AS INTEGER) ELSE NULL END,
               CASE WHEN subpart GLOB '[A-Za-z]' THEN lower(subpart) ELSE NULL END,
               created_at, updated_at, deleted_at
          FROM cash_out`);
      db.exec('DROP TABLE cash_out');
      db.exec('ALTER TABLE cash_out_rebuild RENAME TO cash_out');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    db.exec('PRAGMA foreign_keys = ON');
    // The old table's indexes went with it on DROP; recreate the ledger one (Phase 6C dropped the
    // useless deleted_at index — not recreated here; the tx_date partial index is made below).
    db.exec('CREATE INDEX IF NOT EXISTS idx_cash_out_ledger_code         ON cash_out(ledger_code)');
  } else {
    // Fresh or already-migrated DB: just ensure the two scalar columns exist.
    if (!coCols.includes('phase')) db.exec('ALTER TABLE cash_out ADD COLUMN phase INTEGER');
    if (!coCols.includes('subpart')) db.exec('ALTER TABLE cash_out ADD COLUMN subpart TEXT');
  }

  // Idempotent migration (Phase 1): cash_out gains tx_date — the user-chosen
  // transaction date, ISO 'YYYY-MM-DD'. New writes REQUIRE it. Existing rows are
  // backfilled from their created_at calendar date so no live row is left dateless
  // (a valid, sensible date rather than NULL). Run LAST so a table rebuilt above
  // (old phase_custom_name shape) also picks up the column. No data is altered.
  const coDateCols = db.prepare('PRAGMA table_info(cash_out)').all().map((c) => c.name);
  if (!coDateCols.includes('tx_date')) {
    db.exec('ALTER TABLE cash_out ADD COLUMN tx_date TEXT');
    db.exec("UPDATE cash_out SET tx_date = date(created_at) WHERE tx_date IS NULL");
  }

  // Idempotent migration (Phase 4C): cash_in gains tx_date — inflows were undateable before. Same
  // shape/backfill as cash_out's above: ADD COLUMN (a metadata-only op — NO table rebuild, so no
  // PRAGMA foreign_keys toggling is needed), then backfill existing rows from date(created_at) so no
  // live row is left dateless. Guarded on the column's absence, so it no-ops on fresh installs (whose
  // CREATE already has it) and on a second boot. New writes REQUIRE tx_date (validated in server.js).
  const ciDateCols = db.prepare('PRAGMA table_info(cash_in)').all().map((c) => c.name);
  if (!ciDateCols.includes('tx_date')) {
    db.exec('ALTER TABLE cash_in ADD COLUMN tx_date TEXT');
    db.exec("UPDATE cash_in SET tx_date = date(created_at) WHERE tx_date IS NULL");
  }

  // -------------------------------------------------------------------------
  // Phase 5B — rebuild cash_out ONCE: drop the two dead columns (the OLD contract_service_id + its FK
  // to the OLD contract_services, and units_covered — both verified 0 non-null across the live 11 rows)
  // and add contract_stated_paise (Option C reimbursement offset). SQLite can't drop a column with a
  // foreign key in place, so use the create-copy-swap rebuild, preserving id, every kept column,
  // and soft-delete state EXACTLY.
  //
  // Services phase FIX: the Services phase RE-ADDS a (new-meaning) contract_service_id AFTER this
  // block. So `contract_service_id present` alone is NO LONGER a valid guard — it would re-fire here
  // every reboot and DROP the new column. The unambiguous OLD-shape signal is `contract_service_id
  // present AND contract_stated_paise ABSENT` (the whole point of 5B was to ADD contract_stated_paise;
  // if it's already there, 5B has run). The new shape has BOTH columns, so this stays false for it.
  const coColsP5 = db.prepare('PRAGMA table_info(cash_out)').all().map((c) => c.name);
  if (coColsP5.includes('contract_service_id') && !coColsP5.includes('contract_stated_paise')) {
    // PRAGMA foreign_keys is a NO-OP inside a transaction — set it BEFORE BEGIN, restore AFTER
    // COMMIT, and read it back to prove enforcement is actually off (Phase 4B's trap).
    // Preserve the AUTOINCREMENT high-water mark. create-copy-swap re-inserts ids 1..MAX(id) into a
    // NEW table, so its sqlite_sequence becomes MAX(id) — which RESETS the counter if rows past the
    // current max were ever created and deleted (e.g. the live DB has seq=17 with max id 11). Left
    // unfixed, new rows would REUSE deleted ids 12..17. Capture the old high-water mark and restore
    // it after the swap so the next insert always lands strictly past the highest id ever used.
    const oldSeqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'cash_out'").get();
    const oldSeq = oldSeqRow ? oldSeqRow.seq : null;
    db.exec('PRAGMA foreign_keys = OFF');
    const fkOff = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
    if (fkOff !== 0) throw new Error(`cash_out rebuild: foreign_keys still ${fkOff} after OFF — aborting to avoid an FK-blocked partial rebuild.`);
    db.exec('BEGIN');
    try {
      // Final shape = the current base CREATE above, minus contract_service_id + units_covered,
      // plus contract_stated_paise. Same column order as the CREATE so fresh == migrated.
      db.exec(`CREATE TABLE cash_out_p5 (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        amount_paise          INTEGER NOT NULL,
        tx_date               TEXT,
        by_type               TEXT    NOT NULL,
        by_user_id            INTEGER REFERENCES users(id),
        by_label              TEXT,
        ledger_code           TEXT    NOT NULL,
        subledger_code        TEXT,
        ledger_custom_name    TEXT,
        subledger_custom_name TEXT,
        reason                TEXT,
        contract_scope        TEXT    NOT NULL,
        contract_stated_paise INTEGER,
        phase                 INTEGER,
        subpart               TEXT,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at            TEXT
      )`);
      // Explicit column lists (never SELECT *). Copy id explicitly to preserve row ids (1–11).
      // contract_service_id + units_covered are simply not selected (dropped); contract_stated_paise
      // starts NULL. phase + subpart carried through unchanged (deliberately dormant — not swept here).
      db.exec(`INSERT INTO cash_out_p5
        (id, amount_paise, tx_date, by_type, by_user_id, by_label, ledger_code, subledger_code,
         ledger_custom_name, subledger_custom_name, reason, contract_scope, contract_stated_paise,
         phase, subpart, created_at, updated_at, deleted_at)
        SELECT id, amount_paise, tx_date, by_type, by_user_id, by_label, ledger_code, subledger_code,
               ledger_custom_name, subledger_custom_name, reason, contract_scope, NULL,
               phase, subpart, created_at, updated_at, deleted_at
          FROM cash_out`);
      db.exec('DROP TABLE cash_out');
      db.exec('ALTER TABLE cash_out_p5 RENAME TO cash_out');
      // Restore the AUTOINCREMENT high-water mark (see note above) so ids are never reused.
      db.exec("DELETE FROM sqlite_sequence WHERE name = 'cash_out'");
      if (oldSeq != null) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('cash_out', ?)").run(oldSeq);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
      throw e;
    }
    db.exec('PRAGMA foreign_keys = ON');
    // The dropped table took its indexes with it. Recreate the ledger one; NOT
    // idx_cash_out_contract_service_id (column gone) and NOT idx_cash_out_deleted_at (Phase 6C
    // dropped it as counter-productive). The tx_date partial index is (re)created at init end.
    // (sqlite_sequence was restored to its pre-rebuild high-water mark inside the transaction above.)
    db.exec('CREATE INDEX IF NOT EXISTS idx_cash_out_ledger_code ON cash_out(ledger_code)');
    const fkViol = db.prepare('PRAGMA foreign_key_check').all();
    if (fkViol.length) throw new Error('cash_out rebuild: foreign_key_check found ' + JSON.stringify(fkViol));
  } else if (!coColsP5.includes('contract_stated_paise')) {
    // Already lost the dead columns (e.g. a phase_custom_name-era DB rebuilt above) but predates
    // contract_stated_paise — just add the nullable column. No data altered.
    db.exec('ALTER TABLE cash_out ADD COLUMN contract_stated_paise INTEGER');
  }

  // -------------------------------------------------------------------------
  // Phase 5C — the old contract_services was dropped here. The Services phase RE-INTRODUCES
  // contract_services (new shape), so the unconditional drop is GONE; the conditional old-shape drop
  // moved ABOVE the ledger CREATE block (see "Services phase — contract_services RETURNS"). The old
  // child index drop is kept (harmless if it lingers on an ancient DB).
  db.exec('DROP INDEX IF EXISTS idx_cash_out_contract_service_id');

  // ===========================================================================
  // Tenancy Phase 2 (Part A) — add the tenant dimension. SCHEMA + BACKFILL ONLY: no read/write
  // filter is applied here (that is Phase 3). Model: one account per household, so tenant_id holds a
  // users.id. Named tenant_id (never user_id) so real multi-person households later become a table +
  // backfill, not a rename across ~90 call sites.
  //
  // MECHANISM (verified empirically against node:sqlite): `ALTER TABLE ADD COLUMN tenant_id INTEGER
  // NOT NULL` with NO default is REJECTED on a NON-EMPTY table ("Cannot add a NOT NULL column with
  // default value NULL") but ALLOWED on an EMPTY one. So per table: EMPTY -> ADD COLUMN NOT NULL
  // (cheap, no rebuild, sqlite_sequence untouched); NON-EMPTY -> a forced create-copy-swap rebuild
  // that backfills tenant_id in the INSERT..SELECT and PRESERVES sqlite_sequence. A DEFAULT is
  // deliberately REFUSED: a default silently assigns any future insert that forgets tenant_id to the
  // wrong tenant; NOT NULL with no default makes that a hard error instead. In the live DB only
  // cash_out is non-empty (11 rows, sqlite_sequence=17 with max id 11 — a naive rebuild would reset
  // it to 11 and let new rows REUSE deleted ids 12..17), so exactly one table takes the rebuild path.
  // ---------------------------------------------------------------------------
  // Part D — the tenant every existing row would be assigned to, IF this migration runs at all.
  // Computed unconditionally (cheap, read-only) because Step 2a further below also needs it.
  const tenantUsers = db.prepare('SELECT id FROM users ORDER BY id ASC').all().map((u) => u.id);
  const chosenTenant = tenantUsers.length ? tenantUsers[0] : null;

  // BUG FIX: this whole block (Parts A/B/C — add tenant_id, the per-tenant settings PK, the
  // per-tenant contract index) used to be gated ONLY on column presence ("tenant_id is absent ->
  // add it"). That is unsafe now that Step 2a (further below) deliberately DROPS tenant_id: on the
  // very next boot, presence-gating can't tell "genuinely pre-tenancy" apart from "already
  // collapsed" — it saw the column missing, decided the DB was pre-tenancy, and tried to add it
  // back (and/or recreate an index against it), which is wrong at best and throws at worst. Traced
  // both paths: a pre-tenancy DB is at user_version 0 (< 2) — this block runs, exactly as before,
  // and Step 2a's block immediately after collapses it back down in the SAME boot. A collapsed DB
  // is at user_version 2 (>= 2) — this block is now skipped ENTIRELY, so nothing re-adds tenant_id
  // and nothing tries to build an index against a column that no longer exists.
  if (userVersion < 2) {
    const TENANT_TABLES = ['cash_out', 'cash_in', 'loans', 'contract', 'contract_payment_dates', 'contractor_payments'];
    const rowsNeedingTenant = TENANT_TABLES.filter((t) => {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      return !cols.includes('tenant_id') && db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n > 0;
    });
    if (rowsNeedingTenant.length && chosenTenant == null) {
      throw new Error(`Tenancy Phase 2: tables [${rowsNeedingTenant.join(', ')}] hold rows but there are NO users to own them — refusing to backfill tenant_id to a non-existent user (the FK would fail). Register the household user first, then reboot.`);
    }
    if (rowsNeedingTenant.length && tenantUsers.length > 1) {
      console.warn(`[db] Tenancy Phase 2: ${tenantUsers.length} users share this ledger and it cannot be split — assigning the ENTIRE database to tenant_id=${chosenTenant} (the lowest/first user id). Other users (${tenantUsers.slice(1).join(', ')}) keep their logins but own no ledger rows. This is the documented single-tenant collapse; see README "Tenancy".`);
    }

    // create-copy-swap: rebuild `table` with a trailing NOT NULL tenant_id, backfilling every row to
    // `tenant`. Preserves ids, sqlite_sequence, the table's own indexes, and FK integrity. Reuses the
    // table's CURRENT DDL (comments stripped) so there is no second copy of each schema to drift.
    const rebuildAddingTenant = (table, oldCols, tenant) => {
      const seqRow = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table);
      const oldSeq = seqRow ? seqRow.seq : null;                        // AUTOINCREMENT high-water mark
      const idxDdls = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL").all(table); // DROP TABLE takes indexes with it
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table).sql.replace(/--[^\n]*/g, ''); // strip line comments so the paren scan is safe
      const body = ddl.slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'));
      const tmp = `${table}__tenant_rebuild`;
      // PRAGMA foreign_keys is a NO-OP inside a transaction — set it BEFORE BEGIN, read it back to
      // PROVE enforcement is off (this project's twice-hit trap), restore AFTER COMMIT.
      db.exec('PRAGMA foreign_keys = OFF');
      const fkOff = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
      if (fkOff !== 0) throw new Error(`${table} tenant rebuild: foreign_keys still ${fkOff} after OFF — aborting to avoid an FK-blocked partial rebuild.`);
      db.exec('BEGIN');
      try {
        db.exec(`CREATE TABLE ${tmp} (${body}, tenant_id INTEGER NOT NULL REFERENCES users(id))`);
        const colList = oldCols.join(', ');
        db.prepare(`INSERT INTO ${tmp} (${colList}, tenant_id) SELECT ${colList}, ? FROM ${table}`).run(tenant);
        db.exec(`DROP TABLE ${table}`);
        db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
        // RENAME set sqlite_sequence for the table to the copied max id; restore the true high-water
        // mark so the next insert lands strictly PAST the highest id ever used (never reuses 12..17).
        db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table);
        if (oldSeq != null) db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, oldSeq);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        db.exec('PRAGMA foreign_keys = ON');
        throw e;
      }
      db.exec('PRAGMA foreign_keys = ON');
      // Replay the table's own indexes (DROP TABLE removed them). Skip the old database-wide
      // single-live-contract index — the per-tenant block below creates the correct replacement.
      for (const idx of idxDdls) { if (idx.name !== 'idx_contract_single_live') db.exec(idx.sql); }
      const fkViol = db.prepare('PRAGMA foreign_key_check').all();
      if (fkViol.length) throw new Error(`${table} tenant rebuild: foreign_key_check found ${JSON.stringify(fkViol)}`);
    };

    // Add tenant_id to one table: no-op if present (idempotent / fresh install), ADD COLUMN if empty,
    // forced rebuild if it holds rows.
    const addTenantId = (table) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (cols.includes('tenant_id')) return;
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      if (n === 0) { db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER NOT NULL REFERENCES users(id)`); return; }
      rebuildAddingTenant(table, cols, chosenTenant);
    };
    for (const t of TENANT_TABLES) addTenantId(t);

    // Part C — settings becomes PER-TENANT via a composite (tenant_id, key) primary key. The PK change
    // forces a create-copy-swap rebuild (SQLite can't add a column to a PK in place). Backfill every
    // existing row to the tenant: no CURRENT settings key is genuinely global — budget, recipients,
    // schedule times, and the last-success/attempt/alert bookkeeping are all per-household. (The one
    // genuinely-global piece of state, the shared WhatsApp client session, lives in .wwebjs_auth on
    // disk, not here; a future infra key would use the reserved tenant_id = 0.)
    const settingsCols = db.prepare('PRAGMA table_info(settings)').all().map((c) => c.name);
    if (!settingsCols.includes('tenant_id')) {
      const settingsRows = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
      if (settingsRows > 0 && chosenTenant == null) {
        throw new Error('Tenancy Phase 2: settings holds rows but there are NO users to own them — register the household user first, then reboot.');
      }
      db.exec('PRAGMA foreign_keys = OFF');
      const fkOff = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
      if (fkOff !== 0) throw new Error(`settings tenant rebuild: foreign_keys still ${fkOff} after OFF.`);
      db.exec('BEGIN');
      try {
        // No FK on tenant_id (see the CREATE note). backfill = chosenTenant for every existing row.
        db.exec('CREATE TABLE settings__tenant_rebuild (tenant_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (tenant_id, key))');
        db.prepare('INSERT INTO settings__tenant_rebuild (tenant_id, key, value) SELECT ?, key, value FROM settings').run(chosenTenant);
        db.exec('DROP TABLE settings');
        db.exec('ALTER TABLE settings__tenant_rebuild RENAME TO settings');
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        db.exec('PRAGMA foreign_keys = ON');
        throw e;
      }
      db.exec('PRAGMA foreign_keys = ON');
    }

    // Part B — the single-live-contract invariant becomes PER-TENANT. The old database-wide
    // idx_contract_single_live made a SECOND user unable to create ANY contract (the INSERT
    // failed); replace it so each tenant gets exactly one live contract. Fail LOUDLY first if any
    // tenant already holds more than one live contract — never silently pick a winner.
    const dupLiveTenants = db.prepare('SELECT tenant_id, COUNT(*) AS n FROM contract WHERE deleted_at IS NULL GROUP BY tenant_id HAVING n > 1').all();
    if (dupLiveTenants.length) {
      throw new Error(`Tenancy Phase 2 (Part B): tenant(s) ${dupLiveTenants.map((d) => `${d.tenant_id} (${d.n} live)`).join(', ')} already hold more than one live contract; the per-tenant invariant allows one each. Soft-delete the extras, then reboot — refusing to pick a winner automatically.`);
    }
    db.exec('DROP INDEX IF EXISTS idx_contract_single_live'); // retire the database-wide index
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_single_live_tenant ON contract(tenant_id) WHERE deleted_at IS NULL');
  }

  // ===========================================================================
  // Services phase — contract line-item services + per-user customs. contract_services and
  // ledger_customs are created by the base block above (empty new tables → NOT NULL tenant_id is fine
  // with no rows). Two idempotent ADD COLUMNs for the columns that live on EXISTING tables:
  //  · contract.company (Part F) — optional, nullable.
  //  · cash_out.contract_service_id (Part C/D) — nullable FK to contract_services. Runs AFTER the
  //    Phase 2 cash_out tenant-rebuild (so it isn't dropped) and after contract_services exists.
  const contractColsSvc = db.prepare('PRAGMA table_info(contract)').all().map((c) => c.name);
  if (!contractColsSvc.includes('company')) db.exec('ALTER TABLE contract ADD COLUMN company TEXT');
  const cashOutColsSvc = db.prepare('PRAGMA table_info(cash_out)').all().map((c) => c.name);
  if (!cashOutColsSvc.includes('contract_service_id')) db.exec('ALTER TABLE cash_out ADD COLUMN contract_service_id INTEGER REFERENCES contract_services(id)');

  // Part E — one-time backfill of the per-user custom list so existing free-text ledger names are not
  // orphaned: they still display from their own cash_out.ledger_custom_name (unchanged), AND become
  // selectable. Seed the distinct live custom names to the PRIMARY tenant (chosenTenant, from Phase 2
  // above). Gated on an EMPTY list so a user who later deletes a saved name isn't re-seeded on reboot.
  // ALSO gated on userVersion < 2 AND ledger_customs actually having a tenant_id column. Version alone
  // is not enough here: unlike the 6 TENANT_TABLES above (which Part A actively retrofits whenever
  // userVersion < 2, regardless of current shape), ledger_customs/contract_services only ever get
  // tenant_id at table-CREATION time — there is no ALTER/rebuild path that adds it back. So a boot
  // where userVersion reads < 2 but the column is already gone (e.g. user_version was reset without
  // the schema being reset to match) must not attempt this INSERT.
  // Phase 12: check the cheap userVersion gate FIRST — short-circuits the PRAGMA call below (and
  // everything after it) on every already-migrated boot, same as every other userVersion < 2 gate here.
  if (userVersion < 2 && db.prepare('PRAGMA table_info(ledger_customs)').all().map((c) => c.name).includes('tenant_id') && chosenTenant != null && db.prepare('SELECT COUNT(*) AS n FROM ledger_customs').get().n === 0) {
    db.prepare(
      "INSERT OR IGNORE INTO ledger_customs (tenant_id, name) " +
      "SELECT DISTINCT ?, ledger_custom_name FROM cash_out " +
      "WHERE ledger_code = 'CUSTOM' AND ledger_custom_name IS NOT NULL AND trim(ledger_custom_name) <> '' AND deleted_at IS NULL"
    ).run(chosenTenant);
  }

  // -------------------------------------------------------------------------
  // Phase 6C — index tuning (done LAST so the cash_out rebuild above can't drop these).
  //  · DROP the useless full deleted_at indexes: deleted_at is NULL for ~every row (non-selective),
  //    and idx_cash_out_deleted_at was being CHOSEN over the effective partial index for the range
  //    query, degrading it. Proved with EXPLAIN QUERY PLAN. The list queries full-scan (correct —
  //    they read every live row). IF EXISTS so it's a no-op on fresh DBs / second boot.
  //  · CREATE the PARTIAL date indexes that the Overview range queries actually use — keyed on the
  //    date, restricted to live rows, so `WHERE deleted_at IS NULL AND <date> BETWEEN ?..?` is an
  //    index range scan.
  db.exec('DROP INDEX IF EXISTS idx_cash_out_deleted_at');
  db.exec('DROP INDEX IF EXISTS idx_cash_in_deleted_at');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cash_out_txdate_live ON cash_out(tx_date) WHERE deleted_at IS NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contractor_payments_paydate_live ON contractor_payments(pay_date) WHERE deleted_at IS NULL');
  // Part A — the amount-range filter on the outflow search is a range predicate, so it gets the SAME
  // partial-index-on-live-rows treatment as tx_date above: `WHERE deleted_at IS NULL AND amount_paise
  // BETWEEN ?..?` becomes an index range scan instead of a full table scan. (EXPLAIN-verified: turns the
  // amount-only search from a SCAN into SEARCH … USING idx_cash_out_amount_live.)
  db.exec('CREATE INDEX IF NOT EXISTS idx_cash_out_amount_live ON cash_out(amount_paise) WHERE deleted_at IS NULL');

  // Services phase (Part D) — the ONE-SERVICE-ONE-OFFSET invariant, enforced in the DATABASE (mirrors
  // idx_contract_single_live_tenant): at most one LIVE debit may link any given service, so a single
  // substitution can never offset the contractor's dues twice. Partial + restricted to non-null
  // service ids (a NULL link — the common case — is unconstrained). Created here at init end so the
  // cash_out rebuilds above can't drop it and contract_service_id is guaranteed to exist by now.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_out_service_live ON cash_out(contract_service_id) WHERE contract_service_id IS NOT NULL AND deleted_at IS NULL');

  // ===========================================================================
  // Tenancy Phase 2, Step 2a — SCHEMA-ONLY collapse back to a single tenant. The app is becoming a
  // single-user offline Android install: exactly one users row will ever exist, so tenant_id (added
  // above for a household-sharing feature) is being removed entirely, not frozen. repo.js and
  // server.js still pass/require req.user.id as a tenant argument today — updating THOSE is a later,
  // separate step; this migration only reshapes storage.
  //
  // Version-gated (userVersion < 2, read at the top of init() before any migration touches the
  // marker — same convention as the phase_custom_name/cash_out rebuild above) rather than
  // presence-keyed: "tenant_id is absent" is not a safe trigger here (a database that has ALREADY run
  // this migration also has no tenant_id, so a presence check would re-fire it forever). NEEDS
  // TENANT_TABLES/rebuildAddingTenant() ABOVE to still exist and run first: a genuinely pre-Tenancy
  // database has no tenant_id at all, and this migration's DELETEs below assume the column is there.
  // That add-then-immediately-remove round trip is redundant work for such a database but produces
  // the correct end state, using the already-proven backfill/rebuild logic instead of a second
  // special case here.
  if (userVersion < 2) {
    // Row-count guard (see Part 6 below): snapshot every table's count BEFORE this migration
    // touches anything, and track exactly how many rows each deliberate delete/dedupe step removes.
    const GUARD_TABLES = ['contract', 'contract_payment_dates', 'contractor_payments', 'contract_services', 'cash_in', 'cash_out', 'loans', 'ledger_customs', 'settings'];
    const countsBefore = {};
    const deliberatelyRemoved = {};
    for (const t of GUARD_TABLES) { countsBefore[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; deliberatelyRemoved[t] = 0; }

    // The one real tenant: the lowest users.id (same "household head" convention Tenancy Phase 2
    // used above; `chosenTenant` is that same computed value, still in scope). Any OTHER tenant_id
    // surviving in these tables at this point is a test artifact, not a second real household.
    if (chosenTenant != null) {
      // Before touching any column: drop every row belonging to a tenant other than the real one,
      // across all 8 tenant-bearing tables, so each table's rebuild below has nothing left to lose.
      // contract_services/ledger_customs are NOT in TENANT_TABLES above, so — unlike the other 6 —
      // nothing retrofits tenant_id onto them if it's already absent; skip a table here if it
      // doesn't currently have the column, rather than assume every gated table always does.
      for (const t of ['contract', 'contract_payment_dates', 'contractor_payments', 'contract_services', 'cash_in', 'cash_out', 'loans', 'ledger_customs']) {
        const hasTenantCol = db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'tenant_id');
        if (!hasTenantCol) continue;
        const info = db.prepare(`DELETE FROM ${t} WHERE tenant_id <> ?`).run(chosenTenant);
        deliberatelyRemoved[t] += info.changes;
      }
    }

    // Part 1 — settings: composite (tenant_id, key) PK back to a plain key PK. Where the same key
    // still exists under more than one tenant (shouldn't happen after the delete above unless a row
    // for that key never belonged to chosenTenant to begin with), keep the lowest tenant_id's row.
    {
      db.exec('PRAGMA foreign_keys = OFF');
      const fkOff = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
      if (fkOff !== 0) throw new Error(`settings de-tenant rebuild: foreign_keys still ${fkOff} after OFF — aborting.`);
      db.exec('BEGIN');
      try {
        db.exec('CREATE TABLE settings__detenant_rebuild (key TEXT NOT NULL PRIMARY KEY, value TEXT)');
        const insInfo = db.prepare(`
          INSERT INTO settings__detenant_rebuild (key, value)
          SELECT s.key, s.value FROM settings s
          WHERE s.tenant_id = (SELECT MIN(tenant_id) FROM settings WHERE key = s.key)
        `).run();
        deliberatelyRemoved.settings = countsBefore.settings - insInfo.changes;
        db.exec('DROP TABLE settings');
        db.exec('ALTER TABLE settings__detenant_rebuild RENAME TO settings');
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        db.exec('PRAGMA foreign_keys = ON');
        throw e;
      }
      db.exec('PRAGMA foreign_keys = ON');
    }

    // Part 2 — contract: collapse the per-tenant single-live invariant to a database-wide one. If
    // more than one live contract still exists across tenants (shouldn't happen after the delete
    // above, since idx_contract_single_live_tenant already capped each tenant at one), keep the
    // lowest users.id's and soft-delete the rest — never a silent hard-delete of a live row.
    db.exec(`
      UPDATE contract SET deleted_at = datetime('now')
      WHERE deleted_at IS NULL
        AND tenant_id <> (SELECT MIN(tenant_id) FROM contract WHERE deleted_at IS NULL)
    `);

    // Part 3 — ledger_customs: dedupe by NAME, keeping the lowest id (lowest id, not lowest
    // tenant_id — this becomes a flat pick-list once the tenant dimension is gone, so ties break on
    // row age, not on ownership).
    {
      const dedupInfo = db.prepare('DELETE FROM ledger_customs WHERE id NOT IN (SELECT MIN(id) FROM ledger_customs GROUP BY name)').run();
      deliberatelyRemoved.ledger_customs += dedupInfo.changes;
    }

    // Part 4 — drop tenant_id from all 8 tenant-bearing tables via create-copy-swap, preserving the
    // AUTOINCREMENT high-water mark exactly as rebuildAddingTenant() does above (so no id is ever
    // reused), and replaying each table's OWN indexes afterward — skipping any that reference
    // tenant_id (the two that do, idx_contract_single_live_tenant and idx_ledger_customs_tenant_name,
    // are replaced with their tenant-free equivalents in Part 5, not replayed here).
    const rebuildDroppingTenant = (table, bodySql, keptCols) => {
      const seqRow = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table);
      const oldSeq = seqRow ? seqRow.seq : null;
      const idxDdls = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL").all(table);
      const tmp = `${table}__detenant_rebuild`;
      db.exec('PRAGMA foreign_keys = OFF');
      const fkOff = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
      if (fkOff !== 0) throw new Error(`${table} de-tenant rebuild: foreign_keys still ${fkOff} after OFF — aborting to avoid an FK-blocked partial rebuild.`);
      db.exec('BEGIN');
      try {
        db.exec(`CREATE TABLE ${tmp} (${bodySql})`);
        const colList = keptCols.join(', ');
        db.exec(`INSERT INTO ${tmp} (${colList}) SELECT ${colList} FROM ${table}`);
        db.exec(`DROP TABLE ${table}`);
        db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
        db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table);
        if (oldSeq != null) db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, oldSeq);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        db.exec('PRAGMA foreign_keys = ON');
        throw e;
      }
      db.exec('PRAGMA foreign_keys = ON');
      for (const idx of idxDdls) { if (!/tenant_id/i.test(idx.sql)) db.exec(idx.sql); }
    };

    rebuildDroppingTenant('contract', `
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      contractor_name         TEXT,
      area_of_work            TEXT,
      ledger_code             TEXT,
      subledger_code          TEXT,
      ledger_custom_name      TEXT,
      subledger_custom_name   TEXT,
      amount_paise            INTEGER,
      price_of_contract_paise INTEGER,
      contract_end_date       TEXT,
      date_signed             TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at              TEXT,
      company                 TEXT
    `, ['id', 'contractor_name', 'area_of_work', 'ledger_code', 'subledger_code', 'ledger_custom_name',
        'subledger_custom_name', 'amount_paise', 'price_of_contract_paise', 'contract_end_date',
        'date_signed', 'created_at', 'updated_at', 'deleted_at', 'company']);

    rebuildDroppingTenant('contract_payment_dates', `
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
      pay_date    TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    `, ['id', 'contract_id', 'pay_date', 'created_at']);

    rebuildDroppingTenant('contractor_payments', `
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id           INTEGER NOT NULL REFERENCES contract(id),
      pay_date              TEXT    NOT NULL,
      amount_paise          INTEGER NOT NULL,
      ledger_code           TEXT,
      subledger_code        TEXT,
      ledger_custom_name    TEXT,
      subledger_custom_name TEXT,
      phase                 INTEGER,
      subpart               TEXT,
      remarks               TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at            TEXT
    `, ['id', 'contract_id', 'pay_date', 'amount_paise', 'ledger_code', 'subledger_code',
        'ledger_custom_name', 'subledger_custom_name', 'phase', 'subpart', 'remarks',
        'created_at', 'updated_at', 'deleted_at']);

    rebuildDroppingTenant('contract_services', `
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      price_paise INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at  TEXT
    `, ['id', 'contract_id', 'name', 'price_paise', 'created_at', 'updated_at', 'deleted_at']);

    rebuildDroppingTenant('cash_in', `
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise INTEGER NOT NULL,
      tx_date      TEXT,
      by_type      TEXT    NOT NULL,
      by_user_id   INTEGER REFERENCES users(id),
      by_label     TEXT,
      reason       TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at   TEXT
    `, ['id', 'amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'reason',
        'created_at', 'updated_at', 'deleted_at']);

    rebuildDroppingTenant('cash_out', `
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise          INTEGER NOT NULL,
      tx_date               TEXT,
      by_type               TEXT    NOT NULL,
      by_user_id            INTEGER REFERENCES users(id),
      by_label              TEXT,
      ledger_code           TEXT    NOT NULL,
      subledger_code        TEXT,
      ledger_custom_name    TEXT,
      subledger_custom_name TEXT,
      reason                TEXT,
      contract_scope        TEXT    NOT NULL,
      contract_stated_paise INTEGER,
      phase                 INTEGER,
      subpart               TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at            TEXT,
      contract_service_id   INTEGER REFERENCES contract_services(id)
    `, ['id', 'amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'ledger_code',
        'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'reason', 'contract_scope',
        'contract_stated_paise', 'phase', 'subpart', 'created_at', 'updated_at', 'deleted_at',
        'contract_service_id']);

    rebuildDroppingTenant('loans', `
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise  INTEGER,
      bank_name     TEXT,
      interest_rate REAL,
      tenure        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at    TEXT
    `, ['id', 'amount_paise', 'bank_name', 'interest_rate', 'tenure', 'created_at', 'updated_at', 'deleted_at']);

    rebuildDroppingTenant('ledger_customs', `
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    `, ['id', 'name', 'created_at']);

    // Part 5 — retire the tenant-scoped indexes. idx_contract_single_live_tenant is dropped with NO
    // replacement: SQLite cannot index a constant expression, so there is no database-wide
    // equivalent to create, and app-level enforcement (a 409 on a second live contract — see
    // test/contract.test.js) is sufficient on a single-user app. idx_ledger_customs_tenant_name IS
    // replaced, by a plain unique index on name. (The table rebuilds above already dropped both
    // along with their tables via DROP TABLE; the explicit DROP INDEX here is just defensive in case
    // either survives on an unusual DB.)
    db.exec('DROP INDEX IF EXISTS idx_contract_single_live_tenant');
    db.exec('DROP INDEX IF EXISTS idx_ledger_customs_tenant_name');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_customs_name ON ledger_customs(name)');

    // Part 6 — row-count guard. A create-copy-swap that silently drops (or duplicates) a row is the
    // failure mode this migration most needs to catch. `deliberatelyRemoved` tracks, per table, only
    // the rows THIS migration intentionally removes (the non-chosen-tenant purge above, plus
    // ledger_customs' own name-dedupe and settings' own key-dedupe); every other step here is a
    // column-drop or soft-delete that must never change a row count. Checked with exact equality —
    // stricter than "no more than expected", so it also catches an unexpected UNDER-removal, not
    // only silent loss during the rebuilds.
    for (const t of GUARD_TABLES) {
      const after = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      const expected = countsBefore[t] - deliberatelyRemoved[t];
      if (after !== expected) {
        throw new Error(`Tenancy collapse (Step 2a): row-count guard failed for ${t} — before=${countsBefore[t]}, deliberately removed=${deliberatelyRemoved[t]}, expected after=${expected}, found ${after}. Refusing to stamp the migration as complete.`);
      }
    }

    // Part 7 — integrity check before this migration is allowed to be marked done (user_version is
    // stamped unconditionally at the end of init(), so a throw here leaves it at 0 and the whole
    // chain retries next boot).
    const fkViol = db.prepare('PRAGMA foreign_key_check').all();
    if (fkViol.length) throw new Error('Tenancy collapse (Step 2a): foreign_key_check found ' + JSON.stringify(fkViol));
  }

  // Phase 10a — the 23-category ledger taxonomy (public/ledgers.js) was replaced with a fresh
  // 24-category one derived from the real contract and the owner's tracking spreadsheet. The old
  // and new taxonomies reuse the SAME "N.M" code shape with DIFFERENT meanings per code (old 4.2 =
  // Cement, new 4.2 = Demolition) — so "does this code still exist" is not a safe survival test: a
  // stale row could coincidentally collide with an unrelated new category and silently display the
  // wrong thing forever, which is worse than an obviously-broken one.
  //
  // cash_out.ledger_code is NOT NULL (every debit needs a real category), so a stale row can't be
  // repaired by clearing the tag — and every existing row is seeded mock data; no real payment has
  // ever been entered against the old taxonomy (confirmed with the household). Wiping the table
  // outright loses nothing of value and leaves nothing mislabeled.
  //
  // contract.ledger_code/subledger_code and contractor_payments.ledger_code/subledger_code are
  // OPTIONAL — the same stale-code risk applies, but clearing just the tag (not the row) is enough
  // since the contract/payment record itself is still otherwise valid. CUSTOM-tagged rows are left
  // alone: their free-text name never depended on the fixed taxonomy.
  //
  // Gated on a DEDICATED settings marker, NOT the shared `userVersion < N` counter every migration
  // above uses: several test fixtures (migration-guard, tenancy-collapse) deliberately reset
  // user_version to simulate an old database while testing a DIFFERENT migration's behaviour — a
  // shared "< N" gate would re-fire this one every time they do that, wiping cash_out rows those
  // tests insert for unrelated reasons and need to survive. This migration only cares "has THIS
  // cleanup run yet", independent of whatever the version counter is otherwise made to say.
  if (!db.prepare("SELECT 1 FROM settings WHERE key = '_migrated_ledger_taxonomy_v1'").get()) {
    db.exec('DELETE FROM cash_out');
    db.exec("UPDATE contract SET ledger_code = NULL, subledger_code = NULL WHERE ledger_code IS NOT NULL AND ledger_code <> 'CUSTOM'");
    db.exec("UPDATE contractor_payments SET ledger_code = NULL, subledger_code = NULL WHERE ledger_code IS NOT NULL AND ledger_code <> 'CUSTOM'");
    db.exec("INSERT INTO settings (key, value) VALUES ('_migrated_ledger_taxonomy_v1', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  }

  // Schema-version marker (Phase 11B) — stamped ONLY here, after every migration above has succeeded,
  // so a mid-migration throw leaves it at 0 and the next boot retries the whole chain. Disambiguates
  // the historical presence-keyed DESTRUCTIVE rebuild(s) above: those run only while user_version is 0,
  // so re-adding a same-named column later can never re-arm them. Additive ADD-COLUMN guards stay
  // presence-keyed on purpose — adding an absent column is always correct, so they need no version gate.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

// Phase 4a/4c (WASM SQLite port prep): recognize a SQLITE_IOERR-family error regardless of which
// SQLite binding raised it. node:sqlite exposes the raw result code as `err.errcode`; the real
// sqlite-wasm engine (Phase 4b) exposes it as `err.resultCode` — its actual SQLite3Error property,
// confirmed by reading the package's own type definitions (an earlier guess at `err.sqlite3Rc` was
// wrong; db-engine.js no longer compensates for that, since this checks the real name directly). Both
// use SQLite's own result-code numbering, where every IOERR subcode (SQLITE_IOERR_WRITE, _SHORT_READ,
// etc.) shares base code 10 in its low byte. This is the failure mode confirmed in the kvvfs
// storage-ceiling spike: exceeding the quota surfaces as a clean, atomically-rolled-back SQLITE_IOERR,
// never silent corruption — so a write path seeing this can safely tell the user "storage is full"
// instead of a raw SQLite message.
export function isStorageFullError(err) {
  const code = err && (err.errcode ?? err.resultCode);
  if (typeof code === 'number' && (code & 0xff) === 10) return true;
  return !!(err && typeof err.message === 'string' && /SQLITE_IOERR|disk I\/O error/i.test(err.message));
}
