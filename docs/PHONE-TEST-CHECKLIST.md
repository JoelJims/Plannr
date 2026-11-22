# Phone test checklist

Things the automated tests cannot prove, because they need a real Android phone (or an
emulator). Phase 2, Step 9. Use a **debug build** unless a step says otherwise:

```sh
npm run android:sync
cd android && ./gradlew assembleDebug     # -> android/app/build/outputs/apk/debug/Plannr-debug.apk
```

> **Safety first.** Steps marked ⚠ delete or fill the app's storage. Do them only on a test phone or
> the emulator, with test data. Never do them on the phone that holds your real data, not even after
> a backup.
>
> A debug build and the release build are signed with different keys and cannot be installed over
> each other (`docs/RELEASE.md`). `adb shell run-as` works only with the debug build.
>
> **Which device.** Every adb command for your phone has `-d` ("the phone on USB"), and every adb
> command for the emulator has `-s emulator-5554`. Both go straight after `adb`, before the command
> word: `adb -d install …`, `adb -s emulator-5554 shell …`. The laptop's emulator is often running
> while the phone is connected, and a command without them could reach the wrong device. Never put
> `-d` after `install`: there it means "allow a lower version", which this checklist never needs.
> For another test device, use `-s <its serial>` (the first column of `adb devices`).

Write the result of each check (pass/fail, numbers, phone model, Android and WebView version) in
the table at the end.

## The APK under test

The phone round uses an APK built from `main` after PR #3 is merged. It will have everything in
`plannr-phase3`: the step 1.4 storage move (check 9), the fixes from the review of 2026-11-21
(`docs/security-quality-review-2026-11-21.md`), and the pull requests merged into `plannr-phase3`
on 2026-11-22. Until that APK exists, the current candidate is the `24d1d92` build (the right-hand
column below). Either replaces the step 1.4 RC (`53db636`), which was never run on the phone.

Fill in the box for the APK you will use, and use that one file in every step: on the emulator (A3)
and on the phone (B). Below, `<APK under test>` means that file.

| | APK under test (fill in) | Current candidate (example) |
|---|---|---|
| File | | `D:\Projects\plannr-wt\apk\plannr-phase3-24d1d92-debug.apk` (a work folder: copy the file to `D:\Backups\plannr\` to keep it) |
| SHA-256 | | `2b4f34f6944f48719def17b98e5a689610fa7e44a996f47b14c615d499a14888` |
| Built from commit | | `24d1d92` on `plannr-phase3` (PR #3, not merged yet). The build's branch has one more commit, which only changes CI, so the app is `24d1d92`'s |
| Signing certificate SHA-256 | | `fd12f08172d278469d6cad14786f48e080bc0c308cb457d56ce0ecdae4b95629` (the laptop's Android debug key) |

More about the current candidate:

| | |
|---|---|
| Size | 15,099,506 bytes. It is about 15 MB (the `9d7fd97` build is 5,974,512 bytes) because of the storage plugin's native SQLite library |
| Package / version | `com.plannr.app`, versionCode 1, versionName 1.0 |
| Signing key | The same debug key signed `9d7fd97` (below), so this build installs over it with `adb -d install -r` |
| Permissions | `INTERNET`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM`, and the app's own `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. **No `USE_BIOMETRIC` and no `USE_FINGERPRINT`** (finding S7; the RC had both) |
| INTERNET permission | present, and it stays (offline first: the core never uses it; see `CONTRIBUTING.md`) |
| Emulator | installed over the build already there with `adb install -r` (`firstInstallTime` kept) and opened, 2026-11-22 |

**Versions.** Every Plannr build so far has versionCode 1 and versionName 1.0, so the version
cannot tell the builds apart: check the SHA-256. The owner decided on 2026-11-22 that the first
public versionName is 1.0.0, and that versionCode only ever goes up. adb refuses an APK whose
versionCode is lower than the installed one (`INSTALL_FAILED_VERSION_DOWNGRADE`). If it says that,
stop and ask.

### Build a fresh APK from main

After PR #3 is merged. In PowerShell, in the main folder (`D:\Projects\Plannr`), when `git status`
says there is nothing to commit:

```powershell
git switch main
git pull
git log -1 --format=%h        # write this in "Built from commit"
npm run android:sync
cd android; .\gradlew.bat assembleDebug; cd ..
Copy-Item android\app\build\outputs\apk\debug\Plannr-debug.apk D:\Backups\plannr\plannr-main-<that commit>-debug.apk
```

### Check the APK on the laptop

In PowerShell:

```powershell
Get-FileHash <APK under test> -Algorithm SHA256
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.0.0\apksigner.bat" verify --print-certs <APK under test>
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.0.0\aapt.exe" dump badging <APK under test> | Select-String "package:"
```

- Write the hash in the box. `Get-FileHash` prints capitals: for the current candidate it is
  `2B4F34F6…A14888`.
- Write "Signer #1 certificate SHA-256 digest" in the box. It must be the same as the phone's
  ("What the phone has now" below; for `9d7fd97` it is `fd12f081…b95629`). With a different
  certificate the APK will not install over the phone's Plannr: stop and ask.
- The `package:` line shows `name='com.plannr.app'`, the versionCode and the versionName.

## The owner's phone round

### Decided: install over the real data, with proof first (owner, 2026-11-22)

The agreed order (`docs/step-1.4-storage-plan.md` section 5.4, `docs/pr-plannr-phase2.md`) was: test
data first, then your OK, then real data. The phone most likely has `9d7fd97`, from before step 1.4,
and the APK under test is the first build after step 1.4 to run on a real phone. You chose to install
it over your real data (option 1 of the earlier question), but only with proof first: before
anything is installed on the phone, both backups are restored on the emulator, with the same APK,
and compared with the phone.

1. **A1.** On the phone: make an encrypted backup and a JSON backup, and write down the figures.
2. **A2.** Copy both files to the laptop, and check them.
3. **A3.** On the emulator, with the APK under test: restore the JSON backup and compare, then
   restore the encrypted backup and compare.
4. **A4.** Only if both restores match completely, go to **B**: install over the phone with
   `adb -d install -r <APK under test>`. If either restore fails or is incomplete: stop, do not
   install, keep the backups, and ask.

Then **C** (the checks for this build) and **D** (clear your data from the emulator). The test-data
checks (2, 3, 6, 9, C7, C8) are not needed before B. They never run on the phone while it holds your
real data: run them on the emulator with test data, after D.

### Connect the phone

1. On the phone: Settings → About phone → tap **Build number** 7 times; then Settings → System →
   Developer options → turn on **USB debugging**. Connect the phone by USB and allow the laptop when
   asked.
2. On the laptop, `adb devices` lists the phone as `device` (not `unauthorized`). `adb` is in the
   Android SDK's `platform-tools` folder. If the emulator is running, it is listed too, as
   `emulator-5554`.

### What the phone has now

The phone was not connected when the current candidate was made: `adb devices` listed only the
emulator at 11:47, 11:50 and 11:52 on 2026-11-22. So nothing on the phone was read. The last build
made for it is `9d7fd97`: `android/app/build/outputs/apk/debug/Plannr-debug.apk` in the main
folder, and in `D:\Backups\plannr\`. SHA-256
`7dc29db34fa1bad4de338232b38273fe848f22e7a098f1553ac39f0665b6a2ef`, versionCode 1, versionName 1.0,
signed with the same debug key (`fd12f081…b95629`).

**Assume the Plannr on the phone holds your real data.** Nothing on the PC can see inside it, and
it was not installed just now. So do step A before anything is installed.

To see what is installed without changing anything (read-only commands, PowerShell). `-d` means
"the phone on USB": the laptop's emulator is often running too, and without `-d` adb could read the
emulator instead and give a false match:

```powershell
adb -d shell dumpsys package com.plannr.app | findstr /R "versionName versionCode firstInstallTime lastUpdateTime"
adb -d shell pm path com.plannr.app                    # prints package:/data/app/…/base.apk
adb -d pull <that path without the package: prefix> $env:TEMP\phone-base.apk
```

Then run the `apksigner verify --print-certs` line above on `$env:TEMP\phone-base.apk`. If its
certificate SHA-256 is not the one in the box, the APK under test will not install over it: stop
and ask.

### Rules for this round

- **Never uninstall Plannr from the phone.** Uninstalling deletes its data.
- If Android refuses the update with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (the signing key is
  different), **stop**. Do not uninstall, do not restore anything, and ask. Do the same for
  `INSTALL_FAILED_VERSION_DOWNGRADE`.
- On the phone, while it holds your real data, do not restore any backup and do not tap **Move to
  the new storage**. Your backups are restored on the emulator only (A3). Test backups and the move
  are tried with test data (C7, C8 and check 9).
- The test-data checks (2, 3, 6, 9, C7, C8) never run on the phone while it holds your real data.
- Every phone command has `-d`, and every emulator command has `-s emulator-5554` ("Which device"
  at the top).
- From A3 until D, the emulator holds a copy of your data. Run no test checks on it in that time:
  it is your fallback if the update goes wrong on the phone. D clears it.

### A. Before any install: back up, copy, and prove both backups restore

#### A1. On the phone: both backups, and the figures

Do this in the Plannr that is on the phone now. Its Data Backup page uses the same names as below.

1. Open Plannr. On Home, tap **DATA BACKUP** in the grid of four buttons at the top. The page is
   called **Data Backup**.
2. **Encrypted backup (everything).** In the section **Encrypted full backup**, type a passphrase of
   at least 10 characters in **Passphrase**, and the same again in **Type the passphrase again**.
   Tap **Download encrypted backup**. The share sheet opens: save the `plannr-backup-<date>.db.enc`
   file where you can copy it to the laptop (A2). Write the passphrase down somewhere other than the
   file. Without it, the file cannot be opened.
3. **JSON backup.** In the section **JSON backup**, first tick **Include Daily Report contacts
   (Gmail addresses & WhatsApp numbers)**. Without the tick, the JSON leaves the contacts out, and
   it must be complete. Then tap **Download JSON backup**, and save the `plannr-backup-<date>.json`
   file in the same way.
4. If you closed a share sheet without saving, the page says the file was not saved. Do that step
   again.
5. Write down the figures to compare, or take screenshots. You compare them after each restore on
   the emulator (A3), and after the install (C1):
   - **Overview**: every figure, with the date range at its default (the page says "Showing all
     transactions."; if it does not, tap **Edit**, then **All dates**).
   - **Cash flow** → **Cash outflow**: the number of entries ("… entries"), and for two or three
     ledgers the number when you pick that ledger in the filter ("Showing … of …").
   - **Cash flow** → **Cash inflow**, **Loan details** and **Contractor payments**: how many rows
     each list has.
   - **People**: the names in **Expense By** on Cash outflow (open the list; do not save anything).
   - **Categories**: the names in the **Ledger** list on Cash outflow, above all any you added or
     renamed.
   - **Contract Details**: the contract and its payment dates.
   - **Home**: the **Daily report reminders** times and the **Backup reminder** setting.
   - **Data Backup** → **Recycle Bin**: the number after each group's name.
   - **Contacts**: no page shows the Daily Report contacts, so A2 checks them in the JSON file.

#### A2. Copy both files to the laptop, and check them

Copy both files into `D:\Backups\plannr\`, in one of two ways:

- From the share sheet, save them to Google Drive, then download them on the laptop.
- Save them on the phone (for example in **Download**), then copy them with
  `adb -d pull /sdcard/Download/<file name> D:\Backups\plannr\`. This only reads the phone.

Keep every copy until C1 passes.

Check them on the laptop:

- The JSON file opens in a text editor, starts with `{`, and has `"kind": "plannr-backup"` and
  `"schemaVersion": 2`.
- Count what is in the JSON file (PowerShell):

  ```powershell
  node -e "const b=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));for(const[t,r]of Object.entries(b.tables))console.log(t.padEnd(24),r.length);console.log('contact keys:',b.tables.settings.filter(s=>s.key==='daily_report_recipients'||s.key==='daily_report_whatsapp').map(s=>s.key).join(', ')||'none')" D:\Backups\plannr\plannr-backup-<date>.json
  ```

  It prints the number of rows in each table, and which contact keys the file has. `users` are the
  people, `ledger_mains` and `ledger_subs` the categories and sub-categories, `cash_out` and
  `cash_in` the entries (deleted ones included). Write the numbers down: the JSON restore in A3
  reports the same ones. If you have Daily Report contacts saved, the last line must name them;
  "none" means you have none, or the box in A1 step 3 was not ticked (then make the JSON backup
  again).
- Optional, a first look at the encrypted file (A3 restores it anyway). In PowerShell, in the
  Plannr folder:

  ```powershell
  $env:PLANNR_BACKUP_PASSPHRASE = Read-Host 'Passphrase'
  node decrypt-db.js <the .db.enc file> $env:TEMP\plannr-check.db
  Remove-Item Env:PLANNR_BACKUP_PASSPHRASE
  ```

  It prints the sizes and writes a readable copy; it refuses to write over `data/plannr.db`.
  Delete `plannr-check.db` afterwards (it is your data, unencrypted).

#### A3. On the emulator: restore both, and compare

This proves that both files hold all your data, and that the APK under test restores them, before
the phone gets that APK. **Your data replaces the emulator's own test data.** The emulator is
`emulator-5554` ("Running these on an emulator" below).

1. Install the APK under test on the emulator, over the build that is there, and open Plannr once:

   ```powershell
   adb -s emulator-5554 install -r <APK under test>
   ```

   It must answer `Success`. If it does not, stop and ask.
2. Copy both files to the emulator's **Download** folder:

   ```powershell
   adb -s emulator-5554 push D:\Backups\plannr\plannr-backup-<date>.json /sdcard/Download/
   adb -s emulator-5554 push D:\Backups\plannr\plannr-backup-<date>.db.enc /sdcard/Download/
   ```

3. **The JSON backup first.** In the emulator's Plannr, open Data Backup. In the section **Import /
   Restore**, tap the file field and choose the `.json` file in the **Download** folder. Tap
   **Import / Restore**, then OK on "This REPLACES all current data with the backup…". It must
   answer "Restored ✓ — …" with the same numbers as in A2 (inflows, outflows, loans, contract rows,
   payment dates, contractor payments, settings, categories, sub-categories). If it also says that
   entries "referenced a person not in this install", people are missing: stop.
4. Compare every figure from A1 step 5. A JSON restore replaces every entry, person, category, loan
   and contract, but it keeps any setting the file does not have. So a reminder time or a setting
   you never made is the emulator's own, not a gap in your backup; the next restore replaces it.
5. **Then the encrypted backup.** In the section **Restore from encrypted backup**, tap the file
   field and choose the `.db.enc` file. Type your passphrase in **Passphrase**, tap **Restore from
   encrypted backup**, then OK on "This REPLACES the entire database with this backup's
   contents…". It must answer "Restored ✓ — …", and the page reloads.
6. Compare every figure from A1 step 5 again. This restore replaces the whole database, so
   everything must match exactly.

Why this order: a JSON restore keeps the settings that the file does not have. Done after the
encrypted restore, it would keep the encrypted backup's settings and contacts, and a gap in the JSON
file would not show.

If a restore answers "Storage is full — …", the restore did not go through and nothing was changed.
The emulator is still on the old storage (the WebView's, full at about 2.8 MB of data). Use **Move
to the new storage** on the emulator first (not the Recycle Bin clean-up that the message suggests),
as in check 9 step 2: in **Where your data is kept**,
type a passphrase twice, tap **Move to the new storage**, save the backup it makes in the
emulator's **Download** folder, and tap **I have the backup — continue**. Then do that restore
again. If the emulator already holds your data from the JSON restore, the move's backup is a copy
of your data: D deletes it.

Restoring files pushed this way has not been tried on this emulator yet. If a file is not listed in
the file picker, or a restore fails in any other way, stop and ask.

#### A4. Go, or stop

- **Go to B** only if both restores answered "Restored ✓", and every figure matched after each.
- **Otherwise stop.** Do not install anything on the phone. Keep both backups and the emulator as
  they are, and ask.

### B. Install over it

Only after A4 says go. The phone is connected, and the emulator may be running.

```powershell
adb -d install -r <APK under test>
```

It must answer `Success`. `-r` replaces the app and keeps its data. Never uninstall. If it answers
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` or `INSTALL_FAILED_VERSION_DOWNGRADE`, stop ("Rules for this
round").

Check 7 is skipped: Plannr keeps the INTERNET permission (owner's decision, 2026-11-15). Check 4
(airplane mode) is the offline check on the phone.

### C. The checks for this build

Write each result in the table "The owner's phone: the APK under test" at the end.

1. **The update keeps every entry.** Open Plannr. Every ledger, entry, category and loan is there,
   and every figure is the same as in A1 step 5.
   `adb -d shell dumpsys package com.plannr.app | findstr /R "firstInstallTime lastUpdateTime"`
   shows the old `firstInstallTime` and a new `lastUpdateTime` (an update, not a fresh install).
   The data is still in the old storage: Data Backup → **Where your data is kept** offers **Move to
   the new storage**. Leave it for now.
2. **CSV export: one share sheet (F2).** Data Backup → **CSV for Excel** → **Download CSV (for
   Excel)**. ONE share sheet opens with all the CSV files (one per table). Before this build the
   page said "Downloading … CSV files" on the phone and nothing was saved. Close the sheet with
   BACK: the page says nothing was saved. Then do it again, save the files where you choose, and
   open one in Excel or Sheets. The CSV files are your data, unencrypted: keep them private.
3. **PDF time against the 25 s limit (E1).** Overview → **Download PDF** → **Light**. With a
   stopwatch, time from the tap on **Light** to the moment the share sheet opens. The app gives up
   after 25 s (the message says the native print adapter did not respond). Do it twice and write
   down both times; close each share sheet with BACK. The emulator took 4.1 to 4.5 s.
   `scripts/phone-test.ps1` measures the same and prints it as "8 PDF time (tap to share sheet)".
   With Plannr installed it needs `-AllowExisting`: then it installs and uninstalls nothing, presses
   only BACK on a share sheet, and puts airplane mode back as it was (add `-SkipAirplane` to leave
   airplane mode alone). While the emulator is running, also add `-Serial <the phone's serial>`
   (the first column of `adb devices`): with two devices the script stops and asks for one. It
   force-stops Plannr, and while the data is in `localStorage` a kill can lose the last seconds of
   saves: wait a minute after your last entry before you run it. Its screenshots can show your
   data; they stay in the gitignored `docs/phone-test-evidence/`.
4. **Overview while loading (F3).** Open the Overview. While it loads, the figures show "…", never
   ₹0.00; then your real figures appear. If a load fails, the figures show "—" and the page says
   "The Overview could not be loaded, so no figures are shown. Reload the page to try again." with
   the reason. You are not expected to see the failure; write it down if you do.
5. **Home (F5).** Home no longer says "First login — welcome.".
6. **No biometric permission (S7).**
   `adb -d shell dumpsys package com.plannr.app | findstr /I "BIOMETRIC FINGERPRINT"` prints nothing.
   (Settings → Apps → Permissions does not list these install-time permissions, so it proves
   nothing here.)
7. **Restore rollback (S3/Q6). Test backups only**, on the emulator after D, or on another device
   without your real data (a restore replaces the live data, even one that then fails). A good test
   encrypted backup still restores and writes a safety snapshot (check 3). A backup that fails a
   check after it is copied in must answer "This backup could not be restored. Nothing was changed:
   your data is as it was before. Reason: …", and the data must be as before. Such a file is hard to
   make by hand; the automated tests cover it (`test/backup-encrypted-restore.test.js`,
   `test-ui/backup-roundtrip.js`).
8. **Strict import (F1). Test backups only**, as in C7. Copy a test JSON backup. In a text editor,
   in the `ledger_mains` list, change one `"code"` from, for example, `"22.0"` to `"22"`. Restore
   the copy with **Import / Restore**: it is refused with "ledger_mains: code "22" is not a category
   code (a category's code is "N.0", like "22.0").", and nothing changes. The unchanged test backup
   still restores.

### D. Afterwards: clear your data from the emulator

Once C1 has passed (the update kept everything on the phone), the copy of your data on the emulator
has done its job. It is your data, so remove it (PowerShell):

```powershell
adb -s emulator-5554 shell pm clear com.plannr.app
adb -s emulator-5554 shell ls /sdcard/Download/
adb -s emulator-5554 shell rm /sdcard/Download/<each Plannr backup file it lists>
```

`pm clear` deletes everything the emulator's Plannr holds: your data, and the safety copies the two
restores made of the data before them. The `rm` lines delete the two files pushed in A3, and any
backup a move in A3 saved there. Plannr stays installed and opens as a fresh install; add test data
again before the test checks. Keep your backups on the laptop (`D:\Backups\plannr\`).

## Running these on an emulator (no phone needed)

The results table at the end was first filled in on an emulator. To do the same:

1. Check the PC can run one: `"%LOCALAPPDATA%\Android\Sdk\emulator\emulator-check.exe" accel` must
   say WHPX (or AEHD) "is installed and usable".
2. Create a virtual device with the image `system-images;android-36;google_apis;x86_64` (about
   1.9 GB). In Android Studio: **Device Manager → Create virtual device**, any phone, the API 36
   "Google APIs" x86_64 image. A Google APIs image (not "Google Play") allows `adb root` and
   `run-as`, and needs no Google account.
3. Start it: `emulator -avd <name> -no-snapshot` (add `-no-window` to run it in the background).
4. Install the debug APK with `adb -s emulator-5554 install -r <APK under test>`. The app's WebView
   can be inspected from desktop Chrome at `chrome://inspect` (debug builds only).

The adb commands in checks 1 to 9 below are written for the emulator (`adb -s emulator-5554 …`). On
another test device, write `-s <its serial>` in place of `-s emulator-5554`. Check 0 is written for
your phone (`adb -d …`).

An emulator proves the app's own behaviour (storage, backups, updates, offline, permissions). It
does not prove a particular phone maker's WebView or a real Google Drive backup; repeat checks
2, 5 and 6 on a real phone with test data (never on the phone that holds your real data) before
trusting a phone with the only copy of the data.

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
`-Serial <id>` when more than one device is connected (`-Serial emulator-5554` for the emulator, or
the phone's serial from `adb devices`), `-SkipAirplane`.

## 0. Phone details

Read-only, on your phone (PowerShell):

```powershell
adb -d shell getprop ro.product.model
adb -d shell getprop ro.build.version.release
adb -d shell dumpsys package com.google.android.webview | findstr versionName
```

## 1. Where the data lives, and how big it is

Open the app, add a few entries, then:

```sh
adb -s emulator-5554 shell run-as com.plannr.app ls -la "app_webview/Default/Local Storage/leveldb"
adb -s emulator-5554 shell run-as com.plannr.app ls -la app_webview
adb -s emulator-5554 shell run-as com.plannr.app du -sh app_webview "app_webview/Default/Local Storage" files/safety-snapshots
```

- [ ] The database is under `app_webview/Default/Local Storage/` (or `app_webview/Local Storage/`
      on old WebViews). Both are in the Auto Backup rules (`android/app/src/main/res/xml/`). If it
      is anywhere else, the rules must change.
- [ ] Note the sizes.

After the storage move (check 9), the data is in its own file, and a small marker file says so:

```sh
adb -s emulator-5554 shell run-as com.plannr.app ls -la databases files
adb -s emulator-5554 shell run-as com.plannr.app cat files/plannr-storage.json
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
      `"schemaVersion": 2`, and includes the categories (`ledger_mains`, `ledger_subs`) and the
      people (`users`).
- [ ] **Download encrypted backup**: the file is saved/shared; restoring it with a wrong password fails
      with a clear message and changes nothing.
- [ ] Change something (delete a category's entry, rename a person), then restore the JSON
      backup with **Import / Restore**: everything is back, categories included, totals match.
- [ ] Change something again, then **Restore from encrypted backup**: everything is back. A
      pre-restore safety snapshot was written:

      ```sh
      adb -s emulator-5554 shell run-as com.plannr.app ls -la files/safety-snapshots
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
   adb -s emulator-5554 install -r <APK under test>
   ```

- [ ] Android says the app was updated (not installed fresh).
- [ ] All ledgers, entries, categories and totals are the same as before.
- [ ] If the new version upgrades the database (a new migration), a pre-migration safety snapshot
      appears in `files/safety-snapshots/`.
- [ ] For a real release, repeat with the signed release APK, following `docs/RELEASE.md`.

## 6. Android Auto Backup ⚠ (uninstalls the app)

Needs a Google account on the phone with backup turned on (Settings → Google → Backup).

```sh
adb -s emulator-5554 shell bmgr enabled            # must say "enabled"
adb -s emulator-5554 shell bmgr list transports    # the Google transport has a * in front of it
adb -s emulator-5554 shell bmgr backupnow com.plannr.app
```

- [ ] `backupnow` ends with `Package com.plannr.app with result: Success` (not `Quota exceeded`).
      `Backup is not allowed` means the app is in Android's "stopped" state (just installed or
      force-stopped): open Plannr once, go to Home, and run `backupnow` again.
- [ ] Note the size, if shown (`with progress: <bytes>/…` in the `backupnow` output).

Without a Google account (an emulator), Android's local transport does the same job:
`adb -s emulator-5554 shell bmgr enable true`, then
`adb -s emulator-5554 shell bmgr transport com.android.localtransport/.LocalTransport`, run the
steps here, and switch back afterwards with
`adb -s emulator-5554 shell bmgr transport com.google.android.gms/.backup.BackupTransportService`.

Then, **only on a test install, never on a phone that holds your real data** (uninstalling deletes
it, and Auto Backup may not have run). On the emulator, never while it holds the copy of your data
(from A3 until D):

```sh
adb -s emulator-5554 uninstall com.plannr.app
adb -s emulator-5554 install <APK under test>
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
- [ ] `phone-test.ps1 -Serial emulator-5554 -AllowExisting`: check S passes ("the database file since …, checked … rows in … tables; old copy kept").
- [ ] Add an entry, close Plannr (swipe it away), open it: the entry is there.
- [ ] **Move data back**: Plannr reopens on the old storage, everything there; the section says
      "Your data was moved back to the old storage on <date>. The database file is kept." Then move
      again.
- [ ] **Delete the old copy** asks for an encrypted backup saved after the move first; after one, it
      asks to confirm, deletes it, and the meter no longer counts an old copy.
- [ ] If Plannr is closed during the move (swipe it away while "Moving your data…" shows), it
      reopens on the old storage with everything, and offers **Continue** or **Not now**.

**Moving your real data** comes only after the test above passes on a test install (the emulator or
another device, never the phone that holds your real data), and after you say OK. Do it in this
order, and do not skip a step:

1. **Back up first, in the app you have now.** Data Backup → **Download encrypted backup** and
   **Download JSON backup** (with **Include Daily Report contacts** ticked, as in A1). Save both off
   the phone (on the PC, or in Drive), then check on the PC that the encrypted one opens. In
   PowerShell, in the Plannr folder:

   ```powershell
   $env:PLANNR_BACKUP_PASSPHRASE = Read-Host 'Passphrase'
   node decrypt-db.js <the .db.enc file> $env:TEMP\plannr-check.db
   Remove-Item Env:PLANNR_BACKUP_PASSPHRASE
   ```

   It prints the sizes and writes a readable copy; it refuses to write over `data/plannr.db`. Delete
   `plannr-check.db` afterwards (it is your data, unencrypted). Note the totals on the Overview (or
   take a screenshot).
2. **Install over it, never uninstall.** If the APK under test is not on the phone yet, install it
   with steps A and B above (the backups, the restore proof on the emulator, then
   `adb -d install -r <APK under test>`). Uninstalling deletes the data. If Android answers
   `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, stop: the phone has a build signed with another key.
3. **Check before moving.** Plannr opens with all your data, still in the old storage (the section
   offers **Move to the new storage**); the totals are the same as in step 1.
4. **Move.** As in the test: passphrase twice, save the step-1 backup off the phone, check it is
   there, confirm. Wait until Plannr reopens.
5. **Verify.** The section says all tables match; the totals are the same as in step 1; check S
   passes (`phone-test.ps1 -AllowExisting`, with `-Serial` as in C3; read only).
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
| E6 | Move back, move again, delete the old copy (update from `9d7fd97`, then the RC) | Pass (27) | Moved back: on `localStorage`, every row, the marker `localstorage-v1` with the time, the database file kept, the page says so; a save goes to `localStorage` (and a save killed at once was kept this time). Moved again: every row, the save included, marker `native-v1`, old copy kept; on the file a save survives an immediate kill. Deleting the old copy is refused until an encrypted backup is saved after the move; then it is deleted (0.4 MB freed), no `localStorage` copy left, the marker records it, the Google backup estimate is the file alone, and the meter and panel stop counting an old copy. Run 2 stopped after 11 passing checks on a script race (the page navigated while the script read it after a force-stop); the script's page open now retries, app unchanged. |
| `phone-test.ps1` | The owner's script, run against the emulator (`-Serial emulator-5554`, test data) | S, 1, 2, 3 pass; 4 and 8 fail | After `986ac78` (a tap waits until the element stops moving; longer waits). On the data E1 left (moved: the database file, 1,229 rows in 14 tables, old copy kept). 1: data location and sizes. S: storage in use. 2: the meter ("Your data file is 0.4 MB…"). 3: the JSON backup opens the share sheet and BACK closes it. "4 Home opens offline" was marked FAIL, but its screenshot shows Home open in airplane mode with no error text, still filling ("WELCOME, …"), so most likely the script read the screen too early on the slow emulator; the real phone's check 4 decides (decision 47 in the session report). **The PDF checks (4, 8) fail:** the app's own 25 s PDF limit ran out ("the native print adapter did not respond"), also when driven through Playwright. The PDF path is unchanged since `5736195`, where both passed; the emulator was slow that day (the Data Backup page took 13–15 s to fill on both builds), so this is recorded as finding E1 (measure the PDF time on the real phone), not an RC fault. |

**Not automatable on the emulator, so still for the real phone:** 0 (the phone's own details), the real `localStorage` limit in 2, 4 on a real phone's print service, 5 over the build that is on the phone now, 6 with a real Google account, and 9 with your hands on the device.

### The owner's phone: the APK under test

Not yet run. Step A comes first: both backups made on the phone, copied to the laptop, and both
restored on the emulator and compared. Step B (the install) only if both restores match. The step
1.4 RC (`53db636`) was never run on the phone; the APK under test replaces it.
Checks 2, 3, 6, 9, C7 and C8 need test data: on a phone that holds your real data they cannot run
without uninstalling or restoring, so run them on another device or the emulator (after D), never
here. Check 0 and C1 to C6 run on this phone.

APK under test (copy it from the box at the top). File: . SHA-256: . Built from commit: .
Signing certificate SHA-256: .

Date tested:

| Check | Expected | Result | Notes |
|---|---|---|---|
| What was installed before | versionName, versionCode, `firstInstallTime`; certificate SHA-256 the same as the APK under test's (for `9d7fd97`: `fd12f081…b95629`) | | |
| A. Backups made | Encrypted and JSON backups (with **Include Daily Report contacts** ticked) made on the phone and copied to the laptop; the figures from A1 step 5 written down; the JSON has `"schemaVersion": 2`, and the row counts and contact keys from A2 | | |
| Restore proof on the emulator: JSON | Same APK as the phone gets; "Restored ✓" with the same numbers as A2; no person missing; every figure from A1 step 5 matches | | |
| Restore proof on the emulator: encrypted | Same APK; "Restored ✓" and the page reloads; every figure from A1 step 5 matches exactly | | |
| B. Install over it | Only after both restore proofs passed; `adb -d install -r <APK under test>` answers `Success`; no uninstall | | |
| C1. Update keeps every entry (5) | Every figure the same as in A1 step 5; `firstInstallTime` unchanged | | |
| C2. CSV export (F2) | One share sheet with all the CSV files; BACK says nothing was saved; saved files open | | |
| C3. PDF time (E1) | Share sheet opens well under 25 s; write down both times | | |
| C4. Overview loading (F3) | "…" while loading, never ₹0.00; a failed load shows "—" and says so | | |
| C5. Home (F5) | No "First login — welcome." line | | |
| C6. No biometric permission (S7) | No `USE_BIOMETRIC` or `USE_FINGERPRINT` | | |
| C7. Restore rollback (S3/Q6), test backups only | A good test restore works and writes a safety snapshot; a failed one says "Nothing was changed" and the data is as before | | |
| C8. Strict import (F1), test backups only | A backup with a code like `"22"` is refused and nothing changes; the unchanged backup restores | | |
| D. Your data cleared from the emulator | After C1: `pm clear` done; the pushed files (and any backup a move saved) deleted from the emulator's Download folder | | |
| 0. Phone, Android, WebView version | Written down | | |
| 2. Meter; real `localStorage` limit (fresh test install only; not on this phone while it holds real data) | Meter shown; limit about 5,242,880 characters | | |
| 3. JSON + encrypted export/restore (test data) | Both files saved and restored; a wrong passphrase changes nothing | | |
| 4. Airplane mode | Every page opens offline; PDF and backups work; a reminder fires | | |
| 6. Auto Backup (test install only; never on this phone while it holds real data) | `bmgr backupnow` says `Success`; data comes back after a reinstall | | |
| 7. Without INTERNET | skipped (decision, 2026-11-15) | skipped | |
| S. Storage check (`phone-test.ps1 -AllowExisting`, with `-Serial` as in C3) | Which storage is in use; file sizes | | |
| 9. The storage move, test data (then real data, its own steps) | All tables match; totals the same; old copy kept | | |
