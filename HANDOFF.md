# Plannr — System Reference

Core reference for how Plannr works: what it is, the schema and its invariants, the dues
mechanic, the backup/recovery paths, the deliberate decisions and why, the known limitations, and
troubleshooting by symptom. `README.md` is the short introduction for someone meeting the project for
the first time; this file is the model, the schema and the operational knowledge.

---

## 1. What Plannr is

A **single-user construction-spend ledger** for one household's building project, run offline on the
owner's own Android phone. It records money in/out, tracks what is owed to the contractor, and
categorises spend across a 24-main ledger taxonomy that the owner can edit (rename/add/delete
categories) via CSV export/import.

**Stack:**
- Frontend: server-rendered static HTML in `public/` + vanilla JS (no SPA, no bundler, no CSS
  framework, no ORM).
- Backend, depending on where it runs: `node:sqlite` under `server.js` (desktop/dev), or
  `@sqlite.org/sqlite-wasm` via `public/db-engine.js` + `public/local-api.js`'s in-page fetch shim
  under Capacitor (the actual Android app) or `local-server.js` (a static-hosting test harness for
  the same shim).
- `@capacitor/filesystem` + `@capacitor/share` for saving/sharing backups and PDFs on Android (a
  plain blob-link download does not work in the Android WebView — confirmed on-device); a plain
  browser download is the fallback everywhere else.
- `@capgo/capacitor-pdf-generator` renders the Overview PDF natively on Android; `server.js` renders
  the same HTML via headless Chromium (Playwright) instead.
- No login, no network calls other than to the app's own backend, no email/messaging integration of
  any kind.

### Running modes

The frontend (`public/`) is the same static HTML/JS on every target; only the backend it talks to
changes:

| Mode | Backend | Storage | When you'd use it |
|---|---|---|---|
| **Android app** | `public/local-api.js` — an in-page `fetch()` shim, no network involved | `@sqlite.org/sqlite-wasm` via OPFS/kvvfs, inside the Capacitor WebView | The actual shipped product |
| **`node server.js`** | Real Express routes | `node:sqlite` against `data/plannr.db` | Local desktop use, and what most of the automated test suite boots |
| **`node local-server.js`** | Same `local-api.js` shim as the Android app | Same WASM engine, in a plain Chromium tab | Testing the exact static-hosting model the Android WebView uses, without building an APK |

Because `local-api.js` and `server.js` expose the same API surface, every page works identically
regardless of which one is running underneath — see §7 for why they are duplicated rather than shared.

**Desktop.** `npm start` = `node server.js` → `http://localhost:3000`. `PORT` overrides the port
(default 3000). `PLANNR_DB=/path/to.db` overrides the database file — **always use this for testing;
never test against `data/plannr.db`.** The schema and all migrations are created/run on boot from
`init()`.

**Android.** `npm run android:sync` = `sync-public-modules.js` (copies `db.js`/`repo.js`/vendor into
`public/`) + `npx cap sync android`; then open `android/` in Android Studio to build and run on a
device or emulator. `capacitor.config.json` points `webDir` at `public/` — whatever is in there is
what ships.

### Pages

`home` · `/cash-flow` · `/cash-inflow` (Money Credited) · `/cash-outflow` (Money Debited) ·
`/loan-details` · `/contract-details` · `/contractor-payments` · `/overview` · `/data-backup`.

### Layout

```
server.js         Express app: the ledger CRUD, Overview + PDF, JSON/CSV/encrypted backup, Recycle Bin.
                  Desktop/dev only — not what ships on Android.
db.js             SQLite schema + idempotent migrations (run on boot), node:sqlite (Node) or
                  db-engine.js (WASM, browser) depending on where it's loaded.
db-engine.js      The @sqlite.org/sqlite-wasm adapter db.js uses in a browser/Android WebView.
repo.js           The data-access layer — every table read/write goes through here.
ledgers.js        Seed data for the ledger taxonomy (ledger_mains/ledger_subs); NOT the runtime
                  source once the DB is seeded — see the "Ledger List" export/import in §6.
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

---

## 2. Schema (`data/plannr.db` under server.js; a separate on-device DB under the Android app)

| table | holds |
|---|---|
| `users` | exactly one row: the fixed local owner. `password_hash` is dormant (kept for schema stability; there is no login). |
| `contract` | the single building contract: contractor, area, headline ledger tag, `price_of_contract_paise` (OPTIONAL stated amount — dues math starts here; NULL = no stated price, contributing 0 to A and 0 to owed), optional free-form amount, optional date signed, optional end date. **Rate-based pricing:** `rate_per_sqft_paise` + `measured_area_milli_sqft` (both optional, both editable at any time — the area isn't known until final measurement). When both are set, `price_of_contract_paise` is their product, rewritten on every save. **Optional metadata:** `completion_period_months` (yields a derived expected completion date), `supervision_rate_pct` (informational, drives nothing), and three free-text notes — `specified_brands`, `excluded_scope`, `owner_obligations`. |
| `contract_payment_dates` | a contract's scheduled payment dates (0..many); offered as the date dropdown on the Contractor Payments page. Cascades if the contract is hard-deleted. |
| `contract_services` | a contract's SCOPE OF WORK — a name, and nothing else. The optional `price_paise` was REMOVED: this contract is a fixed unit-rate lump sum whose schedule of work attaches no rupee figure to any scope item, so the field could only hold an invented number (and fed a "remainder" line that meant nothing). Their only downstream job is to be NAMED by a debit via `cash_out.contract_service_id` (provenance: "which item was this spend for"). Soft-delete; cascades if the contract is hard-deleted. |
| `contract_allowances` | the contract's allowance CAPS — optional, 0..many per contract. `cap_kind` is `lump` (a rupee ceiling in `cap_paise`) or `per_sqft` (a ceiling RATE in `cap_rate_per_sqft_paise`, which only becomes a rupee cap once the optional `area_milli_sqft` is recorded). Running spend is DERIVED from live `cash_out` rows tagged with the allowance, never typed; the over/under position is displayed and settles nothing. Soft-delete; cascades if the contract is hard-deleted. |
| `ledger_mains` / `ledger_subs` | the ledger taxonomy — 24 main categories and their sub-ledgers, `code` as the primary key. Seeded once from root `ledgers.js` on first boot; from then on the DB is the source of truth. User-editable: export/import as CSV from Data Backup → "Ledger List" (§6). |
| `ledger_customs` | a saved list of custom ledger names typed by hand, so a typed custom is selectable after first use. |
| `contractor_payments` | money PAID to the contractor, each tied to the contract. Ledger fields are an optional *display* tag and do NOT drive dues. |
| `cash_in` | money credited (inflow): amount, `by_type` (`user`/`relative`/`custom`) + attribution, reason. |
| `cash_out` | money debited (outflow): amount, tx_date, `by_type` (`user`/`custom`) + who paid, ledger/sub-ledger (or `CUSTOM`), `contract_scope` (`included`/`extra`, a descriptive label only), `contract_service_id` (the linked `contract_services` row — provenance; NULL when 'extra' or when no item is picked), and `contract_allowance_id` (the allowance this spend draws against; NULL when 'extra' or untagged — NOT unique, since many debits draw against one cap). `contract_stated_paise` is RETIRED: the column is kept nullable so historical values and backups survive, but nothing writes or reads it (§3). `phase`/`subpart` are dormant, stored but unused. |
| `loans` | one-time loan records: amount, bank, interest rate, tenure. `interest_rate` is informational (drives no calculation); interest actually *paid* is a `cash_out` row under ledger 22.5 (Loan interest). |
| `settings` | key/value app options (budget, notification times). Composite `(tenant_id, key)` PK is a holdover from an earlier multi-household design; in this single-owner app it's always keyed to the one owner. |

The ones worth extra context:

- **`users`** holds exactly one row — the fixed local owner (`username: 'owner'`), seeded by `init()`
  on first boot if none exists; every request resolves to that row regardless of any cookie. There is no
  registration and no password check; `password_hash` is a dormant column kept only for schema
  stability. `requireApiAuth` (server.js) / the equivalent in `local-api.js` is a no-op that attaches
  that one row to every request.
- **`ledger_mains` / `ledger_subs`** are seeded once from root `ledgers.js` (24 mains, ~163 subs) the
  first time `init()` runs against an empty pair of tables — a presence check, not a version gate, so
  it can never re-fire and re-seed duplicates on a later boot. The one migration that reaches back into
  already-seeded rows is the generic-name rename (§7) — five labels, by code AND old name, nothing else.
  From then on these two tables are the runtime source of truth; every consumer (dropdowns, validation, the Overview pie) reads from them,
  not from `ledgers.js`. `code` is the primary key and the sole identity across an export/edit/import
  round trip — no hidden internal id.
- **`settings`** has a composite `(tenant_id, key)` primary key, a holdover from an earlier
  multi-household design that was later collapsed back to single-user (see §8). In the current app
  `tenant_id` is always the one owner's id.

### Invariants enforced in the DATABASE (not just app code)
- **One live contract.** `idx_contract_single_live` (partial unique index on
  `contract WHERE deleted_at IS NULL`) makes a second live contract fail at INSERT/UPDATE.
  Soft-deleted contracts may coexist with the one live row.
- **One service, one live debit.** `idx_cash_out_service_live` (partial unique index on
  `cash_out(contract_service_id) WHERE contract_service_id IS NOT NULL AND deleted_at IS NULL`) makes
  at most one live debit link any given `contract_services` row. It existed to stop one service
  offsetting the dues twice; with the reimbursement offset removed (§3) the link is pure provenance,
  so the index now guards a bookkeeping rule rather than a figure. Kept as-is. Contract Phase A did
  NOT touch it — it never depended on the service price — but it did remove the app-level rule that
  sat beside it ("only a PRICED service can be linked"), which went out with the column. The app
  layers a naming 409 on create/edit/restore on top of the DB constraint, so the failure arrives as a
  readable error rather than a raw index violation.
- **Many debits, one allowance — the deliberate non-index.** `idx_cash_out_allowance_live` (partial
  index on `cash_out(contract_allowance_id) WHERE contract_allowance_id IS NOT NULL AND deleted_at IS NULL`)
  is **not unique**, unlike its service counterpart. An allowance is a CAP that accumulates
  a running spend from many entries; uniqueness there would break the feature rather than protect
  it. The index exists for the rollup query, not as a constraint.
- **Soft-delete everywhere.** The five Recycle Bin tables (`cash_in`, `cash_out`, `loans`, `contract`,
  `contractor_payments`) carry `deleted_at TEXT` (NULL = live); "delete" sets it, the Recycle Bin restores
  or permanently removes. Hard-deleting a contract is blocked while any live `contractor_payments` OR
  any cash-out entry still references one of its `contract_services` rows (the second guard closes a
  foreign-key crash found in the Phase 11 audit). The JSON backup keeps soft-deleted rows; the
  "CSV for Excel" export shows live rows only.
- **Integer paise.** Every `*_paise` column is INTEGER; money is never a float (₹1 = 100 paise;
  formatting to ₹ is display-only).

---

## 3. Dues (owed), and the reimbursement offset that was REMOVED

```
owed (F) = contract.price_of_contract_paise            (0 when no price is stated)
         − Σ contractor_payments.amount_paise         (cumulative)
```

**Worked example.** Contract stated **₹25,00,000**; a payment of **₹5,00,000**; a debit of **₹32,000**
marked *Contract Included: Yes* → **owed = ₹20,00,000** (25,00,000 − 5,00,000). Spent-by-self (C)
shows the real **₹32,000** and Total spent (D) includes it, but the included debit does **not** reduce
owed. `owed` is never clamped — if the contractor is overpaid relative to the contract it goes negative
and the UI presents that as "Overpaid by ₹X" rather than a due amount.

**What changed, and why it is all-or-nothing.** Phase 5E's "Option C" offset had an included debit also
carry `contract_stated_paise` (what the contract stated for that item), subtracted from owed. That
third term is gone:

- The Cash Outflow form no longer asks for a stated amount, and no code path writes the column.
- **Legacy rows that still hold a value do not contribute either.** Owed must not depend on whether a
  row was entered before or after the change; a half-live offset is worse than no offset.
- `contract_stated_paise` remains in the schema, nullable and unused. Backups still round-trip it and
  editing a legacy row leaves it untouched (the column is simply not in the CRUD write list), so the
  history survives. Dropping a column in SQLite is a full table rebuild — not worth it for dead data.
- **Contract Included (Yes/No) stays** — as a descriptive label. It changes no figure.

**Two contract fields, both optional now.** `price_of_contract_paise` (Total contract value) is also
optional: a contract with no stated price contributes 0 to Total contract (A) and 0 to owed, while its
payments still count in B/D/pie.

**The stated price may be DERIVED (Contract Phase A).** A fixed unit-rate lump sum contract prices
the work as `rate_per_sqft_paise × measured_area_milli_sqft`. Both halves are optional and
independently editable — the rate is fixed at signing, the area is not known until final measurement.
When both are present the write path MATERIALISES their product into `price_of_contract_paise`, so
owed, figure A, the PDF and the Contractor Payments "Remaining" line all keep reading the one column
they always read and nothing downstream learns about rates. `pricingMode` (`rate` | `typed` | `none`)
tells the UI which it is, so a computed figure is never presented as one the owner typed. Because the
stored price is derived-and-materialised it can drift — a restored backup writes columns verbatim
rather than re-running the write path — so `reconciliation.contractPriceDerivation` recomputes and
flags it (§4). Re-saving the contract is the repair.

**Allowance caps are DISPLAYED, never settled.** `contract_allowances` holds the only rupee figures
a contract attaches to named items. Plannr SEEDS NONE of them: a contract starts with an empty
allowance list and every cap is one the owner entered (there was once an opt-in ten-row default set
lifted from one agreement — file, endpoint and button are all gone). Spend against a cap is derived from live `cash_out` rows tagged
with `contract_allowance_id`; the position is `effective cap − spend`, signed. Where a contract says an
overrun is added to the next progress payment and an underrun subtracted from the final, that is a
decision the owner makes on the day, so **no allowance figure touches owed, Total contract, or any
Overview total**. A `per_sqft` cap with no area recorded has no rupee ceiling at all and reports no
position, rather than inventing an area to manufacture one.

**Cumulative vs range-scoped (critical).** Owed and paid totals are a *balance* — summed over the full
set. The pie, Paid-to-contractors (B) and Spent-by-self (C) are scoped to the selected date range. A
date range that excludes a payment still leaves owed unchanged.

---

## 4. Overview money model (`GET /api/overview` → `money`)

A `totalContractPaise` (cumulative), B `paidToContractorsPaise` (range), C `spentBySelfPaise` (range),
D `totalSpentPaise` = B + C (range), E `loanReceivedPaise` (cumulative), F `owedToContractorsPaise`
(cumulative, unclamped). Plus `ledgers` (the pie rollup — 24 distinctly-coloured mains, a
"Custom/Uncategorized" bucket for `CUSTOM` spend, and an algorithmically-generated colour for any
main added past the 24th via the Ledger List CSV import so it never reuses an existing colour),
`contracts` (the contract's stated/paid/owed), and `budgetPaise`.

**Where the figures surface:** the on-screen `/overview` summary bar shows **Spent-by-self (C),
Paid-to-contractors (B), Total (D), and Owed to contractors (F)** — the same F value the PDF prints.
Total Contract (A) and Loan Received (E) are **not** broken out as their own on-screen figures (A
gates whether the Owed block renders at all). The downloadable PDF shows the full set of six.
Contractor Payments shows "Remaining = stated − Σ payments", which is now the SAME formula as owed
(F) — with the reimbursement offset gone the two figures agree.

### `reconciliation` — flags, never silent corrections
Every figure is reported as-is; these only detect + report (and log) inconsistencies:
`ok` (false if any trip), `orphanedContractorPayments` `{count, amountPaise, contractIds}` (live
payments whose parent contract is soft-deleted/missing — their ₹ is still in B/D/pie but is not
counted in A/F), `overOffset` `{over, contractPaise, appliedPaise, excessPaise}` (contractor payments
exceed the contract value — the name is a holdover; with the offset gone `appliedPaise` is just the
payments total), and `contractPriceDerivation` (Contract Phase A: a
rate-priced contract whose stored `price_of_contract_paise` no longer equals rate × measured area —
`{ drifted, contracts: [{ contractId, storedPaise, expectedPaise }] }`). `includedDebitsMissingOffset`
was **removed**: it fired on any `included` debit with a NULL/0 stated amount, which is now every
ordinary entry. When `ok` is false a banner shows on `/overview`; the numbers themselves are never
changed. Note there is NO reconciliation check over contract services or allowances: services carry
no figures at all now, and an allowance overrun is a normal state of the world, not an inconsistency.

---

## 5. Running the tests

- **`npm test`** (`run-tests.js`) → `node --test` over `test/*.test.js`, using Node's built-in runner
  (no test framework dependency). Deterministic; asserts the resolved `PLANNR_DB` is never the live
  path, and checks `data/plannr.db`'s mtime is unchanged across the whole run. Two absolute safety
  properties hold it together: **it never opens the live DB** — each test file sets a unique temp
  `PLANNR_DB` before requiring `db.js`/`server.js`, a test asserts the resolved `DB_PATH` is not the
  live path, and `run-tests.js` records `data/plannr.db`'s mtime before and after the whole run and
  fails if it changed; and **`server.js` gates its external side effects** (`app.listen`, signal
  handlers) behind `require.main === module`, so tests can import it. `npm start` is unchanged.
- **`npm run test:ui`** (`test-ui/run.js`) → the Playwright visual suite: pie swatch distinctness,
  table width/edit invariants, unclipped large amounts, By-owner attribution, dirty-check no-op save.
  Boots `server.js` in-process on an isolated DB.
- **`npm run test:static-hosting`** (`test-ui/static-hosting.js`) → boots `local-server.js` (a real
  child process, genuinely empty DB — what a fresh device install looks like) and drives it with a
  real Playwright browser: nav-link correctness under plain static hosting, the Ledger List CSV
  export/import round trip (rename, addition, every rejection case), and the native-save/confirmation
  flow on the four file-producing paths in Data Backup.
- **`npm run test:backup-crypto`** (`test-ui/backup-crypto.js`) → round-trips the encrypted backup
  format through the real export/import routes on a live temp DB.
- **`npm run test:palette`** (`test-ui/palette-distinctness.js`) → seeds every main ledger, renders
  the real Overview pie, reads the colours back off the SVG and the legend, and measures CIEDE2000
  across all 276 pairs. Replaces an assertion that checked 24 distinct *strings* and therefore passed
  while two pale greens sat ΔE00 6.30 apart in the legend. Also pins the ΔE implementation itself
  against published reference data, and checks the PDF's separate palette + its Custom colour.
- **`npm run test:ledger-picker`** (`test-ui/ledger-picker.js`) → the searchable, grouped ledger
  browser: seven sections with every main in exactly one of them, search matching both mains and
  sub-ledgers, and — the checks that matter — that picking through the panel leaves the native
  `<select>` holding the right value and fires the `change` the sub-ledger rebuild and the Custom…
  reveal depend on. Plus the phone-width behaviour (full-bleed panel, 48px rows, no overflow).
- **`npm run test:disclosure`** (`test-ui/disclosure.js`) → the shared "what's this" toggle on every
  page that carries one: collapsed on load, opens to real text, keyboard-focusable with a visible focus
  ring, and no horizontal overflow at 390px with every section revealed and every toggle open. Guards
  the one way this component can fail silently — text that is collapsed AND unreachable has been
  deleted, not disclosed.
- **`npm run test:contract-layout`** (`test-ui/contract-details-layout.js`) → Contract Details at
  390px: the optional block collapsed but auto-opening when it holds data, every optional field
  actually inside it and no core field swept in, the allowance table hidden when empty, per-field
  labels appearing when the grid collapses to one column, and no horizontal overflow.
- **`npm run test:contract-phase-a`** (`test-ui/contract-phase-a.js`) → the Contract Details page in a
  real browser: the derived-total readout appearing and disabling the typed field, the derived
  expected completion date, the scope list with no price input left on it, entering allowance caps by
  hand (nothing seeds them), the two different over/under wordings, and drawing spend against a cap
  from the debit form.
  Fails on any console error.

---

## 6. Recovery paths (all local, all tested)

- **Data loss / bad edit.** JSON backup (`/data-backup`) is a full export/import incl. soft-deleted
  rows, ids and FKs preserved; import validates fully, auto-snapshots current data, then replaces in
  one transaction (rolls back on any error). The **Recycle Bin** restores individually soft-deleted
  rows.
- **Ledger taxonomy edit gone wrong.** Every Ledger List CSV import triggers a mandatory encrypted
  backup first, which you must explicitly confirm you have (a modal names the exact file) before the
  import is allowed to proceed. Import is rejected outright — no partial taxonomy change — if any
  code would be removed while still referenced by existing spend.
- **A destructive migration refusing to boot.** Two migrations in `db.js` can destroy data and both
  REFUSE and explain rather than proceed silently: the Phase 10a ledger-taxonomy cleanup (which
  deletes every `cash_out` row) and Contract Phase A's A3 step (which drops
  `contract_services.price_paise`). Both are gated on their own `settings` marker, not the shared
  `user_version`, so a database already stamped at the current schema version still runs them once.
  Both print what is at stake and both approval hatches — an env var for Node/desktop
  (`PLANNR_ALLOW_TAXONOMY_WIPE=1` / `PLANNR_ALLOW_SERVICE_PRICE_DROP=1`) and a `settings` key for the
  Android build, which has no environment variables. Approve only after exporting a backup. Each is
  pinned by a spawned-process fixture (`test/_taxonomy-guard-fixture.js`,
  `test/_service-price-guard-fixture.js`) covering refuse / lose-nothing / repeat / both hatches /
  ordinary paths unaffected.
- **Database → encrypted snapshots (desktop mode only).** `backup-db.js` writes a consistent
  `VACUUM INTO` snapshot, AES-256-GCM-encrypted when `PLANNR_BACKUP_PASSPHRASE` is set; `decrypt-db.js`
  is the restore step. This applies to a `server.js` install; the Android app's own backup/restore
  goes through the in-app encrypted export/import instead.

### The five file formats `/data-backup` produces

- **JSON backup** — full export/import of every ledger table *including soft-deleted rows*, ids and
  foreign keys preserved. Import validates fully, auto-snapshots current data first, then replaces in
  one transaction (rolls back on any error). The only fully re-importable whole-database format.
- **Encrypted backup** — the same full snapshot, AES-256-GCM-encrypted with a passphrase you choose
  (`backup-crypto.js`). On Android, saving and restoring both go through `Filesystem`/`Share` (the
  native save/share sheet); in a browser they're a plain download.
- **Ledger List CSV** — the 24-main taxonomy itself, exportable and re-importable (Code, Main ledger,
  Sub-code, Sub-ledger columns; `code` is the identity). Renames are allowed and keep historical spend
  attached (the join is always by code); additions are allowed; deletions only for codes with no spend
  against them. Every import triggers a mandatory encrypted safety backup first, which you must
  explicitly confirm you have before the import proceeds — see `data-backup.html`.
- **CSV for Excel** — one file per table, amounts in rupees, live rows only. View/print only; this one
  is **not** re-importable (only the Ledger List CSV above is).
- **PDF (Overview)** — four parts (full / pie / table / ledger) × light/dark. Rendered by headless
  Chromium under `server.js`, or by the on-device native PDF plugin
  (`@capgo/capacitor-pdf-generator`) on Android — same HTML/layout either way, and shared/saved
  through the same native path as the encrypted backup.

### Guards on the destructive scripts

`server.js` defaults to the live `data/plannr.db` (correct — it *is* the app, in desktop mode). Every
**non-server script** instead goes through `db-guard.js`: it prints the absolute path it will write to
and **refuses the live DB** (an unset `PLANNR_DB` counts as live) unless you pass
`--i-really-mean-the-live-db`. So a forgotten `PLANNR_DB=` cannot hit real data by accident.

```sh
PLANNR_DB=/tmp/x.db npm run reset-db                          # wipe an isolated copy (safe)
node reset-db.js --confirm --i-really-mean-the-live-db        # wipe the LIVE (desktop-mode) database
```

`reset-db.js` derives the table list from `sqlite_master` (never a hardcoded array, so a new table
can't be silently skipped), disables foreign keys for the wipe (set before `BEGIN`, restored after
`COMMIT`), and runs `PRAGMA foreign_key_check` afterward. `--confirm` confirms intent; the guard
confirms the target (and requires the live flag for live). There is deliberately **no in-app reset
button**.

---

## 7. Deliberate decisions (not accidents)

- **One live contract.** Enforced in the DB, not just the UI. Contract Details is edit-in-place once
  the contract exists; Contractor Payments auto-selects it.
- **No login, no accounts.** This collapsed a previous multi-household ("tenancy") design back down
  to a single fixed owner row — the app is built for one person's own project, not a hosted service.
  `settings`' composite `(tenant_id, key)` primary key is the one visible remnant of that.
- **Dormant columns kept on purpose** (`cash_out.phase`/`subpart`, `users.password_hash`, the
  contract's optional free-form `amount_paise`) — stored, unused, retained rather than dropped, to
  avoid a schema rebuild for no functional gain.
- **`contract_services.price_paise` was DROPPED, not retired** — the one exception to the rule above,
  and deliberately so. A retired-but-present money column is worse than a dropped one here: the form
  would keep asking for a per-item price the contract does not have, and every answer would be a
  number the owner made up. Dropping it is what removes the question. `ALTER TABLE … DROP COLUMN`
  sufficed (no index or constraint referenced it), so no rebuild was needed. The migration is
  marker-gated and REFUSES TO BOOT if any service actually holds a price, listing the figures in the
  error and archiving them into `settings._archived_service_prices_v1` on an approved run — so they
  survive in every backup even though the column does not. See §6.
- **One line on the page, the rest behind `.wt`.** Every section is a heading, ONE line of description,
  and the control. Anything that genuinely matters but does not fit that line goes in a collapsed
  `<details class="wt">` ("what's this"), defined once in `styles.css` and used by Data Backup, Contract
  Details, Overview and Home. Native `<details>`: no JS, keyboard- and screen-reader-operable for free,
  and legal under this app's CSP. Two rules keep it honest — a destructive action states what it destroys
  ONCE, on the page, in the open (never behind the toggle); and error/validation messages are exempt
  entirely, because they appear only when something has already gone wrong and need to be specific.
  Data Backup went from 485 words on load to 217 under this rule.
- **A taxonomy RENAME is not a taxonomy WIPE.** Five seeded sub-ledger labels were copied out of one
  agreement ("Foundation depth beyond 2.5 ft", "Plinth height beyond 1.5 ft") or named one region's
  supplier ("Electricity connection (KSEB)", "Equipment rental — mixer, JCB", "Plastic waste —
  Harithakarmasena"); `ledgers.js` now seeds generic names, and `_migrated_generic_ledger_names_v1`
  renames them on an installed database. That migration is deliberately NOT gated behind an approval
  hatch like the Phase 10a cleanup, because it destroys nothing: no row is deleted and **no code
  changes**, and a code is the taxonomy's identity across a rename, so every debit keeps pointing at
  exactly the sub-ledger it always pointed at. Each UPDATE matches the OLD NAME as well as the code, so
  a label the household already edited via CSV is left alone. Pinned by `test/_ledger-rename-fixture.js`
  (fresh seed / rename in place / spend and codes intact / owner edit respected / not repeated).
- **A derived price is materialised, not computed on read.** Rate × area is written into
  `price_of_contract_paise` rather than assembled in `contractRow()`. That keeps owed, figure A, the
  PDF and Contractor Payments reading exactly the column they always read (a one-line change instead
  of five), at the cost of a value that can drift — which is why `contractPriceDerivation` exists to
  catch it (§4). The trade was taken knowingly.
- **Allowance spend is derived from tagged debits, never typed.** The alternative — a "spent so far"
  field on each allowance — would be exactly the invented number that got the service price removed.
- **The ledger picker is a facade over the `<select>`, not a replacement.** `createLedgerBrowser`
  (`plannr-ui.js`) renders the visible control; the native `<select>` stays in the DOM, hidden
  (`.lb-native`), and remains the value carrier. Every selection writes to it and dispatches
  `change`, which is the only reason `createCashOutForm`/`createLedgerPicker` needed no changes —
  their `buildSubs`, `syncCustom` and `readBody` all still hang off that one event. Do not "tidy
  this up" by deleting the select.
- **The picker's grouping is ONE constant.** `LEDGER_GROUPS` in `plannr-ui.js`, inclusive `from`/`to`
  main-ledger numbers. A main outside every range falls into a trailing "Other" group rather than
  disappearing, because the Ledger List CSV can add a 25th. Remapping for a new taxonomy is editing
  that array and nothing else; the v2 mapping sits beside it, commented out.
- **Chart colours are derived, not chosen.** Both palettes (`LEDGER_PALETTE` in `overview.html`,
  `PDF_PALETTE` in `server.js` + `local-api.js`) are the output of `test-ui/derive-palette.js`, which
  maximises the smallest pairwise CIEDE2000 subject to each colour staying within an identity budget
  of the one it replaces. The screen palette is at min ΔE00 13.82 with every colour ≥ 3:1 against the
  panel; the PDF's is at 6.00 and that is a ceiling, not an oversight — it keeps a single amber hue
  family by design, and hue is the axis that separates categories. Past the fixed 24 a derived
  extension table takes over from what used to be a golden-angle generator; that generator spread
  extras apart from each other while being blind to the palette it was extending, and reached ΔE00
  2.83. Changing a palette by hand and skipping the tool will not be caught by review, only by
  `npm run test:palette`.
- **Loan interest is a ledger spend, under 22.5.** Interest actually paid on a construction loan is
  recorded as an ordinary `cash_out` row, so it counts in total spend. `loans.interest_rate` is
  informational only (drives no calculation), so there is no derived figure to double-count against.
- **The ledger taxonomy is data, not code.** `ledgers.js` is seed data only, read once on first boot;
  the DB (`ledger_mains`/`ledger_subs`) is what every consumer actually reads, specifically so the
  owner can rename/add/remove categories over the life of a real project without a code change.
- **Per-environment duplication, not a shared backend.** `server.js` and `public/local-api.js`
  implement the same API surface as two independent, mostly byte-for-byte-duplicated files rather than
  one shared module, so the Android app's fetch shim has zero runtime dependency on Node. `repo.js`
  (the data-access layer under both) is the deliberate exception — kept as one shared, synced file
  because its ledger-CSV validation logic is safety-critical enough that two drifting copies would be
  worse than the duplication it avoids elsewhere.

---

## 8. What is NOT done, and why

- **`server.js` is one large file.** It has grown well past a comfortable size and has not been split
  into modules; it works and is tested, but it is the main structural debt.
- **Owed (F) on-screen matches the PDF exactly** — this used to differ (an earlier version showed only
  B/C/D on-screen); if you're reading old notes elsewhere that say otherwise, they're stale.
- **The native Filesystem/Share save path on Android has not been exercised on a real device by this
  round of work** — it was added by exact analogy to the already-device-verified PDF share path and
  passes every test that can run in a browser (where `Capacitor.isNativePlatform()` is always false),
  but the native branch itself needs a real device/emulator check before real data goes in.

---

## 9. Troubleshooting — by symptom

### A save "succeeded" but the value isn't in the database
Every commit lands directly in `data/plannr.db` (desktop mode) with `journal_mode = DELETE` — no
`-wal`/`-shm` sidecar that a naive copy could leave behind. If you're troubleshooting a very old
install that predates that change (still shows a non-trivial `data\plannr.db-wal` via
`Get-ChildItem data\plannr.db*`), a copy of `plannr.db` alone without its sidecars was the cause — copy
all three files together.

### A backup "downloaded" on Android but you can't find the file
Confirm you actually completed the native share sheet Android pops up after the backup is written —
the file is saved to the app's cache and handed to whatever app you choose in that sheet (Files,
Drive, etc.); it does not silently land in a Downloads folder the way a browser download would.

### Ledger List CSV import was rejected
The error message lists exactly which codes are the problem and why — a duplicate code, a malformed
code (mains must be `N.0`, subs `N.M` under an existing main), a sub referencing a main not present in
the file, or (most commonly) a code that's missing from your edited file but still has real spend
recorded against it. Add that code back (even just as a bare rename target) rather than deleting it,
or reassign the affected entries first.
