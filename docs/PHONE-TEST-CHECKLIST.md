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

## The build for this round (real phone, 2026-11-15)

| | |
|---|---|
| Branch / commit | `plannr-phase2`, built from `9d7fd97` (cross-platform plan steps 1.1 and 1.2) |
| File | `android/app/build/outputs/apk/debug/Plannr-debug.apk` |
| Size | 5,988,128 bytes |
| SHA-256 | `5e304ebd31c481b2555455b42b379c45309161c2dc8326813eec65cca588a1af` |
| Version | versionCode 1, versionName 1.0; debug-signed |
| INTERNET permission | still present (removing it is the separate branch `plannr-no-internet`) |

**This round uses test data only.** Do not restore your real backup on the phone yet; that comes
after these checks pass and you approve it.

Install it:

1. On the phone: Settings → About phone → tap **Build number** 7 times; then Settings → System →
   Developer options → turn on **USB debugging**. Connect the phone by USB and allow the PC when
   asked.
2. On the PC, `adb devices` lists the phone as `device` (not `unauthorized`). `adb` is in the
   Android SDK's `platform-tools` folder.
3. `adb install -r android/app/build/outputs/apk/debug/Plannr-debug.apk`

If Android answers `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, a Plannr signed with another key (a
release build) is already on the phone. Uninstalling it deletes its data: if it holds anything you
need, export both backups off the phone first, or stop and ask.

Check 7 needs a build without the INTERNET permission, so it cannot be done with this APK. Leave
its row empty this round.

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

## 2. Storage meter, and the real limit ⚠ (fills storage — test install only)

1. Data Backup page: note the storage line ("… of about 10 MB") and the bar.
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
- [ ] The safety snapshots came back too (`run-as … ls files/safety-snapshots`).

If the data does not come back, restore the exported backup on the Data Backup page.

## 7. Does anything need the INTERNET permission? (test only — do not commit)

Plannr makes no network requests: no page loads anything from outside the app (checked:
`public/` has no external URLs), and the app is served from inside the APK. Capacitor's template
adds the permission anyway. To test without it, in a throwaway local change:

1. Delete the line `<uses-permission android:name="android.permission.INTERNET" />` from
   `android/app/src/main/AndroidManifest.xml`.
2. Build a debug APK and install it over the current debug build.
3. `adb shell dumpsys package com.plannr.app | grep -i "android.permission.INTERNET"` prints
   nothing.

- [ ] The app opens and every page loads.
- [ ] Add/edit/delete, backups (export and restore), PDF export and share, notifications all work.
- [ ] Nothing in `adb logcat | grep -i -E "ERR_|net::|SecurityException"` while doing this.

Then **undo the change** (`git checkout android/app/src/main/AndroidManifest.xml`) and report the
result. Removing the permission for real is a separate decision.

## 8. What changed in this build (plan steps 1.1 and 1.2)

Most of it is invisible in the app (the same request rules as the dev server, covered by the
automated tests). Two things to look at:

- [ ] **PDF total row.** Add three or four entries, then Overview → export the full PDF. In the
      Transactions table, the **Total (n)** row ends at the same right edge as the rows above it.
      Before this build it had one extra empty cell sticking out on the right.
- [ ] **Restores still fit.** Restores now have a 20 MB limit (the app's whole storage is about
      10 MB, so a real backup is far below it). In check 3, note the encrypted file's size; the
      encrypted restore must still work.

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
lost; the database stays consistent (`docs/storage-proposal.md`).

### The owner's phone: debug build from `9d7fd97` (SHA-256 `5e304ebd…a1af`)

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
| 7 | Without INTERNET | not in this build | needs the `plannr-no-internet` build |
| 8 | This build's changes (PDF total row, restores still fit) | | |
