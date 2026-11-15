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
- [ ] A payment-due reminder notification still fires (set one a few minutes ahead).

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
- [ ] Note the size, if shown: `adb shell dumpsys backup | grep -i -A3 plannr`.

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

## Results

| # | Check | Result | Numbers / notes |
|---|---|---|---|
| 0 | Phone, Android, WebView version | | |
| 1 | Data location and sizes | | |
| 2 | Meter; real `localStorage` limit | | |
| 3 | JSON + encrypted export/restore with categories | | |
| 4 | Airplane mode | | |
| 5 | Update over old version | | |
| 6 | Auto Backup (`bmgr backupnow`, uninstall, reinstall) | | |
| 7 | Without INTERNET | | |
