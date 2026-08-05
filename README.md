# Plannr

A self-hosted construction-cost ledger. Node.js + Express + `node:sqlite` (no ORM, no
build step). One shared, multi-user ledger tracks money in and out of a single building
contract, with an analytics Overview, PDF/CSV/JSON exports, and an automated Daily Report
over email and WhatsApp.

Money is **integer paise everywhere** (₹1 = 100 paise) — never a float. Formatting to ₹ is
display-only.

## Run it

```sh
npm install
npm start           # = node server.js  → http://localhost:3000
```

- `PORT` overrides the port (default 3000).
- `NODE_ENV=production` requires HTTPS for the session cookie.
- `PLANNR_DB=/path/to.db` overrides the database file — **always use this for testing; never
  test against `data/plannr.db`.** The schema + all migrations are created/run on boot from `init()`.

### Live-DB guard (for scripts)

`server.js` defaults to the live `data/plannr.db` (correct — it *is* the app). Every **non-server
script** instead goes through `db-guard.js`: it prints the absolute path it will write to and
**refuses the live DB** (an unset `PLANNR_DB` counts as live) unless you pass
`--i-really-mean-the-live-db`. So a forgotten `PLANNR_DB=` can no longer hit production by accident.

### Reset

```sh
PLANNR_DB=/tmp/x.db npm run reset-db                          # wipe an isolated copy (safe)
node reset-db.js --confirm --i-really-mean-the-live-db        # wipe the LIVE database
```

`reset-db.js` derives the table list from `sqlite_master` (never a hardcoded array, so a new
table can't be silently skipped), disables foreign keys for the wipe (set before `BEGIN`,
restored after `COMMIT`), and runs `PRAGMA foreign_key_check` afterward. `--confirm` confirms
intent; the guard confirms the target (and requires the live flag for live). There is deliberately
**no in-app reset button**.

### Password recovery — `set-password.js`

There is deliberately **no in-app password reset**, so if a login is lost or broken this CLI is the
**only** recovery path: it writes a fresh bcrypt hash directly into `users`. It is not reachable
from the app (no route, no button).

```sh
node set-password.js <username> --i-really-mean-the-live-db   # reset a live account's password
```

The password is **never** a CLI argument (argv shows up in `ps`/history) — it is read from stdin
with echo off, twice. It applies the same strength rule registration does and hashes with the same
shared module (`password.js`), so it can't set something the app would reject. It **deletes that
user's sessions**, signing them out on every device, and prints only the new hash's length/prefix
as a sanity check — never the hash. Requires the live-DB flag (targeting live is its purpose).

## Testing

Node's built-in runner (`node --test`) — no test framework dependency.

```sh
npm test          # the full behaviour suite (fast; real bcrypt only in the auth group)
npm run test:ui   # the slow visual suite (Playwright): pie swatches, table layout, CSP, ₹ rendering
```

Two absolute safety properties the suite enforces:

- **It can never send.** Every test process sets `PLANNR_TEST=1`, under which `whatsapp.init()` is a
  hard no-op and `makeTransport()` returns `null` before Nodemailer is ever touched. No test boots a
  WhatsApp client or constructs a live transport.
- **It never opens the live DB.** Each test file sets a unique temp `PLANNR_DB` before requiring
  `db.js`/`server.js`; a test asserts the resolved `DB_PATH` is not the live path; and `npm test`
  (`run-tests.js`) records `data/plannr.db`'s mtime before and after the whole run and fails if it changed.

`server.js` gates its external side effects (`app.listen`, `whatsapp.init()`, cron scheduling, signal
handlers) behind `require.main === module`, so it can be imported by tests. `npm start` is unchanged.

## Pages (all gated server-side; a logged-out request 302-redirects to login)

`login` / `register` · `/` home · `/cash-flow` · `/cash-inflow` (Money Credited) ·
`/cash-outflow` (Money Debited) · `/loan-details` · `/contract-details` ·
`/contractor-payments` · `/overview` · `/data-backup`.

## Database tables

| table | holds |
|---|---|
| `users` | accounts: `username` (unique, case-insensitive), `display_name`, bcrypt `password_hash`. |
| `sessions` | one row per active login; only the SHA-256 hash of the cookie token is stored. Cascades on user delete. |
| `contract` | the single building contract: contractor, area, headline ledger tag, `price_of_contract_paise` (REQUIRED stated amount — dues math starts here), optional free-form amount, date signed, optional end date. |
| `contract_payment_dates` | a contract's scheduled payment dates (0..many); offered as the date dropdown on the Contractor Payments page. Cascades if the contract is hard-deleted. |
| `contract_services` | a contract's line-item services (a name + an OPTIONAL price). Informational — they never enter the dues maths; their only downstream job is to supply `cash_out.contract_stated_paise` on the debit form. Soft-delete; cascades if the contract is hard-deleted. |
| `ledger_customs` | a PER-USER saved list of custom ledger names, so a typed custom is selectable after first use. Genuinely per-user (its read endpoint is filtered by the caller); the 23 built-ins stay in `ledgers.js`. |
| `contractor_payments` | money PAID to the contractor, each tied to the contract. Ledger fields are an optional *display* tag and do NOT drive dues. |
| `cash_in` | money credited (inflow): amount, `by_type` (`user`/`relative`/`custom`) + attribution, reason. |
| `cash_out` | money debited (outflow): amount, tx_date, `by_type` (`user`/`custom`) + who paid, ledger/sub-ledger (or `CUSTOM`), `contract_scope` (`included`/`extra`), `contract_stated_paise` (the reimbursement offset — see below), and `contract_service_id` (the linked `contract_services` row — provenance + the one-offset guard key; NULL when 'extra' or typed manually). `phase`/`subpart` are dormant, stored but unused. |
| `loans` | one-time loan records: amount, bank, interest rate, tenure. `interest_rate` is informational (drives no calculation); interest actually *paid* is a `cash_out` row under ledger 20.3 (Loan interest). |
| `settings` | per-tenant key/value app options (budget, Daily-Report recipients/schedule, send bookkeeping). Composite `(tenant_id, key)` PK; `tenant_id = 0` is reserved for a future genuinely-global setting (none today). |
| `edit_locks` | the single-editor lock for the Overview editable table, scoped **per tenant** (`scope = 'overview:<tenant>'`) so one household editing never freezes another (holder + heartbeat; auto-releasable after 180s stale). |

## Invariants enforced in the DATABASE (not just app code)

- **One live contract PER TENANT.** `idx_contract_single_live_tenant` — a partial unique index on `contract(tenant_id) WHERE deleted_at IS NULL` — makes a second live contract *for the same tenant* fail at INSERT/UPDATE, while letting each tenant hold its own. Soft-deleted contracts coexist with the one live row. (Replaced the old database-wide `idx_contract_single_live`, which wrongly stopped a second user from creating any contract at all — see **Tenancy** below.)
- **Tenant ownership.** The six ledger tables (`cash_out`, `cash_in`, `loans`, `contract`, `contract_payment_dates`, `contractor_payments`) — plus `contract_services` and `ledger_customs` — carry `tenant_id INTEGER NOT NULL REFERENCES users(id)` — the owning household — with **no default**, so an insert that forgets it hard-fails rather than silently mis-tenanting a row. `settings` is keyed per tenant via a composite `(tenant_id, key)` primary key.
- **One service, one offset.** `idx_cash_out_service_live` — a partial unique index on `cash_out(contract_service_id) WHERE contract_service_id IS NOT NULL AND deleted_at IS NULL` — makes at most one LIVE debit link any given `contract_services` row, so a single substitution can never offset the contractor's dues twice. Enforced in the DB, not only in app code (the app adds a naming 409 on create/edit/restore).
- **Soft-delete everywhere.** Transactional tables carry `deleted_at TEXT` (NULL = live); "delete" sets it, the Recycle Bin restores or permanently removes. The JSON backup keeps soft-deleted rows; CSV shows live rows only.
- **Integer paise.** All `*_paise` columns are INTEGER; money is never a float.
- Legacy note: `cash_out.by_type` may in principle be `'contractor'` (no longer written); verified 0 such rows in the live DB.

## Tenancy — one account per household

`tenant_id` on every ledger table holds a `users.id` (named `tenant_id`, never `user_id`, so a real
multi-person household later becomes its own table + backfill, not a rename across ~90 call sites).
The dimension is present on every ledger table and backfilled, and the data-access layer applies the
filters — one household can no longer read or touch another's data.

**The enforcement layer (`repo.js`).** Every read/write/aggregate touching one of the eight tenant
tables (`cash_out`, `cash_in`, `loans`, `contract`, `contract_payment_dates`, `contractor_payments`,
`contract_services`, `ledger_customs`) goes through `repo.*`, whose functions take `tenantId` as a
required first argument and weave the `tenant_id` predicate in centrally — so an unfiltered query is
un-writable, not merely discouraged. The raw table name never appears in a route handler. A boot
assertion (`repo.assertTenantScoped()`, modelled on `assertImportOwnershipComplete()`) scans the
module's own SQL strings and **fails boot** if any statement touching a tenant table lacks a
`tenant_id` predicate — a second line of defence. The cross-tenant isolation harness
(`npm run test:isolation`, folded into `npm test`) is the scoreboard: it must read **0 leaks**, and a
future unfiltered query re-opens one and fails the suite. A cross-tenant mutation returns **404, never
403** (a 403 would confirm the row exists). The per-tenant Daily-Report scheduler renders each
household's PDF through a single bounded, non-shedding queue (concurrency 2, per-tenant staggering).

> **⚠ Single-tenant collapse — a hard limit on migrating a shared install.**
> A database where **several users shared one ledger** (the pre-tenancy norm) **cannot be split**:
> there is no record of who owned which row. On first boot after this migration such a database is
> **assigned in its entirety to one tenant — the lowest (first-registered) user id** — and a loud
> `[db] Tenancy Phase 2: N users share this ledger …` warning names that user. The other users keep
> their logins but own no ledger rows. If that is wrong, restore the pre-migration backup, reassign
> `tenant_id` by hand, and reboot. A single-user database (the live one) migrates cleanly with no
> ambiguity.

Migration mechanism: `tenant_id INTEGER NOT NULL` with **no default**. SQLite allows `ALTER TABLE ADD
COLUMN … NOT NULL` (no default) only on an **empty** table, so empty tables take that cheap path;
a populated table (e.g. `cash_out`) is **rebuilt** create-copy-swap, backfilling `tenant_id` and
**preserving `sqlite_sequence`** so ids are never reused. `settings`' composite-key change also
rebuilds. All of it is idempotent (a second boot is a no-op).

## The reimbursement mechanic (Option C)

A debit marked **Contract Included: Yes** carries `contract_stated_paise` — what the contract
*stated* for that item (distinct from the amount actually spent). It reduces the contractor's
dues while the real spend still counts as spending, so the difference falls out automatically:

```
owed (F) = contract.price_of_contract_paise
         − Σ contractor_payments.amount_paise                                  (cumulative)
         − Σ cash_out.contract_stated_paise WHERE contract_scope = 'included'  (cumulative)
```

**Worked example.** Contract stated ₹1,00,000; a payment of ₹40,000; a debit of ₹32,000 marked
included with `contract_stated_paise` = ₹40,000 → **owed = ₹20,000** (100000 − 40000 − 40000),
spent-by-self = ₹32,000, and Total spent (D) includes the real ₹32,000. The ₹8,000 gap between
stated and spent falls out on its own.

**Cumulative vs range-scoped (critical).** The offset and the paid totals are a *balance* — always
summed over the full set. The pie, Paid-to-contractors (B) and Spent-by-self (C) are scoped to the
selected date range. So a date range that excludes the included debit still leaves owed unchanged.

## Overview money model (`GET /api/overview`)

`money`: A `totalContractPaise` (cumulative), B `paidToContractorsPaise` (range), C
`spentBySelfPaise` (range), D `totalSpentPaise` = B + C (range), E `loanReceivedPaise`
(cumulative), F `owedToContractorsPaise` (cumulative). Also `ledgers` (23-colour pie rollup),
`contracts` (the one contract's stated/paid/offset/owed), and `budgetPaise`.

### `reconciliation` key — flags, never silent corrections

The response also carries `reconciliation`. Every figure above is reported **as-is**; these only
*detect and report* inconsistencies (also logged server-side):

- `ok` — false if any check below trips.
- `orphanedContractorPayments` `{count, amountPaise, contractIds}` — live payments whose parent contract is soft-deleted/missing. Their ₹ is still in B/D/pie but not offset in A/F.
- `includedDebitsMissingOffset` `{count, amountPaise}` — `included` debits with a NULL/0 `contract_stated_paise` (an offset that does nothing; reachable via a pre-Phase-5 backup import).
- `overOffset` `{over, contractPaise, appliedPaise, excessPaise}` — payments + offsets exceed the contract value.

## Exports & backup (`/data-backup`)

- **JSON backup** — full export/import of every ledger table *including soft-deleted rows*, ids and foreign keys preserved. Import validates fully, auto-snapshots current data first, then replaces in one transaction (rolls back on any error). Pre-Phase-5 backups still import (their `included` rows land with a NULL offset, flagged by `includedDebitsMissingOffset`).
- **CSV** — one file per table, amounts in rupees, live rows only. View/print only; not re-importable.
- **PDF** (Overview) — four parts (full / pie / table / ledger) × light/dark, rendered server-side by headless Chromium. The transactions table includes the Contract Stated column.

## Offsite backup & disaster recovery

Everything lives on one laptop — code, `data/plannr.db`, tests, this README, `.wwebjs_auth`. Two independent copies guard against losing it all at once:

**1. Code → git (private remote).** The repo is git-managed. `.env`, `data/`, `.wwebjs_auth*`, `.wwebjs_cache/`, `node_modules/`, and all `*.log` / `*.log.*` are gitignored, so **no credentials and no ledger data are ever committed** — the remote holds code and docs only. Push to a **private** GitHub repo for the offsite copy:

```sh
gh repo create plannr --private --source . --remote origin   # one-time; requires `gh auth login`
git push -u origin main
```

**2. Database → scheduled `VACUUM INTO` snapshots (encrypted).** `backup-db.js` writes a **consistent, self-contained** snapshot of the live DB to **`%USERPROFILE%\PlannrBackups\plannr-YYYYMMDD-HHMMSS.db.enc`** (outside the project), keeping the **newest 14**. It uses SQLite's `VACUUM INTO`, which folds the WAL into one clean file — so it's safe to run while the server is live and it **avoids the trap that copying `plannr.db` alone yields a near-empty file** (recent writes still sit in `plannr.db-wal`) — then **encrypts** that snapshot with **AES-256-GCM** (`node:crypto`, no new dependency) before it touches the backup folder. Every encrypted write is **verified decryptable** in the same run before older snapshots are pruned.

```sh
node backup-db.js                       # one manual snapshot
```

**Encryption key — `PLANNR_BACKUP_PASSPHRASE`.** The passphrase comes from this env var (put it in `.env`, which is gitignored), **never a prompt**, so the unattended 02:00 task can run. It is never logged, never in a filename, never committed.

- **Set** → the snapshot is written encrypted as `…​.db.enc` (the key is derived per-file with scrypt over a random salt; a random IV per file; a GCM auth tag so a wrong key or a tampered file fails loudly instead of yielding garbage).
- **Unset** → the backup still runs but writes a **plaintext `…​.db`** with a loud `⚠ ENCRYPTION OFF` warning — backups never silently stop; encryption is one env var away.

A **daily Task Scheduler job ("Plannr DB Backup", 02:00, StartWhenAvailable)** runs `backup-db.cmd` automatically. Tune with env vars: `PLANNR_BACKUP_DIR` (point it at a OneDrive/synced folder to make it truly **offsite**), `PLANNR_BACKUP_KEEP` (retention count).

> **⚠ A lost passphrase is unrecoverable.** There is no backdoor: an encrypted snapshot can be opened **only** with the exact `PLANNR_BACKUP_PASSPHRASE` it was written with. If you lose it, every `.db.enc` you hold is permanently unreadable — which is worse than no backup, because you'd think you had one. **Store the passphrase somewhere separate from the backups** (a password manager), not only in `.env` on the same machine whose disk loss the backups are meant to survive.

### Restore procedure

An encrypted snapshot must be **decrypted first** (`decrypt-db.js`, the matching step to `backup-db.js`); the result is a complete standalone database. The one crucial step when putting it in place is **removing the stale `-wal`/`-shm`** so the old write-ahead log can't shadow the restored file. `decrypt-db.js` is routed through the live-DB guard, so it refuses to overwrite `data/plannr.db` unless you pass `--i-really-mean-the-live-db` — the safe path is to decrypt to a scratch file and copy it in yourself.

```sh
#  ── with the server STOPPED (stop-plannr.cmd) ──
#  1. pick a snapshot (newest shown last):
ls "$env:USERPROFILE\PlannrBackups"
#  2. decrypt it to a SCRATCH path (PLANNR_BACKUP_PASSPHRASE must be the value it was written with):
$env:PLANNR_BACKUP_PASSPHRASE = "…"
node decrypt-db.js "$env:USERPROFILE\PlannrBackups\plannr-YYYYMMDD-HHMMSS.db.enc" "$env:TEMP\plannr-restore.db"
#  3. replace the live DB with the decrypted file and DROP the stale WAL/SHM:
copy "$env:TEMP\plannr-restore.db" "data\plannr.db"
del  "data\plannr.db-wal" "data\plannr.db-shm"     # ignore "not found" — they may not exist
#  4. start the server; it reopens the restored DB and recreates a fresh WAL.
```

(A legacy **plaintext** `…​.db` snapshot — one written while `PLANNR_BACKUP_PASSPHRASE` was unset — skips step 2: copy it straight to `data\plannr.db` and drop the stale WAL/SHM.)

**Verify a snapshot before trusting it** (non-destructive — decrypts to a scratch path, never the live DB). Check the `cash_out` fixture — it must read **11 rows summing to 78000000** (₹7,80,000):

```sh
$env:PLANNR_BACKUP_PASSPHRASE = "…"
node decrypt-db.js "$env:USERPROFILE\PlannrBackups\plannr-YYYYMMDD-HHMMSS.db.enc" "$env:TEMP\plannr-restore-check.db"
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.TEMP+'/plannr-restore-check.db',{readOnly:true});const r=d.prepare('SELECT COUNT(*) n, SUM(amount_paise) s FROM cash_out').get();console.log(r);if(r.n!==11||r.s!==78000000)process.exit(1)"
# -> { n: 11, s: 78000000 }
```

The **round-trip is also tested** (`test/backup-crypto.test.js`): encrypt → decrypt → the restored DB still reads 11 rows / SUM 78000000, and a wrong passphrase or a tampered file both throw.

## Daily Report

Emails and/or WhatsApps the Overview PDF on a schedule. **Two independent schedules** — email send
times and WhatsApp send times are configured and fire separately. WhatsApp uses a persisted
`whatsapp-web.js` session.

**Hard constraint:** the scheduler is an in-process timer (no OS cron). It only fires **while
`node server.js` is running** — if the process is down at a scheduled minute, that *live* send is
missed, not queued.

**The failure mode catch-up addresses.** If the process is down through both scheduled times, then
before catch-up existed the day's reports were simply gone — nothing left to fire at boot, and nothing
to recover: no record of the miss, no retry, no trace.

**Catch-up on startup.** After the scheduler is set up and the server is listening, it
checks each channel independently: if the channel has recipients, has at least one send time, that
day's **earliest** send time has already passed in IST, and no successful send has been recorded for
today, it sends **one** catch-up report reflecting *current* state. It is labelled unmistakably —
`Plannr — Daily Overview (catch-up for YYYY-MM-DD)` in the subject, WhatsApp caption and PDF filename
— so a late report is never read against the wrong date. **One catch-up per channel per day, never a
backlog:** four days of downtime still produces a single report, because the PDF is a snapshot of the
ledger, not a per-day diff. So a server started after both send times delivers that day's email and
WhatsApp as clearly-marked catch-ups instead of losing them. What it does **not** do: it cannot send
while the machine is off/asleep (a shut lid at boot-time still misses everything), it never duplicates
a report already sent today, and a WhatsApp catch-up needs the reused session to reconnect first (it
waits briefly, then retries next boot if WhatsApp isn't up). `PLANNR_NO_CATCHUP=1` disables it
entirely (set by the test suite so a test can never send at boot).

### Running Plannr unattended (auto-start on this machine)

The current schedule is **09:00 IST (email)** and **16:05 IST (WhatsApp)**, so the machine must be
awake and running `node server.js` at *both* those minutes for that day's reports to go out. You can
remove the "I forgot to start the server" failure by having it auto-start at logon. This section is
**documentation only** — no scheduled task is created and no system setting is changed here; set these
up yourself if you want them.

**1. Start at logon (Windows Task Scheduler).** Create a Basic Task:
- **Trigger:** *When I log on.*
- **Action:** *Start a program* → Program/script: `node` (or the full path to `node.exe`); **Add
  arguments:** `server.js`; **Start in (this is the important field):** the **project root**
  (`C:\Users\joeli\Documents\Plannr`).
- **Why "Start in" matters:** the server calls `process.loadEnvFile()`, which resolves `.env`
  **relative to the working directory**. If the task starts from anywhere else (the default is
  `C:\Windows\System32`), `.env` won't load, `GMAIL_USER`/`GMAIL_APP_PASSWORD` will be undefined, and
  email will silently fail with `credentials are not configured`. Always start Plannr from the project
  root — the same reason `npm start` works (npm runs in the package directory).

**2. Keep the laptop awake.** Task Scheduler can't send a report while the machine is asleep. In
*Settings → System → Power*: set **Screen and sleep → sleep to Never** while plugged in (and, if it
should run on battery, on battery too). Optionally tick the task's *"Wake the computer to run this
task,"* but sleep-to-Never is the reliable choice for a fixed daily schedule.

**What this solves and what it doesn't.** It removes *"forgot to start the server"* — after a reboot
or logon the process comes back on its own, and startup catch-up then delivers any of that day's sends
whose time had already passed (clearly labelled). It does **not** survive a **shut lid / powered-off
laptop**: a closed lid still sleeps or hibernates on most laptops regardless of the plugged-in power
plan, and a machine that's off *through* 09:00 or 16:05 *and* not restarted later that day sends
nothing — catch-up can only recover a missed send once the machine is next on and the server starts.
For delivery you can actually rely on, Plannr needs an always-on host, not a personal laptop.

### Diagnosing "nothing was sent"

The fastest path to an answer:

1. **Boot log lines** — confirm the server started and is in the expected mode:
   - `Plannr running at http://localhost:3000`
   - `[csp] enforcing.` (not `REPORT-ONLY`)
   - `[daily-report] scheduled N EMAIL send(s) at … IST (Asia/Kolkata).` + the WHATSAPP line
   - `[whatsapp] connected — reusing saved session (no QR needed).`
   - `[daily-report] catch-up check (DATE HH:MM IST): email … ; whatsapp … .` — states, per channel,
     whether a catch-up was due and, if not, why (no recipients / no times / time not passed / already
     sent today).
2. **Loaded schedule** — per channel, recipient count + saved times, read *without* a live send: `GET
   /api/daily-report`, or read `daily_report_recipients` / `daily_report_times` /
   `daily_report_whatsapp` / `daily_report_whatsapp_times` from a throwaway copy of `data/plannr.db`.
3. **Computed next fire (IST)** — for each saved time, the next fire is *today* at that time if it's
   still in the future, else *tomorrow*. **If every next fire is tomorrow, that is the answer on its
   own:** the times already passed today, and the catch-up check then finds those channels due and
   sends the labelled catch-ups.

Times are IST wall-clock (`Asia/Kolkata`); stored timestamps stay UTC. Home → Daily Report shows each
channel's recipients, send times, next fire, **last successful send**, and flags when the last report
was a catch-up.

### WhatsApp session snapshot & recovery

The linked session in `.wwebjs_auth/` is mirrored to `.wwebjs_auth_snapshot/` (a local, gitignored
full copy) for recovery. If the live session store is ever corrupted — WhatsApp asks for a QR at boot
(`no valid session` in the log) — **restore from the snapshot instead of re-linking** (repeated
re-linking is the account-ban risk). With the server stopped:

```
# Windows (PowerShell), from the project root, with Plannr NOT running:
robocopy .wwebjs_auth_snapshot .wwebjs_auth /MIR
```

Then start the server; it should reconnect with no QR. Only run `whatsapp-login.js` (a fresh QR scan)
if the snapshot restore also fails. The snapshot never leaves the project and is never committed.

**When the snapshot is taken (completeness guard).** `robocopy /MIR` **silently skips files
the live browser holds locked** — including the WhatsApp IndexedDB LevelDB, which *is* the session
state — and still exits `11` (a "success-ish" code). So a snapshot taken while the browser is running
is **incomplete by definition** and would not restore. Therefore:

- **On `ready` (browser live):** if a **complete** snapshot already exists, the refresh is **skipped**
  — a live copy can only be incomplete, and overwriting a known-good snapshot with a useless one is
  worse than doing nothing. It takes a live copy only to *bootstrap* when no complete snapshot exists
  yet (marked incomplete).
- **On clean shutdown (browser closed):** this is the one moment a **complete** copy is possible, so
  the snapshot is refreshed here (only if the session was actually good this run). A second Ctrl+C
  skips it (force-exit).

Completeness is recorded in a sibling marker `.wwebjs_auth_snapshot.state.json` (`{ complete, code,
at }`), placed *next to* the dir so `robocopy /PURGE` can't delete it. The log always says which path
ran and why (`refreshed — COMPLETE`, `skipped — keeping the existing COMPLETE snapshot`, or
`bootstrapped … INCOMPLETE`). You can still force a guaranteed-complete copy any time with the server
stopped via the `robocopy` command above.

> **Always let the recovery snapshot be refreshed with the server stopped.** A *live* auto-snapshot
> (browser running) is missing the locked files — the WhatsApp IndexedDB LevelDB where the session
> state lives — and robocopy exits `11` ("success-ish"); only a copy taken with the server **stopped**
> is complete (code `3`). The restore path is: with the server stopped, move `.wwebjs_auth/` aside (not
> deleted), restore the snapshot into a fresh `.wwebjs_auth/`, boot, and confirm `connected — reusing
> saved session (no QR needed)`. A snapshot taken while the browser is live may not restore.

> **Second Ctrl+C during shutdown:** the force-exit escape hatch bypasses the graceful browser close, so
> Chromium is killed **without flushing** the session store — reintroducing the corruption the fix
> avoids. The server prints a warning on that path; if the next boot asks for a QR, restore from the
> snapshot before scanning.

## Hosting readiness (before exposing Plannr to the internet)

Plannr today is built for **one household on one trusted machine** (localhost or a LAN behind the
house router). Two integrations make it **unsafe to host as-is for other people**, and both must be
dealt with *before* the first external tenant, not after:

> **⚠ WhatsApp must be removed before hosting.** `whatsapp-web.js` sends from the **personal WhatsApp
> account** linked by QR on this machine. Hosted for several households, every tenant's Daily Report
> would message *their* recipients **from the operator's own phone number** — the operator's contacts,
> read receipts, and ban risk, not the tenant's. There is no per-tenant sender. Drop the integration
> (and its deprecated transitive deps — see the security notes) before anyone else's data flows through it.

> **⚠ Gmail SMTP must be replaced.** Email goes out over `GMAIL_USER` + an app password — one personal
> mailbox, subject to Gmail's ~500/day cap and "less secure app" clawbacks, with no per-tenant `From`
> and no domain reputation. For a hosted service, swap in a **transactional provider** (Postmark, SES,
> Resend, …) with a **verified sending domain** (SPF + DKIM + DMARC), so mail is authenticated and
> deliverable and bounces don't poison a personal address.

Each item below is marked **[REQUIRED]** (must be true before hosting) or **[N/A local]** (only
matters once Plannr is multi-tenant and internet-facing; safely skipped for the local single-user install).

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | **HTTPS with automatic HTTP→HTTPS redirect** | **[REQUIRED]** | Terminate TLS at the reverse proxy (Caddy does it automatically; nginx/Traefik with a redirect server block). Cookies are auth — plaintext HTTP leaks the session token on every request. The redirect (not just an HTTPS listener) stops a first request going out in the clear. |
| 2 | **`trust proxy`** | **[REQUIRED]** — already coded | `server.js` sets `app.set('trust proxy', 1)` when `NODE_ENV=production`. Required so `req.ip` is the client, not the proxy — the rate limiter and login lockout key on it. **Verify, don't assume:** set exactly the number of proxies in front of Plannr (1 for a single reverse proxy). Too high and a client can spoof `X-Forwarded-For` to dodge the limiter; see the deployment report for the curl test. |
| 3 | **Secure-cookie interaction** | **[REQUIRED]** — already coded | The session cookie is `secure: IS_PROD`. `secure: true` **needs `trust proxy` + real HTTPS**: without trust proxy Express sees the proxy's HTTP hop, treats the connection as insecure, and **silently drops the Set-Cookie** — logins appear to "not work." Items 1–3 stand or fall together. |
| 4 | **CAPTCHA (or invite-gate) on `/api/register`** | **[REQUIRED]** | Registration is open and only IP-rate-limited. Public on the internet, that's a spam/abuse funnel. Add a CAPTCHA (hCaptcha/Turnstile) or make registration invite-only before opening it up. |
| 5 | **Disk encryption at rest** | **[REQUIRED]** | `data/plannr.db` holds every household's finances in cleartext SQLite. On a rented VM/VPS, enable full-disk/volume encryption (LUKS, provider-managed) — otherwise a snapshot or disposed disk is a plaintext data breach. |
| 6 | **Persistent paths survive restarts/redeploys** | **[REQUIRED]** | `data/` (the DB + WAL), `.env` (secrets), and the backup/snapshot files **must be on a persistent volume**, not an ephemeral container layer. A redeploy that wipes `data/` is total data loss; one that regenerates `.env` invalidates every session and can't decrypt nothing (there's no app-level crypto, but a new session secret logs everyone out). |
| 7 | **Email verification on signup** | **[REQUIRED]** | (Tenancy audit gap.) No proof a registrant owns the address. Needed before password reset (item 8) can be trusted and before Daily Reports mail out on a stranger's say-so. |
| 8 | **Self-service password reset** | **[REQUIRED]** | (Tenancy audit gap.) Recovery today is `set-password.js`, an **operator-run CLI** — fine for one owner, unworkable for tenants who can't reach the box. Needs the verified email from item 7. |
| 9 | **Per-account rate limits** | **[REQUIRED]** | (Tenancy audit gap.) Limits are per-IP only. One authenticated account behind a shared IP (or a botnet) isn't individually bounded — add per-account throttling on the expensive routes (PDF render, import, batch save). |
| 10 | **Terms of Service + Privacy Policy** | **[REQUIRED]** | (Tenancy audit gap.) Holding other people's financial data obliges a stated retention/deletion/contact policy and consent at signup. Non-negotiable for a real service; irrelevant for your own local copy. |

For the single-user localhost install, items 1–10 are all **[N/A local]** — no proxy, no HTTPS, no
other tenants, the machine's own login is the security boundary, and disk encryption is the OS's call.
The list becomes live the moment Plannr is reachable by anyone but you.

## Layout

```
server.js      Express app: auth, the ledger CRUD (cash_in/cash_out/loans/contract/
               contractor_payments), Overview + PDF, JSON/CSV backup, Recycle Bin, Daily Report.
db.js          node:sqlite setup + schema + idempotent migrations (run on boot).
daily-report.js  Email + WhatsApp scheduling and sending.
ledgers.js     The fixed 23-ledger list (single source of truth).
public/        Static frontend + shared PlannrUI helpers (public/plannr-ui.js).
reset-db.js    One-shot full wipe (npm run reset-db).
data/plannr.db SQLite file (created on first run, gitignored).
```
