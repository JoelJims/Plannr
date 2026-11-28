# Security and quality review of `plannr-phase2`, 2026-11-21

> **Status on 2026-11-23.** This review was written on 2026-11-21. Since then:
> - `plannr-phase2` was merged into `main` (PR #1, `4b3ab08`, 2026-11-21). That fixed S1: `server.js`
>   now listens on `127.0.0.1` only, unless `PLANNR_HOST` is set, and then only with a
>   `PLANNR_TOKEN` of at least 16 characters; otherwise it refuses to start (`accessConfig()` and
>   `app.listen(PORT, access.host, …)` in `server.js`).
> - All nine decisions of section 6 were taken. S1 and CI (decision 8, F12) reached `main` with
>   PR #1. The other fixes are on `plannr-phase3` (sections 8 and 9); pull requests #4 to #8 were
>   merged into it on 2026-11-23. `plannr-phase3` into `main` is pull request #3, still open.
> - The Status column in section 2 is kept up to date. Sections 1, 5, 6 and 7 describe the end of
>   the 2026-11-21 session and are kept as a record.
> - What is still open now is in section 10.

Scope: the final state of step 1.4 (`71b9fce`, code as `53db636`). Phase 1 (read-only audit) by
three reviewers working in parallel (security; data safety and reliability; frontend, tests,
tooling, efficiency), each finding checked against the code; every Critical and High finding confirmed
by hand. Phases 2–5 ran inside a 3-hour session together with other work, so they are partly done:
see section 6, SKIPPED.

## 1. Verdict

**No Critical finding. One High (Q1), confirmed and fixed.** For a single-user, offline app whose
shipped product is the phone app, the branch is in good shape on security. The dev server binds to
this PC only, has a Host allow-list against DNS rebinding, and needs a token for LAN use. Request SQL
is parameterised. Restores are checked before they change anything. Backups use AES-256-GCM with a
fresh salt and IV per file. No secret is in the history. What remains is mostly data safety at the
edges (restore failure after the file is replaced, two-statement saves, move-back headroom), escaping
in one place (fixed), and slow pages with many entries. **`main` is the exposed branch:** its
`server.js` still listens on every interface with no login (S1); merging this branch closes it.
(Since fixed: the merge into `main` on 2026-11-21, PR #1; see S1 in section 2.)

## 2. Findings

Severity is judged for this app: one user, offline, phone app shipped, dev server for development.
"Status" was first written at the end of the 2026-11-21 session and is kept up to date (last:
2026-11-23).

| ID | Sev. | Finding | Evidence | Status |
|---|---|---|---|---|
| Q1 | **High** | A database from the two oldest schemas (v1) keeps the removed login's `sessions` table, which the start-up ownership check refuses: the app cannot start (dev server; phone after restoring such an encrypted backup) | `backup-format.js:42-45` (list), `:82-97` (check), `core/routes/backup.js:36` (start job); fixtures 01, 02, L1–L5 | **Fixed** (`ed52850`) |
| S1 | Medium | `main` (not this branch) listens on every interface with no login; export and import reachable from the Wi-Fi and by DNS rebinding | `main:server.js:2615` `app.listen(PORT, '0.0.0.0'…)`, `main:server.js:171` (both before the merge) | **Fixed** 2026-11-21 by the merge into `main` (PR #1, `4b3ab08`): `server.js` listens on `127.0.0.1` unless `PLANNR_HOST` and a `PLANNR_TOKEN` of 16+ characters are set, and refuses to start in LAN mode without one |
| S3 / Q6 | Medium | A restore replaces the database, then runs migrations and the foreign-key check; if they fail, the backup's data stays live while the answer says it failed; on the phone the safety copy is out of reach | `db.js:372-376`; `core/routes/backup.js:133-134`; `public/local-snapshot.js:100,107` | **Fixed** 2026-11-22 (`5e98901`): automatic rollback, as decided |
| Q3 | Medium | Saving a contract writes it and its payment dates as separate statements, outside a transaction; a failure between them leaves dates deleted or a contract without dates | `repo.js:217`; `core/routes/contracts.js:321-331` | **Fixed** 2026-11-22 (`00f6a59`) |
| Q4 | Medium | "Move data back fits" counts only the incoming size, not the journal or what is already in `localStorage` | `core/storage-move.js:251`; `public/db-adapter-kvvfs.js:52-90` | **Fixed** 2026-11-22 (`883aabd`, `ws-a-fixes`) |
| Q2 | Medium | On `localStorage`, a kill loses the last seconds of saves (WebView writes late); nothing tells the user | measured on the emulator (E3, E6); `public/data-backup.html:233-238` | **Fixed** 2026-11-22 (`08939c1`, `ws-a-fixes`) |
| F1 | Medium | Ledger codes from a restored JSON backup go into HTML attributes unescaped (a crafted backup could run script in the app) | `public/plannr-ui.js:138,145,311,318,1007,1022,1060`; `backup-format.js:157-170` (codes only checked non-empty) | **Fixed** (`678092c`); the stricter import too, 2026-11-22 (`b623200`) |
| F2 | Medium | "Download CSV (for Excel)" uses a plain download link, a dead end in the Android WebView, and reports success | `public/data-backup.html:875-878` (vs `saveFile()` elsewhere) | **Fixed** 2026-11-22 (`8b9101e`) |
| F3 | Medium | The Overview shows ₹0.00 while loading and after a failed load, with no message | `public/overview.html:375-381, 620-621, 637-638` | **Fixed** 2026-11-22 (`e5b30ca`) |
| F4 | Medium | "₹X left" compares a date-range spend with the whole-project budget | `public/overview.html:725-741` (renderTotalBar); `core/overview-pdf.js:118-135` (budgetBlock) | **Fixed** 2026-11-22: option (b), decided by the owner (`ws-b-f4`, merged as PR #4 on 2026-11-23) |
| Q5 | Low | An unreadable marker file plus a lost `localStorage` key after a kill could lead startup to delete the database file (two faults) | `public/storage-native.js:128-135,177`; `core/storage-move.js:227` | **Fixed** 2026-11-25 (`d59d5df`, `ws2-a-fixes`) |
| S2 | Low | Dev server: no Origin check; two body-less POST routes (mark exported, restore from bin) can be triggered by a web page while it runs | `core/routes/backup-reminder.js:78`; `core/routes/trash.js:45` | **Fixed** 2026-11-25 (`e1761b5`, `ws2-a-fixes`) |
| S4 | Low | A crafted backup can bring triggers or views; the `localStorage` restore runs schema SQL from the file | `public/local-snapshot.js:59-60,76-77`; `db-adapter-node.js:95` | Open |
| S5 | Low | Backup key derivation scrypt N=2^14 (below current advice), minimum passphrase 10 characters; parameters not in the header | `core/backup-crypto.js:29,34` | Planned, not built (decided 2026-11-21): backup format v2; v1 files always stay readable |
| S7 | Low | The APK has `USE_BIOMETRIC` and `USE_FINGERPRINT` from the storage plugin's dependencies; Plannr never uses them | merged manifest; `aapt dump permissions` of the RC | **Fixed** 2026-11-22 (`4cf1784`), checked on the built APK and the emulator |
| S9 / F19 | Low | `.gitignore` misses `*.jks`, `*.p12`, `*.pem`, `.env.*`, plain exports and pulled snapshots | `.gitignore` | **Fixed** (`d33953b`) |
| S10 / R2 | Low | A `PLANNR_DB` that is set but empty opens the real database (incident 1) | `db.js:31` | **Fixed** (`a3ea627`) |
| Q7 | Low | A leftover `kvvfs-local-jrnl` record is counted as data and takes quota | `public/local-api.js:67-76` | **Won't fix** (2026-11-25, owner's decision): the leftover record really takes `localStorage` quota, so the storage page's sizes and the move-back room check (Q4) count it on purpose. A fix, `c6a9a33`, was reverted in `4e87808`: `backupBytes` relies on it (section 11) |
| Q8 / R3 | Low | `node:sqlite` stores numbers as REAL: `sqlite_sequence.seq` and unchecked TEXT columns from hand-edited backups differ between desktop and phone | `db.js:1001,1101,1337`; `backup-format.js:122-283,328` | Open |
| Q9 | Low | A backup's `sequences` naming a table without an id gives a 500 instead of a 400 | `backup-format.js:178-184,326` | **Fixed** 2026-11-22 (`d8ef781`, `ws-a-fixes`) |
| Q10 | Low | No upper limit on amounts; a typo near ₹90 trillion can break the Overview's sums | `core/parsers.js:11-17` | **Fixed** 2026-11-26 (`7c6302f`, `ws3-a-fixes`, owner's decision): one entry (cash in, cash out, a contractor payment) is at most ₹1,00,00,000 (₹1 crore); a save above it gets a 400 with a plain message. Totals (the budget, loans, the contract, an allowance's cap and rate) have a limit of ₹10,00,00,00,000 (₹1,000 crore), so sums stay exact integer paise (owner's decision 2026-11-27, `1332d03`; section 12). Since 2026-11-28 the JSON import checks both limits too and refuses a file with a larger amount (`ws4-a-import`, owner's decision; section 13) |
| Q11 | Low | Any I/O error is reported as "storage full" on every engine | `db.js:1717-1723` | **Fixed** 2026-11-26 (`08b3a69`, `ws3-a-fixes`, owner's decision): only `SQLITE_FULL` or an I/O error the browser's quota caused says "Storage is full"; any other failed save says "Couldn't save – try again." (section 12). The owner's wording for a full storage, a failed import and a failed restore followed on 2026-11-28 (`ws4-a-import`; section 13) |
| Q12 | Low | Move snapshots go through the regular rotation and cut it by one; they are never pruned | `public/safety-snapshots.js:40,52-57` | **Partly fixed** 2026-11-22 (`7b2d695`, `ws-a-fixes`): a move snapshot no longer cuts the rotation. Move snapshots are still never pruned, so they add up. The rest: fix in `ws3-b-q12` (its own pull request): until the move is confirmed on the Data Backup page, its snapshots are never deleted and do not count; after that, from the next snapshot written, the newest 3 snapshots in total remain; the one just written is never deleted, and a move back makes the move unconfirmed again |
| Q13 | Low | If planning the upgrade throws, the phone shows a blank page | `public/local-bootstrap.js:54` | **Fixed** 2026-11-22 (`76d4c3d`, `ws-a-fixes`) |
| Q14 | Low | A ledger entry and its custom-name write are two writes; a failure between them leads to a duplicate on retry | `core/ledger-crud.js:44-66,82-121` | **Fixed** 2026-11-22 (`908b9d4`, `ws-a-fixes`) |
| Q16 | Low | The phone's API answers every error as 500 and does not decode route params | `public/local-api.js:303-321` | **Fixed** 2026-11-25 (`d184d3b`, `ws2-a-fixes`) |
| F5 | Low | Home says "First login — welcome." on every start (left from the removed login) | `public/home.html:233-258` | **Fixed** 2026-11-22 (`5e6afb7`) |
| F7 | Low | The UI "no console errors" rule fails on sqlite-wasm's harmless "wasm streaming compile failed" fallback | `test-ui/static-hosting.js:41-58`; `test-ui/offline.js:57-59`; `db-engine.js:39` | **Fixed** 2026-11-22, follow-ups 2026-11-23 (`c927071`, `d11f8ac`, `c3b63d6`, `ws-a-fixes`; proof in section 9) |
| F8 / F9 | Low | Fixed ports and sleeps in UI and node tests (flake risk) | `test-ui/*.js`; `test/stop-sentinel.test.js:16-31`; `test/request-queue-wiring.test.js:54` | Open (partly: `contract-phase-a` waits for the condition and lets only a timeout pass, `8b5546a`, `420416a`; proof in section 9) |
| F10 | Low | The phone pass picks its test files with a literal regex | `run-tests.js:44` | **Fixed** 2026-11-25 (`055c7c9`, `ws2-a-fixes`) |
| F12 | Low | No CI, lint or format configuration | no `.github/` | **Fixed**: CI added with `plannr-phase2` (PR #1) |
| F13 | Low | `reset-db` deletes the `_migrated_*` markers too | `reset-db.js:58` | **Fixed** 2026-11-25 (`8ee6c0b`, `ws2-a-fixes`) |
| F14 | Low | Encrypted restore body limit 20 MB (base64), so a database over about 15 MB cannot be restored on the phone; export does not warn | `request-rules.js:11,26` | **Fixed** 2026-11-26 (`884d292`, `ws3-a-fixes`, owner's decision): the limit is 32 MB (an encrypted file of up to 24 MB), and the Data Backup page warns at export from 75% of it (section 12). The owner confirmed 32 MB on 2026-11-28 (section 13) |
| F15–F18 | Low | Fetch-shim edge cases; row buttons can be double-submitted; unsaved input lost on Back; modal focus | `public/local-api.js:291-292`; `public/data-backup.html:1066-1073`; `public/plannr-ui.js:370-463` | Open (F18 **Fixed** 2026-11-22: `f2f1701`, `ws-c-cleanup`; checked by `npm run test:modal-focus`. F15 **Fixed** 2026-11-25: `832d31d`, then the `Request` case, `ws2-a-fixes`) |
| F20 | Low | `engines` says Node ≥22.12.0; `node:sqlite` is unflagged from 22.13 (unchecked) | `package.json:41` | Open |
| E1 | Low | The PDF export gives up after 25 s; a slow emulator reached it | `public/overview.html` (withTimeout), emulator 2026-11-21 | Open; `phone-test.ps1` now waits up to 90 s and reports the PDF time (`46d21ec`): 4.1 to 4.5 s on the emulator 2026-11-22 |
| S6, S8, S11–S19, Q15, Q17–Q19, F6, F11, F21–F25 | Info | Auto Backup holds plain data (by design); broad FileProvider path; `run-tests.js` says "never opened" but checks mtime; error details and paths in answers; logging; PDF Chromium `--no-sandbox`; CSV formula prefix; `.env` read from the working folder; LAN token over HTTP; dead code and imports; README screenshots missing; docs say the storage move is not done and that snapshots are in Auto Backup | see the audit notes | Open (docs and clean-up), except: the README shows six screenshots from `docs/images/` (demo data; added in Phase 2, `b8ae126`; the old `screenshots/` folder holds only a `.gitkeep`), but they predate F4: `budget.png` shows "₹X left · Budget ₹Y" and `pdf-export.png` "₹X left." where the app now says "left of total budget" (retaking them is open, section 10); the docs' "storage move not done" and "snapshots in Auto Backup" were corrected on 2026-11-23 (`HANDOFF.md`, and status notes in `docs/cross-platform-plan.md` and `docs/storage-proposal.md`); two unused helpers were removed from `server.js` (`57b033e`). The other Info items are not checked again |

## 3. Secrets

Scanned with `git log -p --all --reflog` (all 5 branches, `origin/*`, 8 tags, the stash and the
reflog), the file names in every commit, the objects (`git rev-list --all --objects`), the files git
treats as binary (each version read separately), and the unreachable objects (`git fsck
--unreachable`: 155 blobs, none with a SQLite or PLBK header). **No real secret, key, token,
keystore, `.env`, database or backup file anywhere in the history.** Only test values were found,
shown here as type, place and first 4 characters:

| Type | Where | Value |
|---|---|---|
| Known-answer test passphrase (documented as a test value) | `test/fixtures/backup-kat/manifest.json:3` | `Plan****` |
| Demo login password of the removed login (printed by the demo seeder) | `seed-demo.js:183` | `Demo****` |
| Test passwords in retired login tests (history only) | old `test/*.test.js` | `Wron****`, `what****` |
| Placeholder phone number and e-mail addresses in fixtures | `test/fixtures/*`, tests | `+9198****`, `a-se****@gmail.com` |

Not ignored by `.gitignore` but should be (none is in git today): `*.jks`, `*.p12`, `*.pem`,
`.env.*`, `plannr-backup-*.json`, `plannr-*.csv`, `plannr-overview-*.pdf`, `*.db.gz`,
`auto-snapshot-before-import-*.json` (S9).

## 4. Fixes

| Commit | Change | Proving test |
|---|---|---|
| `ed52850` | Q1 (High): `sessions` (the removed login's table, still in databases first made by the two oldest schemas) is import-owned, so the start-up check accepts those databases and the import clears its dead rows (`backup-format.js`). No schema, upgrade step or baseline changes. | `test/legacy-sessions-start.test.js`: starts the real `server.js` on fixtures 01, 02 and L1; it starts, keeps every entry, and a JSON import clears `sessions`. Before the fix all 3 failed ("IMPORT_OWNED_TABLES is incomplete"). |
| `678092c` | F1 (Medium): ledger codes are escaped in the seven places `public/plannr-ui.js` put them into HTML attributes (the ledger selects' option values, the picker's `data-code`/`data-sub`). Nothing visible changes. | `test-ui/ledger-picker.js`, "a ledger code with markup": restores a backup whose codes carry an `<img onerror>` probe and opens the picker on the three pages; nothing runs, no element is added, the option holds the code as text. Before the fix the probe ran on all three (6 checks failed). |
| `a3ea627` | R2 / S10 (Low): `db.js` refuses a `PLANNR_DB` that is set but empty (or spaces) before anything is opened; unset still means `data/plannr.db`. | `test/live-db-guard.test.js`: on its own copy of `db.js`, `""` and `"   "` are refused with the message, inside and outside the test runner, and the copy's `data/plannr.db` is never created. Before the fix the copy's live file was opened outside the test runner. |
| `d33953b` | S9 (Low): `.gitignore` also ignores signing keys and certificates (`*.jks`, `*.p12`, `*.pem`), `.env.*`, plain exports, CSV and PDF exports, compressed databases and pulled snapshots. | `test/release-guards.test.js`: each pattern is listed, and `git check-ignore` ignores a sample name for each (and not `.env.example`). Before the change it failed on the first missing pattern. `git ls-files -ci --exclude-standard`: no tracked file newly ignored. |

## 5. Speed

Phase 3 (efficiency) was **not started**: no change was made for speed, so there is no "after". The
measurements from the end of step 1.4 (desktop, `s18/bench.js`, `53db636`) are the baseline for it:
startup on a new database 256/252/242 ms; 400 saves 5,637/5,610/5,643 ms; 400 Overviews
5,588/5,524/5,816 ms; 4 × 100 requests at once 1,063/1,066/876 ms; `npm test` 145/127 s (660 tests).
On the emulator (2026-11-21, a slow day): the Data Backup page fills 13.8 s after a reload (1,229
rows); the encrypted backup 12.3 s; the move 10.3 s. APK 15,087,178 bytes.

The likely gains, from the audit (to be measured first):

1. The Overview and Money Debited pages load every `cash_out` row and render them all (F-E1).
2. `computeOverview` sums every row in JavaScript instead of `SUM … GROUP BY` (F-E2).
3. Every page runs `init()` again: about 80 bridge calls per page on the phone (F-E3).
4. The Data Backup page reads every `localStorage` value to size the old copy (F-E5).
5. One query per scheduled payment date in the Overview (F-E6).
6. three.js (2.1 MB unminified) for one background shader (F-E7); SQLCipher's native libraries for
   4 ABIs although the database is not encrypted (F-E8).

## 6. Lists

*A record of 2026-11-21. All nine decisions below have since been taken: S1 and CI (F12) by the
merge into `main` (PR #1), the others in section 8. Most of the SKIPPED items have been fixed since; section
2 has each one's status. What is open now is in section 10.*

### NEEDS MY DECISION
1. **S1, `main`'s open dev server.** (a) Merge `plannr-phase2` into `main` (the PR text is in `docs/pr-plannr-phase2.md`; recommended); (b) a one-line fix on `main` first (`app.listen(PORT, '127.0.0.1')`), then the merge later; (c) stop running `main`'s `server.js` until the merge.
2. **S3 / Q6, a restore that fails after the file is replaced.** (a) Upgrade and check the incoming database in a temporary file first and swap only if it passes (recommended; the phone needs the same in `local-snapshot.js`); (b) on failure, put the pre-restore safety copy back automatically; (c) keep it as it is and only make the message say where the safety copy is.
3. **F4, "₹X left" under a date range.** (a) Intended: the whole budget minus what was spent in the range; then only the label changes ("left of the budget, for this range"); (b) always compare the whole-project spend with the budget, whatever range is shown; (c) hide "left" while a range is set.
4. **S5, backup key strength.** (a) Backup format v2: scrypt N = 2^17 and the parameters in the header, v1 files still open (the golden `.plbk` files must keep opening); (b) leave v1 (the files stay on your own devices; a 10+ character passphrase).
5. **INCIDENT 3, a user-folder path in pushed commit `6e26df4`.** (a) Leave it (fixed in `71b9fce`; the name is close to the author name every commit already shows); (b) you rewrite that commit and force-push (this session may not force-push). Matters only if the repository is or becomes public.
6. **The UI suites' browser.** (a) Run `npx playwright install chromium` in `D:\Projects\Plannr` to get the exact Chromium 1228 back (a download of about 150 MB); (b) keep the stand-in (the installed Chromium 151 through junctions in this session's scratch folder, which a reboot can clear).
7. **F1, a stricter import.** (a) Also refuse ledger codes that are not in the code format (as the CSV import does): stops crafted codes at the door, but could refuse an older backup with codes in another shape; (b) escaping only (done).
8. **CI.** (a) Add a GitHub Actions workflow running `npm test` (both passes) and the UI suites (a new tool: GitHub-hosted runners); (b) keep running the suites locally.
9. **S7, unused permissions.** (a) Remove `USE_BIOMETRIC` and `USE_FINGERPRINT` from the merged manifest with `tools:node="remove"` (needs a new build and an emulator check); (b) leave them (no prompt is ever shown).

### OUTSIDE THE CODE
- `main` still runs the open dev server (S1): merge `plannr-phase2`, or stop using `main`'s server.
- The exact Playwright browser (Chromium revision 1228) was removed by another project's install;
  the UI suites run on Chromium 151 through junctions until you run `npx playwright install chromium`.
- No CI: the repository has no workflow (F12). Adding one uses GitHub-hosted actions, a new tool.
- The real-phone checks in `docs/PHONE-TEST-CHECKLIST.md`.

### REVERTED
- None. Every change in this session passed the full suite (both node passes, all 15 UI suites, `test:slow`, the phone pass at the same 17 known differences) before it was committed.

### SKIPPED
- **Phase 3 (efficiency) and Phase 4 (quality clean-up) were not started** (decision 45): the session had about 3 hours of work for step 1.4's finish, the emulator checks, the audit and four fixes. The baseline numbers and the likely gains are in section 5.
- The other Medium findings (S3/Q6, Q3, Q4, Q2, F2, F3, F4) are not fixed: three need your decision first; Q3 (contract and its dates in one transaction) and F2 (CSV download on the phone) are the next fixes that need none.
- S7 (unused permissions) not changed: it is a manifest change that needs a new build (decision 9 above).
- F1's stricter import (decision 7 above).
- On the emulator, `phone-test.ps1`'s PDF checks (4, 8) fail on the app's 25 s PDF limit (finding E1): not changed, to be measured on the real phone first.

## 7. Final state

*The state at the end of the 2026-11-21 session, kept as a record. CI was added since (F12), and
the APK for the real-phone round is now a fresh debug build from `main` after PR #3
(`docs/PHONE-TEST-CHECKLIST.md`).*

- **Tests** at `d33953b` (the last code change): `npm test` desktop pass 665 tests: 662 pass, 3 skipped, 0 fail; phone-code pass
  213 of 230 (the same 17 known differences, nothing new); all 15 UI suites pass; `npm run test:slow` 2 of 2.
- **APK:** no new APK was built in this session. The latest is the RC,
  `D:\Backups\plannr\Plannr-debug-rc-53db636.apk`, SHA-256
  `1c54c4c889dec806fcadfdb79c50ea2be6c6429f0b07f2ad817a00cd1990e1f0`. F1 changes the phone's pages,
  so build a new APK from this branch before the real-phone round.
- **Bundle:** made at the end of the session, `D:\Backups\plannr\plannr-phase2-2026-11-21-<the session's last commit>.bundle`
  (verified; older bundles kept; the exact name is in the session report, B5).
- **Commits:** the review's commits are listed in section 4. Everything up to `71b9fce` was pushed
  earlier in the session; the rest is pushed at the end of it after a clean pre-push check. If
  anything is left unpushed, the push is:

  ```powershell
  git push origin plannr-phase2
  ```

## 8. Follow-up, 2026-11-22 (`plannr-phase3`)

The decisions from 2026-11-21 were carried out on `plannr-phase3`, one commit per change, each
with a test that failed before the fix and the full suite after it. The details and the speed
measurements are in `docs/session-report-2026-11-22.md`; its list of what was still open is from
that day. What is open now is in section 10.

| Item | Decision | Commit |
|---|---|---|
| S1 | (a) Merge `plannr-phase2` into `main` (done on 2026-11-21, before `plannr-phase3` was cut) | PR #1, `4b3ab08` |
| CI (F12) | (a) A GitHub Actions workflow runs `npm test` and the UI suites (added on `plannr-phase2` on 2026-11-21, so in `main` with PR #1, before `plannr-phase3` was cut) | `0466181` |
| S3 / Q6 | Automatic rollback: a restore that fails after the database is replaced puts the data from before it back, and says so | `5e98901` |
| F1 | Also refuse badly shaped ledger codes at import | `b623200` |
| Q3 | A contract and its payment dates in one transaction | `00f6a59` |
| S7 | Remove `USE_BIOMETRIC` and `USE_FINGERPRINT` | `4cf1784` |
| `phone-test.ps1` | Wait for Home to settle offline; time the PDF on slow devices | `46d21ec` |
| F2 | CSV export on the phone: all files in one share sheet | `8b9101e` |
| F3 | Overview: no ₹0.00 while loading or after a failed load | `e5b30ca` |
| F5 | Home: no "First login — welcome." line | `5e6afb7` |
| S5 | Not built. Planned as backup format v2 (scrypt N = 2^17, the parameters in the header); v1 files always stay readable | none |
| Incident 3 | Left as it is, as decided | none |
| Playwright browser | `npx playwright install chromium` run: the UI suites use Chromium revision 1228 again | none |
| F4 | **Fixed** 2026-11-22: option (b), decided by the owner (`ws-b-f4`, merged as PR #4 on 2026-11-23) | `50997b1`, `eb73860`, `ade8d3d`, `7e3a915`, `1986cac`, `c4c7198`, `3674ba0` |

## 9. Follow-up, 2026-11-22 (`ws-a-fixes`)

Fixed on the branch `ws-a-fixes` (pull request #8 into `plannr-phase3`, merged on 2026-11-23). The F7 and
F8 / F9 follow-ups `c3b63d6` and `420416a` are from 2026-11-23. Each fix has
a test that failed on the code before it. For F7 and F8 / F9 the fix is to a UI suite itself, so
the failing runs used scratch harnesses that are not in the repository: they forced the problem
(a `.wasm` file served with the wrong type, a slow page load, a broken wait), ran the old and the
new suite, and are described in each commit message.

| Finding | What changed | Commit |
|---|---|---|
| Q4 | "Move data back" also counts the old copy, its rollback journal and the other `localStorage` keys (`moveBack()`, `moveBackRoomBytes()`) | `883aabd` |
| Q2 | The Data Backup page says that, while the data is in `localStorage`, a sudden close can lose the last seconds of saves, and points to the move | `08939c1` |
| Q14 | A ledger entry and its custom-name write are one transaction | `908b9d4` |
| Q9 | A backup whose `sequences` names a table without an id is refused with a 400 | `d8ef781` |
| Q13 | If planning the upgrade throws, the phone shows the reason instead of a blank page | `76d4c3d` |
| Q12 (partly) | A storage-move snapshot no longer cuts the rotation of regular safety snapshots. Move snapshots are still never pruned; whether to prune them is open (section 10) | `7b2d695` |
| F7 | The "no console errors" checks in `static-hosting` and `offline` ignore sqlite-wasm's own two-line fallback message ("wasm streaming compile failed: ..." then "falling back to ArrayBuffer instantiation"), and only that pair; any other console error still fails them. Both suites use one shared collector, `test-ui/_console-errors.js`. The pair appears when a suite leaves a page while its `.wasm` is still downloading. A wrong Content-Type for `sqlite3.wasm` also causes the pair, so `static-hosting` now checks that header itself: every `.wasm` the pages load must come back as `application/wasm`. Proof: a scratch harness (not committed) served every `.wasm` as `text/plain`; the old suites failed (14 and 12 checks), the new ones pass and still fail three planted errors. With the `.wasm` type removed from `local-server.js`, the header check is the one check that fails | `c927071`, `d11f8ac`, `c3b63d6` |
| F8 / F9 (partly) | `contract-phase-a` waits for what it reads next (15 s at most) instead of sleeping a fixed time, and its waits let only a timeout pass: any other error stops the suite at the wait that broke. Proof: scratch copies of the suite (not committed) made the page's contract load answer late (the old suite crashed, the new one passes) and broke single waits (the old suite passed or failed at an unrelated check, the new one stops at that wait). The fixed ports, the other suites and the node tests named in the finding are unchanged | `8b5546a`, `420416a` |

Elsewhere (other branches, merged into `plannr-phase3` on 2026-11-23, statuses set above): F4
option (b), decided by the owner, is fixed on `ws-b-f4`; F18 (modal focus) is fixed on
`ws-c-cleanup` (`f2f1701`, checked by `npm run test:modal-focus`).
Q7 and Q16 (`public/local-api.js`) were left for later because that file was being cleaned up on
`ws-c-cleanup` at the same time.

## 10. Still open (2026-11-23)

After pull requests #4 to #8 were merged into `plannr-phase3` (`9c6e394`). The full suite on
`9c6e394`: `npm test` desktop pass 725 tests, 722 pass, 3 skipped, 0 fail; phone-code pass 233 of
250 (the same 17 known differences); all 16 UI suites pass, `test:modal-focus` included;
`npm run test:slow` 2 of 2.

**Decisions for the owner**
- **The owner's phone, from the debug build to the release build.** The phone runs a debug build
  and holds the only live copy of the real data. A release APK cannot be installed over it
  (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`), and Plannr is never uninstalled on that phone. Not
  decided; the question is in `docs/release-plan.md` section 6. Until then the phone gets debug
  builds only, through `docs/PHONE-TEST-CHECKLIST.md`.
- **A copy of the laptop's debug key.** While the owner's phone runs a debug build, only debug
  builds signed by the owner's current laptop's debug key install over it (`SETUP.md` §2).
  Whether and how to keep a copy of that key: not decided.
- **Q12, the rest.** Move snapshots (`plannr-pre-move-*`, `plannr-old-copy-*`,
  `plannr-pre-move-back-*`) are never pruned: prune them, or keep them all.

**For the owner to do**
- Make the second offline backup copy of the release key (`docs/release-plan.md` section 1.3).
- Pull request #3 (`plannr-phase3` into `main`) is open; the owner merges it.
- The real-phone round (`docs/PHONE-TEST-CHECKLIST.md`), with a fresh debug build from `main` after
  pull request #3. Not run yet.

**Code and CI (named here, not changed by this update)**
- `.github/workflows/tests.yml`: the push trigger still names `plannr-phase2`, not
  `plannr-phase3`, so a merge into `plannr-phase3` gets no CI run of its own (only the pull
  request's run before it).
- `test-ui/c-modal-focus.js` waits a fixed 100 ms in three places (lines 43, 63 and 72) before it
  reads focus or the dialog's result. It is part of the full suite and of CI now: the same
  fixed-sleep pattern as F8 / F9.
- Findings still **Open** in section 2: Q5, S2, S4, Q7, Q8, Q10, Q11, Q16, F8 / F9 (all but
  `contract-phase-a`), F10, F13, F14, F15 to F17, F20, E1 (to measure on the real phone) and the
  rest of the Info row. S5 is planned (backup format v2) but not built.
- Speed (section 5): none of the likely gains has been worked on. The 2026-11-22 measurements are
  in `docs/session-report-2026-11-22.md` section 5.

**README images (not changed by this update)**
- `docs/images/budget.png` and `docs/images/pdf-export.png`, both shown in `README.md`, were made
  before F4 and still show the old "left" wording. Retake them with the demo data, as
  `docs/DEVELOPERS.md` ("README images") describes.

## 11. Follow-up, 2026-11-25 (`ws2-a-fixes`)

Fixed on the branch `ws2-a-fixes`. Each fix has a test (`test/ws2a-*.test.js`) that failed on the
code before it.

| Finding | What changed | Commit |
|---|---|---|
| Q7 | **Reverted.** `c6a9a33` left a leftover `kvvfs-local-jrnl` record out of `measureStorage()`'s database bytes. That number is also the old copy's size in `/api/storage`'s `backupBytes`, and `test-ui/storage-startup.js` counts the journal there; the move-back room check (Q4) counts it on purpose. **Won't fix** (2026-11-25, owner's decision): the record really takes `localStorage` quota, and the storage page's sizes count it on purpose | `c6a9a33`, reverted in `4e87808` |
| Q16 | The phone's API URL-decodes route params (a malformed one gets 400) and keeps the status of an error that carries one, as `server.js` does. The phone pass still has the same 17 known differences | `d184d3b` |
| F10 | `run-tests.js` picks the phone-pass files with `usesHelpers()`: any quote style, an optional `.js`, spaces. It finds the same files today | `055c7c9` |
| Q5 | Startup reports a marker file that is there but unreadable; the database file is then set aside, never deleted | `d59d5df` |
| F13 | `reset-db` keeps the `_migrated_*` rows in `settings` | `8ee6c0b` |
| S2 | The dev server answers 403 to a POST, PUT, PATCH or DELETE whose `Origin` is another site. Same-origin pages and requests with no `Origin` are unchanged | `e1761b5` |
| F15 | The phone's fetch shim takes a URL object and an absolute `/api/` address on the page's own origin; other origins still go to the page's own fetch. A `Request` passed without `init` keeps its method and body | `832d31d` and the next commit |

Still open from this list: Q11, Q10, F14, S4, F16, F17 (Q10 and F14 need a limit value from
the owner). F20 needs `package.json`, which this branch does not change.

## 12. Follow-up, 2026-11-26 (`ws3-a-fixes`)

Fixed on the branch `ws3-a-fixes`, as the owner decided. Each fix has a test (`test/ws3a-*.test.js`)
that failed on the code before it.

| Finding | What changed | Commit |
|---|---|---|
| Q7 | **Won't fix** (2026-11-25, owner's decision). The leftover `kvvfs-local-jrnl` record really takes `localStorage` quota. The storage page's sizes and the move-back room check (Q4) count it on purpose, and `backupBytes` relies on it (the reverted `c6a9a33`). Docs only | `7aa2928` |
| Q10 | One entry is at most ₹1,00,00,000.00 (₹1 crore): `MAX_AMOUNT_PAISE` in `core/parsers.js`. Cash in, cash out (add, edit, Save All) and contractor payments refuse more with a 400: "An amount can be at most ₹1,00,00,000 (₹1 crore)." Totals have a limit of ₹10,00,00,00,000.00 (₹1,000 crore): `MAX_TOTAL_PAISE` (owner's decision 2026-11-27, "Single entries only"). The budget, loans (add, edit), the contract's amounts (rate × area too) and an allowance's cap and rate refuse more with a 400 (a per-sq-ft allowance's rate × area is not checked against it: it is only shown, never summed): "A total can be at most ₹10,00,00,00,000 (₹1,000 crore)." Amounts were already stored and summed as integer paise. A sum stays exact while it is at most `Number.MAX_SAFE_INTEGER` paise: over 9,000 totals at the totals limit, or over nine million entries at the cap. Tests sum 6,000 entries at the cap and 300 loans at the totals limit on both passes. Not covered yet: the JSON import (`backup-format.js`) does not check either limit, so a backup with a larger amount still restores (covered since 2026-11-28: section 13) | `7c6302f`, `1332d03` |
| Q11 | `isStorageFullError` (`db.js`) says "full" only for `SQLITE_FULL`, or for an I/O error the browser's quota caused. kvvfs logs the `QuotaExceededError` through `sqlite3.config.error`, and `watchKvvfsQuota` listens there. Any other failed save answers "Couldn't save – try again." (`SAVE_FAILED` in `request-rules.js`); a failed read still answers "Something went wrong.". `test:storage-limit` still shows "Storage is full" for a real quota error | `08b3a69` |
| F14 | The restore limit is 32 MB (`request-rules.js`): an encrypted file of up to 24 MB, so every database the storage meter calls healthy can be restored. The Data Backup page shows a note under each export button from 75% of what a restore takes: the size, the limit and what to do | `884d292` |
| Q12 | The rest (pruning move snapshots): fix in `ws3-b-q12` (its own pull request): until the move is confirmed on the Data Backup page, its snapshots are never deleted and do not count; after that, from the next snapshot written, the newest 3 snapshots in total remain; the one just written is never deleted, and a move back makes the move unconfirmed again | |

## 13. Follow-up, 2026-11-28 (the owner's decisions)

The owner decided the remaining points on 2026-11-28. Each change is on its own branch, with a test
that failed on the code before it.

| Point | Decision and what changed | Branch |
|---|---|---|
| Q10, JSON import | The JSON import checks the same limits as a typed amount: one entry (cash in, cash out, a contractor payment) at most ₹1,00,00,000 (₹1 crore), a total (the budget, a loan, the contract's amounts, an allowance's cap and rate) at most ₹10,00,00,00,000 (₹1,000 crore). A backup with any amount over its limit is refused whole, before the safety copy and before any write, with a message that names the rows (the list, the row's place in the file, its date and amount, and the limit; at most 10 rows, then "and N more"). Nothing changes. Every budget row in the file is checked, not only the first | `ws4-a-import` |
| Q11, wording | A failed import: "Couldn't import this file. Nothing was changed. Please try again." A failed restore: "Couldn't restore this backup. Your data hasn't changed." A full storage: "Your phone's storage is full. Free up some space and try again. Nothing was changed." Both hosts use the same texts. A refused file (wrong passphrase, not a backup, made by a newer version, too big, or over the Q10 limits) keeps its own message. The technical cause is logged, not shown | `ws4-a-import` |
| F14 | Keep 32 MB: no change | |
| Field borders | `.lb-trigger` has used `var(--field-border)` since `943c3d6` (PR #15); a check on the rendered page now keeps its border at 3:1 or more. The Allowances "Cap type" dropdowns on Contract details had no border rule at all; they now get `var(--field-border)` | `ws4-b-ui` |
| Old copy size | The Data Backup page showed the old copy as 0.2 MB in one place and 0.3 MB in another. Both places now use one count (`GET /api/storage`) and one formatter, which rounds up to the next 0.1 MB | `ws4-b-ui` |
| PDF file names | They use the phone's local date, the same date as the email subject | `ws2-c-share` (PR #13) |
| Desktop links | Links to Plannr's own pages stay in the app; http and https links open in the system browser; everything else is blocked | `ws2-e-desktop` (PR #10, a draft) |
| Release certificate | Its SHA-256 fingerprint goes into `docs/release-plan.md` (section 1.3): the fingerprint only, which is public. Not recorded yet: the release key has not signed a build, and reading the fingerprint from the key needs the owner's password | `ws4-c-docs` |
| Decision dates | The two decisions in `docs/release-plan.md` section 6 are dated 2026-11-28 | `ws4-c-docs` |
