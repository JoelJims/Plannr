# Session reports, 2026-11-21

> A dated record of those runs; their open decisions and next steps are from that day. The current
> state is in `CHANGELOG.md` and `docs/security-quality-review-2026-11-21.md` (section 10).

Two autonomous runs end on this date: **A**, the run that finished step 1.4 (2026-11-18 → 2026-11-21), and **B**, the 3-hour session after it.

## A. Step 1.4 finished (2026-11-18 → 2026-11-21)

Autonomous run on `plannr-phase2`, from `28f4927` (B5) to `53db636`. Nothing was pushed during the run (A7), nothing
ran on the real phone, and nothing changed or deleted `data/plannr.db`, the phone's Plannr data or
the real backup files. `data/plannr.db` was *opened* by mistake twice, without any change (A9).

**Result:** step 1.4 is built and tested. The phone can move its data out of the WebView's storage
into a database file of its own, check every table, and switch only if all of it matches, with a
way back. The desktop restores an encrypted backup through the same file adapter. Every part passed
the full test run. No part was reverted. An RC debug APK is built (not installed on the phone).

### A1. Parts and commits

39 commits since `28f4927`: one per part, three test or safety fixes (`305afec`, `163d662`, `0539d5e`), the RC checklist update and this report.

| Commit | Part |
|---|---|
| a22d3ca | B6: 25 more `legacyInit()` calls awaited; legacy-shape fixtures cover the pre-v1 branches |
| a9fa6c7 | B7: the Tenancy Phase 2 block of `legacyInit()` awaited (53 calls) |
| bdbf247 | B8: the Tenancy Step 2a collapse awaited (38 calls); two-household fixtures |
| a8fc7ca | B9: the rest of `legacyInit()` and the upgrade plan awaited |
| 3969efb | B10: `repo.js` starts on the async interface; the ledger index refreshes inside the queue |
| 6744747 | B11: `repo.contract` on the async interface |
| 6fb022b | B12: the rest of `repo.js` async; Save All uses `transaction()` |
| dacb325 | B13: `backup-format.js` async; the ownership check is a start job |
| 6688d88 | B14: the settings routes async |
| 305afec | test:slow: the PDF idle test no longer races its idle window (decision 8) |
| 144f241 | B15: the people routes and the owner/user checks async |
| c315622 | B16: the core gets no synchronous database handle |
| 5f80e46 | B17a: `server.js`, `reset-db.js`, `seed-demo.js` start with the async `init()` |
| 8cdb14b | B17b: the phone's encrypted restore writes through the async interface |
| c8d9c2d | B17c: the synchronous transition code removed |
| 611c4c8 | B18: the Overview timed on the emulator before and after stage B |
| d557662 | C1: the spike report (`@capacitor-community/sqlite` 8.1.1 on the emulator) |
| 197e1f8 | C2: Plannr's own storage helper for the phone (`PlannrStorage`) |
| 7279e74 | C3: the phone's file adapter; the plugin pinned at 8.1.1 |
| 61d09f3 | C4: `core/storage-check.js`, the checks after the move's copy |
| 710a897 | C5: `core/storage-move.js`, the move from localStorage to the file |
| 2fd2436 | C6: the move stopped at every step, by an error and by a real kill |
| a9ccbef | C7: low space and the move |
| 70fd211 | C8: after the move: move back, use the old copy, delete the old copy |
| b79d3d1 | C9: startup chooses the storage from the marker; the recovery screen |
| 377b462 | C10: the Data Backup page runs the move |
| 163d662 | Incident 2: no test may open `data/plannr.db` |
| a107166 | C11: the encrypted backup and `/api/storage` move into the core |
| 5736195 | C12: Auto Backup rules for the database file |
| 069a65c | C13: emulator E1 (update, then the move); `phone-test.ps1` storage check |
| 0539d5e | storage-move-ui waits for the move panel (decision 31) |
| 61f811e | C14: emulator E2, the move near the old limit |
| b0f505b | C15 (1 of 2): emulator E3 (kills) and E4 (low space) |
| 7c548a5 | C15 (2 of 2): emulator E5 (Auto Backup) and E6 (the way back) |
| d3fb92d | C16: phone checklist and plan for the move |
| 018e10b | D1: the desktop restores an encrypted backup through the file adapter |
| 53db636 | D2: the desktop app's data folder for Windows, macOS and Linux |
| dec4e81 | The checklist names the RC build; E1 on the emulator with the RC |
| (this commit) | This report |

Each part's details (what changed, its tests, the deliberate breaks that proved them) are in
`docs/step-1.4-storage-plan.md` §8.

**Open items from the request:** `scripts/phone-test.ps1` has the storage check (check S, C13), and
the checklist has section 9 and the E1–E6 results (C16).

**Reverts: none.** Three parts failed a run and were fixed inside the part instead (each with its
proof and a fresh full run): B8 (a flaky test cleanup, decision 6), B17a (tests relied on a
synchronous start, decision 10), and C13 (a UI test's wait, fixed as its own part, decision 31). One
static-hosting check failed once in C11 and passed 3 of 3 after (decision 29).

### A2. Tests

| | Start (`28f4927`) | Now (`53db636`) |
|---|---|---|
| `npm test` (desktop pass) | 456 tests: 453 pass, 3 skipped | 660 tests: 657 pass, 3 skipped, 0 fail |
| Phone-code pass | 185 of 202 (the 17 known differences) | 213 of 230 (the same 17, nothing new) |
| UI suites | 13, all pass | 15, all pass (on the stand-in Chromium, decision 37) |
| `test:slow` | 2 of 2 | 2 of 2 |
| Emulator proofs | — | E1 13/13, E2 13/13, E3 96/96, E4 15/15, E5 all, E6 27/27 |

Every new test was proven: the guarded code was broken on purpose, the test failed, the code was
restored (by SHA). The init()-equivalence tests (`migration-equivalence`, `migration-faults`,
`upgrade-retry`, `db-init-async`, `migration-legacy-shapes`) pass at every commit.

### A3. Speed, before and after each stage

Same machine, alternating runs (`s18/bench.js`, through `server.js` on a temp database). The PC was
shared with other test runs, so differences under about 10% are noise.

| Measure | Stage B: 28f4927 → 611c4c8 | Stage C: 611c4c8 → d3fb92d | Stage D: d3fb92d → 53db636 |
|---|---|---|---|
| Startup, new database (`init()`) | 133/143 → 181/183 ms | 181/160/179 → 250/194/164 ms | 240/251/231 → 256/252/242 ms |
| 400 saves, one after another | 5,756/5,731 → 5,793/5,687 ms | 5,677/5,827/5,695 → 5,648/5,627/5,778 ms | 5,660/5,531/5,651 → 5,637/5,610/5,643 ms |
| 400 Overviews, one after another | 5,391/5,570 → 5,425/5,498 ms | 5,778/5,622/5,748 → 5,732/5,527/5,707 ms | 5,794/5,787/5,505 → 5,588/5,524/5,816 ms |
| 4 × 100 requests at once | 1,439/1,602 → 1,259/1,437 ms | 912/874/835 → 822/895/753 ms | 900/1,117/883 → 1,063/1,066/876 ms |
| `npm test` time | 107 s (456 tests) → 121 s (492) | 121 s (492) → 127/139 s (645) | 127/139 s (645) → 145/127 s (660) |

- Stage B made startup on a new database about 45 ms slower (every call is now awaited); saves,
  Overviews and concurrent requests did not change. On the emulator the Overview was no slower.
- Stages C and D: no change outside the noise.
- `npm test` grew with the tests (456 → 660), not per test.

### A4. The RC debug APK

| | |
|---|---|
| File | `D:\Backups\plannr\Plannr-debug-rc-53db636.apk` (a copy of the build in the session's scratch folder) |
| Built from | `53db636` (step 1.4 complete); debug build, versionCode 1, versionName 1.0 |
| SHA-256 | `1c54c4c889dec806fcadfdb79c50ea2be6c6429f0b07f2ad817a00cd1990e1f0` |
| Size | 15,087,178 bytes (the storage plugin's native SQLite library makes it larger than `9d7fd97`'s 5,974,512) |
| Signed | the Android debug key, the same as the build on your phone (`9d7fd97`), so `adb install -r` updates it in place |
| Permissions | as `9d7fd97`, plus `USE_BIOMETRIC` and `USE_FINGERPRINT` from the storage plugin (Plannr does not use them; on the review list) |

**Not installed on your phone.** The real-phone APK at
`android/app/build/outputs/apk/debug/Plannr-debug.apk` is still `9d7fd97` (`7dc29db3…a2ef`): the
build script saved it before the build and put it back after, and checked its SHA-256.

**Checked on the `plannr-test` emulator (E1 again, with the RC):** the build your phone has
(`9d7fd97`) with 1,000 typical test entries, then the RC over it with `adb install -r`, then the
move: all 16 checks pass (every row kept by the update; encrypted backup 12.3 s, move 10.3 s;
every table matches; a save goes to the file). A first run failed two page checks only because the
script read the Data Backup page 2.5 s after a reload while the slow emulator took 13.8 s to fill it
(the 5736195 build took as long on the same data that day; decision 38).

### A5. DECISIONS

1. **1a needed no new code.** The B4 equivalence and failure-at-each-step tests are already permanent (`npm test` + `npm run test:slow`); re-ran them (31 + 2 pass) and recorded it, rather than adding duplicate tests.
2. **1b "previous build" = the B4 build (12a5c42), the last build that was on the emulator.** The B4 fix (d5f68a9) was never built. Stage C's E1 separately starts from the real-phone build 9d7fd97.
3. **The Capacitor "Error injecting safe area CSS" console message** seen only when a script navigates pages quickly is left alone (it comes from @capacitor/android's SystemBars plugin, not Plannr code).
4. **Synthetic legacy-shape fixtures (B6).** The schema-history fixtures never reach legacyInit()'s pre-v1 branches, so two deliberate breaks survived. Added made-up user_version 0/1 databases built from fixture 01 (test/fixtures/legacy-shapes/, checksummed, `-text` in .gitattributes) and a test comparing the old runner, await init() and initSync() on them. Test-only; reversible by deleting the folder and test.
5. **A frozen-baseline quirk found in B8 is recorded, not fixed.** On a pre-v2 database where a second household's contract has payment dates, Step 2a's purge removes those dates through ON DELETE CASCADE, its row-count guard does not count them, and the first start refuses (before the version stamp; nothing outside the intended removal is lost, the snapshot is kept); the next start finishes. Only test databases ever had a second household (phone installs were made at v2), and the B stage's rule is "same writes as the old runner". Pinned by fixture L5 and its test instead; a fix would be a behaviour change for a separate, approved step.
6. **A flaky cleanup in test/runtime-mode.test.js was fixed, not retried away.** In the B8 suite run, the "DEV MODE banner" test failed with Windows EPERM deleting its temp database 300 ms after killing the spawned server (it passed 3 of 3 alone). The cleanup now waits for the process to exit (up to 5 s) and deletes with rmSync's built-in retries. Test-only; the B8 node pass was re-run (474 tests, 0 failures); the UI suites and test:slow had already passed in that suite run.

7. (2026-11-19) A second request arrived mid-run: a 5-phase security and quality review, "start only after the current test run has finished; use the final state of plannr-phase2". Read as: finish the step 1.4 work first, then review its final state. Why: the review's checklist covers things only the end of step 1.4 creates (the Android and desktop storage adapters, Auto Backup rules, kill-mid-write behaviour, "the build from before this review" for the update test), and interleaving two streams of commits on one branch risks conflicts. Reversible: the review can start at any commit. Also: B13 onward keep going under the first request's rules, which the review's rules match.

8. (2026-11-19) **The timed PDF idle test (test:slow) was fixed, not retried away.** It failed once in the B14 full run: the app arms its idle timer when the Overview visit starts the Chromium launch, so the test's 1.5 s window could close the browser before the test looked when the machine was busy. The test now uses a 5 s window and waits for the close (up to 30 s) instead of sleeping, and checks the close was not early. Test-only, its own commit; proven with 2 deliberate breaks. Same approach as decision 6.

9. (2026-11-19) **B17 is split into three commits (B17a start, B17b phone restore, B17c removal), and the optional B17d (rewriting legacyInit()'s ~200 `yield q.x(` calls as `await tx.x(`) is not done.** The generator form already awaits every call through the async interface (what stage C needs), and its writes are pinned one for one against the old runner. Rewriting 200 call sites in a frozen, data-touching upgrade path is risk with no behaviour gain. Reversible: it can be done later as its own step under the same equivalence tests. CONTRIBUTING.md describes the generator as the current form.

10. (2026-11-19) **B17a's first full run failed (5 desktop tests, 139 phone-pass tests); fixed in the same part rather than reverted.** Tests had relied on `require('../server')` setting the database up synchronously. `test/helpers.js` now exports `H.ready`, its seed helpers refuse to run before it, and the phone pass starts the phone's code only after server.js's `init()` (otherwise two upgrades race on one test file). Test-only; proven with 3 deliberate breaks; full suite re-run.

11. (2026-11-19) **A pre-existing start-up failure on the two oldest schemas (finding R1, A10) is recorded, not fixed in B17b.** Upgrading a v1 database from commits 7cfcf89/2ebaf69 leaves a legacy `sessions` table that the start-up ownership check refuses. Any fix changes upgrade or check behaviour (and the old-runner baseline), so it goes to the security and quality review with options. B17b's old-backup test uses fixture 03 (also v1 with tenant_id) and checks parity with the desktop's own upgrade.

12. (2026-11-19) **C1's "stop and report" is a written report, not a stop.** The first request says not to stop between parts, so the spike's findings go into the plan's §8 as their own doc-only commit, and C2 starts straight after. The spike code itself stays in the scratchpad (`c1spike/`), as the plan says.

13. (2026-11-19) **The adapter never uses the plugin's `execute()`** (C1 found it rewrites SQL inside string literals) and asks `SELECT changes()` when the plugin reports more than 1 change (C1 found it counts cascaded rows). Both keep the shared core's answers identical to `node:sqlite`; both are reversible adapter details.

14. (2026-11-19) A part that changes only documentation (B18, the C1 report) is committed without its
    own full-suite run: the code is the same as the previous commit, whose full suite passed.
15. (2026-11-19) C3: each page load closes the plugin connection a previous page left open and opens
    it again (never reuses it). It first sends ROLLBACK on that connection: on Android a BEGIN is
    EXCLUSIVE and closing the connection does not end it (the emulator showed "database is locked"),
    so a transaction a page left half-done is rolled back, as after a crash. Costs a few bridge calls
    per page.
16. (2026-11-19) C5 startup table, "no marker, files present": the candidate file is always deleted
    (plan §2.2), but a plannrSQLite.db is deleted only if the progress record says a move had
    started; otherwise it is renamed aside and kept (never delete data nothing explains).
17. (2026-11-19) Stage B speed, same machine load: init() on a new database +45 ms on desktop
    (every call awaited); saves, Overviews and concurrent requests unchanged; emulator Overview
    no slower. Recorded in plan §8 B18; the ~10 s Overview page load with 10,000 entries goes to the
    efficiency review.
18. (2026-11-19) C3: @capacitor-community/sqlite 8.1.1 (approved) brings 17 packages of its own,
    all for its browser implementation (jeep-sqlite, @stencil/core, sql.js, localforage, jszip and
    their helpers; MIT, Apache-2.0, ISC; jszip is MIT-or-GPL, taken as MIT) plus 8 optional rollup
    binaries of which only the one for this PC is installed. None has an install script and none is
    in the APK (checked with unzip -l). They are accepted as part of the approved package and
    locked by package-lock.json; nothing else was added.
19. (2026-11-19) C5-C9: the safety snapshots the move takes (`plannr-pre-move-*`, `plannr-pre-move-back-*`,
    `plannr-old-copy-*`) are outside the 3-snapshot rotation (`SNAPSHOT_NAME` does not match them), so
    no later backup or upgrade deletes them. They are small (gzipped) and few (one per move). Reversible
    by adding the names to the regex.
20. (2026-11-19) C5: the step-1 encrypted backup records its time in the database being moved
    (`mark-exported`), so `moveToFile` exports the database again after step 1 and uses that for the
    snapshot, the file, the check and "Continue". Found by reading the real backup flow before the
    commit; the test host now does the same write (Observation 46).
21. (2026-11-19) C10: "Not now" hides the "interrupted" prompt for the browser session only; the
    progress record stays, so "Continue" later still skips the backup if nothing changed. The prompt
    is on the Data Backup page (where the move was started), not on every page.
22. (2026-11-19) C10: `moveBack()` now checks the size and the free space before the confirmation, so the
    page never asks a question it cannot carry out (the UI calls it once unconfirmed). Reversible by
    moving one line back.
23. (2026-11-19) The apply scripts' "already applied" check missed insertions (the new text contains the
    old), so a second run in the scratch worktree applied C10 twice. Fixed (the check looks for the new
    text first); the main repo had each script run once, checked by counting the inserted lines.
24. (2026-11-19) C11: `isStorageFullError` now treats SQLITE_FULL (code 13, "database or disk is full")
    as "storage is full". The Phase 2 Step 3 test asserted the opposite when only localStorage
    existed; on the phone's file and the desktop a full disk gives SQLITE_FULL, so that assertion is
    flipped (a deliberate behaviour change, called out in the test). Reversible: one line.
25. (2026-11-19) C11: the dev server's encrypted restore stays a 501 until D1. `core/host.js` gets
    optional services (`database.restore` with `snapshot.writeDatabase`, given together or not at
    all); without them the shared route answers 501 before reading anything, with the same message
    as before. A new express-only test pins the 501, for D1 to replace.
26. (2026-11-19) C11: the encrypted restore now refreshes the category list afterwards (the phone's
    old inline route did not; the JSON import always did). Found while moving the route into the
    core; covered by the core route test.
27. (2026-11-19) C11: on the file, the storage meter shows Android's Google backup estimate against
    25 MB (decision D5) and says when the phone has under 100 MB free; "Storage is full" on the file
    says the phone is out of space (the localStorage text would give the wrong advice).
28. (2026-11-20) Incident 2: a test opened data/plannr.db without writing (found by a scratch run
    that created an empty file). Treated as a hard-stop matter discovered after the fact: fixed at
    once so no further run can open it, recorded for the report, and work continued (no step touches
    real data). The guard lives in db.js (test runner only) rather than in run-tests.js, so it also
    covers single files run by hand and the mutation runs.
29. **C11 suite: one static-hosting failure counted as a flake, not a revert.** One check failed once
    ("wasm streaming compile failed: Failed to fetch" on contractor-payments.html, followed by
    sqlite-wasm's own fallback). C11 changes nothing that page loads before the database; the suite
    passed 3 of 3 runs straight after. Kept C11; the flaky check goes on the Request 2 review list
    (a recoverable fallback logged with console.error fails the "no console errors" check).
30. **Emulator E1–E6: the Android share sheet is answered inside the page.** The move's step 1 saves
    the encrypted backup through Share.share, which opens Android's share sheet; a script cannot pick
    a target safely (it might send the file somewhere). The scripts make Capacitor's Share.share
    resolve in the page, so the app still writes the file to its cache and checks it, and the move's
    own confirmation dialog is still clicked. Choosing where the file goes stays a by-hand step on
    the real phone (checklist).
31. **C13: a storage-move-ui check failed once; C13 kept, the wait fixed in its own part.** C13 only
    changes scripts/phone-test.ps1 and the plan. The failing check ("the prompt is back in a new
    session") passed 3 of 3 runs again, and the very next check clicked that prompt's button, so the
    prompt was there: the test's open() waited for the storage choice but not for the move panel.
    Fixed as a separate part (test only) with proofs both ways (a prompt that never shows, a
    "Not now" that does not hold).
32. **Parts that change only documents (C14, C15's records) are committed on the previous part's full
    suite.** The code they ship is byte-identical to the commit whose full suite just passed
    (0539d5e and after); a 13-minute rerun proves nothing new. Each such entry says so. Any part that
    changes code, tests or scripts the suites run gets its own full run.
33. **E3: the "interrupted" prompt follows what survived the kill.** Android's WebView writes
    localStorage to disk a few seconds after the page does; a force-stop loses the last seconds. At
    kill 3 (8.6 s in) the progress record, written just after the backup, was lost, and no move file
    existed yet, so the app reopened with no prompt: correct and safe (every row there, "Move" works).
    The script's check was changed from "shown from kill 3 on" to "shown exactly when a progress
    record or a move file survived", and E3 was run again in full.
34. **E6: the save made after moving back is given 8 s to reach the disk before the kill test.** In
    run 2 the app was killed about a second after a save on `localStorage` ("killed at once", the
    measurement), and the earlier save, made a second before it, was most likely lost with it (the WebView's
    delayed write, decision 33). So "moved again: every row, with the save made after moving back"
    failed (one check covered both halves, so which half failed was not recorded; every other E6
    check passed, deleting the old copy included). The script now waits 8 s after that save, checks
    "every row" and "with the save" separately, and E6 was run again in full. The lost save is
    recorded as a finding, not hidden: on `localStorage` a kill can lose the last seconds of saves.
35. **D1 turns on the encrypted restore on the dev server (server.js), as the plan's D1 says.** It
    replaces the server's database file, which by default is data/plannr.db when the owner runs the
    dev server; that was already true of the JSON restore, and both write a safety copy first (the
    encrypted one: safety-snapshots/plannr-pre-restore-….db beside the database). No test or script
    of this session opens data/plannr.db: every test sets PLANNR_DB to its own temp file. Noted for
    the Request 2 audit: the dev server listens on all network interfaces with no login, so anyone on
    the same Wi-Fi can already replace the data through either restore.
36. **The shim pass's local-snapshot stand-in now restores through db.js's restoreFromBytes** (the
    path the phone's local-snapshot.js takes on its database file) instead of refusing, so the restore
    tests run in both passes as the plan asks. The phone's kvvfs path (sqlite-wasm) stays covered by
    test-ui/backup-roundtrip.js.
37. **The UI suites' browser went missing outside this session; the suites run on the installed newer
    Chromium through a scratch folder until you restore the exact one.** Playwright 1.61.1 needs
    Chromium revision 1228. At 2026-11-20 21:45 another project's Playwright install cleaned the
    shared folder D:\dev\ms-playwright and left only revision 1234 (Plannr at D:\Projects\Plannr is
    not registered in its .links, only an older copy of the project in another folder is). Downloading
    the browser again is a download from the internet, which needs your OK, so it was not done. The
    UI suites now run with PLAYWRIGHT_BROWSERS_PATH set to scratchpad\pw-browsers, where the -1228
    names are junctions to the installed -1234 browsers (nothing in D:\dev\ms-playwright changed).
    To restore the exact browser yourself: `npx playwright install chromium` in D:\Projects\Plannr
    (this also registers Plannr in .links), then run the UI suites again.
38. (2026-11-21) **RC check on the emulator: E1's page check waits for the page instead of 2.5 s.** E1 with the RC (update from the real phone's build 9d7fd97 with 1,000 entries, then the move) passed every data check but read the meter and the storage panel 2.5 s after a reload, while they were still "Checking…". The same data on the 5736195 build (A/B on the emulator) also took 13–15 s to fill, so it is the slow emulator/PC that day, not the RC. E1 now waits up to 60 s for the page to fill (it took 13.8 s) and passed in full. The page's fill time goes to the efficiency review.


### A6. Bundles

All in `D:\Backups\plannr\`, each verified (`git bundle verify`, a fresh clone's tree equal to the
commit's, `git fsck` clean). None deleted.

| Bundle | Commit | Stage |
|---|---|---|
| plannr-phase2-2026-11-18-a8fc7ca.bundle | a8fc7ca | B9 |
| plannr-phase2-2026-11-19-c315622.bundle | c315622 | B16 |
| plannr-phase2-2026-11-19-611c4c8.bundle | 611c4c8 | stage B end |
| plannr-phase2-2026-11-19-2fd2436.bundle | 2fd2436 | C6 |
| plannr-phase2-2026-11-20-5736195.bundle | 5736195 | C12 |
| plannr-phase2-2026-11-20-d3fb92d.bundle | d3fb92d | stage C end |
| plannr-phase2-2026-11-21-53db636.bundle | 53db636 | stage D end |

The RC checklist update and this report change only documents; they go into the bundle at the end of the next session's work (B).

### A7. Pushed

Until 2026-11-21 nothing was pushed (the first request did not allow it). The next request allowed
normal pushes to `plannr-phase2`: after a pre-push check of all 51 commits (no secrets, no database,
`.env`, keystore or real backup files, no personal data; decision 39 in B), `e044c32..53db636`
was pushed on 2026-11-21. GitHub Actions: the repository has no workflow, so there is no CI run.
The commits after `53db636` are pushed with the next push:

```powershell
git push origin plannr-phase2
```

### A8. On the real phone: the safe order

Nothing in this session touched the phone. When you are ready, in this order (the full text is in
`docs/PHONE-TEST-CHECKLIST.md`, section 9):

**First, the test round with test data** (checks 0, 2, 3, 5, 6, S and 9 in the checklist), on the RC
build above.

**Then your real data, only after the test round passes, and never skipping a step:**

1. **Back up first**, in the app you have now: Data Backup → **Download encrypted backup** and
   **Download JSON backup**. Save both off the phone and check on the PC that the encrypted one
   opens (`decrypt-db.js`, checklist §9 step 1; it refuses to write over `data/plannr.db`). Note the
   Overview totals.
2. **Install over it, never uninstall:** `adb install -r <the RC APK>`. If Android answers
   `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, stop.
3. **Check before moving:** all your data is there, still in the old storage; the totals match
   step 1.
4. **Move:** passphrase twice, save the move's own encrypted backup off the phone, check it is there,
   confirm. Wait for Plannr to reopen.
5. **Verify:** the section says all tables match; the totals match step 1;
   `scripts/phone-test.ps1 -AllowExisting` check S passes (read only).
6. **Only then allow removing the old copy**, and not before a week of normal use: save a new
   encrypted backup off the phone first; then **Delete the old copy**.

If anything is wrong at step 3 or 5: stop, delete nothing. The old copy and both step-1 backups are
there, and **Move data back** returns to the old storage.

### A9. Incidents

#### INCIDENT 1 (2026-11-19): a scratch script opened `data/plannr.db`

- **What happened:** a scratch measuring script (counting the calls `init()` makes) ran with
  `PLANNR_DB` set from a shell expression that failed, so it was empty. `db.js` treats an empty
  `PLANNR_DB` as unset and opened its default, `data/plannr.db`, and ran `init()` on it twice.
- **Effect:** checked by file metadata only: the modification time is still 2026-09-04 07:43:12 and
  the size 184,320 bytes; `data/` has no `-journal` file and no `safety-snapshots/` folder. Nothing was
  written; the file was read.
- **Since then:** scratch scripts take `PLANNR_DB` only as a literal absolute path in the scratchpad
  or the OS temp folder and refuse to run otherwise. The root cause (an empty `PLANNR_DB` falls back
  to the real database) is finding R2 for the security review.

#### INCIDENT 2 (2026-11-19/20): a test opened `data/plannr.db`

- **What happened:** `test/seed-demo.test.js` (B17a) read `SCHEMA_VERSION` with `require('../db')`
  in the test process, where `PLANNR_DB` was not set, so each `npm test` from 2026-11-19 19:41 opened
  the live file (read-write handle, `PRAGMA journal_mode = DELETE`, `PRAGMA foreign_keys = ON`,
  closed at exit).
- **Effect:** no change: the file's modification time is still 2026-09-04 07:43:12 and the `data/`
  folder's still 2026-09-12 11:13:47, so no rollback journal was ever created (SQLite creates one
  before any write).
- **Why the guard missed it:** `run-tests.js` compares the modification time, which an open that
  writes nothing does not change (its "never opened" message overstates this; on the review list).
- **Fix (163d662):** `db.js` refuses to open the live path under Node's test runner, whether
  `PLANNR_DB` is unset or names it; the test uses its own file; `test/live-db-guard.test.js` (4 tests,
  3 deliberate breaks caught).

### A10. Found along the way (for the security and quality review)

- On the old storage (`localStorage`), Android's WebView writes to disk a few seconds after the page
  does: a kill can lose the last seconds of saves (E3, E6; decisions 33, 34). On the file, a save is
  on disk when it answers. This is a reason to move.
- The dev server on `plannr-phase2` binds 127.0.0.1 with a Host allow-list, and LAN use needs a
  token (`a3d5571`); the open listener is on `main` (review S1). Corrected: this line first said the
  dev server listened on all interfaces (decision 42).
- An empty `PLANNR_DB` falls back to the real database (R2); a v1 database from the two oldest
  schemas cannot start after its upgrade (R1); `node:sqlite` binds a whole number as REAL (R3).
- The static-hosting check can fail on sqlite-wasm's "wasm streaming compile failed" fallback
  (decision 29); a kvvfs leftover journal record.

### A11. Needs your OK

- **The exact Playwright browser.** Another project's install removed Chromium revision 1228 from
  the shared `D:\dev\ms-playwright` folder. The UI suites now run on the installed newer Chromium
  through junctions in the session's scratch folder (decision 37). To restore it (a download):

  ```powershell
  npx playwright install chromium
  ```

- **Pushing** (A7) and **the real phone** (A8) are yours.

## B. The 3-hour session (2026-11-21)

Autonomous session on `plannr-phase2`, from `53db636` to `e691756`. It ran 01:35–02:28 and
07:42–10:45 (paused in between; resumed on "Try again"). Nothing touched the real phone, `data/plannr.db`
or the real backups; the emulator `plannr-test` was the only device. Nothing was force-pushed,
merged into `main`, opened as a pull request or changed in the repository's settings.

### B1. What was done, part by part

| Part | Done | Commits |
|---|---|---|
| 1. The step 1.4 run's results | Recorded in section A of this file (parts, tests, speed, the RC, decisions 1–38, bundles, real-phone order, incidents) | `6e26df4`, `71b9fce` |
| 2. Pre-push check, push, CI | 51 commits checked (decision 39) and pushed (`e044c32..53db636`). **INCIDENT 3** (B7): the next push carried a user-folder path; fixed and the push is now gated. CI: the repository has no workflow, so nothing ran | `71b9fce` |
| 3. Unfinished work | Step 1.4: the RC section and E1 in the phone checklist, this report. Then the security and quality review: Phase 1 audit complete (37 rows), Phase 2 fixed Q1 (High), F1, R2 and S9; Phases 3 and 4 not started (decision 45). Nothing moved or migrated real data | `dec4e81`, `ed52850`, `678092c`, `a3ea627`, `d33953b` |
| 4. Emulator | E1 (update from the real phone's build `9d7fd97` with 1,000 entries, then the move) on the RC: pass (16). `scripts/phone-test.ps1` against the emulator: tap timing fixed; S, 1, 2, 3 pass; the PDF checks (4, 8) fail on the app's 25 s PDF limit on a slow emulator (finding E1); "4 Home opens offline" failed while its screenshot shows Home open offline with no error (decision 47). E6 (move back, move again, delete the old copy) on the RC: pass (27 of 27); run 2 had stopped on a script race after 11 passing checks, and the script's page open now retries (decision 48). Results in `docs/PHONE-TEST-CHECKLIST.md` | `986ac78`, `4bca469` |
| 5. Documents and bundle | `docs/share-and-reminder-pdf-plan.md` was already written (`7ff468d`); `docs/pr-plannr-phase2.md` (not opened as a PR); `docs/security-quality-review-2026-11-21.md`; bundle in `D:\Backups\plannr\` | `e691756`; the PR description and this section in the commit after it |

### B2. Tests and CI

At `d33953b` (the last code change), the full run:

| Suite | Result |
|---|---|
| `npm test`, desktop pass | 665 tests: 662 pass, 3 skipped, 0 fail |
| `npm test`, phone-code pass | 213 of 230 (the same 17 known differences, nothing new) |
| UI suites | all 15 pass (on the stand-in Chromium, decision 37) |
| `npm run test:slow` | 2 of 2 pass |

Every new test was proven by breaking the code it guards first: Q1's 3 starts failed, F1's 6 checks
failed, R2's refusal failed, S9's list check failed. **CI:** none (no workflow in the repository);
adding one is in NEEDS MY DECISION.

### B3. Emulator, and what still needs the real phone

On the RC (`53db636`): E1 pass (16 of 16); `phone-test.ps1` S, 1, 2, 3 pass; the PDF checks (4, 8) fail on the 25 s
PDF limit, and "4 Home opens offline" failed while its screenshot shows Home open with no error (the emulator was slow that day: the Data Backup page took 13–15 s to fill on both the RC and
`5736195`; the PDF path is unchanged since `5736195`, where both passed). E6 (move back, move again, delete the old copy) on the RC: pass (27 of 27); run 2 had stopped on a script race after 11 passing checks, and the script's page open now retries (decision 48).

**Still needs the real phone** (checklist, "The owner's phone: the step 1.4 RC"): 0 phone details;
1 data location; 2 the meter and the real `localStorage` limit; 3 export/restore with categories;
4 airplane mode and the PDF time on a real phone; 5 update over the old version; 6 Auto Backup;
8 this build's changes; S; 9 the storage move with test data. Then the real data, in the order in A8.

### B4. NEEDS MY DECISION, REVERTED, SKIPPED

**NEEDS MY DECISION** (options in `docs/security-quality-review-2026-11-21.md`, section 6):

1. S1: `main` still listens on every interface with no login: merge this branch (recommended), a
   one-line fix on `main` first, or stop running `main`'s server.
2. S3/Q6: a restore that fails after the file is replaced: check a temporary copy before the swap
   (recommended), put the safety copy back automatically, or only improve the message.
3. F4: "₹X left" under a date range: intended (relabel), always the whole project, or hide it.
4. S5: backup format v2 with stronger key derivation, or keep v1.
5. INCIDENT 3: leave the path in `6e26df4`'s history, or rewrite and force-push it yourself.
6. The UI suites' browser: `npx playwright install chromium`, or keep the stand-in.
7. F1: also refuse badly shaped ledger codes at import, or escaping only (done).
8. CI: add a GitHub Actions workflow, or keep running locally.
9. S7: remove the unused biometric permissions from the manifest, or leave them.

**REVERTED:** none.

**SKIPPED:** the review's Phases 3 (efficiency) and 4 (quality clean-up); the other Medium findings
(Q3 and F2 are the next ones that need no decision); S7; F1's stricter import. 

### B5. Pushed, bundle, APK

- **Pushed:** `e044c32..53db636` and `dec4e81..71b9fce` earlier in the session; `986ac78..e691756`
  at the end of the session, after a clean pre-push check. This section's own commit goes in the same push.
- **Bundle:** in `D:\Backups\plannr\`, named `plannr-phase2-2026-11-21-<commit>.bundle` after the commit that
  adds this section, made right after it (verified: `git bundle verify`, a fresh clone's tree equal to
  that commit's, `git fsck` clean). The older bundles are kept.
- **Latest APK:** the RC, `D:\Backups\plannr\Plannr-debug-rc-53db636.apk`, SHA-256
  `1c54c4c889dec806fcadfdb79c50ea2be6c6429f0b07f2ad817a00cd1990e1f0`. The changes after `53db636` are the review fixes, test and documentation changes;
  F1 changes the phone's pages (`public/plannr-ui.js`), so the next APK should be built from
  this branch's latest commit before the real-phone round (`npm run release:android` for a release, or the debug build).

### B6. Next steps for you, in order

1. Read `docs/security-quality-review-2026-11-21.md` sections 1, 2 and 6, and answer the NEEDS MY
   DECISION list (S1 and S3/Q6 first).
2. Build a new debug APK from this branch's latest commit (it carries F1), and save its SHA-256.
3. Run the real-phone checks with **test data** (checklist: 0, 1, 2, 3, 4, 5, 6, 8, S, 9) and record
   them in the checklist's owner table.
4. Only after they pass: move the real data in the order in A8 (back up first, install over it,
   check, move, verify, keep the old copy for a week).
5. Open the pull request from `plannr-phase2` into `main` with `docs/pr-plannr-phase2.md` as its
   description (this closes S1), once you are happy with steps 1–4.
6. Optionally: `npx playwright install chromium` (the exact UI-test browser).

### B7. INCIDENT 3 (2026-11-21): a user-folder path was pushed

The pre-push scan of `dec4e81` and `6e26df4` and the push ran in one shell command with no stop
between them. The scan found one hit and the push went ahead: decision 37's text quoted a Windows
user-folder path from Playwright's records, so this PC's account name is in `6e26df4` on GitHub. It is
not a secret, password, key, token or data, and the name is close to the author name every commit
already shows. `71b9fce` replaced it (pushed after a clean scan). The old text stays in `6e26df4`'s
history; removing it needs a history rewrite and a force-push (NEEDS MY DECISION 5). Since then every
push goes through a script that pushes only when its check is clean (decision 41).

### B8. Decisions in this session

39–48:

- 39: pushing allowed to `plannr-phase2` only; the 51 commits' pre-push check was clean; the golden
  `.plbk` files are generated test vectors, not data.
- 40: one report file for both runs.
- 41: every push through a gated script (after INCIDENT 3).
- 42: correction: the dev server on this branch binds 127.0.0.1 (A10's earlier line was wrong; `main`
  is the exposed one).
- 43: `phone-test.ps1`'s timing fixed; checks 4 and 8 left failing on the slow emulator (finding E1).
- 44: F1 fixed by escaping only.
- 45: the review's Phases 3 and 4 not started.
- 46: S9 (`.gitignore`) got its own proving test and a full suite run.
- 47: phone-test's "4 Home opens offline" failed in the last run while its screenshot shows Home open
  offline with no error (still filling); recorded with that note; the real phone's check 4 decides.
- 48: E6 run 2 stopped on a script race after 11 passing checks; the script's page open now retries
  (app unchanged); run 3 passed 27 of 27.
