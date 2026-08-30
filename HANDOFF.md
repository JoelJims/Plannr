# Plannr — System Reference

Core reference for how Plannr works: what it is, the schema and its invariants, the dues
mechanic, the backup/recovery paths, the deliberate decisions and why, the known limitations, and
troubleshooting by symptom. `README.md` is the fuller feature/setup reference; this file is the model
and the operational knowledge.

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

**Run it:** see `README.md` → "How it runs" for desktop (`node server.js`) vs. Android
(`npm run android:sync` + Android Studio) vs. the static-hosting test mode (`node local-server.js`).

---

## 2. Schema (`data/plannr.db` under server.js; a separate on-device DB under the Android app)

See `README.md` for the full table list. The ones worth extra context here:

- **`users`** holds exactly one row — the fixed local owner, seeded on first boot. There is no
  registration and no password check; `password_hash` is a dormant column kept only for schema
  stability. `requireApiAuth` (server.js) / the equivalent in `local-api.js` is a no-op that attaches
  that one row to every request.
- **`ledger_mains` / `ledger_subs`** are seeded once from root `ledgers.js` (24 mains, ~163 subs) the
  first time `init()` runs against an empty pair of tables — a presence check, not a version gate, so
  it can never re-fire and re-seed duplicates on a later boot. From then on these two tables are the
  runtime source of truth; every consumer (dropdowns, validation, the Overview pie) reads from them,
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
  sat beside it ("only a PRICED service can be linked"), which went out with the column.
- **Many debits, one allowance — the deliberate non-index.** `idx_cash_out_allowance_live` is
  partial and **not unique**, unlike its service counterpart. An allowance is a CAP that accumulates
  a running spend from many entries; uniqueness there would break the feature rather than protect
  it. The index exists for the rollup query, not as a constraint.
- **Soft-delete everywhere.** The five Recycle Bin tables (`cash_in`, `cash_out`, `loans`, `contract`,
  `contractor_payments`) carry `deleted_at` (NULL = live); "delete" sets it, the Recycle Bin restores
  or permanently removes. Hard-deleting a contract is blocked while any live `contractor_payments` OR
  any cash-out entry still references one of its `contract_services` rows (the second guard closes a
  foreign-key crash found in the Phase 11 audit).
- **Integer paise.** Every `*_paise` column is INTEGER; money is never a float.

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

**The stated price may be DERIVED (Contract Phase A).** This contract is a fixed unit-rate lump sum:
its price is `rate_per_sqft_paise × measured_area_milli_sqft`. Both halves are optional and
independently editable — the rate is fixed at signing, the area is not known until final measurement.
When both are present the write path MATERIALISES their product into `price_of_contract_paise`, so
owed, figure A, the PDF and the Contractor Payments "Remaining" line all keep reading the one column
they always read and nothing downstream learns about rates. `pricingMode` (`rate` | `typed` | `none`)
tells the UI which it is, so a computed figure is never presented as one the owner typed. Because the
stored price is derived-and-materialised it can drift — a restored backup writes columns verbatim
rather than re-running the write path — so `reconciliation.contractPriceDerivation` recomputes and
flags it (§4). Re-saving the contract is the repair.

**Allowance caps are DISPLAYED, never settled.** `contract_allowances` holds the only rupee figures
the contract attaches to named items. Spend against a cap is derived from live `cash_out` rows tagged
with `contract_allowance_id`; the position is `effective cap − spend`, signed. Per the contract an
overrun is added to the next progress payment and an underrun subtracted from the final — that is a
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
`ok` (false if any trip), `orphanedContractorPayments` (payments whose contract is soft-deleted/gone),
`overOffset` (contractor payments exceed the contract value — the name is a holdover; with the offset
gone `appliedPaise` is just the payments total), and `contractPriceDerivation` (Contract Phase A: a
rate-priced contract whose stored `price_of_contract_paise` no longer equals rate × measured area —
`{ drifted, contracts: [{ contractId, storedPaise, expectedPaise }] }`). `includedDebitsMissingOffset`
was **removed**: it fired on any `included` debit with a NULL/0 stated amount, which is now every
ordinary entry. When `ok` is false a banner shows on `/overview`; the numbers themselves are never
changed. Note there is NO reconciliation check over contract services or allowances: services carry
no figures at all now, and an allowance overrun is a normal state of the world, not an inconsistency.

---

## 5. Running the tests

- **`npm test`** (`run-tests.js`) → `node --test` over `test/*.test.js`. Deterministic; asserts the
  resolved `PLANNR_DB` is never the live path, and checks `data/plannr.db`'s mtime is unchanged across
  the whole run.
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
- **`npm run test:contract-phase-a`** (`test-ui/contract-phase-a.js`) → the Contract Details page in a
  real browser: the derived-total readout appearing and disabling the typed field, the derived
  expected completion date, the scope list with no price input left on it, seeding the ten allowance
  caps, the two different over/under wordings, and drawing spend against a cap from the debit form.
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
- **A derived price is materialised, not computed on read.** Rate × area is written into
  `price_of_contract_paise` rather than assembled in `contractRow()`. That keeps owed, figure A, the
  PDF and Contractor Payments reading exactly the column they always read (a one-line change instead
  of five), at the cost of a value that can drift — which is why `contractPriceDerivation` exists to
  catch it (§4). The trade was taken knowingly.
- **Allowance spend is derived from tagged debits, never typed.** The alternative — a "spent so far"
  field on each allowance — would be exactly the invented number that got the service price removed.
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
