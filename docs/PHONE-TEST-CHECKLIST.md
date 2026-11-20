# Phone test checklist

Things the automated tests cannot prove, because they need a real Android phone (or an
emulator). Phase 2, Step 9. Use a **debug build** unless a step says otherwise:

```sh
npm run android:sync
cd android && ./gradlew assembleDebug     # -> android/app/build/outputs/apk/debug/Plannr-debug.apk
```

> **Safety first.** Steps marked ⚠ delete or fill the app's storage. Do them only on a test phone or
> emulator, or on a phone whose data you have exported **off the phone** first (Data Backup →
> **Download encrypted backup** and **Download JSON backup**), and never with the only copy of real data.
>
> A debug build and the release build are signed with different keys and cannot be installed over
> each other (`docs/RELEASE.md`). `adb shell run-as` works only with the debug build.

Write the result of each check (pass/fail, numbers, phone model, Android and WebView version) in
the table at the end.

## The build for this round (real phone): the step 1.4 RC, 2026-11-21

| | |
|---|---|
| Branch / commit | `plannr-phase2`, built from `53db636` (step 1.4: the storage move, stages A–D) |
| File | `D:\Backups\plannr\Plannr-debug-rc-53db636.apk` |
| Size | 15,087,178 bytes |
| SHA-256 | `1c54c4c889dec806fcadfdb79c50ea2be6c6429f0b07f2ad817a00cd1990e1f0` |
| Version | versionCode 1, versionName 1.0; debug-signed with the same key as `9d7fd97`, so it installs over it with `adb install -r` |
| Permissions | as `9d7fd97`, plus `USE_BIOMETRIC` and `USE_FINGERPRINT`, which the storage plugin (`@capacitor-community/sqlite` 8.1.1) declares; Plannr never asks for them and Android does not prompt for them |
| INTERNET permission | present, and it stays (offline first: the core never uses it; see `CONTRIBUTING.md`) |

The APK is larger than `9d7fd97`'s (5,974,512 bytes) because of the storage plugin's native SQLite
library. The previous build for this round, `9d7fd97` (5,974,512 bytes, SHA-256
`7dc29db34fa1bad4de338232b38273fe848f22e7a098f1553ac39f0665b6a2ef`), is still at
`android/app/build/outputs/apk/debug/Plannr-debug.apk` and in `D:\Backups\plannr\`; the
emulator's update tests start from it, since it is the build your phone has.

**This round uses test data only.** Do not restore your real backup on the phone yet; that comes
after these checks pass and you approve it.

Install it:

1. On the phone: Settings → About phone → tap **Build number** 7 times; then Settings → System →
   Developer options → turn on **USB debugging**. Connect the phone by USB and allow the PC when
   asked.
2. On the PC, `adb devices` lists the phone as `device` (not `unauthorized`). `adb` is in the
   Android SDK's `platform-tools` folder.
3. `adb install -r D:\Backups\plannr\Plannr-debug-rc-53db636.apk`

If Android answers `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, a Plannr signed with another key (a
release build) is already on the phone. Uninstalling it deletes its data: if it holds anything you
need, export both backups off the phone first, or stop and ask.

Check 7 is skipped: Plannr keeps the INTERNET permission (owner's decision, 2026-11-15). Check 4
(airplane mode) is the offline check on the phone.

## Running these on an emulator (no phone needed)

The results table at the end was first filled in on an emulator. To do the same:

1. Check the PC can run one: `"%LOCALAPPDATA%\Android\Sdk\emulator\emulator-check.exe" accel` must
   say WHPX (or AEHD) "is installed and usable".
2. Create a virtual device with the image `system-images;android-36;google_apis;x86_64` (about
   1.9 GB). In Android Studio: **Device Manager → Create virtual device**, any phone, the API 36
   "Google APIs" x86_64 image. A Google APIs image (not "Google Play") allows `adb root` and
   `run-as`, and needs no Google account.
3. Start it: `emulator -avd <name> -no-snapshot` (add `-no-window` to run it in the background).
4. Install the debug APK with `adb install -r …/Plannr-debug.apk`. The app's WebView can be
   inspected from desktop Chrome at `chrome://inspect` (debug builds only).

An emulator proves the app's own behaviour (storage, backups, updates, offline, permissions). It
does not prove a particular phone maker's WebView or a real Google Drive backup; repeat checks
2, 5 and 6 on the real phone before trusting it with the only copy of the data.

### The automated part: `scripts/phone-test.ps1`

Checks 0, 1, S (which storage is in use: step 1.4), 2 (the meter), 3 (the JSON backup's share
sheet), 4 (airplane mode, the PDF's share sheet) and 8 (a share sheet left open 25 seconds) run on
their own over adb:

```
powershell -ExecutionPolicy Bypass -File scripts\phone-test.ps1
```

It taps through the screens (`adb shell input`), reads what is on screen (`uiautomator dump`),
saves a screenshot per step and a `results.md` to `docs/phone-test-evidence/<date-time>/`
(gitignored, since the screenshots can show ledger data), and prints a pass/fail table. The rest
are listed as MANUAL.

What it will not do:
- run if the device is unauthorised, or locked with a PIN, password or pattern. It reads the lock
  state only and never enters or tries a credential;
- run if Plannr is already installed (it may hold real data), unless you pass `-AllowExisting`.
  With that flag it installs and uninstalls nothing;
- send anything. When a share sheet opens, it presses BACK and nothing else;
- leave airplane mode changed: it puts it back as it was, even after an error.

Options: `-Apk <file>` (default: the debug build in `android/app/build/outputs/apk/debug/`),
`-Serial <id>` when more than one device is connected, `-SkipAirplane`.

## 0. Phone details

```sh
adb shell getprop ro.product.model
adb shell getprop ro.build.version.release
adb shell dumpsys package com.google.android.webview | grep versionName
```

## 1. Where the data lives, and how big it is

Open the app, add a few entries, then:

```sh
adb shell run-as com.plannr.app ls -la "app_webview/Default/Local Storage/leveldb"
adb shell run-as com.plannr.app ls -la app_webview
adb shell run-as com.plannr.app du -sh app_webview "app_webview/Default/Local Storage" files/safety-snapshots
```

- [ ] The database is under `app_webview/Default/Local Storage/` (or `app_webview/Local Storage/`
      on old WebViews). Both are in the Auto Backup rules (`android/app/src/main/res/xml/`). If it
      is anywhere else, the rules must change.
- [ ] Note the sizes.

After the storage move (check 9), the data is in its own file, and a small marker file says so:

```sh
adb shell run-as com.plannr.app ls -la databases files
adb shell run-as com.plannr.app cat files/plannr-storage.json
```

- [ ] `databases/plannrSQLite.db` is there, and no `plannr-movingSQLite.db` (a move's unfinished
      copy). The marker says `"storage":"native-v1"`, with the date of the move and whether the old
      copy is kept. `phone-test.ps1` check S reads the same, and changes nothing.

## 2. Storage meter, and the real limit ⚠ (fills storage — test install only)

1. Data Backup page: note the storage line and the bar. Before the move it is the WebView's storage
   ("Used … MB of about 10 MB (…%)"). After the move (check 9) the file has no such limit; the line
   is Android's Google backup estimate instead: "Your data file is … MB. With the old copy (… MB),
   Android's Google backup of Plannr is about … MB of the 25 MB it allows (…%)." It warns from
   20 MB, strongly from 23 MB, and says so when the phone has under 100 MB free.
2. On a **fresh test install with no real data**, measure the real limit. Connect the phone, open
   `chrome://inspect` in desktop Chrome, inspect the Plannr WebView, and run in its console:

   ```js
   (() => {
     const p = '__quota_probe_'; let n = 0;
     for (const size of [100000, 1000, 10]) {
       const chunk = 'x'.repeat(size);
       try { for (;;) { localStorage.setItem(p + n, chunk); n++; } } catch (e) {}
     }
     let used = 0;
     for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); used += k.length + localStorage.getItem(k).length; }
     for (let i = 0; i < n; i++) localStorage.removeItem(p + i);
     return { limitChars: used, afterCleanup: localStorage.length };
   })()
   ```

- [ ] `limitChars` is about 5,242,880 (what `public/local-api.js` assumes). If not, change
      `LOCALSTORAGE_LIMIT_CHARS` and tell the maintainer.
- [ ] After the probe, the app still opens and the meter is back to where it was.
- [ ] Optional: keep adding entries until the app says **"Storage is full"**; the last entry is not
      saved, everything before it is still there, and the meter shows the strong warning.

## 3. Backups and restores, with categories present

Set up: two people, three categories (one renamed), a contract with payments, a loan, some
entries in several categories, one item in the Recycle Bin.

- [ ] **Download JSON backup** (Data Backup): the file is saved/shared and opens as JSON with
      `"version": 2`, and includes `categories` and `people`.
- [ ] **Download encrypted backup**: the file is saved/shared; restoring it with a wrong password fails
      with a clear message and changes nothing.
- [ ] Change something (delete a category's entry, rename a person), then restore the JSON
      backup with **Import / Restore**: everything is back, categories included, totals match.
- [ ] Change something again, then **Restore from encrypted backup**: everything is back. A
      pre-restore safety snapshot was written:

      ```sh
      adb shell run-as com.plannr.app ls -la files/safety-snapshots
      ```

      Only the newest 3 snapshots are kept; each name ends in `.gz`.

## 4. Airplane mode

Turn on airplane mode (Wi-Fi and mobile data off), force-stop Plannr, open it.

- [ ] Every page opens; no error box, no endless spinner.
- [ ] Add, edit and delete an entry; restart the app; the changes are kept.
- [ ] PDF overview export works and the share sheet opens.
- [ ] JSON and encrypted backup export work.
- [ ] A reminder notification still fires (Home → reminder times: add one a few minutes ahead,
      put the app in the background, wait).

## 5. Update over the old version keeps the data

1. Build a debug APK of the **previous** version (for example `git worktree add ../plannr-old
   main`, then `npm install`, `npm run android:sync` and `./gradlew assembleDebug` there), install
   it, add data, note the totals.
2. Install the **new** debug APK over it, without uninstalling:

   ```sh
   adb install -r android/app/build/outputs/apk/debug/Plannr-debug.apk
   ```

- [ ] Android says the app was updated (not installed fresh).
- [ ] All ledgers, entries, categories and totals are the same as before.
- [ ] If the new version upgrades the database (a new migration), a pre-migration safety snapshot
      appears in `files/safety-snapshots/`.
- [ ] For a real release, repeat with the signed release APK, following `docs/RELEASE.md`.

## 6. Android Auto Backup ⚠ (uninstalls the app)

Needs a Google account on the phone with backup turned on (Settings → Google → Backup).

```sh
adb shell bmgr enabled                 # must say "enabled"
adb shell bmgr list transports         # the Google transport has a * in front of it
adb shell bmgr backupnow com.plannr.app
```

- [ ] `backupnow` ends with `Package com.plannr.app with result: Success` (not `Quota exceeded`).
      `Backup is not allowed` means the app is in Android's "stopped" state (just installed or
      force-stopped): open Plannr once, go to Home, and run `backupnow` again.
- [ ] Note the size, if shown (`with progress: <bytes>/…` in the `backupnow` output).

Without a Google account (an emulator), Android's local transport does the same job:
`adb shell bmgr enable true`, then
`adb shell bmgr transport com.android.localtransport/.LocalTransport`, run the steps here, and
switch back afterwards with
`adb shell bmgr transport com.google.android.gms/.backup.BackupTransportService`.

Then, **with the data exported off the phone first**:

```sh
adb uninstall com.plannr.app
adb install android/app/build/outputs/apk/debug/Plannr-debug.apk
```

- [ ] After reinstalling, Plannr opens with the data restored (Android restores the backup during
      the install). If it does not, check that the reinstalled APK is the same kind of build
      (debug/release) as the one backed up.
- [ ] The safety snapshots did **not** come back (`run-as … ls files/safety-snapshots` finds
      nothing). Since step 1.4 they stay on the phone and are left out of Auto Backup (decision D2);
      the data itself is not affected.
- [ ] After the storage move (check 9): `databases/plannrSQLite.db`, `files/plannr-storage.json`
      and, while it is kept, the old copy come back, and Plannr opens on the file with everything.

If the data does not come back, restore the exported backup on the Data Backup page.

## 7. Without the INTERNET permission: skipped (decision, 2026-11-15)

Plannr keeps the INTERNET permission and stays **offline first**:
- the core (logging, editing, backups, PDF creation) never uses the network and works with no
  connection;
- any future online feature is optional and only used when you use it (`CONTRIBUTING.md`,
  "Offline first").

The branch `plannr-no-internet` (which removes the permission) is kept as a reference, not merged.
The emulator result below is from that branch. Offline behaviour is checked by check 4 on the
phone, and by `test/offline.test.js` and `npm run test:offline` on every change.

## 8. What changed in this build (plan steps 1.1 and 1.2)

Most of it is invisible in the app (the same request rules as the dev server, covered by the
automated tests). Two things to look at:

- [ ] **PDF total row.** Add three or four entries, then Overview → export the full PDF. In the
      Transactions table, the **Total (n)** row ends at the same right edge as the rows above it.
      Before this build it had one extra empty cell sticking out on the right.
- [ ] **Restores still fit.** Restores now have a 20 MB limit (the app's whole storage is about
      10 MB, so a real backup is far below it). In check 3, note the encrypted file's size; the
      encrypted restore must still work.

## 9. The storage move (step 1.4) ⚠ test data first

From step 1.4, the Data Backup page has a section **Where your data is kept**. It moves Plannr's
data out of the WebView's storage (full at about 2.8 MB of data) into a database file of its own on
the phone. The move starts with an encrypted backup that you save and confirm, then a safety copy
on the phone. It copies the data, checks every table against the original, and switches only if
all of it matches. The old copy stays until you delete it, and **Move data back** returns to it.

**On a test install, with test data only** (the emulator ran all of this: results below):

1. Install the build over the previous version, as in check 5, so that the data is still there.
2. Data Backup → **Where your data is kept**: type a passphrase twice, tap **Move to the new
   storage**. Save the encrypted backup where you choose (off the phone), check that it is there,
   then tap **I have the backup — continue**. Plannr reopens.
- [ ] The section says "Your data is in its own file on this phone since <date>. All <n> tables
      match (<n> rows)." and "Old copy kept (from <date>, <n> MB). Nothing deletes it unless you do."
- [ ] Every total on the Overview is the same as before.
- [ ] The meter shows the Google backup estimate (check 2), and check 1's files are there.
- [ ] `phone-test.ps1 -AllowExisting`: check S passes ("the database file since …, checked … rows in … tables; old copy kept").
- [ ] Add an entry, close Plannr (swipe it away), open it: the entry is there.
- [ ] **Move data back**: Plannr reopens on the old storage, everything there; the section says
      "Your data was moved back to the old storage on <date>. The database file is kept." Then move
      again.
- [ ] **Delete the old copy** asks for an encrypted backup saved after the move first; after one, it
      asks to confirm, deletes it, and the meter no longer counts an old copy.
- [ ] If Plannr is closed during the move (swipe it away while "Moving your data…" shows), it
      reopens on the old storage with everything, and offers **Continue** or **Not now**.

**Moving your real data** comes only after the test above passes on your phone, and after you say
OK. Do it in this order, and do not skip a step:

1. **Back up first, in the app you have now.** Data Backup → **Download encrypted backup** and
   **Download JSON backup**. Save both off the phone (on the PC, or in Drive), then check on the PC
   that the encrypted one opens. In PowerShell, in the Plannr folder:

   ```powershell
   $env:PLANNR_BACKUP_PASSPHRASE = Read-Host 'Passphrase'
   node decrypt-db.js <the .db.enc file> $env:TEMP\plannr-check.db
   Remove-Item Env:PLANNR_BACKUP_PASSPHRASE
   ```

   It prints the sizes and writes a readable copy; it refuses to write over `data/plannr.db`. Delete
   `plannr-check.db` afterwards (it is your data, unencrypted). Note the totals on the Overview (or
   take a screenshot).
2. **Install over it, never uninstall.** `adb install -r <the new APK>`. Uninstalling deletes the
   data. If Android answers `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, stop: the phone has a build signed
   with another key.
3. **Check before moving.** Plannr opens with all your data, still in the old storage (the section
   offers **Move to the new storage**); the totals are the same as in step 1.
4. **Move.** As in the test: passphrase twice, save the step-1 backup off the phone, check it is
   there, confirm. Wait until Plannr reopens.
5. **Verify.** The section says all tables match; the totals are the same as in step 1; check S
   passes (`phone-test.ps1 -AllowExisting`, read only).
6. **Keep the old copy** for at least a week of normal use. Only then: save a new encrypted backup
   off the phone, and only after that tap **Delete the old copy**.

If anything looks wrong at step 3 or 5, stop and do not delete anything: the old copy and both
backups from step 1 are still there, and **Move data back** returns to the old storage.

## Results

### Emulator, 2026-11-15 (debug builds; driven over adb with Playwright's Android support)

| # | Check | Result | Numbers / notes |
|---|---|---|---|
| 0 | Phone, Android, WebView version | — | Emulator `sdk_gphone64_x86_64`, Android 16 (API 36), WebView 133.0.6943.137, Google APIs image, no Google account. |
| 1 | Data location and sizes | Pass | `app_webview/Default/Local Storage/leveldb/` (in the Auto Backup rules). With the test data: Local Storage 224 KB, `app_webview` 704 KB, `files/` 72 KB. |
| 2 | Meter; real `localStorage` limit | Pass | Meter shown: "Used 0.2 MB of about 10 MB (2%)" on a fresh install. Real limit **5,242,866** characters (the app assumes 5,242,880). The app opened normally after the probe, meter unchanged. |
| 3 | JSON + encrypted export/restore with categories | Pass | Both buttons wrote the file (verified size: JSON 51,304 bytes, encrypted 311,345 bytes) and opened the share sheet. JSON is v2 with categories and people. Each restore gave back every table, counter and the schema version exactly. A wrong password: "decryption failed — wrong passphrase, or the backup file is corrupt/tampered.", nothing changed. Each restore wrote a `.gz` safety snapshot; only the newest 3 were kept. |
| 4 | Airplane mode | Pass | All 10 pages open, no error box. Add/edit/delete kept after a restart. PDF, JSON and encrypted export open the share sheet. A reminder fired on time (to the second) with "Alarms & reminders" allowed; without it, Android delays it (more than 2 minutes late in the test), hence the new "Allow on-time reminders" button. |
| 5 | Update over old version | Pass | `main` (Phase 1) → this branch with `adb install -r`: Android kept `firstInstallTime` (an update), every entry and total the same. Both are schema v2, so no upgrade ran. Forcing an older schema wrote `plannr-pre-migration-v1-to-v2-….db.gz` (17 KB) before upgrading; a newer schema (v3) stopped with "Plannr could not open your data … newer version … Nothing was changed", and it was true. |
| 6 | Auto Backup (`bmgr backupnow`, uninstall, reinstall) | Pass | Local transport. Backup 280,064 bytes for a 0.55 MB database. After `adb uninstall` + `adb install` Android restored it during the install: every table, counter, the schema version and all 3 safety snapshots came back. |
| 7 | Without INTERNET | Pass | Every page, add/edit/delete, PDF and backup export, JSON restore and scheduling a reminder work; nothing in logcat. Asking for notification permission still works. |

**Found and fixed on the emulator** (both also affect the `main` branch):

- Opening Home pushed Android's **"Alarms & reminders" settings screen** over the app on every
  start, once notifications were allowed (Android 14+; `@capacitor/local-notifications` 8.3 opens it
  by default). Fixed in `public/notifications.js`; the screen now opens only from the new button.
- The **Recycle Bin** never listed anything: with even one deleted item it showed "Network error
  loading the Recycle Bin.", so deleted entries could not be restored. A function it used was
  defined in the page's other script block. Fixed in `public/data-backup.html`.
- Leaving the **share sheet** open for more than 20 seconds showed "✗ Share.share threw: Opening
  the share sheet timed out after 20s." while it was still open, and an encrypted backup saved
  after that was not recorded as exported. Closing the sheet showed a red "Share canceled" error.
  Fixed in `public/data-backup.html` and `public/overview.html`: no timer on the share sheet, and
  closing it shows "Not saved: the share sheet was closed…". Checked on the emulator (sheet open
  25 s, then closed, for the JSON backup, the encrypted backup and the PDF).

**Known limit (measured):** a save made less than about a second before Android kills the app can be
lost; the database stays consistent (`docs/storage-proposal.md`). Measured again on 2026-11-20 (E3
below): the WebView writes `localStorage` to disk a few seconds late, so a kill can lose the last few
seconds of saves. **After the storage move (check 9) this no longer applies:** a save is in the
database file when it answers.

### Emulator, 2026-11-15 evening: debug build from `2d5fda8` (steps 1.3a–c)

Same emulator (`sdk_gphone64_x86_64`, Android 16, WebView 133.0.6943.137, no Google account). Fresh
install, test data only, driven over adb with Playwright's Android support. Nothing was sent from
any share sheet; each one was closed with BACK.

| # | Check | Result | Numbers / notes |
|---|---|---|---|
| 0 | Phone, Android, WebView version | — | As above. |
| 1 | Data location and sizes | Pass | `app_webview/Default/Local Storage/leveldb/`. After the checks: `app_webview` 4,912 KB (4 MB of it is Chromium's `BrowserMetrics-spare.pma`), Local Storage 332 KB, `files/` 60 KB. |
| 2 | Meter; real `localStorage` limit | Pass | "Used 0.2 MB of about 10 MB (2%)." on a fresh install. Real limit 5,242,866 characters. The meter was the same (2%) after the probe. |
| 3 | JSON + encrypted export/restore with categories | Pass | JSON 51,304 bytes (v2, categories and people), encrypted 311,345 bytes; both opened the share sheet. Both restores gave back everything. Wrong password: clear message, nothing changed. `.gz` snapshots written, at most 3 kept. |
| 4 | Airplane mode | Pass | All 10 pages open offline, no error box. Add/edit/delete kept after a restart. PDF, JSON and encrypted export each open the share sheet offline. With notifications allowed and "Alarms & reminders" allowed, a reminder set for 20:38 was posted at 20:38:08 (logcat: id 102), offline, app in the background. (The script's own check read the backup-overdue notification, id 201, by mistake; the logcat line is the evidence.) Without notification permission nothing is scheduled; on a fresh install it has to be allowed first, as on a phone. |
| 5 | Update over old version | Pass | `main`'s debug APK, then this build with `adb install -r`: `firstInstallTime` kept, every entry and loan the same. Both schema v2, so no upgrade and no pre-migration snapshot (correct). Forced older schema: two `plannr-pre-migration-v1-to-v2-….db.gz` snapshots written first, data and `integrity_check` intact. Newer schema (v3): "Plannr could not open your data … Nothing was changed", and it was true. |
| 6 | Auto Backup (`bmgr backupnow`, uninstall, reinstall) | Pass | Local transport, `Success`, 110,080 bytes. After `adb uninstall` and `adb install` every table, counter, the schema version and both snapshots came back. Transport switched back to Google's afterwards. |
| 7 | Without INTERNET | skipped | the permission stays (decision, 2026-11-15) |
| 8 | PDF total row; share sheet held open | Pass | Measured in the phone's WebView on the exact HTML handed to the PDF plugin: both tables with a total row span the header's columns (5 = 5, 7 = 7) and end at the same right edge (788 px). The share sheet stayed open 25 s with no timeout message; BACK then showed "PDF not shared: the share sheet was closed…". Encrypted restore at 311,345 bytes works (far under 20 MB). |

**Still needs the real phone:**
- 0: the model, Android and WebView versions.
- 2: the phone maker's WebView limit.
- 3: sharing to real apps (Files, Drive, WhatsApp) and opening the files there.
- 4: a reminder under the maker's battery management.
- 5 and 6: the update and a real Google Drive backup.
- 8: looking at the PDF in a PDF viewer.

`scripts/phone-test.ps1` on the same emulator and build, 2026-11-15 20:54: with Plannr installed it
stopped before changing anything (exit 2). After uninstalling Plannr from the emulator, a fresh run
passed all 7 automated checks (1, 2, 3, the two airplane-mode checks, and 8) with exit 0. The
screenshots show the share sheet opened in airplane mode and closed with BACK, then "PDF not
shared…". Airplane mode was back off afterwards. A second run with `-AllowExisting -SkipAirplane`
installed nothing and passed too.

### Emulator, 2026-11-20: debug build from `5736195` (step 1.4, the storage move)

The `plannr-test` emulator (Android 16, Google APIs image), test data only. Each run starts clean:
the build your phone has now (`9d7fd97`, a byte-identical copy of `7dc29db3…a2ef`) with test data,
then this build over it with `adb install -r`, as on the phone. The share sheet of the step-1
backup was answered inside the page; choosing where the file goes is checked by hand on the phone.
Details: `docs/step-1.4-storage-plan.md` §5.3.

| Run | What | Result | Numbers / notes |
|---|---|---|---|
| E1 | Update, then the move (1,000 typical entries) | Pass (13) | Every row kept by the update, on `localStorage`. Encrypted backup 2.9 s, move 1.6 s; marker `native-v1`, 1,229 rows checked; every table matches; a save goes to the file. Meter: "Your data file is 0.4 MB. With the old copy (0.9 MB)… about 1.4 MB of the 25 MB it allows (6%)." |
| E2 | Near the old limit (12,800 entries, `localStorage` 95.9% full) | Pass (13) | Backup 4.3 s, move 7.7 s, file 2.2 MB, every table matches. Meter: "…about 9.9 MB of the 25 MB it allows (40%)." |
| E3 | Killed inside each of the move's 11 steps | Pass (96) | Killed before the marker: reopens on `localStorage`, every row, no move file left; "Continue" finishes in 2.8–5.4 s, "Not now" keeps working. Killed after it: on the file, every row. |
| E4 | Low space | Pass (15) | 12 MB free: refused before the backup ("needs about 21 MB free… has 7 MB"), nothing changed. 60 MB free: the low-space warning. Phone full: a save says the phone is out of space and saves nothing; saving works again once space is freed; `integrity_check` ok. |
| E5 | Auto Backup after the move (`bmgr backupnow`, uninstall, install) | Pass | Included files 0.44 MB; Android's backup 477,184 bytes (25 MB allowed). Restored on install: the database file, the marker and the old copy (41 pages); the safety snapshots are not (decision D2). Opens on the file, every row; a save works. Transport put back to Google's. |
| E6 | Move back, move again, delete the old copy | Pass (27) | Moved back: on `localStorage`, every row, the file kept, the page says so; a save works. Moved again: every row, the save included. Deleting the old copy is refused until an encrypted backup is saved after the move; then it is deleted, and the estimate is the file alone (0.3 MB, 1%). A save then a kill at once: lost on `localStorage` in 2 of 3 runs, kept on the file in 3 of 3. |

`scripts/phone-test.ps1` (check S added): after the move, S, 1, 2, 3, 4 (offline home and PDF) and 8
pass; on a fresh install S says "localStorage (not moved yet)" and passes; with the marker made
unreadable S fails (proof), and the marker was put back byte for byte.

**Still needs the real phone (step 1.4):** check 9 with test data, then the real data with the
steps in "Moving your real data", after checks 0, 2, 3, 5 and 6 pass on this build.

### Emulator, 2026-11-21: the step 1.4 RC, debug build from `53db636`

Same emulator and method as above, with the RC (`1c54c4c8…e1f0`).

| Run | What | Result | Numbers / notes |
|---|---|---|---|
| E1 | Update from `9d7fd97` with 1,000 typical entries, then the move | Pass (16) | Every row kept by the update, on `localStorage`; encrypted backup 12.3 s, move 10.3 s; marker `native-v1`, 1,229 rows checked; every table matches; a save goes to the file and not to the old copy; the meter and the panel as in the 5736195 run. The Data Backup page took 13.8 s to fill after a reload; the 5736195 build took 13–15 s on the same data that day, so the emulator was slow, not the RC (the first run read the page at 2.5 s and failed those two checks; the script now waits for the page). |

### The owner's phone: the step 1.4 RC, debug build from `53db636` (SHA-256 `1c54c4c8…e1f0`)

Not yet run. At least checks 0, 2, 3, 5 and 6 must pass here before the real data moves. Test
data only.

Date tested:

| # | Check | Result | Numbers / notes |
|---|---|---|---|
| 0 | Phone, Android, WebView version | | |
| 1 | Data location and sizes | | |
| 2 | Meter; real `localStorage` limit | | |
| 3 | JSON + encrypted export/restore with categories | | |
| 4 | Airplane mode | | |
| 5 | Update over old version | | |
| 6 | Auto Backup (`bmgr backupnow`, uninstall, reinstall) | | |
| 7 | Without INTERNET | skipped | the permission stays (decision, 2026-11-15) |
| 8 | This build's changes (PDF total row, restores still fit) | | |
| S | Storage check (`phone-test.ps1`): which storage, file sizes | | |
| 9 | The storage move, test data (then real data, its own steps) | | |
