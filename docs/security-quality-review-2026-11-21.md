# Security and quality review of `plannr-phase2`, 2026-11-21

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

## 2. Findings

Severity is judged for this app: one user, offline, phone app shipped, dev server for development.
"Status" is at the end of this session.

| ID | Sev. | Finding | Evidence | Status |
|---|---|---|---|---|
| Q1 | **High** | A database from the two oldest schemas (v1) keeps the removed login's `sessions` table, which the start-up ownership check refuses: the app cannot start (dev server; phone after restoring such an encrypted backup) | `backup-format.js:42-45` (list), `:82-97` (check), `core/routes/backup.js:36` (start job); fixtures 01, 02, L1–L5 | **Fixed** (`ed52850`) |
| S1 | Medium | `main` (not this branch) listens on every interface with no login; export and import reachable from the Wi-Fi and by DNS rebinding | `main:server.js:2615` `app.listen(PORT, '0.0.0.0'…)`, `main:server.js:171` | Outside the code: merge (NEEDS MY DECISION) |
| S3 / Q6 | Medium | A restore replaces the database, then runs migrations and the foreign-key check; if they fail, the backup's data stays live while the answer says it failed; on the phone the safety copy is out of reach | `db.js:372-376`; `core/routes/backup.js:133-134`; `public/local-snapshot.js:100,107` | **Fixed** 2026-11-22 (`5e98901`): automatic rollback, as decided |
| Q3 | Medium | Saving a contract writes it and its payment dates as separate statements, outside a transaction; a failure between them leaves dates deleted or a contract without dates | `repo.js:217`; `core/routes/contracts.js:321-331` | **Fixed** 2026-11-22 (`00f6a59`) |
| Q4 | Medium | "Move data back fits" counts only the incoming size, not the journal or what is already in `localStorage` | `core/storage-move.js:251`; `public/db-adapter-kvvfs.js:52-90` | **Fixed** 2026-11-22 (`883aabd`, `ws-a-fixes`) |
| Q2 | Medium | On `localStorage`, a kill loses the last seconds of saves (WebView writes late); nothing tells the user | measured on the emulator (E3, E6); `public/data-backup.html:233-238` | **Fixed** 2026-11-22 (`08939c1`, `ws-a-fixes`) |
| F1 | Medium | Ledger codes from a restored JSON backup go into HTML attributes unescaped (a crafted backup could run script in the app) | `public/plannr-ui.js:138,145,311,318,1007,1022,1060`; `backup-format.js:157-170` (codes only checked non-empty) | **Fixed** (`678092c`); the stricter import too, 2026-11-22 (`b623200`) |
| F2 | Medium | "Download CSV (for Excel)" uses a plain download link, a dead end in the Android WebView, and reports success | `public/data-backup.html:875-878` (vs `saveFile()` elsewhere) | **Fixed** 2026-11-22 (`8b9101e`) |
| F3 | Medium | The Overview shows ₹0.00 while loading and after a failed load, with no message | `public/overview.html:375-381, 620-621, 637-638` | **Fixed** 2026-11-22 (`e5b30ca`) |
| F4 | Medium | "₹X left" compares a date-range spend with the whole-project budget | `public/overview.html:691-706`; `core/overview-pdf.js:121` | Open (NEEDS MY DECISION, still: intended?) |
| Q5 | Low | An unreadable marker file plus a lost `localStorage` key after a kill could lead startup to delete the database file (two faults) | `public/storage-native.js:128-135,177`; `core/storage-move.js:227` | Open |
| S2 | Low | Dev server: no Origin check; two body-less POST routes (mark exported, restore from bin) can be triggered by a web page while it runs | `core/routes/backup-reminder.js:78`; `core/routes/trash.js:45` | Open |
| S4 | Low | A crafted backup can bring triggers or views; the `localStorage` restore runs schema SQL from the file | `public/local-snapshot.js:59-60,76-77`; `db-adapter-node.js:95` | Open |
| S5 | Low | Backup key derivation scrypt N=2^14 (below current advice), minimum passphrase 10 characters; parameters not in the header | `core/backup-crypto.js:29,34` | Planned, not built (decided 2026-11-21): backup format v2; v1 files always stay readable |
| S7 | Low | The APK has `USE_BIOMETRIC` and `USE_FINGERPRINT` from the storage plugin's dependencies; Plannr never uses them | merged manifest; `aapt dump permissions` of the RC | **Fixed** 2026-11-22 (`4cf1784`), checked on the built APK and the emulator |
| S9 / F19 | Low | `.gitignore` misses `*.jks`, `*.p12`, `*.pem`, `.env.*`, plain exports and pulled snapshots | `.gitignore` | **Fixed** (`d33953b`) |
| S10 / R2 | Low | A `PLANNR_DB` that is set but empty opens the real database (incident 1) | `db.js:31` | **Fixed** (`a3ea627`) |
| Q7 | Low | A leftover `kvvfs-local-jrnl` record is counted as data and takes quota | `public/local-api.js:67-76` | Open |
| Q8 / R3 | Low | `node:sqlite` stores numbers as REAL: `sqlite_sequence.seq` and unchecked TEXT columns from hand-edited backups differ between desktop and phone | `db.js:1001,1101,1337`; `backup-format.js:122-283,328` | Open |
| Q9 | Low | A backup's `sequences` naming a table without an id gives a 500 instead of a 400 | `backup-format.js:178-184,326` | **Fixed** 2026-11-22 (`d8ef781`, `ws-a-fixes`) |
| Q10 | Low | No upper limit on amounts; a typo near ₹90 trillion can break the Overview's sums | `core/parsers.js:11-17` | Open |
| Q11 | Low | Any I/O error is reported as "storage full" on every engine | `db.js:1717-1723` | Open |
| Q12 | Low | Move snapshots go through the regular rotation and cut it by one; they are never pruned | `public/safety-snapshots.js:40,52-57` | **Fixed** 2026-11-22 (`7b2d695`, `ws-a-fixes`) |
| Q13 | Low | If planning the upgrade throws, the phone shows a blank page | `public/local-bootstrap.js:54` | **Fixed** 2026-11-22 (`76d4c3d`, `ws-a-fixes`) |
| Q14 | Low | A ledger entry and its custom-name write are two writes; a failure between them leads to a duplicate on retry | `core/ledger-crud.js:44-66,82-121` | **Fixed** 2026-11-22 (`908b9d4`, `ws-a-fixes`) |
| Q16 | Low | The phone's API answers every error as 500 and does not decode route params | `public/local-api.js:303-321` | Open |
| F5 | Low | Home says "First login — welcome." on every start (left from the removed login) | `public/home.html:233-258` | **Fixed** 2026-11-22 (`5e6afb7`) |
| F7 | Low | The UI "no console errors" rule fails on sqlite-wasm's harmless "wasm streaming compile failed" fallback | `test-ui/static-hosting.js:41-58`; `db-engine.js:39` | Open |
| F8 / F9 | Low | Fixed ports and sleeps in UI and node tests (flake risk) | `test-ui/*.js`; `test/stop-sentinel.test.js:16-31`; `test/request-queue-wiring.test.js:54` | Open |
| F10 | Low | The phone pass picks its test files with a literal regex | `run-tests.js:44` | Open |
| F12 | Low | No CI, lint or format configuration | no `.github/` | **Fixed**: CI added with `plannr-phase2` (PR #1) |
| F13 | Low | `reset-db` deletes the `_migrated_*` markers too | `reset-db.js:58` | Open |
| F14 | Low | Encrypted restore body limit 20 MB (base64), so a database over about 15 MB cannot be restored on the phone; export does not warn | `request-rules.js:11,26` | Open |
| F15–F18 | Low | Fetch-shim edge cases; row buttons can be double-submitted; unsaved input lost on Back; modal focus | `public/local-api.js:291-292`; `public/data-backup.html:1066-1073`; `public/plannr-ui.js:370-463` | Open |
| F20 | Low | `engines` says Node ≥22.12.0; `node:sqlite` is unflagged from 22.13 (unchecked) | `package.json:41` | Open |
| E1 | Low | The PDF export gives up after 25 s; a slow emulator reached it | `public/overview.html` (withTimeout), emulator 2026-11-21 | Open; `phone-test.ps1` now waits up to 90 s and reports the PDF time (`46d21ec`): 4.1 to 4.5 s on the emulator 2026-11-22 |
| S6, S8, S11–S19, Q15, Q17–Q19, F6, F11, F21–F25 | Info | Auto Backup holds plain data (by design); broad FileProvider path; `run-tests.js` says "never opened" but checks mtime; error details and paths in answers; logging; PDF Chromium `--no-sandbox`; CSV formula prefix; `.env` read from the working folder; LAN token over HTTP; dead code and imports; README screenshots missing; docs say the storage move is not done and that snapshots are in Auto Backup | see the audit notes | Open (docs and clean-up) |

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
with a test that failed before the fix and the full suite after it. The details, the speed
measurements and what is still open are in `docs/session-report-2026-11-22.md`.

| Item | Decision | Commit |
|---|---|---|
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
| F4 | Still NEEDS MY DECISION (options in section 6) | none |

## 9. Follow-up, 2026-11-22 (`ws-a-fixes`)

Fixed on the branch `ws-a-fixes` (pull request into `plannr-phase3`, not merged yet). Each fix has
a test that failed on the code before it.

| Finding | What changed | Commit |
|---|---|---|
| Q4 | "Move data back" also counts the old copy, its rollback journal and the other `localStorage` keys (`moveBack()`, `moveBackRoomBytes()`) | `883aabd` |
| Q2 | The Data Backup page says that, while the data is in `localStorage`, a sudden close can lose the last seconds of saves, and points to the move | `08939c1` |
| Q14 | A ledger entry and its custom-name write are one transaction | `908b9d4` |
| Q9 | A backup whose `sequences` names a table without an id is refused with a 400 | `d8ef781` |
| Q13 | If planning the upgrade throws, the phone shows the reason instead of a blank page | `76d4c3d` |
| Q12 | A storage-move snapshot no longer cuts the rotation of regular safety snapshots | `7b2d695` |

Elsewhere the same day (other branches, statuses to be set here when they merge): F4 option (b)
is on `ws-b-f4` as a draft, awaiting the decision; F18 (modal focus) is fixed on `ws-c-cleanup`.
Q7 and Q16 (`public/local-api.js`) were left for later because that file was being cleaned up on
`ws-c-cleanup` at the same time.
