# Plannr

A **single-user, offline construction-spend ledger**, built as an Android app with
[Capacitor](https://capacitorjs.com/). One person runs it on their own phone to track money in and
out of a single building contract — no server, no login, no internet connection required once
installed. There is also a Node/Express mode (`server.js`) for development and testing on a desktop,
which runs the exact same frontend against a real SQLite file instead of the on-device WASM engine.

Money is **integer paise everywhere** (₹1 = 100 paise) — never a float. Formatting to ₹ is
display-only.

## How it runs

Plannr's frontend (`public/`) is the same static HTML/JS on every target; only the backend it talks
to changes:

| Mode | Backend | Storage | When you'd use it |
|---|---|---|---|
| **Android app** | `public/local-api.js` — an in-page `fetch()` shim, no network involved | `@sqlite.org/sqlite-wasm` via OPFS/kvvfs, inside the Capacitor WebView | The actual shipped product |
| **`node server.js`** | Real Express routes | `node:sqlite` against `data/plannr.db` | Local desktop use, and what most of the automated test suite boots |
| **`node local-server.js`** | Same `local-api.js` shim as the Android app | Same WASM engine, in a plain Chromium tab | Testing the exact static-hosting model the Android WebView uses, without building an APK |

Because `local-api.js` and `server.js` expose the same API surface, every page works identically
regardless of which one is actually running underneath — see "Duplicated logic" below for how that's
kept true.

### Run the desktop/dev mode

```sh
npm install
npm start           # = node server.js  → http://localhost:3000
```

- `PORT` overrides the port (default 3000).
- `PLANNR_DB=/path/to.db` overrides the database file — **always use this for testing; never
  test against `data/plannr.db`.** The schema + all migrations are created/run on boot from `init()`.

### Build/run the Android app

```sh
npm run android:sync   # = sync-public-modules.js (copies db.js/repo.js/vendor into public/) + npx cap sync android
```

Then open `android/` in Android Studio to build and run on a device or emulator. `capacitor.config.json`
points `webDir` at `public/` — whatever is in there is what ships.

### Live-DB guard (for scripts)

`server.js` defaults to the live `data/plannr.db` (correct — it *is* the app, in desktop mode). Every
**non-server script** instead goes through `db-guard.js`: it prints the absolute path it will write to
and **refuses the live DB** (an unset `PLANNR_DB` counts as live) unless you pass
`--i-really-mean-the-live-db`. So a forgotten `PLANNR_DB=` can no longer hit production by accident.

### Reset

```sh
PLANNR_DB=/tmp/x.db npm run reset-db                          # wipe an isolated copy (safe)
node reset-db.js --confirm --i-really-mean-the-live-db        # wipe the LIVE (desktop-mode) database
```

`reset-db.js` derives the table list from `sqlite_master` (never a hardcoded array, so a new
table can't be silently skipped), disables foreign keys for the wipe (set before `BEGIN`,
restored after `COMMIT`), and runs `PRAGMA foreign_key_check` afterward. `--confirm` confirms
intent; the guard confirms the target (and requires the live flag for live). There is deliberately
**no in-app reset button**.

## No login — a single fixed local owner

There is no registration, no password, no session. `init()` seeds exactly one `users` row on first
boot (`username: 'owner'`) if none exists; every request resolves to that one row (`requireApiAuth` is
a no-op that just attaches it), regardless of any cookie. `password_hash` is a leftover column kept for
schema stability, not an active password — there is nothing to log into.

## Testing

Node's built-in runner (`node --test`) — no test framework dependency.

```sh
npm test                    # the full behaviour suite (run-tests.js: node --test over test/*.test.js)
npm run test:ui             # the visual suite (Playwright, in-process server.js): pie swatches, table layout, ₹ rendering
npm run test:static-hosting # the local-server.js suite (Playwright): the real static-hosting model the Android WebView uses
```

Two absolute safety properties `npm test` enforces:

- **It never opens the live DB.** Each test file sets a unique temp `PLANNR_DB` before requiring
  `db.js`/`server.js`; a test asserts the resolved `DB_PATH` is not the live path; and `run-tests.js`
  records `data/plannr.db`'s mtime before and after the whole run and fails if it changed.
- `server.js` gates its external side effects (`app.listen`, signal handlers) behind
  `require.main === module`, so it can be imported by tests. `npm start` is unchanged.

`test-ui/backup-crypto.js` (`npm run test:backup-crypto`) round-trips the encrypted backup format
end to end through the real routes on a live temp DB.

## Pages

`home` · `/cash-flow` · `/cash-inflow` (Money Credited) · `/cash-outflow` (Money Debited) ·
`/loan-details` · `/contract-details` · `/contractor-payments` · `/overview` · `/data-backup`.

## Database tables

| table | holds |
|---|---|
| `users` | exactly one row: the fixed local owner. `password_hash` is dormant (kept for schema stability; there is no login). |
| `contract` | the single building contract: contractor, area, headline ledger tag, `price_of_contract_paise` (OPTIONAL stated amount — dues math starts here; NULL = no stated price, contributing 0 to A and 0 to owed), optional free-form amount, optional date signed, optional end date. **Rate-based pricing:** `rate_per_sqft_paise` + `measured_area_milli_sqft` (both optional, both editable at any time — the area isn't known until final measurement). When both are set, `price_of_contract_paise` is their product, rewritten on every save. **Optional metadata:** `completion_period_months` (yields a derived expected completion date), `supervision_rate_pct` (informational, drives nothing), and three free-text notes — `specified_brands`, `excluded_scope`, `owner_obligations`. |
| `contract_payment_dates` | a contract's scheduled payment dates (0..many); offered as the date dropdown on the Contractor Payments page. Cascades if the contract is hard-deleted. |
| `contract_services` | a contract's SCOPE OF WORK — a name, and nothing else. The optional `price_paise` was REMOVED: this contract is a fixed unit-rate lump sum whose schedule of work attaches no rupee figure to any scope item, so the field could only hold an invented number (and fed a "remainder" line that meant nothing). Their only downstream job is to be NAMED by a debit via `cash_out.contract_service_id` (provenance: "which item was this spend for"). Soft-delete; cascades if the contract is hard-deleted. |
| `contract_allowances` | the contract's allowance CAPS — optional, 0..many per contract. `cap_kind` is `lump` (a rupee ceiling in `cap_paise`) or `per_sqft` (a ceiling RATE in `cap_rate_per_sqft_paise`, which only becomes a rupee cap once the optional `area_milli_sqft` is recorded). Running spend is DERIVED from live `cash_out` rows tagged with the allowance, never typed; the over/under position is displayed and settles nothing. Soft-delete; cascades if the contract is hard-deleted. |
| `ledger_mains` / `ledger_subs` | the ledger taxonomy — 24 main categories and their sub-ledgers, `code` as the primary key. Seeded once from root `ledgers.js` on first boot; from then on the DB is the source of truth. User-editable: export/import as CSV from Data Backup → "Ledger List" (see below). |
| `ledger_customs` | a saved list of custom ledger names typed by hand, so a typed custom is selectable after first use. |
| `contractor_payments` | money PAID to the contractor, each tied to the contract. Ledger fields are an optional *display* tag and do NOT drive dues. |
| `cash_in` | money credited (inflow): amount, `by_type` (`user`/`relative`/`custom`) + attribution, reason. |
| `cash_out` | money debited (outflow): amount, tx_date, `by_type` (`user`/`custom`) + who paid, ledger/sub-ledger (or `CUSTOM`), `contract_scope` (`included`/`extra`, a descriptive label only), `contract_service_id` (the linked `contract_services` row — provenance; NULL when 'extra' or when no item is picked), and `contract_allowance_id` (the allowance this spend draws against; NULL when 'extra' or untagged — NOT unique, since many debits draw against one cap). `contract_stated_paise` is RETIRED: the column is kept nullable so historical values and backups survive, but nothing writes or reads it (see below). `phase`/`subpart` are dormant, stored but unused. |
| `loans` | one-time loan records: amount, bank, interest rate, tenure. `interest_rate` is informational (drives no calculation); interest actually *paid* is a `cash_out` row under ledger 22.5 (Loan interest). |
| `settings` | key/value app options (budget, notification times). Composite `(tenant_id, key)` PK is a holdover from an earlier multi-household design; in this single-owner app it's always keyed to the one owner. |

## Invariants enforced in the DATABASE (not just app code)

- **One live contract.** `idx_contract_single_live` — a partial unique index on `contract WHERE deleted_at IS NULL` — makes a second live contract fail at INSERT/UPDATE. Soft-deleted contracts coexist with the one live row.
- **One service, one live debit.** `idx_cash_out_service_live` — a partial unique index on `cash_out(contract_service_id) WHERE contract_service_id IS NOT NULL AND deleted_at IS NULL` — makes at most one LIVE debit link any given `contract_services` row. Enforced in the DB, not only in app code (the app adds a naming 409 on create/edit/restore). NOTE: this index was built to stop a single service offsetting the contractor's dues twice. With the reimbursement offset removed the link is pure provenance and the index now guards a bookkeeping rule ("record each service once"), not a figure. It is kept because it still reads as a sensible rule and dropping a unique index is a schema change with no upside. The "only a PRICED service is linkable" rule that used to sit alongside it went out with `price_paise` — every live scope item is selectable now.
- **Many debits, one allowance.** `idx_cash_out_allowance_live` — a partial, deliberately **non-unique** index on `cash_out(contract_allowance_id) WHERE contract_allowance_id IS NOT NULL AND deleted_at IS NULL`. It exists for the rollup, not as a constraint: an allowance is a cap that accumulates a running spend, so uniqueness here would break the feature rather than protect it.
- **Soft-delete everywhere.** The five Recycle Bin tables (`cash_in`, `cash_out`, `loans`, `contract`, `contractor_payments`) carry `deleted_at TEXT` (NULL = live); "delete" sets it, the Recycle Bin restores or permanently removes. The JSON backup keeps soft-deleted rows; the "CSV for Excel" export shows live rows only.
- **Integer paise.** All `*_paise` columns are INTEGER; money is never a float.

## Dues (owed) — and the reimbursement offset that was REMOVED

```
owed (F) = contract.price_of_contract_paise            (0 when no price is stated)
         − Σ contractor_payments.amount_paise         (cumulative)
```

**Worked example.** Contract stated ₹1,00,000; a payment of ₹40,000; a debit of ₹32,000 marked
Contract Included: Yes → **owed = ₹60,000** (100000 − 40000). Spent-by-self = ₹32,000 and
Total spent (D) includes the real ₹32,000, but the included debit does **not** reduce owed.

**What changed.** Phase 5E's "Option C" reimbursement offset had a debit marked *Contract Included:
Yes* also carry `contract_stated_paise` — what the contract stated for that item — which was
subtracted from owed. That third term is gone, deliberately and **all-or-nothing**:

- The Cash Outflow form no longer asks for a stated amount, and nothing writes `contract_stated_paise`.
- Legacy rows that still hold a value do **not** contribute either. Owed must not depend on whether a
  row was entered before or after the change — a half-live offset is worse than none.
- The column stays in the schema, nullable and unused, and backups still round-trip it, so historical
  values survive. (Dropping a column in SQLite is a table rebuild; not worth the risk for dead data.)
- **Contract Included (Yes/No) stays** as a label. It records whether the item was in the contract; it
  changes no figure.

**Cumulative vs range-scoped (critical).** Owed and the paid totals are a *balance* — always summed
over the full set. The pie, Paid-to-contractors (B) and Spent-by-self (C) are scoped to the selected
date range. So a date range that excludes a payment still leaves owed unchanged.

## Overview money model (`GET /api/overview`)

`money`: A `totalContractPaise` (cumulative), B `paidToContractorsPaise` (range), C
`spentBySelfPaise` (range), D `totalSpentPaise` = B + C (range), E `loanReceivedPaise`
(cumulative), F `owedToContractorsPaise` (cumulative, unclamped — negative means overpaid). Also
`ledgers` (the pie rollup, 24 main categories each with a distinct colour, plus a "Custom /
Uncategorized" bucket for `CUSTOM`-ledger spend; a 25th+ main added via CSV import gets an
algorithmically generated colour rather than reusing an existing one), `contracts` (the one
contract's stated/paid/owed), and `budgetPaise`.

### `reconciliation` key — flags, never silent corrections

The response also carries `reconciliation`. Every figure above is reported **as-is**; these only
*detect and report* inconsistencies:

- `ok` — false if any check below trips.
- `orphanedContractorPayments` `{count, amountPaise, contractIds}` — live payments whose parent contract is soft-deleted/missing. Their ₹ is still in B/D/pie but not counted in A/F.
- `overOffset` `{over, contractPaise, appliedPaise, excessPaise}` — contractor payments exceed the contract value. (Named from the removed offset; with the offset gone `appliedPaise` is just the payments total.)
- `includedDebitsMissingOffset` was **removed**. It fired on any `included` debit with a NULL/0 `contract_stated_paise` — which, with the offset gone, is every ordinary entry.

## Exports & backup (`/data-backup`)

- **JSON backup** — full export/import of every ledger table *including soft-deleted rows*, ids and foreign keys preserved. Import validates fully, auto-snapshots current data first, then replaces in one transaction (rolls back on any error).
- **Encrypted backup** — the same full snapshot, AES-256-GCM-encrypted with a passphrase you choose (`backup-crypto.js`). On Android, saving and restoring both go through `Filesystem`/`Share` (the native save/share sheet); in a browser they're a plain download.
- **Ledger List CSV** — the 24-main taxonomy itself, exportable and re-importable (Code, Main ledger, Sub-code, Sub-ledger columns; code is the identity). Renames are allowed and keep historical spend attached (the join is always by code); additions are allowed; deletions are only allowed for codes with no spend against them. Every import triggers a mandatory encrypted safety backup first, which you must explicitly confirm you have before the import proceeds — see `data-backup.html`.
- **CSV for Excel** — one file per table, amounts in rupees, live rows only. View/print only; this one is **not** re-importable (only the Ledger List CSV above is).
- **PDF** (Overview) — four parts (full / pie / table / ledger) × light/dark. Rendered by headless Chromium under `server.js`, or by the on-device native PDF plugin (`@capgo/capacitor-pdf-generator`) on Android — same HTML/layout either way, and shared/saved through the same native save/share path as the encrypted backup.

## Layout

```
server.js         Express app: the ledger CRUD, Overview + PDF, JSON/CSV/encrypted backup, Recycle Bin.
                  Desktop/dev only — not what ships on Android.
db.js             SQLite schema + idempotent migrations (run on boot), node:sqlite (Node) or
                  db-engine.js (WASM, browser) depending on where it's loaded.
db-engine.js      The @sqlite.org/sqlite-wasm adapter db.js uses in a browser/Android WebView.
repo.js           The data-access layer — every table read/write goes through here.
ledgers.js        Seed data for the ledger taxonomy (ledger_mains/ledger_subs); NOT the runtime
                  source once the DB is seeded — see the "Ledger List" export/import above.
local-api.js      (public/) An in-page fetch() shim exposing the same API surface as server.js,
                  backed by the WASM engine — this is what the Android app actually runs against.
local-server.js   A trivial static file server for testing public/ the way a real static host
                  (or the Android WebView) would, with server.js not running at all.
public/           Static frontend + shared PlannrUI helpers (public/plannr-ui.js).
android/          The Capacitor-generated native Android project (`npx cap sync android`).
reset-db.js       One-shot full wipe (npm run reset-db).
backup-db.js      Desktop-only: writes a scheduled, encrypted VACUUM INTO snapshot of data/plannr.db
                  to a folder outside the project — useful if you also run the desktop/server.js mode.
data/plannr.db    SQLite file used by server.js (created on first run, gitignored). The Android app
                  keeps its own separate on-device database; the two are never the same file.
```

## Duplicated logic between `server.js` and `public/local-api.js`

The two backends deliberately duplicate most route handlers rather than sharing them — each is a
self-contained implementation of the same API surface, which is what keeps the Android app's fetch
shim independent of Node entirely. `repo.js` (the data-access layer underneath both) is the one
exception, kept as a single shared, synced file (via `sync-public-modules.js`) because the ledger CSV
validation logic in particular is safety-critical enough to not risk two drifting copies. See the
Phase 12 efficiency report for an exact line-count inventory of what's duplicated where.
