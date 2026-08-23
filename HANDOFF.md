# Plannr — System Reference

Core reference for how Plannr works: what it is, the schema and its invariants, the reimbursement
mechanic, the notification architecture, recovery paths, the deliberate decisions and why, the known
limitations, and troubleshooting by symptom. `README.md` is the fuller feature reference (tenancy,
search/filter, exports, encrypted backups, hosting-readiness); this file is the model and the
operational knowledge.

---

## 1. What Plannr is

A **construction-spend ledger** for a household's building project, run by the owner on their own
Windows laptop on the local network. It records money in/out, tracks what is owed to the contractor,
categorises spend across 23 fixed ledgers, and emails/WhatsApps a daily PDF summary. One account per
household; the tenant data-access model (`repo.js`) is documented in `README.md` → Tenancy.

**Stack (no build step, no framework):**
- Node.js + Express 4.21.2; server-rendered static HTML in `public/` + vanilla JS (no SPA).
- `node:sqlite` (`DatabaseSync`) — the built-in SQLite, DELETE journal mode (Phase 4a — changed from WAL to prepare for the WASM SQLite port; a WAL-stamped file can't be opened by that build); DB at `data/plannr.db`.
- `bcrypt` (native) for password hashing; SHA-256 session-cookie tokens.
- Playwright (headless Chromium) renders the Overview PDF server-side.
- `whatsapp-web.js` (unofficial) for the WhatsApp channel; `nodemailer` (Gmail SMTP) for email.
- `node-cron` for the in-process daily scheduler.
- No bundler, no CSS framework, no ORM.

**Run it:** `npm start` (or `node server.js`) **from the project root** — `process.loadEnvFile()`
resolves `.env` relative to the working directory, so a wrong CWD means `GMAIL_USER` /
`GMAIL_APP_PASSWORD` are undefined and email fails with "credentials are not configured". Serves on
`http://localhost:3000` and on the LAN IP. `.env` holds the Gmail credentials and the optional
`PLANNR_BACKUP_PASSPHRASE` (for encrypted backups — see `README.md`).

---

## 2. Schema (`data/plannr.db`)

Core tables (see `README.md` for the complete list, including `contract_services` and `ledger_customs`):

| table | holds |
|---|---|
| `users` | accounts: `username` (unique, case-insensitive), `display_name`, bcrypt `password_hash`. |
| `sessions` | one row per active login; only the SHA-256 hash of the cookie token is stored (never the token). `expires_at` = created + 90 days; records origin `ip` + `user_agent`; cascades on user delete. |
| `contract` | the household's contract: contractor, area, headline ledger tag, `price_of_contract_paise` (**REQUIRED** — the stated amount; dues math starts here), an optional free-form `amount_paise`, date signed, optional end date. |
| `contract_payment_dates` | a contract's scheduled payment dates (0..many); offered as the date dropdown on Contractor Payments, and surfaced forward on Overview + the daily report. |
| `contractor_payments` | money PAID to the contractor, each tied to the contract. Ledger fields are an optional *display* tag and do NOT drive dues. |
| `cash_in` | money credited (inflow): amount, `by_type` (`user`/`relative`/`custom`) + attribution, reason. |
| `cash_out` | money debited (outflow): amount, tx_date, `by_type` (`user`/`custom`) + who paid, ledger/sub-ledger (or `CUSTOM`), `contract_scope` (`included`/`extra`), `contract_stated_paise` (reimbursement offset). `phase`/`subpart` columns are **dormant** — stored, unused, kept on purpose. |
| `loans` | one-time loan records: amount, bank, interest rate, tenure. Loan interest lives only here. |
| `settings` | per-tenant key/value options (composite `(tenant_id, key)` PK): overall budget, the two daily-report schedules + recipients, last-send/catch-up bookkeeping, and the bounded auth-event rings. |
| `edit_locks` | the single-editor lock for the Overview editable table (holder + heartbeat; auto-releasable after 180s stale). |

### Invariants enforced in the DATABASE (not just app code)
- **One live contract per household.** `idx_contract_single_live_tenant` (partial unique index on
  `contract(tenant_id) WHERE deleted_at IS NULL`) makes a second live contract for the same tenant fail
  at INSERT/UPDATE. Soft-deleted contracts may coexist with the one live row.
- **Soft-delete everywhere.** Transactional tables carry `deleted_at` (NULL = live); "delete" sets it,
  the Recycle Bin restores or permanently removes. JSON backup keeps soft-deleted rows; CSV shows live
  only.
- **Integer paise.** Every `*_paise` column is INTEGER; money is never a float.
- Legacy note: `cash_out.by_type` could in principle be `'contractor'` (no longer written; verified 0
  such rows live).

---

## 3. The reimbursement mechanic (Option C) — the one non-obvious money rule

A debit marked **Contract Included: Yes** carries `contract_stated_paise` — what the contract *stated*
for that item, distinct from what was actually spent. It reduces the contractor's dues while the real
spend still counts as spending, so the gap falls out automatically:

```
owed (F) = contract.price_of_contract_paise
         − Σ contractor_payments.amount_paise                                  (cumulative)
         − Σ cash_out.contract_stated_paise WHERE contract_scope = 'included'  (cumulative)
```

**Worked example.** Contract stated **₹25,00,000**; a payment of **₹5,00,000**; an included debit that
the contract stated **₹40,000** for but only **₹32,000** was spent → **owed = ₹19,60,000**
(25,00,000 − 5,00,000 − 40,000). Spent-by-self (C) shows the real **₹32,000**; the **₹8,000** gap
between stated and spent falls out on its own. Reconciliation stays quiet because the data is consistent.

**Cumulative vs range-scoped (critical).** The offset and paid totals are a *balance* — summed over
the full set. The pie, Paid-to-contractors (B) and Spent-by-self (C) are scoped to the selected date
range. A date range that excludes the included debit still leaves owed unchanged.

---

## 4. Overview money model (`GET /api/overview` → `money`)

A `totalContractPaise` (cumulative), B `paidToContractorsPaise` (range), C `spentBySelfPaise` (range),
D `totalSpentPaise` = B + C (range), E `loanReceivedPaise` (cumulative), F `owedToContractorsPaise`
(cumulative). Plus `ledgers` (the 23-colour pie rollup), `contracts` (the contract's
stated/paid/offset/owed), `budgetPaise`, `upcomingPayments`, and `reconciliation`.

**Where the figures surface:**
- **On-screen `/overview`** deliberately shows only the spending figures — **Spent-by-self (C),
  Paid-to-contractors (B), Total (D)** — plus the pie and the editable transactions table (which
  includes the *Contract Included* and *Contract Stated* columns). Total Contract (A), Loan Received
  (E) and **Owed to Contractors (F) are intentionally omitted from the on-screen summary bar.**
- **The downloadable PDF** shows the full set: all six headline figures **including Owed (F)** and an
  "Owed on the contract" table (stated − paid − offset per contract).
- **Contractor Payments** shows a *simple* "Remaining = stated − Σ payments" (e.g. ₹20,00,000) that
  **deliberately excludes the reimbursement offset** — it is not the same as owed (F).
- So the reimbursement-adjusted **owed (F) is a PDF-only figure on the interactive side.** This is by
  design, but it surprises first-time users; see §9 friction.

### `reconciliation` — flags, never silent corrections
Every figure is reported as-is; these only detect + report (and log) inconsistencies:
`ok` (false if any trip), `orphanedContractorPayments` (payments whose contract is soft-deleted/gone),
`includedDebitsMissingOffset` (`included` debits with NULL/0 offset — reachable via an older import),
`overOffset` (payments + offsets exceed the contract value). When `ok` is false a banner shows on
`/overview` (amber) and the flags are stamped on the PDF; the numbers are never changed.

---

## 5. Notification architecture (Daily Report)

Two **independent** schedules — email send-times and WhatsApp send-times — configured and fired
separately (Home → Daily Report). Email = Gmail SMTP via nodemailer; WhatsApp = a resident
`whatsapp-web.js` client reusing a persisted session (`.wwebjs_auth/`). Both attach the same
light-theme Overview PDF, and both carry a "what changed since the last report" summary (entries logged
since the last successful send, movement in the headline figures, today's individual transactions, and
the next scheduled payment). All times are **IST wall-clock** (`Asia/Kolkata`, no hardcoded +5:30);
stored timestamps stay UTC.

**Hard constraint: the scheduler is an in-process `node-cron` timer, not OS cron.** It fires only
while `node server.js` is running. If the process is down at a scheduled minute, that live send is
missed, not queued.

**Catch-up on startup.** After the scheduler is up and the server is listening, each channel is checked
independently: if it has recipients, ≥1 send time, that day's *earliest* time has already passed in IST,
and no success is recorded for today → it sends **one** catch-up (labelled `… (catch-up for
YYYY-MM-DD)` in subject/caption/filename). One per channel per day, never a backlog (the PDF is a
current snapshot, not a per-day diff). A WhatsApp catch-up waits (bounded) for the reused session to
reconnect. It records last-success only on a genuine success, so a skip/failure leaves the date
unwritten and the next boot retries. `PLANNR_NO_CATCHUP=1` disables it (set by the test suite). What it
does **not** fix: a machine off/asleep at boot-time too still sends nothing.

---

## 6. Running the tests

- **`npm test`** → `node --test` over `test/*.test.js`, then the cross-tenant isolation harness
  (`test-isolation/run.js`, must read **0 leaks**). Structurally cannot send: the harness sets
  `PLANNR_TEST=1` (so `whatsapp.init()` is a no-op and `makeTransport()` returns null) and
  `PLANNR_NO_CATCHUP=1`, points `PLANNR_DB` at a per-file temp DB, asserts the resolved DB path is
  **not** the live one, and (via `run-tests.js`) checks `data/plannr.db`'s mtime is unchanged across the
  whole run. Deterministic across repeated runs.
- **`npm run test:ui`** → the Playwright visual suite (`test-ui/run.js`): 0 CSP violations on every
  page, the 23-colour pie, table width/edit invariants, unclipped large amounts, By-owner attribution,
  dirty-check no-op save. Boots in-process on an isolated DB.

---

## 7. Recovery paths (all local, all tested)

- **Forgot password → offline reset.** `node set-password.js` sets a new password directly against the
  DB (bcrypt), no email flow. There is **no in-app password reset** by design.
- **WhatsApp session lost (QR at boot).** Restore `.wwebjs_auth/` from `.wwebjs_auth_snapshot/` with the
  server stopped (`robocopy .wwebjs_auth_snapshot .wwebjs_auth /MIR`) — **do not re-link** unless the
  restore also fails (repeated re-linking is the account-ban risk). **Completeness caveat:** a snapshot
  taken while the browser is live is *incomplete* — `robocopy /MIR` silently skips locked files
  (the IndexedDB LevelDB session state), exiting 11. The completeness guard refuses to overwrite a known
  complete snapshot with a live one and takes the complete copy at clean shutdown; completeness is
  recorded in `.wwebjs_auth_snapshot.state.json`.
- **Data loss / bad edit.** JSON backup (`/data-backup`) is a full export/import incl. soft-deleted
  rows, ids and FKs preserved; import validates fully, auto-snapshots current data, then replaces in
  one transaction (rolls back on any error). The **Recycle Bin** restores individually soft-deleted
  rows. CSV export is view/print only (not re-importable).
- **Database → encrypted snapshots.** `backup-db.js` writes a consistent `VACUUM INTO` snapshot,
  AES-256-GCM-encrypted when `PLANNR_BACKUP_PASSPHRASE` is set; `decrypt-db.js` is the restore step. See
  `README.md` → Offsite backup & disaster recovery (including the lost-passphrase case).

---

## 8. Deliberate decisions (not accidents)

- **One live contract per household.** Enforced in the DB (`idx_contract_single_live_tenant`), not just
  the UI. Contract Details is edit-in-place once the contract exists; Contractor Payments auto-selects it.
- **No in-app password reset.** Offline `set-password.js` is the reset path.
- **No idle/sliding session expiry.** Expiry is absolute-from-creation (90 days); adding a sliding
  window would require a write on every authenticated request, on the hottest read path. Kept read-only
  on purpose.
- **One accent colour (amber `#f59e0b`, alert `#ffb020`).** The **only** documented exception is the
  23-colour ledger pie. Warnings differentiate by weight/tint/icon, never a second hue.
- **Dormant columns kept on purpose** (`cash_out.phase`/`subpart`, contract's optional free-form
  `amount_paise`) — stored, unused, retained rather than dropped.
- **Loan interest is a ledger spend, under 20.3.** Interest actually paid on a construction loan is
  recorded as an ordinary `cash_out` row under ledger 20.0 (Taxes & Finance Charges), sub-ledger 20.3
  (Loan interest), so it counts in total spend. `loans.interest_rate` is informational only (drives no
  calculation), so there is no derived figure to double-count against. Interest is never part of a
  contract, so it is always logged out-of-contract (`extra`).
- **WhatsApp on an unofficial library** (`whatsapp-web.js`) with known costs: it drives a real Chromium,
  can be rate-limited/banned on repeated re-links, and depends on the machine being awake. Chosen
  deliberately over the paid official Cloud API for a local tool.
- **CSP is startup-hashed and enforced** (not report-only). Inline `<script>`/`<style>` blocks are
  hashed at boot; inline `style=` attributes are blocked outright (use classes + CSSOM).

---

## 9. What is NOT done, and why

- **No hosting.** Runs on the owner's laptop only. There is no always-on server, so guaranteed daily
  delivery is not possible; catch-up softens missed sends but a machine that stays off still sends
  nothing. Auto-start at logon + a no-sleep power setting are documented and can be set up (see README),
  but a shut lid still misses.
- **WhatsApp automation depends on the machine being awake** at the scheduled minute (or at the next
  startup for catch-up). This is inherent to the in-process scheduler + local run.
- **`server.js` is one large file.** It has grown well past a comfortable size and has not been split
  into modules; it works and is tested, but it is the main structural debt.
- **Owed (F) is not shown on the interactive Overview** (only in the PDF) — see §4. Whether to surface
  it on-screen is an open UX call, not a bug.

### Known first-use friction
- **Contract form has two amount fields.** The contract's value goes in the field labelled *"Amount of
  contract stated (₹)"* (required); the field labelled plainly *"Amount (optional)"* is a dormant
  free-form value that does **not** feed the dues math. A first-time user could easily type the
  contract value into the wrong field. *(Recommend relabelling before real entry.)*
- Amount inputs don't group digits as you type (you type `2500000`, not `25,00,000`) — cosmetic.

---

## 10. Troubleshooting — by symptom

*Fastest path first. All commands run from the project root in PowerShell; the console log is
`plannr-startup.log` (previous run rotates to `plannr-startup.log.1`). `GET /api/…` means open that URL
in a browser while logged in — those endpoints require an authenticated session.*

### WhatsApp went silent — device logged out remotely
- **Symptom:** email still sends, but the WhatsApp Daily Report + Test-send silently fail. The log has
  `[whatsapp] disconnected: device logged out remotely — the saved session is being cleared (browser
  first); a re-link will be needed.` then `[whatsapp] session cleared after logout — re-link with
  \`node whatsapp-login.js\` …`. `.wwebjs_auth/` is now empty and the phone's Linked Devices no longer
  lists this device.
- **First check:** `Select-String -Path plannr-startup.log* -Pattern "logged out remotely|session cleared after logout"`
- **Fix:** this is a genuine loss, **not** corruption — a remote LOGOUT unlinks the device at
  WhatsApp's servers, so a snapshot restore won't help (its credentials are logged out too). This is
  one of the few times re-linking is correct: confirm the phone has a free device slot (next symptom),
  then `node whatsapp-login.js` and scan the QR once. The rest of Plannr is unaffected throughout.

### Re-link fails — the phone's linked-device slots are full
- **Symptom:** `node whatsapp-login.js` shows a QR but never reaches `✅ WhatsApp linked successfully`;
  the phone shows "maximum number of linked devices" (WhatsApp caps companion devices at 4). Each failed
  attempt can leave a half-linked slot, compounding it.
- **First check:** on the phone — WhatsApp → Settings → Linked Devices — count the devices.
- **Fix:** log out a stale device there (tap it → *Log Out*), then re-run `node whatsapp-login.js`.
  Don't loop on the QR — free a slot first.

### A scheduled Daily Report never fired
- **Symptom:** nothing arrived at the scheduled email/WhatsApp time (IST); Home → Daily Report and
  `channels.*.lastSuccess` in `GET /api/health` show an older date. There's no `[daily-report]
  scheduled …` line covering that minute because the process was down — the scheduler is in-process
  `node-cron`, so a missed minute is missed, not queued.
- **First check:** `Select-String -Path plannr-startup.log* -Pattern "Plannr running at|catch-up check"`
  — was the server even up before the send time?
- **Fix:** start the server; catch-up then sends **one** clearly-labelled `(catch-up for YYYY-MM-DD)`
  per channel if that day's earliest time already passed and nothing went out yet. To stop the
  recurrence, set up auto-start at logon + sleep-to-Never (README → *Running Plannr unattended*). A
  machine that stayed off *through* the send time and was never restarted that day still sends nothing.

### A save "succeeded" but the value isn't in the database
Phase 4a (WASM SQLite port prep) changed `journal_mode` from WAL to DELETE, so this failure mode is
retired going forward: every commit lands directly in `data/plannr.db`, with no `-wal`/`-shm` sidecar
that a naive copy could leave behind. **If you're troubleshooting an install that predates that
change** (still shows a non-trivial `data\plannr.db-wal` via `Get-ChildItem data\plannr.db*`), a copy
of `plannr.db` alone without its sidecars was the cause — copy all three files together, or stop
cleanly with `stop-plannr.cmd` first, then copy just `plannr.db`.

### The three WhatsApp states — linked / authenticated / ready

Three distinct things, easily conflated; only the third can send.

| State | What it means | How to tell |
|---|---|---|
| **linked** | the phone lists this device under Linked Devices and its credentials sit on disk in `.wwebjs_auth/`. Established *once* by `whatsapp-login.js`; survives reboots. | the folder is non-empty; the device shows on the phone. |
| **authenticated** | at this run's startup whatsapp-web.js loaded those creds and WhatsApp accepted them. **Not yet usable.** | log: `[whatsapp] session authenticated.` |
| **ready** | the client finished syncing and can send. **The only sendable state.** | log: `[whatsapp] connected — reusing saved session (no QR needed).`; and `channels.whatsapp.ready === true` in `GET /api/health`. |

**Why "re-run whatsapp-login.js" is often the WRONG advice.** When a send can't go out, the app
appends *"Re-run whatsapp-login.js if this persists"*, and a genuine `qr` event logs *"no valid
session — run `node whatsapp-login.js`"*. But that nudge fires on **every** not-ready state — including
**authenticated-but-not-yet-ready**, where the session is perfectly valid and merely slow (or stuck)
reaching `ready`. That state is a **hang, not a missing session**: the log shows `session
authenticated.` with **no** following `connected — reusing saved session` line, and Test-send/catch-up
report "WhatsApp is not connected". Re-linking at that moment is the wrong move — it burns a
linked-device slot and forces an unnecessary QR rescan, which is the account-ban risk.

**Right fix for a valid-but-stuck / corrupted (but NOT logged-out) session — snapshot restore, don't
re-link:**
1. Confirm the snapshot is restorable: `.wwebjs_auth_snapshot.state.json` must read `"complete": true`.
   An incomplete snapshot (one taken while the browser was live — robocopy silently skipped the locked
   LevelDB session state) will **not** restore.
2. Stop cleanly: `stop-plannr.cmd`. Never a force-kill / second Ctrl+C — that skips the
   complete-snapshot refresh and can re-corrupt the store.
3. Move the live store aside (don't delete): rename `.wwebjs_auth` → `.wwebjs_auth_old`.
4. Restore, with the server stopped: `robocopy .wwebjs_auth_snapshot .wwebjs_auth /MIR`.
5. Reboot the server and confirm `[whatsapp] connected — reusing saved session (no QR needed).`. Only
   if the restore *also* fails do you fall back to re-linking with `node whatsapp-login.js`.
