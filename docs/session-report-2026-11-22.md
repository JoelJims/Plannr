# Session report, 2026-11-22

> A dated record of that session; its open decisions and next steps are from that day. The current
> state is in `CHANGELOG.md` and `docs/security-quality-review-2026-11-21.md` (section 10).

A 2-hour autonomous session on a new branch, `plannr-phase3`, cut from `main` at `b9b4e7d`. It
started at 00:15 IST. At about 01:28 the PC went to sleep in the middle of a suite run and stayed
asleep until about 07:25; the session went on at 07:51, when you asked it to continue. The one suite
the sleep broke was run again (section 3).

The session carried out the review decisions of 2026-11-21, then fixed more review findings that
needed no decision, then measured speed. Nothing ran on the real phone. Nothing
opened or changed `data/plannr.db` or a real backup (every node pass checks the live database's
mtime and found it unchanged). Only the `plannr-test` emulator was used.

## 1. What was done

One commit per change. Each fix has a test that was run against the old code first and failed
there, and the full suite was run on every commit (section 3).

| Commit | Change | The test that failed before the fix |
|---|---|---|
| `5e98901` | **S3/Q6.** A restore that fails after the database was replaced (an older backup that will not upgrade, or a broken foreign key) now puts the data from before the restore back and says "Nothing was changed". If putting it back fails too, it says so and points to the safety copy | `test/backup-encrypted-restore.test.js`, `test/backup-encrypted-route.test.js`, `test-ui/backup-roundtrip.js`: the bad backup's data stayed live |
| `b623200` | **F1.** The JSON import also refuses badly shaped ledger codes (a category must be `N.0`, a sub-category `N.M` under its own category) | `test/validate-backup.test.js`: the three shapes were accepted |
| `00f6a59` | **Q3.** A contract and its payment dates are saved in one transaction | `test/contract.test.js`: an edit kept the new name when one date failed |
| `4cf1784` | **S7.** `USE_BIOMETRIC` and `USE_FINGERPRINT` removed from the APK | `test/android-permissions.test.js`; `aapt dump permissions` on the built APK |
| `46d21ec` | **`phone-test.ps1`.** Check 4 waits for Home to settle (two reads 1.5 s apart that match, up to 45 s); the PDF checks wait up to 90 s and report the real time | run on the emulator (section 4) |
| `8b9101e` | **F2.** "Download CSV (for Excel)" works on the phone: every file is written and checked, then one share sheet holds them all | `test-ui/runtime-mode.js`: no share call, five `<a download>` clicks |
| `e5b30ca` | **F3.** The Overview shows "…" while loading and "—" plus a message with the reason if the load fails (it showed ₹0.00 with no message) | `test-ui/run.js`: ₹0.00 everywhere, no message |
| `5e6afb7` | **F5.** Home no longer says "First login — welcome." on every start (dead code from the removed login) | `test-ui/run.js`: the line was there |
| this commit | The review document's statuses (section 8 there) and this report | none (documents only) |

Also done, with no commit: `npx playwright install chromium` (the UI suites run on Chromium
revision 1228 again, from `D:\dev\ms-playwright`).

Decided items left as decided: **S5** is not built; it is planned as backup format v2 (scrypt
N = 2^17, the parameters in the file header), and v1 files always stay readable. **Incident 3** is
left as it is.

## 2. REVERTED and SKIPPED

**REVERTED**
- **Speed attempt: the test helper's HTTP client** (`test/helpers.js`, not committed). Node's
  `fetch` takes about 14 ms per request made one after another on this PC, even against a server
  that does nothing (400 requests: 5,573 ms with `fetch`, 100 ms with `http.request` on a
  keep-alive agent). Switching `H.req()` to the faster client did not make the desktop test pass
  faster: 58,994 and 57,655 ms with it, 57,539 ms without (676 tests, all passing both ways). The
  pass's time is set by its slowest test files, not by request time. No gain, so it was reverted.

**SKIPPED**
- **F4** ("₹X left" under a date range): not decided, so not changed (section 6).
- **Phase 4 clean-up:** only F5 (dead code on Home) was done. Duplicated code, oversized
  functions, names and accessibility were not started: the time went to the fixes and to running
  the full suite on each of the 8 commits (about 10 minutes each).
- **Other findings that need no decision** and were not reached, most important first: Q4 (the
  "move back fits" estimate), Q2 (a note that `localStorage` can lose the last seconds of saves),
  Q14, Q9, Q13, Q11, S2, S4, Q5, Q7, Q12, Q16, F7, F13, F14, F15 to F18.
- **Speed improvements:** measured only (section 5). The one attempt was reverted.

## 3. Tests

The full suite on every commit, in a separate worktree so this checkout stayed free: `npm test`
(the desktop pass and the phone-code pass), all 15 UI suites, and `npm run test:slow`.

| Commit | Desktop pass (tests: pass, 3 skipped) | Phone-code pass | UI suites | `test:slow` |
|---|---|---|---|---|
| `b9b4e7d` (`main`, before) | 666: 663 | 214 of 231 | 15 of 15 | 2 of 2 |
| `5e98901` S3/Q6 | 669: 666 | 217 of 234 | 15 of 15 | 2 of 2 |
| `b623200` F1 | 672: 669 | 220 of 237 | 15 of 15 | 2 of 2 |
| `00f6a59` Q3 | 673: 670 | 221 of 238 | 15 of 15 | 2 of 2 |
| `4cf1784` S7 | 676: 673 | 221 of 238 | 15 of 15 | 2 of 2 |
| `46d21ec` `phone-test.ps1` | 676: 673 | 221 of 238 | 15 of 15 | 2 of 2 |
| `8b9101e` F2 | 676: 673 | 221 of 238 | 15 of 15 | 2 of 2 |
| `e5b30ca` F3 (run again after the sleep) | 676: 673 | 221 of 238 | 15 of 15 | 2 of 2 |
| `5e6afb7` F5 | 676: 673 | 221 of 238 | 15 of 15 | 2 of 2 |

No test failed on any commit. The first run on `e5b30ca` stopped in the offline UI suite with
`net::ERR_NETWORK_IO_SUSPENDED`: the PC had gone to sleep. That run was thrown away and the whole
suite was run again on that commit. The node tests gained 10; the UI suites gained checks for
S3/Q6 (`backup-roundtrip`), F1 (`ledger-picker`), F2 (`runtime-mode`), F3 and F5 (`ui`).

The phone-code pass has the same 17 known differences (`test/phone-code-differences.json`) on
every commit, and nothing new.

## 4. On the emulator (`plannr-test`, Android 16)

- **Update from `main`'s build to this branch's build** (`e1-update-move.js`, the same check as for
  the RC): `main`'s build installed fresh, the full test fixture plus 1,000 entries saved through
  the app (1,218 rows in 13 tables), then this branch's build installed over it. Every row was still
  there after the update. The move to the database file then matched all 14 tables (1,229 rows), a
  save went to the file, and the Data Backup page filled in 1.2 s. **ALL CHECKS PASSED.**
- **F2 in the real WebView:** the CSV button opened one system share sheet, "Sharing 6 files",
  4.5 s after the tap, after all 6 files were written and checked. BACK closed it and the page said
  "Not saved: the share sheet was closed without choosing where to keep the files."
- **S7:** the APK lists INTERNET, RECEIVE_BOOT_COMPLETED, WAKE_LOCK, POST_NOTIFICATIONS,
  SCHEDULE_EXACT_ALARM and the app's own receiver permission; no biometric permission. It installs
  over the old build and opens.
- **`phone-test.ps1`**, fresh install (S7 build): no automated check failed; Home settled 6.9 s
  after launch; the PDF share sheet opened 4.5 s (offline) and 4.1 s after the tap.
- **`phone-test.ps1` again after the update** (`-AllowExisting`, 1,229 rows on the database file):
  no automated check failed; Home settled after 6.7 s; the PDF share sheet opened 11.5 s (offline)
  and 9.3 s after the tap. That is under the app's own 25 s PDF limit (finding E1, unchanged), but
  with more data on a slower phone it could come close: measure it on the real phone.

## 5. Speed, before and after

`main` (`b9b4e7d`) against this branch (`5e6afb7`), on this PC with nothing else running. Desktop
dev server on a temporary database; two runs each, taken in turn (main, branch, main, branch).

| Measure | `main`, run 1 / 2 | Branch, run 1 / 2 |
|---|---|---|
| Start-up, new database (median of 7) | 159 / 192 ms | 177 / 185 ms |
| Start-up, large database (6,400 money-in rows, median of 5) | 6.9 / 5.9 ms | 7.0 / 6.8 ms |
| 400 saves, one after another | 5,774 / 5,874 ms | 5,846 / 5,921 ms |
| 400 Overviews, one after another | 5,395 / 5,607 ms | 5,569 / 5,497 ms |
| 4 × 100 requests at once | 1,026 / 902 ms | 832 / 801 ms |
| Page load to network idle: Home | 632 / 629 ms | 617 / 615 ms |
| Overview | 664 / 641 ms | 642 / 635 ms |
| Money In | 614 / 614 ms | 608 / 590 ms |
| Data Backup | 638 / 639 ms | 637 / 644 ms |
| Debug APK size | 15,087,614 bytes | 15,089,730 bytes (+2,116) |
| `npm test` desktop pass / `test:slow` | 61 s / 50 s | 53 s / 53 s |
| Every suite except `test:slow` | not timed on `main` | 526 to 568 s on each commit |

(The script is `s20/bench2.js` in the session's scratch folder; it is not in the repository.)

**What the numbers show.** Nothing in this session was meant to change speed, and nothing did
beyond noise. "400 saves" and "400 Overviews" are mostly the test client's own wait: a server that
does nothing takes the same 14 ms per request with Node's `fetch` on Windows. The real per-request
cost of Plannr is the small difference above that. The earlier baseline (5.6 s for 400 saves) has
the same limit.

**The next things to measure** (from the audit, not tried): the Overview and Money Debited pages
load and draw every `cash_out` row; `computeOverview` sums in JavaScript instead of SQL; every page
runs `init()` again (about 80 bridge calls on the phone); three.js (2.1 MB unminified) for one
background effect. Measure them on the phone first: that is where the app is slow.

## 6. NEEDS MY DECISION

1. **F4, "₹X left" under a date range.** The Overview compares the money spent *in the range* with
   the *whole-project* budget. (a) Intended: only change the label ("left of the budget, for this
   range"); (b) always compare the whole-project spend with the budget, whatever range is shown;
   (c) hide "left" while a range is set.

## 7. Pushed, PR, bundle

- **Pushed:** `plannr-phase3` to `origin` after a clean gated pre-push check (no secrets, personal
  data, databases, keystores or backups in the added lines or files). Not merged: a PR into `main`
  is open. Its link and the CI result are in the chat report and on the PR.
- **Bundle:** `D:\Backups\plannr\plannr-phase3-2026-11-22-<this commit>.bundle`, made after this
  commit and verified (`git bundle verify`, a fresh clone's tree equal to the commit's, `git fsck`
  clean). The older bundles are kept.
- **APKs (emulator only, not for the real phone yet):** `main`'s build and this branch's build are
  in the session's scratch folder. For the real-phone round, build from the branch after the merge.

## 8. Next steps for you

1. Review the PR and merge it if you are happy (this session does not merge).
2. Decide F4 (section 6).
3. Real-phone round with this branch's APK (`docs/PHONE-TEST-CHECKLIST.md`), especially: the CSV
   share sheet (F2), the PDF time (now reported by `phone-test.ps1`), and the update over the
   build the phone has now.
4. Later: S5 (backup format v2), and the speed items in section 5, measured on the phone.
