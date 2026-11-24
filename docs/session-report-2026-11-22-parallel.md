# Session report, 2026-11-22 (parallel workstreams)

> A dated record of that session. Every decision in its section 5 has since been taken, and pull
> requests #4 to #8 were merged into `plannr-phase3` on 2026-11-23. The current state is in
> `CHANGELOG.md` and `docs/security-quality-review-2026-11-21.md` (section 10).

A 60-minute session from 11:38 IST, with five workstreams run in parallel by sub-agents, each in
its own git worktree. It is the second session of the day; the first is in
`docs/session-report-2026-11-22.md`.

**It ran over time.** From about 12:07 to 12:41 every agent stopped at once, and the session had
to be restarted ("Try again"). Windows' system log shows no sleep in that window, and test runs
kept going, so the cause was the agent service, not the PC. In the same window, one UI suite run
(`disclosure`, on E) hung at 12:09. It was stopped at 12:43 and the whole E suite was run again.
By 12:07 every change now on the branches had been made. What the stall held up was the wrap-up:
the full suites, the pushes and the PRs. These were done after 12:41, and no new work was started
after the stall.

## Setup

- **Base:** PR #3 (`plannr-phase3` into `main`) was **not merged** at 11:38. So every branch starts
  from `plannr-phase3` at `24d1d92`, and every PR goes into `plannr-phase3`.
- **Worktrees** (outside the main checkout, all left in place):

| Workstream | Branch | Worktree |
|---|---|---|
| A, review fixes | `ws-a-fixes` | `D:\Projects\plannr-wt\a` |
| B, F4 option (b) | `ws-b-f4` | `D:\Projects\plannr-wt\b` |
| C, clean-up | `ws-c-cleanup` | `D:\Projects\plannr-wt\c` |
| D, docs and release | `ws-d-docs` | `D:\Projects\plannr-wt\d` |
| E, real-phone preparation | `ws-e-phone` | `D:\Projects\plannr-wt\e` |

  Each worktree's `node_modules` is a junction to the main checkout's `node_modules` (nothing was
  installed). The APK is in `D:\Projects\plannr-wt\apk\`.
- **CI trigger.** `.github/workflows/tests.yml` ran only for pull requests into `main`. Pull
  requests into `plannr-phase3` would have had no CI at all. So the first commit on every branch
  adds `plannr-phase3` to the `pull_request` branches. It is one line; the jobs and the read-only
  permissions are unchanged.
- **Shared test resources.** Nine UI suites use fixed ports, so five worktrees could not run them at
  the same time. Every UI suite, the whole node run and `test:slow` went through a machine-wide lock.
  There is one lock per UI suite, two slots for the node run and one for `test:slow`. This let the
  five full runs overlap without clashing.
- **Review.** Each branch got an independent, read-only review by a fresh agent. Its findings are
  below. The review findings for D and E that put the user's data at risk were fixed before those
  branches were pushed.
- **Safety.** The real phone was not connected, so only the `plannr-test` emulator was used.
  Nothing opened `data/plannr.db`: every full run checks its modification time, and it was
  unchanged. There was no force-push or merge, no repo setting was changed, and nothing was deleted.

## 1. Results

| Workstream | Branch | Commits | Tests added | PR | CI |
|---|---|---|---|---|---|
| A, review fixes | `ws-a-fixes` | 8: CI trigger, 6 fixes, review statuses | 9 node tests, 2 UI checks | [#8](https://github.com/JoelJims/Plannr/pull/8) | running at 13:16 |
| B, F4 option (b) | `ws-b-f4` | 2: CI trigger, F4 (b) | 3 node tests, 2 UI checks | [#4](https://github.com/JoelJims/Plannr/pull/4) (draft) | pass (3 of 3) |
| C, clean-up | `ws-c-cleanup` | 7: CI trigger, 6 clean-up commits | 8 node tests, 1 UI check file (5 checks) | [#7](https://github.com/JoelJims/Plannr/pull/7) | 2 pass, Windows running at 13:16 |
| D, docs and release | `ws-d-docs` | 6: CI trigger, 4 docs commits, this report | none (docs) | [#5](https://github.com/JoelJims/Plannr/pull/5) | pass (3 of 3) |
| E, real-phone preparation | `ws-e-phone` | 3: CI trigger, checklist, review fixes | none (docs) | [#6](https://github.com/JoelJims/Plannr/pull/6) | 2 pass, Windows running at 13:16 |

**Full suite before each push.** Each branch got all node tests in both passes, every UI suite and
`test:slow`. The phone-code pass always had the same 17 known differences and nothing new.

| Branch | Desktop pass (tests: pass, 3 skipped) | Phone-code pass | UI suites | `test:slow` |
|---|---|---|---|---|
| `plannr-phase3` (base) | 676: 673 | 221 of 238 | 15 of 15 | 2 of 2 |
| `ws-a-fixes` (`e09dfad`) | 685: 682 | 225 of 242 | 15 of 15 | 2 of 2 |
| `ws-b-f4` (`50997b1`) | 679: 676 | 224 of 241 | 15 of 15 | 2 of 2 |
| `ws-c-cleanup` (`e08c49d`) | 700: 697 | 221 of 238 | 15 of 15 | 2 of 2 |
| `ws-d-docs` (`533b03e`) | 676: 673 | 221 of 238 | 15 of 15 | 2 of 2 |
| `ws-e-phone` (`0eb6d73`) | 676: 673 | 221 of 238 | 14 of 15; `contract-phase-a` then passed alone | 2 of 2 |

No test failed because of a change. Three things need saying:

- On `ws-e-phone`, `contract-phase-a` failed once at `test-ui/contract-phase-a.js:172`. A fixed
  600 ms wait ran out while three suites ran at once (the known fixed-sleeps finding, F8/F9). Run
  again on its own, it passed. The branch changes no code, and the same suite passed on the base,
  B and D.
- An earlier run on E hung in `disclosure`, so it was stopped and the whole suite run again. In
  that rerun, `disclosure` passed.
- D and E each got one docs-only commit after their full run (`894875d`, `29ca03c`), and D also
  got this report. Neither changes code.

### A. Review fixes (`ws-a-fixes`)

Each fix has a test that failed on the code before it.

| Commit | Finding | Change |
|---|---|---|
| `883aabd` | Q4 | "Move data back" also counts the old copy, its rollback journal and the other `localStorage` keys, not only the incoming data |
| `08939c1` | Q2 | The Data Backup page says that, while the data is in `localStorage`, a sudden close can lose the last seconds of saves, and points to the move |
| `908b9d4` | Q14 | A ledger entry and its custom-name write are one transaction (single and batch saves) |
| `d8ef781` | Q9 | A backup whose `sequences` names a table without an id is refused with a 400 (it gave a 500) |
| `76d4c3d` | Q13 | If planning the upgrade throws, the phone shows the reason instead of a blank page |
| `7b2d695` | Q12 | A storage-move snapshot no longer cuts the rotation of regular safety snapshots |
| `e09dfad` | | Review document: these six marked Fixed, plus a section 9 |

**Review:** no correctness bug found on either platform. The reviewer checked the Q4 peak formula
against how kvvfs writes (journal mode DELETE, pages reused in place) and found it correct. There
are five low points. Two are test gaps: the batch-save part of Q14, and the phone's real
`usedChars()`, which no test calls. The others are a message that can say "about 0.0 MB" without
saying why, a stale comment in `public/safety-snapshots.js`, and Q2's Android wording possibly
showing in the desktop browser preview.

### B. F4 option (b), awaiting your decision (`ws-b-f4`, draft PR)

`50997b1`: "₹X left" always uses the whole project's spend, even with a date range set. The label
now reads "₹X left of total budget" or "₹X over total budget", and the same rule applies on the
screen and in the PDF, on both platforms. The range's "Spent" figure is unchanged.

**Review (medium):** the bar itself still compares the range's spend with the budget (its fill and
its amber "over" colour). Under a range it can show headroom while the label under it says "over
total budget". If you choose (b), the bar should follow the whole-project spend or be labelled as
range-only. Also low: with a range set, the figures shown do not add up, because the whole-project
spend is never displayed.

### C. Clean-up (`ws-c-cleanup`)

Behaviour-preserving apart from accessibility. No existing test was changed.

| Commit | Change |
|---|---|
| `0eb97e1` | One copy of the owner queries and the IST date stamp, shared by the desktop server and the phone |
| `f2f1701` | F18: keyboard focus stays inside the confirm and choice dialogs, Escape closes them, and focus goes back to the button that opened them |
| `57b033e` | Two helpers nothing calls removed from `server.js` (`istStampFull`, `currentUser`) |
| `0170b60` | Every control in the bulk-edit cash-out table has a name for screen readers |
| `21b91df` | One copy of `parsePaise` for the contract pages, in `PlannrUI` |
| `e08c49d` | One copy of the start-up jobs helper (`atStart`), shared by both platforms |

**Review:** no behaviour change found. The low points are as follows. The F18 check
`test-ui/c-modal-focus.js` is not in `package.json`, so neither the full suite nor CI runs it. No
workstream could edit `package.json`, to keep the five PRs free of conflicts. It passed when run by
hand at 12:50. The dead-code test sees only top-level functions, so it barely covers
`public/local-api.js`. Focus may not return to the opener after a backdrop click.

### D. Docs and release preparation (`ws-d-docs`)

- **`docs/share-and-reminder-pdf-plan.md`:** it already covered most of the list. Added: the installed
  plugin versions (`@capacitor/share` 8.0.3, `@capacitor/local-notifications` 8.3.1,
  `@capacitor/filesystem` 8.1.5, `@capgo/capacitor-pdf-generator` 8.0.53). Also added: notification
  actions cited from the plugin's own type definitions, and the fact that **Plannr has no
  payment-due reminder** today.
- **`docs/release-plan.md` (new):** the release key, version rules, moving debug-build users over, a
  release notes template and a checklist.
- **`CHANGELOG.md`:** up to `24d1d92`. Phase 2 is under "Merged into main" and Phase 3 under "In
  review".
- **Review fixes (`894875d`):** three medium points, all now fixed. (1) The plan had no step proving
  the encrypted backup opens before the uninstall deletes the only copy on the phone. (2) The JSON
  fallback left out the report contacts by default. (3) The key check used
  `keytool -printcert -jarfile`, which can say "Not a signed jar file" on this build and push
  someone to make a new key. The plan now uses `apksigner verify --print-certs`. `docs/RELEASE.md`
  and `SETUP.md` still use the old command. That is a follow-up.

### E. Real-phone preparation (`ws-e-phone`)

- **Phone:** not connected at any check (11:39, 11:47, 11:50, 11:52, 11:53, 11:54), so nothing on
  it was read. The last APK built for it is `9d7fd97`, from before step 1.4 (SHA-256
  `7dc29db3…a2ef`). It is signed with the same laptop debug key as the new build, so the new build
  should install over it with `adb install -r`. That is not confirmed for the app actually
  installed, because the phone could not be read. **Assume the phone holds real data.**
- **APK** from the base code: see section 4.
- **`docs/PHONE-TEST-CHECKLIST.md`:** has backup steps before any install, the checks for this build
  and an empty results table. **Review (high), fixed in `29ca03c`:** the checklist installed the
  first post-step-1.4 build over the phone's real data before any test-data check had passed. That
  skips the agreed order (`docs/step-1.4-storage-plan.md` section 5.4: test data first, then your
  OK, then real data). Step B now waits for your decision (section 5). The same commit fixes five
  smaller points: every adb command uses `-d`, because the emulator is often running; the JSON
  check looks for `"schemaVersion": 2`; the Home button is in the grid at the top; check 6
  (uninstall) never runs on the phone with real data; and only `dumpsys` proves S7.

## 2. REVERTED and SKIPPED

**REVERTED:** nothing.

**SKIPPED**
- **A:** Q7 and Q16 (`public/local-api.js` was being cleaned up on `ws-c-cleanup` at the same
  time). Also Q11, Q5, F13, F14, S2, S4, Q10, F7, F10, F20 and F15 to F17: not reached.
- **B:** none of B's own work was skipped. The review's points (the bar, showing the whole-project
  spend) were not changed, because F4 is not decided.
- **C:** splitting the largest functions, contrast checks and keyboard use beyond the dialogs were
  not reached.
- **E:** reading the phone (not connected).
- **Wrap-up:** `test-ui/c-modal-focus.js` is not wired into `package.json`; that is one line for
  whoever merges C.

## 3. Phone findings (E)

| | |
|---|---|
| Phone connected | No (only the emulator), at every check |
| Installed build | Unknown. The last build made for the phone is `9d7fd97`, 5,974,512 bytes, SHA-256 `7dc29db34fa1bad4de338232b38273fe848f22e7a098f1553ac39f0665b6a2ef`, versionCode 1, versionName 1.0 |
| Real-data risk | **Assume real data** (nothing could be read, and nothing shows it was installed recently) |
| Debug key | The last phone build and the new build have the same certificate SHA-256, `fd12f08172d278469d6cad14786f48e080bc0c308cb457d56ce0ecdae4b95629` (this laptop's debug key). The installed app's key could not be checked |

## 4. APK

- **Path:** `D:\Projects\plannr-wt\apk\plannr-phase3-24d1d92-debug.apk` (built in worktree E from
  the base code, `plannr-phase3` at `24d1d92`).
- **SHA-256:** `2b4f34f6944f48719def17b98e5a689610fa7e44a996f47b14c615d499a14888`.
- **Details:** 15,099,506 bytes; package `com.plannr.app`, versionCode 1, versionName 1.0. It is
  signed with this laptop's debug key and has no biometric permission. On the emulator it installed
  over the earlier build (`adb install -r`, first install time kept) and started.

## 5. NEEDS MY DECISION

1. **F4, "₹X left" under a date range.** Option (b) is built on the draft PR #4.
   - (a) Label only.
   - (b) Whole-project spend: PR #4. If you choose it, the bar should follow the same spend; see B's review.
   - (c) Hide "left" while a range is set.
2. **Installing the phase-3 build over the phone's real data.** The agreed order is test data first,
   then your OK, then real data, and the phone has a pre-step-1.4 build.
   - (1) Install over the real data after the checklist's step A backups, accepting that they are
     the only way back.
   - (2) First run the test-data checks on another Android device or the emulator, then install on
     the phone.
   - (3) Wait.
3. **Which reminder gets "Send PDF"** (from D). Plannr has no payment-due reminder.
   - (a) Put it on the daily report reminders.
   - (b) Build a payment-due reminder first.
4. **Where the release key lives** (from D). It is git-ignored in the project root today.
   - (a) Leave it there.
   - (b) Move it to a folder outside the project and point `storeFile` at it. You edit
     `keystore.properties` yourself.
5. **First public versionName** (from D). `release-android.js` bumps "1.0" to "1.1".
   - (a) Accept "1.1".
   - (b) Set "1.0.0" or "1.1.0" with `--version-name`, to follow MAJOR.MINOR.PATCH.

## 6. Bundle

A verified git bundle of all five branches, plus `plannr-phase3` and `origin/main`, is in
`D:\Backups\plannr\`, named `plannr-ws-2026-11-22-<time>.bundle`. It was made after this commit:
`git bundle verify` passed, every branch's tree in a fresh clone matched, and `git fsck` was clean.
The older bundles are kept. The chat report gives the exact name.

## 7. Your next steps, in order

1. Review and merge PR #3 (`plannr-phase3` into `main`). GitHub then moves the PRs below onto
   `main`, or you can merge them into `plannr-phase3` first.
2. Review PRs [#8](https://github.com/JoelJims/Plannr/pull/8), [#7](https://github.com/JoelJims/Plannr/pull/7), [#5](https://github.com/JoelJims/Plannr/pull/5) and [#6](https://github.com/JoelJims/Plannr/pull/6).
   When merging C, add `test-ui/c-modal-focus.js` to `package.json` so the suite and CI run it.
3. Decide F4 (section 5.1). Then either finish PR #4 (make the bar follow the whole-project spend)
   or close it.
4. Decide the phone question (section 5.2). Then do the checklist's step A backups on the phone
   **before** any install.
5. The real-phone round with the APK in section 4, or a fresh one built from `main` after the merges.
6. Later: Q7 and Q16 (now that C is done with `public/local-api.js`), the remaining low findings,
   `docs/RELEASE.md` and `SETUP.md` moving to `apksigner`, and S5.
