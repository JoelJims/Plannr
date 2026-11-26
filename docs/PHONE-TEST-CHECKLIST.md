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
> each other (`docs/RELEASE.md`). `adb shell run-as` works only with the debug build. The owner's
> phone moves from the debug build to the release build once, in "The debug to release switch
> round" below.
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

The phone round uses a **fresh debug APK built from `main` after PR #3 is merged** ("Build a fresh
APK from main" below). It will have everything in `plannr-phase3`: the step 1.4 storage move
(check 9), the fixes from the review of 2026-11-21 (`docs/security-quality-review-2026-11-21.md`),
and pull requests #4 to #8, merged into `plannr-phase3` on 2026-11-23 (among them the new budget
wording, F4, checked in C9; `CHANGELOG.md` lists them all). It replaces the step 1.4 RC
(`53db636`), which was never run on the phone.

Fill in the box for the APK you will use, and use that one file in every step: on the emulator (A3)
and on the phone (B). Below, `<APK under test>` means that file.

The right-hand column is an **old example** of a filled-in box: the `24d1d92` build of 2026-11-22.
It shows what goes where. Do not use it for the round: it was built before pull requests #4 to #8
and has none of their changes.

| | APK under test (fill in) | Old example (`24d1d92`, 2026-11-22; not for the round) |
|---|---|---|
| File | | `D:\Projects\plannr-wt\apk\plannr-phase3-24d1d92-debug.apk` (a work folder: copy the file to `D:\Backups\plannr\` to keep it) |
| SHA-256 | | `2b4f34f6944f48719def17b98e5a689610fa7e44a996f47b14c615d499a14888` |
| Built from commit | | `24d1d92` on `plannr-phase3`, before pull requests #4 to #8. The build's branch has one more commit, which only changes CI, so the app is `24d1d92`'s |
| Signing certificate SHA-256 | | `fd12f08172d278469d6cad14786f48e080bc0c308cb457d56ce0ecdae4b95629` (the laptop's Android debug key) |

More about the old example:

| | |
|---|---|
| Size | 15,099,506 bytes. It is about 15 MB (the `9d7fd97` build is 5,974,512 bytes) because of the storage plugin's native SQLite library |
| Package / version | `com.plannr.app`, versionCode 1, versionName 1.0 |
| Signing key | The same debug key signed `9d7fd97` (below), so this build installs over it with `adb -d install -r` |
| Permissions | `INTERNET`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM`, and the app's own `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. **No `USE_BIOMETRIC` and no `USE_FINGERPRINT`** (finding S7; the RC had both) |
| INTERNET permission | present, and it stays (offline first: the core never uses it; see `CONTRIBUTING.md`) |
| Emulator | installed over the build already there with `adb install -r` (`firstInstallTime` kept) and opened, 2026-11-22 (a record; on this laptop today, name the emulator: `adb -s emulator-5554 install -r`) |

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

- Write the hash in the box. `Get-FileHash` prints capitals: for the old example it was
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
and compared with the phone, and the install itself is rehearsed there.

1. **A1.** On the phone: make an encrypted backup and a JSON backup, and write down the figures.
   From then until C1 passes, change nothing in Plannr on the phone.
2. **A2.** Copy both files to the laptop by cable, and check them.
3. **A3.** On the emulator, with the APK under test: empty Plannr, restore the JSON backup, and
   compare the figures and the files. Empty it again, restore the encrypted backup, and compare
   again. Then rehearse B: empty it again, install the phone's own APK, restore the JSON backup
   with it, install the APK under test over it, and compare again.
4. **A4.** Only if both restores and the rehearsal match completely, go to **B**: install over the
   phone with `adb -d install -r <APK under test>`. If any of them fails or is incomplete: stop, do
   not install, keep the backups, and ask.

Then **C** (the checks for this build) and **D** (clear your data from the emulator). The test-data
checks (2, 3, 6, 9, C7, C8, C11) are not needed before B. They never run on the phone while it holds
your real data: run them on the emulator with test data, after D.

### Connect the phone

1. On the phone: Settings → About phone → tap **Build number** 7 times; then Settings → System →
   Developer options → turn on **USB debugging**. Connect the phone by USB and allow the laptop when
   asked.
2. On the laptop, `adb devices` lists the phone as `device` (not `unauthorized`). `adb` is in the
   Android SDK's `platform-tools` folder. If the emulator is running, it is listed too, as
   `emulator-5554`.

### What the phone has now

The phone was not connected when the old example was made: `adb devices` listed only the
emulator at 11:47, 11:50 and 11:52 on 2026-11-22. So nothing on the phone was read. The last build
made for it is `9d7fd97`, kept as `D:\Backups\plannr\Plannr-debug-realphone-9d7fd97.apk`. SHA-256
`7dc29db34fa1bad4de338232b38273fe848f22e7a098f1553ac39f0665b6a2ef`, 5,974,512 bytes, versionCode 1,
versionName 1.0, signed with the same debug key (`fd12f081…b95629`).

**Assume the Plannr on the phone holds your real data.** Nothing on the PC can see inside it, and
it was not installed just now. So do step A before anything is installed.

To see what is installed without changing anything (read-only commands, PowerShell). `-d` means
"the phone on USB": the laptop's emulator is often running too, and without `-d` adb could read the
emulator instead and give a false match:

```powershell
adb -d shell dumpsys package com.plannr.app | findstr /R "versionName versionCode firstInstallTime lastUpdateTime"
adb -d shell pm path com.plannr.app                    # prints package:/data/app/…/base.apk
adb -d pull "<that path without the package: prefix>" D:\Backups\plannr\phone-current.apk
Get-FileHash D:\Backups\plannr\phone-current.apk -Algorithm SHA256
```

- `pm path` prints one line. If it prints nothing, Plannr is not on the device adb reached. If it
  prints more than one line, the app was installed in parts. Either way, stop and ask.
- `adb -d pull` copies the phone's own Plannr APK to the laptop: the app only, none of your data.
  Like `pm path`, it only reads the phone. Keep the copy: A3 installs it on the emulator to rehearse
  B. If the pull fails, stop and ask.
- If the phone still has `9d7fd97`, the hash is `7DC29DB3…A2EF`, the same as
  `D:\Backups\plannr\Plannr-debug-realphone-9d7fd97.apk`. This line compares the two hashes in
  full. It prints `True` if they are the same and `False` if not:

  ```powershell
  (Get-FileHash D:\Backups\plannr\phone-current.apk -ErrorAction Stop).Hash -eq (Get-FileHash D:\Backups\plannr\Plannr-debug-realphone-9d7fd97.apk -ErrorAction Stop).Hash
  ```

  Write the hash in the results table ("What was installed before"). If it prints `False`, the
  phone has another build: stop and ask before A1. If it prints red error text instead, a file is
  missing or misnamed: stop and ask too. The names in A1 and in the rehearsal (A3) were checked
  against `9d7fd97` only.
- Run the `apksigner verify --print-certs` line above on `D:\Backups\plannr\phone-current.apk`. If
  its certificate SHA-256 is not the one in the box, the APK under test will not install over it:
  stop and ask.

### Rules for this round

- **Never uninstall Plannr from the phone.** Uninstalling deletes its data. The one exception is
  step 3 of "The debug to release switch round" below, and only after its emulator proof.
- **From A1 until C1 passes, do not add, edit or delete anything in Plannr on the phone**: no
  entries, people, categories, reminder times or settings. Opening and reading pages is fine. If you
  have to change something, start again at A1 (new backups, then A2 and A3 again with the new files)
  before B. Otherwise the backups miss the change, and C1 compares against old figures.
- If the install on the phone answers anything other than `Success`, **stop**. Do not uninstall, do
  not restore anything, do not try other flags or advice from the web, and ask. That includes
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (the signing key is different),
  `INSTALL_FAILED_VERSION_DOWNGRADE`, `INSTALL_FAILED_INSUFFICIENT_STORAGE`, "more than one device",
  a timeout, and a cable that came out during the install.
- On the phone, while it holds your real data, do not restore any backup and do not tap **Move to
  the new storage**. Your backups are restored on the emulator only (A3). Test backups and the move
  are tried with test data (C7, C8, C11 and check 9). The one restore on the phone is step 5 of
  "The debug to release switch round" below, into the newly installed release app.
- The test-data checks (2, 3, 6, 9, C7, C8, C11) never run on the phone while it holds your real
  data.
  This rule wins over the older "still needs the real phone" lists under Results.
- Every phone command has `-d`, and every emulator command has `-s emulator-5554` ("Which device"
  at the top).
- From A3 until D, the emulator holds a copy of your data. Run no test checks on it in that time:
  it is your fallback if the update goes wrong on the phone. D clears it.

### A. Before any install: back up, copy, and prove both backups restore

#### A1. On the phone: both backups, and the figures

Do this in the Plannr that is on the phone now. Its Data Backup page uses the same names as below.
**From now until C1 passes, do not add, edit or delete anything in Plannr on the phone.** If you
have to, start again here: new backups, then A2 and A3 again with the new files, before B.

Keep both files on the phone, in **Download**: A2 copies them to the laptop by cable. Do not upload
them (to Google Drive or anywhere else) unless the cable does not work. The JSON file holds your
Daily Report contacts unencrypted, and a file deleted from Drive stays in Drive's Trash for 30 days.

1. Open Plannr. On Home, tap **DATA BACKUP** in the grid of four buttons at the top. The page is
   called **Data Backup**.
2. **Encrypted backup (everything).** In the section **Encrypted full backup**, type a passphrase of
   at least 10 characters in **Passphrase**, and the same again in **Type the passphrase again**.
   Tap **Download encrypted backup**. The share sheet opens: save the `plannr-backup-<date>.db.enc`
   file on the phone, in **Download**. A2 copies it to the laptop by cable; use Google Drive only if
   that does not work (A2). Write the passphrase down somewhere other than the file. Without it,
   the file cannot be opened.
3. **JSON backup.** In the section **JSON backup**, first tick **Include Daily Report contacts
   (Gmail addresses & WhatsApp numbers)**. Without the tick, the JSON leaves the contacts out, and
   it must be complete. Then tap **Download JSON backup**, and save the `plannr-backup-<date>.json`
   file in the same way. It holds your contacts unencrypted, so do not upload it unless the cable
   does not work.
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
   - **Contacts**: no page shows the Daily Report contacts, so A2 checks them in the JSON file,
     and A3 compares them in the emulator's export.

#### A2. Copy both files to the laptop, and check them

Copy both files into `D:\Backups\plannr\`. Use the cable if you can: the JSON file holds your Daily
Report contacts unencrypted, so it is better not to upload it.

- **By cable (preferred).** Save both files on the phone in **Download**. List the folder, then copy
  each file (one line per file). This only reads the phone:

  ```powershell
  adb -d shell ls /sdcard/Download/
  adb -d pull "/sdcard/Download/<file name>" D:\Backups\plannr\
  ```

  Use the names `ls` shows: if a file of that name was there already, the phone may have saved the
  new one as `… (1).json`.
- **Only if the cable does not work:** save them to Google Drive from the share sheet, then
  download them on the laptop and move them from the browser's **Downloads** folder into
  `D:\Backups\plannr\`, so no copy stays in Downloads. A file you delete from Drive stays in
  Drive's **Trash** (called **Bin** in some languages) for 30 days, so D deletes them from both.

Keep the copies in `D:\Backups\plannr\` for good. Once C1 passes, delete the copies from the phone's
Download folder, and from Google Drive and then Drive's Trash if you used it (D).

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
  reports the same ones. If you have Daily Report contacts saved, the last line must name them.
  "none" means you have none, or the box in A1 step 3 was not ticked. If you are not sure it was
  ticked, make the JSON backup again with the box ticked (a JSON backup changes nothing in Plannr),
  copy the new file, and count again. Use the new file from then on.
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
the phone gets that APK. Each restore starts from an empty Plannr, with its data in the old storage
like the phone's, so it cannot borrow anything from the emulator's test data or from the other
restore. Then steps 11 to 17 rehearse B itself: the phone's own build writes your data, and the APK
under test is installed over it. **The emulator's own test data is deleted.** The emulator is
`emulator-5554` ("Running these on an emulator" below). From now until D, start it from a terminal
with `emulator -avd <name> -no-snapshot-save` (if it is running, close it and start it this way; D
says why).

1. Install the APK under test on the emulator, over the build that is there:

   ```powershell
   adb -s emulator-5554 install -r <APK under test>
   ```

   It must answer `Success`. If it does not, stop and ask.
2. Copy both files to the emulator's **Download** folder:

   ```powershell
   adb -s emulator-5554 push D:\Backups\plannr\plannr-backup-<date>.json /sdcard/Download/
   adb -s emulator-5554 push D:\Backups\plannr\plannr-backup-<date>.db.enc /sdcard/Download/
   ```

3. **Empty the emulator's Plannr**, then open it once:

   ```powershell
   adb -s emulator-5554 shell pm clear com.plannr.app
   ```

   It must answer `Success`. This deletes everything the emulator's Plannr holds: its data, its
   settings, the new storage if it had moved, and its safety copies. The files you pushed to
   Download stay. Open Plannr and wait for Home: it is now a fresh install with its data in the old
   storage, like the phone.
4. **Restore the JSON backup.** Data Backup → section **Import / Restore**: tap the file field and
   choose the `.json` file in **Downloads** ("The file picker" below). Tap **Import / Restore**,
   then OK on "This REPLACES all current data with the backup…". It must answer "Restored ✓ — …".
   Its numbers (inflows, outflows, loans, …) are counted from the file itself, so they only confirm
   that you chose the right file: they must be the numbers A2 printed. If it also says that entries
   "referenced a person not in this install", people are missing: stop.
5. Compare every figure from A1 step 5. Every one must match exactly.
6. **Compare the files** ("After each restore: compare the files" below). Save the emulator's
   export as `emulator-after-json.json`, and run the comparison line marked "After the JSON
   restore". It must end with `ALL THE SAME`.
7. **Empty the emulator's Plannr again** with the `pm clear` line, and open it once, as in step 3.
8. **Restore the encrypted backup.** Section **Restore from encrypted backup**: tap the file field
   and choose the `.db.enc` file. Type your passphrase in **Passphrase**, tap **Restore from
   encrypted backup**, then OK on "This REPLACES the entire database with this backup's
   contents…". It must answer "Restored ✓ — …", and the page reloads.
9. Compare every figure from A1 step 5 again. Every one must match exactly, with one exception:
   Home's backup banner ("Plannr — your last backup was … days ago." or "Plannr — you have never
   backed up.") may show here but not on the phone. That is expected. The encrypted file is made a
   moment before Plannr records that an encrypted backup was saved (that happens after the share
   sheet), so the file still carries the time of your previous encrypted backup.
10. **Compare the files** again. Save the new export as `emulator-after-enc.json`, and run the
    comparison line marked "After the encrypted restore": its second file is
    `emulator-after-enc.json`, not the JSON round's file. It must end with `ALL THE SAME`.

The order of the two restores does not matter: each starts from an empty Plannr (steps 3 and 7), so
a gap in one file cannot be hidden by the other.

**Rehearse B** (steps 11 to 17). In steps 3 to 10 the APK under test wrote your data itself. On the
phone, B installs it over the phone's own build, which wrote your data into the old storage. These
steps rehearse that on the emulator: the phone's own build restores your data, then the APK under
test is installed over it. They change nothing on the phone. They prove the update with your data's
content, not with the phone's own database file (its history and layout), which only B itself
touches; that is why C1 checks the phone again afterwards. The emulator tests recorded under Results
(2026-11-20 and 2026-11-21) did the same with test data.

11. **The phone's own APK.** "What the phone has now" copied it to
    `D:\Backups\plannr\phone-current.apk`. Check that it is still the same file:

    ```powershell
    Get-FileHash D:\Backups\plannr\phone-current.apk -Algorithm SHA256
    ```

    The hash must be the one you wrote in the results table ("What was installed before"; for
    `9d7fd97` it is `7DC29DB3…A2EF`). If the file is not there, copy it again with the read-only
    `pm path` and `adb -d pull` lines in "What the phone has now", and check its hash. If the hash
    is another one, stop and ask.
12. **Empty the emulator's Plannr** with the `pm clear` line from step 3. It must answer `Success`.
    Do not open Plannr yet.
13. **Install the phone's own APK** over the APK under test:

    ```powershell
    adb -s emulator-5554 install -r D:\Backups\plannr\phone-current.apk
    ```

    It must answer `Success`. A debug build of `main` made on this laptop and `9d7fd97` both have
    versionCode 1 (the `package:` line in "Check the APK on the laptop") and the same debug key,
    so `-r` works. If it answers anything else (for example
    `INSTALL_FAILED_VERSION_DOWNGRADE`, when the APK under test has a higher versionCode than the
    phone's build): stop and ask. Do not try other flags, and do not uninstall.
14. **Restore the JSON backup with the phone's build.** Open Plannr and wait for Home: it is the
    phone's build, empty, with its data in the old storage. Restore the `.json` file as in step 4:
    Data Backup → **Import / Restore**, choose the file in **Downloads**, tap **Import / Restore**,
    then OK on "This REPLACES all current data with the backup…". The `9d7fd97` build has the same
    section, button and messages. It must answer "Restored ✓ — …" with the numbers A2 printed. If
    it also says that entries "referenced a person not in this install", stop. If it answers
    "Storage is full — …", stop and ask: this build has no **Move to the new storage**.
15. **Install the APK under test over it**, as B does on the phone:

    ```powershell
    adb -s emulator-5554 install -r <APK under test>
    ```

    It must answer `Success`. If it does not, stop and ask.
16. Open Plannr and wait for Home. Data Backup → **Where your data is kept** offers **Move to the
    new storage**: the data is still in the old storage, as it will be on the phone after B. Leave
    it. Compare every figure from A1 step 5: every one must match exactly.
17. **Compare the files** once more. Save the new export as `emulator-after-update.json`, and run
    the comparison line marked "After the rehearsal of B". It must end with `ALL THE SAME`.

##### After each restore: compare the files

The figures in A1 step 5 do not cover everything. No page shows the Daily Report contacts, and the
people (`users`), the saved custom category names (`ledger_customs`), the contract services and
allowances, and the settings are not in that list. So export the emulator's data and compare it with
the phone's JSON file, table by table and row by row.

1. In the emulator's Plannr: Data Backup → section **JSON backup** → tick **Include Daily Report
   contacts (Gmail addresses & WhatsApp numbers)** → **Download JSON backup**. The share sheet
   opens. On this emulator it offers only Quick Share, Drive and Gmail (checked on 2026-11-22), and
   none of them saves the file on the emulator: close it with BACK. The page then says "Not saved:
   the share sheet was closed…". That is expected here: Plannr wrote the file into its own cache
   folder before the share sheet opened, and the file stays there.
2. Copy it to the laptop (PowerShell). The first line lists the folder, so you see the file's name:

   ```powershell
   adb -s emulator-5554 shell run-as com.plannr.app ls cache/
   cmd /c "adb -s emulator-5554 exec-out run-as com.plannr.app cat cache/plannr-backup-<date>.json > D:\Backups\plannr\emulator-after-json.json"
   ```

   That `cmd /c` line is for the JSON round (A3 step 6). At its end, write `emulator-after-enc.json`
   instead after the encrypted restore (A3 step 10), and `emulator-after-update.json` after the
   rehearsal of B (A3 step 17). `cmd /c` copies the file byte for byte (PowerShell's own `>` would
   rewrite it as UTF-16 text). `run-as` works with the debug build only. `pm clear` (A3 steps 3, 7
   and 12) empties the cache folder, so every file there was exported in this round.

   If the share sheet on your emulator can save into **Download**, you may do that instead. That
   folder also holds the two files you pushed in A3 step 2, and it may hold an earlier round's
   export, so take care to copy the new file:
   - Before each export, delete the emulator's earlier export there, if there is one (the `rm` line
     in D). Do not delete the two files you pushed.
   - After the export, list the folder with `adb -s emulator-5554 shell ls -l /sdcard/Download/`.
     The new file is the one with the time of a minute ago. Its name may end in `(1).json`.
   - Copy only that file, with
     `adb -s emulator-5554 pull "/sdcard/Download/<that file>" D:\Backups\plannr\emulator-after-json.json`
     (`emulator-after-enc.json` after the encrypted restore, `emulator-after-update.json` after the
     rehearsal). D then deletes it there too.
3. Compare it with the phone's JSON from A2 (PowerShell, one line). Use the line for the step you
   are in. Each line starts with the A2 file, and the second file is the new export. From the
   encrypted round on, a third file names the export made before it, so that an old export cannot
   pass in place of the new one. (C1 has its own line, for the phone after B.)

   After the JSON restore (A3 step 6):

   ```powershell
   node -e "const fs=require('fs');const [p,e,o]=process.argv.slice(1).map(f=>JSON.parse(fs.readFileSync(f,'utf8')));const rows=(b,t)=>(b.tables[t]||[]).filter(r=>t!=='settings'||r.key!=='last_encrypted_export_at');const ck=b=>rows(b,'settings').filter(s=>s.key==='daily_report_recipients'||s.key==='daily_report_whatsapp').map(s=>s.key).join(', ')||'none';let bad=0;const show=(n,x,y,a,c)=>{const ok=JSON.stringify(x)===JSON.stringify(y);if(!ok)bad++;console.log(n.padEnd(24),String(a).padStart(7),String(c).padStart(10),ok?'same':'DIFFERENT')};console.log('table'.padEnd(24),'A2 file','new export');for(const t of new Set(Object.keys(p.tables).concat(Object.keys(e.tables))))show(t,rows(p,t),rows(e,t),rows(p,t).length,rows(e,t).length);const sp=p.sequences||{},se=e.sequences||{};show('sequences',sp,se,Object.keys(sp).length,Object.keys(se).length);console.log('contact keys: A2 file',ck(p),'| new export',ck(e));if(ck(p)!==ck(e))bad++;console.log('exported: A2 file',p.exportedAt,'| new export',e.exportedAt+(o?' | earlier export '+o.exportedAt:''));if(e.exportedAt===p.exportedAt||(o&&!(e.exportedAt>o.exportedAt))||!(Date.now()-Date.parse(e.exportedAt)<=30*60*1000)){bad++;console.log('The second file is not a new export (the same as another file, not newer than the third file, or older than 30 minutes). Export again.')}console.log(bad?'NOT THE SAME: '+bad+' line(s) differ. Stop.':'ALL THE SAME')" D:\Backups\plannr\plannr-backup-<date>.json D:\Backups\plannr\emulator-after-json.json
   ```

   After the encrypted restore (A3 step 10):

   ```powershell
   node -e "const fs=require('fs');const [p,e,o]=process.argv.slice(1).map(f=>JSON.parse(fs.readFileSync(f,'utf8')));const rows=(b,t)=>(b.tables[t]||[]).filter(r=>t!=='settings'||r.key!=='last_encrypted_export_at');const ck=b=>rows(b,'settings').filter(s=>s.key==='daily_report_recipients'||s.key==='daily_report_whatsapp').map(s=>s.key).join(', ')||'none';let bad=0;const show=(n,x,y,a,c)=>{const ok=JSON.stringify(x)===JSON.stringify(y);if(!ok)bad++;console.log(n.padEnd(24),String(a).padStart(7),String(c).padStart(10),ok?'same':'DIFFERENT')};console.log('table'.padEnd(24),'A2 file','new export');for(const t of new Set(Object.keys(p.tables).concat(Object.keys(e.tables))))show(t,rows(p,t),rows(e,t),rows(p,t).length,rows(e,t).length);const sp=p.sequences||{},se=e.sequences||{};show('sequences',sp,se,Object.keys(sp).length,Object.keys(se).length);console.log('contact keys: A2 file',ck(p),'| new export',ck(e));if(ck(p)!==ck(e))bad++;console.log('exported: A2 file',p.exportedAt,'| new export',e.exportedAt+(o?' | earlier export '+o.exportedAt:''));if(e.exportedAt===p.exportedAt||(o&&!(e.exportedAt>o.exportedAt))||!(Date.now()-Date.parse(e.exportedAt)<=30*60*1000)){bad++;console.log('The second file is not a new export (the same as another file, not newer than the third file, or older than 30 minutes). Export again.')}console.log(bad?'NOT THE SAME: '+bad+' line(s) differ. Stop.':'ALL THE SAME')" D:\Backups\plannr\plannr-backup-<date>.json D:\Backups\plannr\emulator-after-enc.json D:\Backups\plannr\emulator-after-json.json
   ```

   After the rehearsal of B (A3 step 17):

   ```powershell
   node -e "const fs=require('fs');const [p,e,o]=process.argv.slice(1).map(f=>JSON.parse(fs.readFileSync(f,'utf8')));const rows=(b,t)=>(b.tables[t]||[]).filter(r=>t!=='settings'||r.key!=='last_encrypted_export_at');const ck=b=>rows(b,'settings').filter(s=>s.key==='daily_report_recipients'||s.key==='daily_report_whatsapp').map(s=>s.key).join(', ')||'none';let bad=0;const show=(n,x,y,a,c)=>{const ok=JSON.stringify(x)===JSON.stringify(y);if(!ok)bad++;console.log(n.padEnd(24),String(a).padStart(7),String(c).padStart(10),ok?'same':'DIFFERENT')};console.log('table'.padEnd(24),'A2 file','new export');for(const t of new Set(Object.keys(p.tables).concat(Object.keys(e.tables))))show(t,rows(p,t),rows(e,t),rows(p,t).length,rows(e,t).length);const sp=p.sequences||{},se=e.sequences||{};show('sequences',sp,se,Object.keys(sp).length,Object.keys(se).length);console.log('contact keys: A2 file',ck(p),'| new export',ck(e));if(ck(p)!==ck(e))bad++;console.log('exported: A2 file',p.exportedAt,'| new export',e.exportedAt+(o?' | earlier export '+o.exportedAt:''));if(e.exportedAt===p.exportedAt||(o&&!(e.exportedAt>o.exportedAt))||!(Date.now()-Date.parse(e.exportedAt)<=30*60*1000)){bad++;console.log('The second file is not a new export (the same as another file, not newer than the third file, or older than 30 minutes). Export again.')}console.log(bad?'NOT THE SAME: '+bad+' line(s) differ. Stop.':'ALL THE SAME')" D:\Backups\plannr\plannr-backup-<date>.json D:\Backups\plannr\emulator-after-update.json D:\Backups\plannr\emulator-after-enc.json
   ```

   It prints one line per table: the number of rows in the A2 file (column `A2 file`), the number
   in the new export (column `new export`), and `same` only if every row is identical. Then
   `sequences` (the last id each table handed out), the contact keys in both files, when each file
   was exported (`exported: …`, in UTC time), and last `ALL THE SAME` or `NOT THE SAME`. Two things
   may differ without counting as a difference in your data: the export time (`exportedAt`), and
   the setting `last_encrypted_export_at` (when the last encrypted backup was saved; step 9 says why
   it can differ). Every table line and the `sequences` line must say `same`, and the last line
   must be `ALL THE SAME`. If not, stop (A4).

   It uses the export times for one check: it refuses a second file that is not a new export. That
   is: one exported at the same time as the A2 file (the same file twice), one not newer than the
   third file (the export made before it), or one exported more than 30 minutes ago. Then it prints
   "The second file is not a new export…" and `NOT THE SAME`. Make the export again (step 1; an
   export changes nothing in Plannr), copy it (step 2), and compare within 30 minutes. If it still
   says so about an export you have just made, the clock of the device that made it is wrong: stop
   and ask. If `node` prints an error instead (for example, a file it cannot find), check the file
   names and run it again.

##### The file picker

Tried on this emulator on 2026-11-22 (Android 16, the `24d1d92` build), with made-up files only:

- Files copied with `adb push` to `/sdcard/Download/` are listed straight away. No media scan was
  needed.
- The picker may open on **Recent**, which says "No items". Tap ☰ (top left), then **Downloads**:
  the pushed files are listed under "Files in Downloads".
- In the picker for **Import / Restore** only `.json` files can be chosen (a `.db.enc` file is
  greyed out). The picker for **Restore from encrypted backup** lets you choose any file: choose
  the `.db.enc` one.
- After you choose, the file's name shows in the field.

Not tried yet: restoring a file chosen this way (no restore was run in that check), and a file the
size of a real backup (the made-up files were 54 bytes and 2 KB). If a file is not listed, or a
restore fails in any other way, stop and ask.

##### If a restore answers "Storage is full — …"

The restore did not go through, and nothing was changed. The rest of the message says which storage
is full:

- "… permanently delete items you no longer need from the Recycle Bin to make room." means the
  emulator's old storage (the WebView's, full at about 2.8 MB of data) is full. Do not use the
  Recycle Bin clean-up the message suggests. Use **Move to the new storage** on the emulator, as in
  check 9 step 2: in **Where your data is kept**, type a passphrase twice, tap **Move to the new
  storage**, save the backup it makes, and tap **I have the backup — continue**. The move needs
  that backup saved through the share sheet, and on this emulator the share sheet has only Quick
  Share, Drive and Gmail: if nothing there can save the file, stop and ask. After the move, do that
  restore again straight away, without `pm clear` (it would undo the move). The emulator was empty
  before the move (step 3 or 7), so the move's backup holds none of your data.
- "… This phone is out of space…" means the emulator itself has no space left: stop and ask.

#### A4. Go, or stop

- **Go to B** only if both restores and the restore in the rehearsal answered "Restored ✓", every
  figure matched after each (Home's backup banner after the encrypted restore aside, A3 step 9),
  every install on the emulator answered `Success`, and all three file comparisons ended with
  `ALL THE SAME`.
- **Otherwise stop.** Do not install anything on the phone. Keep both backups and the emulator as
  they are, and ask. Do D only once the problem is settled.

### B. Install over it

Only after A4 says go. The phone is connected, and the emulator may be running.

```powershell
adb -d install -r <APK under test>
```

It must answer `Success`. `-r` replaces the app and keeps its data. Never uninstall.

**Anything other than `Success` means stop.** That is any other answer from adb (for example
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, `INSTALL_FAILED_VERSION_DOWNGRADE`,
`INSTALL_FAILED_INSUFFICIENT_STORAGE`, "more than one device" or "no devices found"), and also no
answer (it hangs or times out), or the cable coming out during the install. Then:

- do not run it again, with the same flags or with other ones;
- do not uninstall Plannr, and do not restore anything on the phone;
- do not follow advice from the web;
- run the read-only `dumpsys` line from "What the phone has now", and write down what it prints and
  what adb answered. Its `lastUpdateTime` shows whether Plannr was replaced after all (every build
  so far has the same version numbers, so they cannot tell). Then ask ("Rules for this round").

Check 7 is skipped: Plannr keeps the INTERNET permission (owner's decision, 2026-11-15). Check 4
(airplane mode) is the offline check on the phone. Do it only after C1 passes, and follow the part
of check 4 for the phone that holds your real data: it adds, edits and deletes an entry, and
force-stops Plannr.

### C. The checks for this build

Write each result in the table "The owner's phone: the APK under test" at the end.

1. **The update keeps every entry.** Open Plannr. Every ledger, entry, category and loan is there,
   and every figure is the same as in A1 step 5.
   `adb -d shell dumpsys package com.plannr.app | findstr /R "firstInstallTime lastUpdateTime"`
   shows the old `firstInstallTime` and a new `lastUpdateTime` (an update, not a fresh install).
   The data is still in the old storage: Data Backup → **Where your data is kept** offers **Move to
   the new storage**. Leave it for now.

   Then prove the rest with a file, as on the emulator. The figures do not cover the contacts, the
   people, the custom category names, the contract services and allowances, or the settings.
   - Data Backup → section **JSON backup** → tick **Include Daily Report contacts (Gmail addresses
     & WhatsApp numbers)** → **Download JSON backup**. Save the file in **Download**, as in A1
     step 3. A JSON backup changes nothing in Plannr.
   - Copy it to the laptop by cable. The first line lists the folder with times: the new file is
     the one from a minute ago. The A1 files are still there, so its name may end in `(1).json`.
     Both lines only read the phone.

     ```powershell
     adb -d shell ls -l /sdcard/Download/
     adb -d pull "/sdcard/Download/<that file>" D:\Backups\plannr\phone-after-update.json
     ```

     If the cable does not work, use Google Drive as in A2; D then deletes the file there and from
     Drive's Trash.
   - Compare it with the A2 file, as in "After each restore: compare the files" (PowerShell, one
     line):

     ```powershell
     node -e "const fs=require('fs');const [p,e,o]=process.argv.slice(1).map(f=>JSON.parse(fs.readFileSync(f,'utf8')));const rows=(b,t)=>(b.tables[t]||[]).filter(r=>t!=='settings'||r.key!=='last_encrypted_export_at');const ck=b=>rows(b,'settings').filter(s=>s.key==='daily_report_recipients'||s.key==='daily_report_whatsapp').map(s=>s.key).join(', ')||'none';let bad=0;const show=(n,x,y,a,c)=>{const ok=JSON.stringify(x)===JSON.stringify(y);if(!ok)bad++;console.log(n.padEnd(24),String(a).padStart(7),String(c).padStart(10),ok?'same':'DIFFERENT')};console.log('table'.padEnd(24),'A2 file','new export');for(const t of new Set(Object.keys(p.tables).concat(Object.keys(e.tables))))show(t,rows(p,t),rows(e,t),rows(p,t).length,rows(e,t).length);const sp=p.sequences||{},se=e.sequences||{};show('sequences',sp,se,Object.keys(sp).length,Object.keys(se).length);console.log('contact keys: A2 file',ck(p),'| new export',ck(e));if(ck(p)!==ck(e))bad++;console.log('exported: A2 file',p.exportedAt,'| new export',e.exportedAt+(o?' | earlier export '+o.exportedAt:''));if(e.exportedAt===p.exportedAt||(o&&!(e.exportedAt>o.exportedAt))||!(Date.now()-Date.parse(e.exportedAt)<=30*60*1000)){bad++;console.log('The second file is not a new export (the same as another file, not newer than the third file, or older than 30 minutes). Export again.')}console.log(bad?'NOT THE SAME: '+bad+' line(s) differ. Stop.':'ALL THE SAME')" D:\Backups\plannr\plannr-backup-<date>.json D:\Backups\plannr\phone-after-update.json
     ```

     Every table line and the `sequences` line must say `same`, and the last line must be
     `ALL THE SAME`. If it says the second file is not a new export, export and copy it again.

   Keep `phone-after-update.json` in `D:\Backups\plannr\`: it is a backup of your data after the
   update. D deletes the copy in the phone's Download folder.

   **If C1 fails** (a figure differs, something is missing, the comparison of a new export does not
   end with `ALL THE SAME`, or Plannr does not open): stop. On the phone, do not restore any backup,
   do not tap **Move to the new storage**, and do not uninstall. Do not run C2 to C6, C9, C10 or
   `phone-test.ps1`, and do not do D. Keep the backups and the emulator as they are (the emulator
   holds your data from the rehearsal of B, A3 steps 11 to 17), and ask.
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
9. **Overview budget (F4). Look only; safe on your real data.** Open the Overview and find the
   bar under **Overall budget (optional)**. Do not type in the budget box and do not tap **Set
   budget** or **Clear**. Write down the caption on the left of the bar ("Spent ₹Z") and the label
   on the right. With a budget set, the label now reads "₹X left of total budget · Budget ₹Y" or
   "₹X over total budget · Budget ₹Y" (before this build: "₹X left · Budget ₹Y" or "Over budget
   by ₹X"); with none, "No budget set". Then, under **Date range**, tap **Edit**, choose a shorter
   range (a later "From" date) and tap **Apply**. The figures in the cards change to the range,
   but the budget bar does not: the caption reads "Spent ₹Z in total" with the same Z, the label
   is the same as before, and the bar is just as full. Tap **Edit**, then **All dates**, to go
   back. A date range only changes what the page shows; it saves nothing. The PDF's budget line follows the same
   rule; the automated tests check it (`test/f4-budget-left.test.js`), so there is no need to open
   a PDF for this.
10. **A note about the old storage (Q2). Look only; safe on your real data.** Data Backup → the
    storage section. While your data is still in the old storage (on your phone, until you move
    it), it shows: "In this storage, Android writes your saves to the phone a few seconds late. If
    Plannr is force-stopped or crashes right after you save, the last few seconds of saves can be
    lost. …". Before this build there was no such note. After the move it is gone.
11. **Backup check (Q9). Test backups only**, as in C7. Copy a test JSON backup. In a text editor,
    in the `"sequences"` section near the end, add `"settings": 5` (with a comma if another entry
    comes before it). Restore the copy with **Import / Restore**: it is refused with "sequences:
    settings has no id column, so it cannot have a sequence.", and nothing changes. The unchanged
    test backup still restores.

Not checked by hand in this round (they need a keyboard, a screen reader, test data, a forced
failure or a damaged database); the automated tests cover them: the dialog focus (F18,
`npm run test:modal-focus`), the screen-reader names in the bulk-edit table
(`test/c-a11y-labels.test.js`), "Move data back" (Q4, `test/q4-move-back-room.test.js`), the
move snapshots (Q12, `test/q12-move-snapshots.test.js`), an entry and its custom name in one
transaction (Q14, `test/q14-ledger-custom-atomic.test.js`) and the start-up message for a database
that cannot be read (Q13, `test-ui/backup-roundtrip.js`).

### D. Afterwards: clear your data from the emulator

Once C1 has passed (the update kept everything on the phone), the copy of your data on the emulator
has done its job. It is your data, so remove it. If the round stopped at A4 or C1, do D only once
the problem is settled.

1. On the emulator (PowerShell):

   ```powershell
   adb -s emulator-5554 shell pm clear com.plannr.app
   adb -s emulator-5554 shell ls /sdcard/Download/
   adb -s emulator-5554 shell rm "'/sdcard/Download/<one Plannr backup file it lists>'"
   adb -s emulator-5554 shell bmgr list transports
   ```

   `pm clear` deletes everything the emulator's Plannr holds: your data, the safety copies the
   restores made of the data before them, and the JSON files the comparisons left in its cache
   folder. Run the `rm` line once for each Plannr backup file that `ls` lists (the two pushed in A3,
   and any other). Keep both kinds of quotes as shown: the emulator's shell needs the inner ones for
   a name with spaces or brackets, such as `plannr-backup-2026-11-23 (1).json`. Then run the `ls`
   line again: no Plannr file is left.

   `bmgr list transports` shows which backup service Android uses: the one with `*` in front. If it
   is `com.android.localtransport/.LocalTransport`, Android may have backed up Plannr on the
   emulator itself. Erase that copy with
   `adb -s emulator-5554 shell bmgr wipe com.android.localtransport/.LocalTransport com.plannr.app`.
   If it is Google's (`com.google.android.gms/.backup.BackupTransportService`) and the emulator has
   no Google account, as on 2026-11-22, nothing was backed up.
2. On the laptop, delete the emulator's exports from A3. They hold your contacts unencrypted:

   ```powershell
   Remove-Item D:\Backups\plannr\emulator-after-json.json, D:\Backups\plannr\emulator-after-enc.json, D:\Backups\plannr\emulator-after-update.json
   ```

   Keep `phone-after-update.json` (C1) and `phone-current.apk`: the first is one of your backups,
   the second is only the app.

   If you made the readable copy in A2 (the optional first look) and it is still there, delete it
   too: `Remove-Item $env:TEMP\plannr-check.db`. If you used Google Drive (A2 or C1), also delete
   any Plannr backup left in the browser's **Downloads** folder (the copies in
   `D:\Backups\plannr\` stay).
3. On the phone, delete every Plannr backup and export you saved in the **Download** folder during
   this round (with the phone's Files app): the two backups from A1, any you made again (A1 or A2),
   and the JSON export from C1. If you used Google Drive for any of them (A2 or C1), delete
   them there, then also from Drive's **Trash** (called **Bin** in some languages; there, **Delete
   forever**): Drive keeps a deleted file there for 30 days. Keep the copies in
   `D:\Backups\plannr\` for good.
4. **Quick Boot.** When the emulator closes, Quick Boot saves its memory to the laptop, and from A3
   to D that memory can hold your data. That is why A3 starts the emulator with
   `-no-snapshot-save`. If it was closed with Quick Boot in that time, or if you want no trace left
   at all, wipe it after D: Android Studio → **Device Manager** → the emulator's ⋮ menu → **Wipe
   Data**. That also removes Plannr and its test data from the emulator: install the APK again
   before the test checks.

After step 1, Plannr stays installed on the emulator and opens as a fresh install. Add test data
again before the test checks.

## The debug to release switch round (the owner's phone, once)

The owner's decision (`docs/release-plan.md` §6, which explains each step): the owner's phone
moves from the debug build to the release build once, by this round. The owner does every step by
hand; nothing is automated. This round is the **only** time Plannr is uninstalled on that phone
(step 3), and step 5 is the only restore on that phone. Outside this round, every rule above
stays: never uninstall, and no restore on the phone.

Before you start: the release APK is built (`npm run release:android`, `docs/RELEASE.md`), and
you have the release certificate SHA-256 you wrote down (`docs/release-plan.md` §1.3). Use that
one APK file on the emulator and on the phone.

**Stop rules.** Any mismatch, error or missing item in step 2 means **stop: do not uninstall
anything on the phone**. Keep both backups and ask. Any adb answer other than `Success` means
stop and ask. From step 1 until step 6 passes, change nothing in Plannr on the phone.

1. **Back up, and copy both files off the phone.**
   - [ ] Data Backup → **Download encrypted backup** (the passphrase is in your password manager).
   - [ ] Tick **Include Daily Report contacts**, then **Download JSON backup**.
   - [ ] Both files copied off the phone to two places (for example `D:\Backups\plannr\` and a USB
         stick). No file is 0 bytes.
   - [ ] Figures written down: ledgers, people, categories, one ledger's entry count and total,
         the newest three entries (date, amount, reason), the budget on Overview, the storage
         figure on Data Backup.
2. **Prove the restore on the emulator** (the release APK, `emulator-5554` only; start it with
   `-no-snapshot-save`, as A3 says).
   - [ ] `adb -s emulator-5554 uninstall com.plannr.app`, then
         `adb -s emulator-5554 install <release APK>`: `Success`.
   - [ ] Both files pushed to the emulator's Download folder (A3 step 2).
   - [ ] Encrypted backup restored: every figure from step 1 and the newest entries match the
         phone.
   - [ ] `adb -s emulator-5554 shell pm clear com.plannr.app`, then the JSON backup restored:
         every figure and the newest entries match again.
   - [ ] Everything matched. If not: **stop here**, do not uninstall on the phone, and ask.
3. **Uninstall the debug app on the phone.**
   - [ ] Android Settings → Apps → Plannr → Uninstall. This erases the phone's copy of the data:
         from now on, the two backup copies are the only copy.
4. **Install the release APK.**
   - [ ] `apksigner verify --print-certs <release APK>` prints the release certificate SHA-256
         you wrote down, not `fd12f081…b95629` (the debug key).
   - [ ] `adb -d install <release APK>`: `Success`.
5. **Restore.**
   - [ ] Data Backup → **Restore from encrypted backup**, the file from step 1: "Restored ✓". If
         it fails, **Import / Restore** with the JSON backup. If both fail: stop and ask; do not
         uninstall again.
6. **Verify on the phone.**
   - [ ] The counts and the ledger's total match step 1.
   - [ ] The newest three entries are there.
   - [ ] The budget on Overview is the same.
   - [ ] Overview → **Download PDF** makes a PDF that opens.
   - [ ] A new test entry: added, still there after closing Plannr fully and opening it again,
         then deleted.
   - [ ] Home shows the **Backup reminder**.
   - [ ] Your data cleared from the emulator, as D above.

After the round, the phone runs the release build. Its updates are release APKs installed with
`adb -d install -r` (`docs/RELEASE.md`), never with an uninstall. Debug builds no longer install
on it, and the laptop's debug key is no longer needed for it. In later rounds, the APK under test
is a release APK, and its certificate must be the release one, not `fd12f081…b95629`.

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
does not prove a particular phone maker's WebView or a real Google Drive backup. When you have a
phone that does not hold your real data, repeat checks 2, 5 and 6 on it with test data. That is not
a condition for your own phone. There the decision of 2026-11-22 applies ("Decided: install over
the real data, with proof first", above): the proof is on the emulator (A3), check 5 is C1 on your
real data, and checks 2 and 6 never run on it while it holds your real data.

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

**On the phone that holds your real data** (only after C1 passes):
- For the add, edit and delete, use one clearly named test entry (for example ₹1 with the reason
  "TEST – delete me"), and change nothing else. After you delete it, it stays in the Recycle Bin:
  leave it there, or permanently delete that one entry.
- Before each force-stop or restart, wait a minute after your last change. While the data is in the
  old storage, a kill can lose the last few seconds of saves (the known limit under Results).
- After the reminder has fired, remove the test time: Home → **Daily report reminders** → **Remove**
  next to it.
- If you would rather add no test entry, do only the other parts: every page opens, the PDF export
  and the backup exports.

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
- [ ] For a real release, repeat with the signed release APK, following `docs/RELEASE.md`. A
      release APK cannot be installed over a debug build (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`).
      The owner's real-data phone, which has a debug build, moves to the release key only by
      "The debug to release switch round" above: never uninstall it to get past this error.

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
   **Download JSON backup** (with **Include Daily Report contacts** ticked, as in A1). Save both in
   **Download** and copy them to the PC with `adb -d pull`, as in A2 (the JSON holds your contacts
   unencrypted). Use Google Drive only if the cable does not work; then, once they are on the PC,
   delete them from Drive and from Drive's Trash. Check on the PC that the encrypted one opens. In
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
   with steps A and B above (the backups, the restore proof and the rehearsal of B on the emulator,
   A4, then `adb -d install -r <APK under test>`). Uninstalling deletes the data. If Android answers
   anything other than `Success`, stop and ask (B). `INSTALL_FAILED_UPDATE_INCOMPATIBLE` means the
   phone has a build signed with another key.
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

**Still needs a real phone** (2, 3 and 6 only on a phone with test data, never on the phone that
holds your real data: "Rules for this round"):
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

**Still needs a real phone (step 1.4):** check 9 with test data on a phone that does not hold your
real data, then the real data with the steps in "Moving your real data", after checks 0, 2, 3, 5
and 6 pass on this build (2, 3 and 6 also only with test data, never on the phone that holds your
real data). This note is a record of that day; for installing over your real data, "Rules for this
round" and steps A and B decide.

### Emulator, 2026-11-21: the step 1.4 RC, debug build from `53db636`

Same emulator and method as above, with the RC (`1c54c4c8…e1f0`).

| Run | What | Result | Numbers / notes |
|---|---|---|---|
| E1 | Update from `9d7fd97` with 1,000 typical entries, then the move | Pass (16) | Every row kept by the update, on `localStorage`; encrypted backup 12.3 s, move 10.3 s; marker `native-v1`, 1,229 rows checked; every table matches; a save goes to the file and not to the old copy; the meter and the panel as in the 5736195 run. The Data Backup page took 13.8 s to fill after a reload; the 5736195 build took 13–15 s on the same data that day, so the emulator was slow, not the RC (the first run read the page at 2.5 s and failed those two checks; the script now waits for the page). |
| E6 | Move back, move again, delete the old copy (update from `9d7fd97`, then the RC) | Pass (27) | Moved back: on `localStorage`, every row, the marker `localstorage-v1` with the time, the database file kept, the page says so; a save goes to `localStorage` (and a save killed at once was kept this time). Moved again: every row, the save included, marker `native-v1`, old copy kept; on the file a save survives an immediate kill. Deleting the old copy is refused until an encrypted backup is saved after the move; then it is deleted (0.4 MB freed), no `localStorage` copy left, the marker records it, the Google backup estimate is the file alone, and the meter and panel stop counting an old copy. Run 2 stopped after 11 passing checks on a script race (the page navigated while the script read it after a force-stop); the script's page open now retries, app unchanged. |
| `phone-test.ps1` | The owner's script, run against the emulator (`-Serial emulator-5554`, test data) | S, 1, 2, 3 pass; 4 and 8 fail | After `986ac78` (a tap waits until the element stops moving; longer waits). On the data E1 left (moved: the database file, 1,229 rows in 14 tables, old copy kept). 1: data location and sizes. S: storage in use. 2: the meter ("Your data file is 0.4 MB…"). 3: the JSON backup opens the share sheet and BACK closes it. "4 Home opens offline" was marked FAIL, but its screenshot shows Home open in airplane mode with no error text, still filling ("WELCOME, …"), so most likely the script read the screen too early on the slow emulator; the real phone's check 4 decides (decision 47 in the session report). **The PDF checks (4, 8) fail:** the app's own 25 s PDF limit ran out ("the native print adapter did not respond"), also when driven through Playwright. The PDF path is unchanged since `5736195`, where both passed; the emulator was slow that day (the Data Backup page took 13–15 s to fill on both builds), so this is recorded as finding E1 (measure the PDF time on the real phone), not an RC fault. |

**Not automatable on the emulator, so still for a real phone:** 0 (the phone's own details), the real `localStorage` limit in 2, 4 on a real phone's print service, 5 over the build that is on the phone now, 6 with a real Google account, and 9 with your hands on the device. On a real phone, checks 2, 6 and 9 only with test data, never on the phone that holds your real data ("Rules for this round").

### The owner's phone: the APK under test

Not yet run. Step A comes first: both backups made on the phone, copied to the laptop, both
restored on the emulator and compared, and B rehearsed there. Step B (the install) only if all of
that matches. The step 1.4 RC (`53db636`) was never run on the phone; the APK under test replaces
it.
Checks 2, 3, 6, 9, C7, C8 and C11 need test data: on a phone that holds your real data they cannot
run without uninstalling or restoring, so run them on another device or the emulator (after D),
never here. Check 0, C1 to C6, C9, C10, check 4 (its part for the phone that holds your real data,
after C1) and S run on this phone. The APK under test must be a fresh build from `main` after PR #3,
not the old example (`24d1d92`) at the top.

APK under test (copy it from the box at the top). File: . SHA-256: . Built from commit: .
Signing certificate SHA-256: .

Date tested:

| Check | Expected | Result | Notes |
|---|---|---|---|
| What was installed before | versionName, versionCode, `firstInstallTime`; SHA-256 of `phone-current.apk` (for `9d7fd97`: `7dc29db3…a2ef`); certificate SHA-256 the same as the APK under test's (for `9d7fd97`: `fd12f081…b95629`) | | |
| A. Backups made | Encrypted and JSON backups (with **Include Daily Report contacts** ticked) made on the phone and copied to the laptop; the figures from A1 step 5 written down; the JSON has `"schemaVersion": 2`, and the row counts and contact keys from A2 | | |
| Restore proof on the emulator: JSON | Same APK as the phone gets; `pm clear` first; "Restored ✓" with the numbers from A2 (they only show the right file was chosen); no person missing; every figure from A1 step 5 matches exactly; the comparison of `emulator-after-json.json` with the phone's JSON ends with `ALL THE SAME` | | |
| Restore proof on the emulator: encrypted | Same APK; `pm clear` first; "Restored ✓" and the page reloads; every figure from A1 step 5 matches exactly (Home's backup banner may differ, A3 step 9); the comparison line for the encrypted restore (`emulator-after-enc.json`, then `emulator-after-json.json`) ends with `ALL THE SAME` | | |
| Rehearsal of B on the emulator | `pm clear` first; the phone's own APK (`phone-current.apk`, the hash above) installed with `install -r`: `Success`; the JSON restored with it: "Restored ✓", no person missing; the APK under test installed over it: `Success`; still in the old storage; every figure from A1 step 5 matches exactly; the comparison line for the rehearsal (`emulator-after-update.json`, then `emulator-after-enc.json`) ends with `ALL THE SAME` | | |
| B. Install over it | Only after both restore proofs and the rehearsal passed; `adb -d install -r <APK under test>` answers `Success` (anything else: stopped and asked); no uninstall | | |
| C1. Update keeps every entry (5) | Every figure the same as in A1 step 5; `firstInstallTime` unchanged; the comparison of `phone-after-update.json` (contacts ticked) with the A2 file ends with `ALL THE SAME` | | |
| C2. CSV export (F2) | One share sheet with all the CSV files; BACK says nothing was saved; saved files open | | |
| C3. PDF time (E1) | Share sheet opens well under 25 s; write down both times | | |
| C4. Overview loading (F3) | "…" while loading, never ₹0.00; a failed load shows "—" and says so | | |
| C5. Home (F5) | No "First login — welcome." line | | |
| C6. No biometric permission (S7) | No `USE_BIOMETRIC` or `USE_FINGERPRINT` | | |
| C7. Restore rollback (S3/Q6), test backups only | A good test restore works and writes a safety snapshot; a failed one says "Nothing was changed" and the data is as before | | |
| C8. Strict import (F1), test backups only | A backup with a code like `"22"` is refused and nothing changes; the unchanged backup restores | | |
| C9. Overview budget (F4), look only | Label "₹X left of total budget · Budget ₹Y" (or "over total budget"), or "No budget set"; with a shorter range applied, the caption says "Spent ₹Z in total" with the same Z, and the label and the bar do not change | | |
| C10. Old-storage note (Q2), look only | Data Backup's storage section shows the note that the last few seconds of saves can be lost | | |
| C11. Backup check (Q9), test backups only | A backup with `"settings"` in `sequences` is refused ("… has no id column …") and nothing changes; the unchanged backup restores | | |
| D. Your data cleared from the emulator | After C1: `pm clear` done; every Plannr file deleted from the emulator's Download folder; no local-transport backup left (`bmgr`); `emulator-after-json.json`, `emulator-after-enc.json`, `emulator-after-update.json` and any `plannr-check.db` deleted from the laptop; every Plannr backup and export from this round deleted from the phone's Download folder (A1, any made again, C1), and from Google Drive and its Trash and the laptop's browser Downloads folder if Drive was used; the backups (`phone-after-update.json` included) kept in `D:\Backups\plannr\` | | |
| 0. Phone, Android, WebView version | Written down | | |
| 2. Meter; real `localStorage` limit (fresh test install only; not on this phone while it holds real data) | Meter shown; limit about 5,242,880 characters | | |
| 3. JSON + encrypted export/restore (test data; not on this phone while it holds real data) | Both files saved and restored; a wrong passphrase changes nothing | | |
| 4. Airplane mode | Every page opens offline; PDF and backups work; a reminder fires | | |
| 6. Auto Backup (test install only; never on this phone while it holds real data) | `bmgr backupnow` says `Success`; data comes back after a reinstall | | |
| 7. Without INTERNET | skipped (decision, 2026-11-15) | skipped | |
| S. Storage check (`phone-test.ps1 -AllowExisting`, with `-Serial` as in C3) | Which storage is in use; file sizes | | |
| 9. The storage move: test data on another device or the emulator, then real data on this phone with its own steps ("Moving your real data") | All tables match; totals the same; old copy kept | | |
