# Session report, 2026-11-25 (ws2: five parallel workstreams)

A dated record, written at about 20:20 on 2026-11-25. For the current state, see `CHANGELOG.md`, the pull requests below, and sections 10 and 11 of `docs/security-quality-review-2026-11-21.md`.

## Time

- Timebox: 19:20 to 20:20, with new work until 20:10.
- Workers A, B, C, D and E ran in parallel until about 19:52, then a read-only reviewer each. Follow-ups for D and C ran until about 19:58.
- Full suites take 15 to 20 minutes each here, partly one after another (the UI suites use fixed ports). They passed for E at 20:06, B at 20:08, D at 20:12 and C at 20:15. A's failed at 20:13 (see "Reverted") and was started again after the revert.
- No agent stalled and nothing hung. About 5 minutes went to two false alarms in the pre-push check (see "Tooling").

## Base

PR #3 (`plannr-phase3` → `main`) was not merged at the start, and there is no separate Q12 / key-switch PR. So all five branches start at `d99d310` (the head of `plannr-phase3`), and their PRs into `main` are **stacked on #3**: until #3 is merged, each diff also shows #3's commits. The Q12 / debug-to-release key switch / `.gitignore` task is not recorded anywhere, and its parts are open owner decisions, so workstream A did not do it (see "Needs your decision").

The worktrees are `D:\Projects\plannr-wt\g` to `k` (`f` was already used by `ws-f-docs-sync`, which was kept). They are left in place.

## File ownership

No two workstreams edited the same file.

| Workstream | Branch / worktree | Owns (may edit) | New files allowed |
|---|---|---|---|
| A fixes | `ws2-a-fixes` / `g` | `public/local-api.js`, `db.js`, `public/storage-native.js`, `core/storage-move.js`, `reset-db.js`, `request-rules.js`, `public/data-backup.html`, `core/routes/backup-reminder.js`, `core/routes/trash.js`, `server.js`, `public/local-snapshot.js`, `db-adapter-node.js`, `core/parsers.js`, `run-tests.js`, `public/plannr-ui.js`, `public/safety-snapshots.js`, `test/phone-code-differences.json`, `docs/security-quality-review-2026-11-21.md`; existing tests that cover only these files | `test/ws2a-*.test.js` |
| B clean-up | `ws2-b-cleanup` / `h` | `public/styles.css`, `public/contract-details.html`, `public/cash-flow.html`, `public/cash-inflow.html`, `public/cash-outflow.html`, `public/contractor-payments.html`, `public/loan-details.html`, `public/index.html`, `repo.js`, `ledgers.js`, `core/ledger-crud.js`, `core/ledger-index.js`, `core/overview-pdf.js`, `core/owner.js`, `core/request-queue.js`, `core/storage-check.js`, `core/routes/{backup,budget,cash-and-loans,contractor-payments,contracts,ledger-list,overview,pdf,people,storage}.js`. Existing tests: never edited | `test/ws2b-*.test.js` |
| C share | `ws2-c-share` / `i` | `public/overview.html`, `public/home.html`, `public/notifications.js`, `core/routes/notification-times.js`, `backup-format.js`, `sync-public-modules.js`, `package.json`, `package-lock.json`, `android/app/src/main/AndroidManifest.xml`, `android/app/src/main/java/com/plannr/app/MainActivity.java`, `test/shim-capacitor-fake.mjs`, `docs/share-and-reminder-pdf-plan.md`, `docs/PHONE-TEST-CHECKLIST.md`; existing PDF/overview UI tests. **Added during the session** (nobody else needed them): `test/share-sheet.test.js`, `android/capacitor.settings.gradle`, `android/app/capacitor.build.gradle` | `public/share-pdf.js`, `android/app/src/main/java/com/plannr/app/ShareToPlugin.java`, `test/ws2c-*.test.js`, `test-ui/ws2c-*.js` |
| D release | `ws2-d-release` / `j` | `release-android.js`, `android/app/build.gradle`, `android/gradle.properties`, `test/release-script.test.js`, `test/release-guards.test.js`, `.gitignore`, `README.md` (Install section only), `SETUP.md`, `docs/RELEASE.md`, `docs/release-plan.md`, `CHANGELOG.md` | `docs/release-notes-1.0.0.md`, `test/ws2d-*.test.js`, this report |
| E desktop | `ws2-e-desktop` / `k` | nothing outside its new folder | `desktop/**`, `test/desktop-*.test.js` |

Nobody owned: `HANDOFF.md`, `CONTRIBUTING.md`, `docs/DEVELOPERS.md`, `docs/cross-platform-plan.md`, `.github/**`, `capacitor.config.json`, `android/variables.gradle`, the other `public/*` and `core/*` files, and every other existing test.

## Results

| Workstream | Branch | Commits | Tests added | PR | Local full suite | CI at 20:17 |
|---|---|---|---|---|---|---|
| A fixes | `ws2-a-fixes` | 13: Q16, F10, Q5, F13, S2, F15 (2), Q7 and its revert, 4 docs | 6 files (`test/ws2a-*`); `test/reset-db.test.js` adjusted | opened after its re-run | failed on Q7, re-run after the revert | not started |
| B clean-up | `ws2-b-cleanup` | 7: 1 contrast fix, 2 splits, 1 duplicate removed, 3 characterization tests | 4 files (`test/ws2b-*`) | #11 | pass | 2 of 3 jobs pass, Windows pending |
| C share | `ws2-c-share` | 10 | 4 node test files (`test/ws2c-*`), 1 UI suite (`test-ui/ws2c-share-settings.js`); `test/share-sheet.test.js` moved to the new file | #13 (draft) | pass | running |
| D release | `ws2-d-release` | 4, plus this report | 2 files (`test/ws2d-*`) | #12 | pass | 1 of 3 jobs pass, 2 pending |
| E desktop | `ws2-e-desktop` | 3 | 1 file (`test/desktop-trial.test.js`, 7 tests) | #10 (draft) | pass | 2 of 3 jobs pass, Windows pending |

Every fix or feature commit has a test that failed before it; each PR lists the failure it saw. B's refactors are proved by the existing tests passing unchanged, plus characterization tests added first.

## Reverted

- **Q7** (A, `c6a9a33`, reverted in `4e87808`). The fix left a leftover `kvvfs-local-jrnl` record out of `measureStorage()`'s database bytes. That number is also the old copy's size in `/api/storage`'s `backupBytes` after the move, and the full suite's `test:storage-startup` (the C11 check) counts every `kvvfs-local` record there, so it failed (513,488 against 545,820 bytes). The Q4 move-back room check counts the journal on purpose, so which count is right for a backup needs a closer look. Q7 is Open again in the review document (`1948d7d`).

A's reviewer also found one must-fix (six status cells appended to the review document's title line). It was fixed forward in `243e299`, because a revert would have conflicted with two later commits.

## Skipped

| Item | Workstream | Why |
|---|---|---|
| Q10, F14 | A | Need a limit value the review does not recommend (see below) |
| Q11 | A | The fix changes an assertion in `test/storage.test.js`, which also covers B's `core/routes/storage.js`, and desktop users would see a different message |
| S4, F16, F17 | A | Not reached in the time box |
| F7 | A | Already fixed (PR #8); confirmed only |
| F20 | A → C | Needs `package.json` (C's). Fixed on `ws2-c-share` (`8d3d71e`); the review document's F20 row (A's file) still says Open |
| `SETUP.md` still says Node `>=22.12.0` | C → D | Follow-up once `ws2-c-share` is merged |
| Split `computeOverview`, `buildOverviewPdfHtml`, the `contract-details.html` scripts | B | Not reached in the time box |
| Dead code | B | None that a whole-repo search proves unused |
| The **Send to WhatsApp** / **Send by email** buttons, their fallbacks and offline note, and their UI suite | C | Not reached in the time box. The settings, the email plugin, the WhatsApp plugin and the moved share code are in |
| Emulator check of the share fallbacks | C | The buttons it would test are not built |
| Reminder **Send PDF** button | C | Not in part 1, as asked: it is the next part |
| Scripted desktop click-through | E | Playwright 1.61.1's `_electron.launch` times out before the first window, also with an empty Electron app |
| Real signed release build | D | Needs your passwords; the flow was proved with throwaway TEST keys |

## Release APK

The real signed build was **not** run: it needs your passwords, and nothing may read them. The flow was proved with two throwaway TEST keys outside the repository (`D:\Projects\plannr-wt\test-keys\plannr-TEST-ONLY.keystore` and `plannr-TEST-ONLY-2.keystore`). The git-ignored `keystore.properties` in worktree `j` points at the second. They are not the release key.

| APK (TEST key) | SHA-256 of the APK | Certificate SHA-256 |
|---|---|---|
| TEST key 1, versionCode 1 | `7f708b4e9ba9247188bffd4d22e7bd508d3685fc9ef70b8896c0e7530bcb118a` | `6550e9f20fd4b7bd840c0662f41edbb5b4dd8857d795128d76f85f4607f7ba40` |
| TEST key 2, versionCode 1 | `4ccaddf983fff99092312d60ab7123933996ce4c534c791d9f6a27b9e9c59ba8` | `45d74964ec65a767b6f07cef6bb35df056139a6ffe77a4dc85c4daa3c90a63e5` |
| TEST key 2, versionCode 2 | `5612007fddddac6bb833be65085e3abe815403d5ac4273facfc70a5c9a38eedc` | same as above |

The APK files are in the session's temporary folder, not in the repository.

Emulator (`emulator-5554`, test data only):
- (a) Fresh install: `Success`. It opens on Home ("Welcome, Owner"), `versionCode=1`.
- (b) Release → release update: versionCode 1; backup reminder changed from 7 to 30 days; force-stop and restart (still 30); `install -r` of versionCode 2: `Success`, `versionCode=2`, still 30 days. One setting was checked, not a ledger entry.
- (c) Release over debug: `Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.plannr.app signatures do not match newer version; ignoring!]`. As expected: moving a phone from the debug build to the release build needs its own planned round.

`node release-android.js --dry-run` would set `versionCode` 1 → 2 and `versionName` 1.0 → 1.0.0. No bump is committed; the release flow writes it.

## Desktop trial

- **Works:** the node tests (open a file database, write, close, reopen with the data still there; the security surface: `contextIsolation` on, `nodeIntegration` off, `sandbox` on, navigation and new windows blocked, every non-`app:` request cancelled, no `listen(` or network call in the main process, preload exactly `{ runtime: 'desktop' }`). Under Electron 45.3.2 the main process starts and creates `userData/plannr.db`, and `node:sqlite` works there.
- **Not proven:** opening a window, adding and editing an entry by script, then restarting. Playwright's Electron launcher times out on this machine, also with an empty app.
- **Not built:** the PDF (`pdf.render` answers 501), saving files, notifications, a "desktop" mode in `public/runtime-mode.js`. No packaging or installers.

## Tooling

The session's pre-push check (a scratch script, not in the repository) stopped two pushes on false alarms, and two of its rules were narrowed after a check both ways:
- `storePassword` / `keyPassword` now count only when a value follows (`=`, `:` or a quoted literal). It flagged the Gradle lines that read the passwords from the environment.
- Email addresses at the reserved `example.com`, `example.org` and `example.net` domains are ignored. The share-settings tests use them.

## Needs your decision

1. **Merge order.** Merge PR #3 first; the ws2 PRs are stacked on it.
2. **Q12 / debug-to-release key switch / `.gitignore`:** no such task or decision is recorded. Q12's rest (prune the move snapshots, or keep them all) and `docs/release-plan.md` §6 (how your phone moves from the debug build to the release build) are still open.
3. **The real signed build** (you run it): remove the two password lines from your `keystore.properties`; `npm run release:android -- --dry-run`; `npm run release:android` (it asks for the passwords); `apksigner verify --print-certs`; compare with `docs/release-plan.md` §1.3; commit the version bump.
4. **Password lines in `keystore.properties`:** the script now stops (implemented). Alternative: only warn.
5. **Q7:** count a leftover journal record in a backup's room or not (the reverted fix said not).
6. **Q10** (no upper limit on amounts): (a) a cap you choose, for example ₹1,000 crore; (b) no cap, but safe sums; (c) leave it.
7. **F14** (encrypted restore limit 20 MB): (a) raise it; (b) warn at export above about 15 MB; (c) both.
8. **Q11** (any I/O error shown as "storage full"): (a) only kvvfs errors count, and one assertion in `test/storage.test.js` changes; (b) leave it.
9. **WCAG 1.4.11:** input borders are about 1.51:1 against the page. (a) Leave them; (b) a new field-border token of about `rgba(255,255,255,0.36)`; (c) raise `--line-strong`.
10. **Desktop smoke harness:** (a) try another Playwright version (a new dependency, needs your OK); (b) a self-test mode inside the app; (c) check by hand.
11. **Desktop runtime mode:** (a) keep the dev-server marker; (b) add a "desktop" mode to `public/runtime-mode.js` later.

## Your next steps, in order

1. Merge PR #3 into `main`.
2. Then, once their CI is green: #12 (release), #11 (clean-up), A's PR (review fixes). Last, the drafts #13 (share, part 1) and #10 (desktop trial), when you want them.
3. After #13 is merged: `npm ci` in your main checkout (it adds `@capawesome/capacitor-mail-composer` 0.2.2).
4. Remove the password lines from `keystore.properties`, then run the real signed build (decision 3).
5. The real-phone round (`docs/PHONE-TEST-CHECKLIST.md`) with a fresh debug build from `main`. It stays a debug build, because of test (c).
6. Decide items 2 and 5 to 11.

## Backup

A verified git bundle of all five branches is made in `D:\Backups\plannr\` after this report; the older bundles are kept.
