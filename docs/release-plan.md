# Plan: publishing a public release APK safely

Status (2026-11-23): **a plan, partly built.** Decided by the owner on 2026-11-22 and done since:
the release key is out of the project, in `D:\Keys\plannr\` (section 1.2), and
`npm run release:android` checks the key before it builds; the first public `versionName` is
`1.0.0`, and the script makes it from today's `1.0` (section 2). CI runs the tests on every pull
request into `main` and `plannr-phase3` (`.github/workflows/tests.yml`). Still open: the owner's
second offline backup copy of the key (section 1.3), the owner's phone's one-time switch from
the debug build to the release build (decided, not done yet: section 6), and the first public
release itself. Nothing else here changes a signing setting or a signing file. Written
2026-11-22.

This page is about the first **public** release: an APK anyone can download from a GitHub Release.
The step-by-step build and install routine for every release is already in
[`docs/RELEASE.md`](RELEASE.md), and the build itself is done by
[`release-android.js`](../release-android.js) (`npm run release:android`). This page does not repeat
them. It adds what a public release needs on top: a release key you own, version rules, moving
people off the debug build, the release notes, and a checklist.

## 1. The release signing key

Android only installs an update over an app when both are signed with the **same key**. The key is
therefore the app's identity. Lose it and no update can ever be installed over the app again.

### 1.1 Make one (free, on your own computer)

**First check whether a key already exists** (see "A key already exists" below). Making a
second key changes the app's identity. Only if there is none:

A release key costs nothing. `keytool` comes with the Java that Android Studio ships (on Windows
usually `C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe`; use that full path if
`keytool` alone is not found). The key goes straight into its own folder outside the project,
`D:\Keys\plannr\` (section 1.2). On a PC with only `C:`, use `C:\Keys\plannr\` in both lines
instead, because the key folder must be on the same drive as the project. In Command Prompt or
PowerShell, first make the folder, then the key:

```bat
mkdir D:\Keys\plannr
keytool -genkeypair -v -storetype PKCS12 -keystore D:\Keys\plannr\plannr-release.keystore -alias plannr -keyalg RSA -keysize 4096 -validity 10000
```

- If `mkdir` says the folder already exists, stop and look in it: a key may already be there
  ("A key already exists" below).
- `keytool` asks for a keystore password, then your name and place (these go into the certificate
  and are public once the APK is shared; a project name is enough), then confirms.
- `-validity 10000` is about 27 years. The key must outlive every update you will ever ship.
- Choose long, random passwords and put them straight into a password manager (1.3).
- Then create `keystore.properties` in the project root with the two entries from `SETUP.md` §2
  (`storeFile` and `keyAlias`; the passwords are never in a file, the release build asks for them).
  Its `storeFile` line is the key's path relative to the project root
  (`storeFile=../../Keys/plannr/plannr-release.keystore` for a checkout at `D:\Projects\Plannr`;
  `SETUP.md` §2 explains it and says how to save the file without a byte-order mark).
  `npm run release:android -- --dry-run` then prints "Signing: release key at ..." if the key is
  where the line says.

**A key already exists.** This laptop has `plannr-release.keystore`, now in `D:\Keys\plannr\`
(section 1.2), and `keystore.properties` in the project root. Both file types stay git-ignored
(`.gitignore`: `*.keystore`, `*.jks`, `*.p12`, `*.pem`, `keystore.properties`). Never open them,
print them, paste
them anywhere or commit them. To check that they are there, list the folder; do not look inside.
If a release has ever been installed on a phone with that key, **keep using it**: a new key cannot
update those installs.

### 1.2 Where to keep it

- **Outside the repository.** Never in git, not even in a private branch. `test/release-guards.test.js`
  fails if the key or its properties file could be committed; do not weaken that test.
- **Outside cloud-synced folders.** Not in OneDrive, Google Drive, Dropbox, or a synced
  Documents/Desktop folder. A synced copy is a copy you do not control.
- How the build finds it: `android/app/build.gradle` reads `keystore.properties` from the project
  root and joins its `storeFile` value to the project root (`new File(projectRootDir, ...)` in the
  `signingConfigs.release` block). `SETUP.md` §2 describes the file's two entries (the store file
  and the alias). The two passwords come from `PLANNR_STORE_PASSWORD` and `PLANNR_KEY_PASSWORD`,
  which `npm run release:android` sets for the Gradle run only, from the environment or a hidden
  prompt (since 2026-11-25; a file that still has password lines stops the release, and the
  owner decided to keep that stop: section 6).
- **Where it is now (owner decision, 2026-11-22):** the key is in `D:\Keys\plannr\`, a folder of
  its own outside the project and outside git. `keystore.properties` stays in the project root
  (git-ignored), and its `storeFile` line is the path relative to the project root:
  `../../Keys/plannr/plannr-release.keystore` for a checkout at `D:\Projects\Plannr`. It has to be
  relative because `build.gradle` joins it to the project root; an absolute `D:\...` path does not
  work there. A relative path cannot change drive, so the key folder must be on the same drive as
  the project: on a PC with only `C:`, use `C:\Keys\plannr\` and a checkout under `C:\`
  (`SETUP.md` §2). Gradle's `signingReport` confirmed that it opens the key at the new place.
  `npm run release:android` checks that the key file is there before it builds (it reads only the
  `storeFile` line) and stops, naming the path, if it is not.
- `.gitignore` still blocks key files (`*.keystore`, `*.jks`, `*.p12`, `*.pem`,
  `keystore.properties`), so a copy put back into the project by mistake still cannot be
  committed. `test/release-guards.test.js` checks this.
- After any change to where the key is, build once and print the certificate with
  `apksigner verify --print-certs <the APK>` (in the Android SDK's `build-tools\<version>\`
  folder): it must print the same certificate SHA-256 as before. (Do not use
  `keytool -printcert -jarfile` for this: it reads only the old v1 signature. With
  `minSdkVersion` 24 the build may sign with v2/v3 only, and then it prints "Not a signed jar
  file" for a correctly signed APK. That does not mean the key is broken: never make a new key
  because of it.)

### 1.3 Back it up

- The copy in `D:\Keys\plannr\` is the working copy on the laptop's disk, not a backup.
- **Two offline copies** of `plannr-release.keystore`, for example on two USB sticks kept in two
  different places. If only one backup copy exists today, make the second one now. Check that each
  copy opens: `keytool -list -keystore <copy>` asks for the store password and lists the key's entry
  (its alias).
- **Both passwords and the alias in a password manager.** A key without its passwords is as lost as
  no key.
- Write down the certificate's SHA-256 fingerprint (printed by `apksigner verify --print-certs` on
  a signed APK). It is public, and it lets anyone check that a later APK came from the same key.
- Never e-mail the key, never put it in a chat, never in git, never in a cloud folder.

### 1.4 If the key is lost

- No update can be installed over the app any more. Android refuses it
  (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`).
- Every user would have to back up their data, **uninstall** (which deletes the app's data), install
  an APK signed with a new key and restore their backup: the same steps as section 3.
- There is no way to recover a lost key. The backups in 1.3 are the only protection.

## 2. Version numbers

The current values in `android/app/build.gradle` (`defaultConfig`) are `versionCode 1` and
`versionName "1.0"`.

- **`versionCode`** is a whole number that Android compares. It only ever goes **up**, by exactly 1
  for each build you publish. Android refuses an APK whose `versionCode` is not higher than the
  installed one (`INSTALL_FAILED_VERSION_DOWNGRADE`). Never reuse a number, even for a build you
  withdrew. `npm run release:android` adds 1 (`bumpVersions()` in `release-android.js`).
- **`versionName`** is the text people see. Use semantic versions, `MAJOR.MINOR.PATCH`:
  - PATCH (1.0.0 → 1.0.1): fixes only.
  - MINOR (1.0.1 → 1.1.0): new features; old backups still restore.
  - MAJOR (1.1.0 → 2.0.0): a change people must act on (for example a new install path).
- **Decided (owner, 2026-11-22): the first public `versionName` is `1.0.0`**, and `versionCode`
  keeps going up by 1 for every published build, never reused.
- The script's automatic bump (`nextVersionName()` in `release-android.js`) turns a two-part name
  into the first three-part one, `1.0` → `1.0.0`, and after that adds 1 to the **last** (patch)
  number: `1.0.0` → `1.0.1`, `1.2.9` → `1.2.10`. Any other form must be given with
  `--version-name`. So:
  - the first public release: plain `npm run release:android` (versionName 1.0 → 1.0.0,
    versionCode 1 → 2);
  - a patch release after that: `npm run release:android` (1.0.0 → 1.0.1);
  - a minor or major release: pass `--version-name 1.1.0` or `--version-name 2.0.0`.
- Use the same name for the git tag, with a `v`: `v1.0.0`.

## 3. Moving from the debug build to the release build

The APK people have today may be a **debug** build (`Plannr-debug.apk`), signed with the Android
debug key. The release build is signed with the release key. The keys differ, so Android **refuses
to install the release APK over the debug app**, and uninstalling the debug app **deletes all its
data**. The only safe way across is a backup.

> **Not for the owner's real-data phone.** That phone runs a debug build (debug key) and holds the
> only live copy of the real data. A release APK installed over it fails with
> `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. It moves to the release key once, by the **switch round**
> in section 6 (owner's decision), which proves the restore on the emulator before anything is
> uninstalled. Until that round is done, that phone follows `docs/PHONE-TEST-CHECKLIST.md`: debug
> builds only, both backups proven on the emulator first (A1 to A4), then `adb -d install -r`,
> never uninstall, and stop on any answer other than `Success`.

The steps below are for other people who have a debug build. Tell each of them to do these steps,
in this order. The button names are the ones on the **Data Backup** page
(`public/data-backup.html`).

1. **Make an encrypted backup.** Open Plannr → **Data Backup** → **Download encrypted backup**.
   Type a passphrase of at least 10 characters, twice, and remember it. The file is the whole
   database, encrypted.
2. **Also make a JSON backup**: tick **Include Daily Report contacts**, then **Download JSON
   backup** on the same page. It is a second copy that needs no passphrase. Without the tick it
   leaves out the report contacts. It is not encrypted: delete it from any drive or e-mail once
   the move is done.
3. **Save both files off the phone**: share them to a computer, a drive or an e-mail to yourself.
4. **Check the files**: both are there off the phone and neither is 0 bytes. **Prove the encrypted
   one opens with your passphrase before you uninstall anything**: on the PC, in the Plannr folder,
   set `PLANNR_BACKUP_PASSPHRASE` and run `node decrypt-db.js <the .db.enc file> <a temp folder>\check.db`
   (it refuses to write over `data/plannr.db`); it must print the sizes. Delete `check.db` afterwards
   (it is your data, unencrypted). Open the JSON in a text editor: it starts with `{` and has
   `"kind": "plannr-backup"`. Keep the old debug APK too, so it can be put back if the release
   restore fails. Note a few numbers to compare later: the number of ledgers, one ledger's total,
   the storage figure on Data Backup.
5. **Uninstall the debug app** (Android Settings → Apps → Plannr → Uninstall). This deletes the
   data on the phone; the backup files from step 3 are now the only copy.
6. **Install the release APK** (open `Plannr.apk` on the phone; Android warns about an app from
   outside the Play Store, see `SETUP.md` §4).
7. **Restore**: open Plannr → **Data Backup** → **Restore from encrypted backup**, choose the file
   from step 1 (a `.enc` file) and type its passphrase. If that fails, use **Import / Restore** with the JSON backup
   from step 2.
8. **Check the data**: the same ledgers, the same total for the ledger you noted, people,
   categories and the Daily Report contacts are there, the storage figure is about the same. Add a test entry, close the app
   fully, open it again, check the entry is there, then delete it.

Do not rely on Android's own Auto Backup to carry the data across this move; use the files from
steps 1 to 3. After this one-time move, every later update installs **over** the release app with
no uninstall, as `docs/RELEASE.md` describes.

## 4. GitHub Release notes (draft template)

Make the release as a **draft** first, attach `Plannr.apk`, and publish only after the checklist in
section 5 is done. The "How to update" lines are for other people. They do not cover the owner's
real-data phone: see the note at the top of section 3.

```markdown
## Plannr vX.Y.Z

### What's new
- <one line per user-visible change, from CHANGELOG.md>

### How to update
- **Already on a release build (vA.B.C or later):** download `Plannr.apk` and open it on the phone.
  Android offers to *update*. Do not uninstall first.
- **On the old debug build (`Plannr-debug.apk`):** Android cannot update it to this version. Follow
  "Moving from the debug build" in docs/release-plan.md: back up, uninstall, install, restore.
- Before any update: Data Backup → Download encrypted backup, and keep the file off the phone.

### Check the download
- `Plannr.apk` SHA-256: `<64 hex characters>`
  (Windows: `certutil -hashfile Plannr.apk SHA256`; macOS/Linux: `shasum -a 256 Plannr.apk`)
- Signing certificate SHA-256: `<from apksigner verify --print-certs>` (the same for every release)

### Known issues
- <anything not fixed yet, with a workaround if there is one>
- Android shows a warning for apps installed from outside the Play Store. This is expected.
```

## 5. Pre-release checklist

- [ ] All work for this release is merged into `main`, and CI is green on `main`.
- [ ] `CHANGELOG.md` has an entry for this version (moved out of "In review" / "Merged into main").
- [ ] The release key is at `D:\Keys\plannr\plannr-release.keystore` (`C:\Keys\plannr\...` on a
      PC with only `C:`), `keystore.properties` is in the project root, and neither is staged
      (`git status` shows neither).
- [ ] Two offline backup copies of the key exist, and both passwords and the alias are in a
      password manager (section 1.3).
- [ ] `npm run release:android -- --dry-run` shows the expected `versionCode` (+1) and
      `versionName`, and "Signing: release key at D:\Keys\plannr\plannr-release.keystore"
      (`C:\Keys\plannr\plannr-release.keystore` on a PC with only `C:`).
- [ ] `npm run release:android` (with `--version-name` if needed) finished: every test passed and
      the APK was built.
- [ ] `apksigner verify --print-certs android/app/build/outputs/apk/release/Plannr.apk` prints the
      same certificate SHA-256 as the last release, and its "certificate DN" line
      (`Signer #1 certificate DN: CN=...`) has nothing personal in it.
- [ ] The APK's own SHA-256 is computed and pasted into the release notes.
- [ ] Installed **over** the previous release on a test phone or emulator: the data is still there
      (`docs/RELEASE.md` §3 and §4). For the first release: the debug-to-release steps of section 3
      tried once, end to end, on an emulator with test data.
- [ ] The phone checks that apply are done (`docs/PHONE-TEST-CHECKLIST.md`).
- [ ] The version bump is committed and tagged `vX.Y.Z`.
- [ ] The GitHub Release draft has the notes from section 4, `Plannr.apk` attached, and is then
      published.
- [ ] Nothing personal in the notes or the attached files (no names, e-mail addresses or local
      paths).

## 6. Decisions: the owner's phone

1. **Decided: the owner's phone moves from the debug build to the release build once, by the
   switch round below** (owner's decision, dated 2026-11-28). The phone runs the debug build
   (debug key) and holds the only live copy of the real data. A release APK cannot be installed
   over a debug-key app: Android answers `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. So the round backs
   the data up, proves the restore on the emulator, and only then uninstalls the debug app,
   installs the release APK and restores. The other ways named before were not chosen: keeping
   debug builds on that phone for good, and giving release builds a different app id.

   The owner does every step by hand; nothing here is automated. This round is the **one
   exception** to two rules: it is the only time Plannr is uninstalled on that phone (step 3), and
   its step 5 is the only restore on that phone. Everywhere else, "never uninstall" and "no
   restore on the owner's phone" stay as they are. The check boxes for the round are in
   `docs/PHONE-TEST-CHECKLIST.md` ("The debug to release switch round").

   **The switch round, step by step:**

   1. **Back up twice, and copy both files off the phone.** On the phone: Data Backup →
      **Download encrypted backup** (a passphrase of at least 10 characters; keep it in your
      password manager). Then tick **Include Daily Report contacts** and **Download JSON backup**.
      Copy both files off the phone to **two places**, for example `D:\Backups\plannr\` on the
      laptop and a USB stick. Check each copy is there and is not 0 bytes. Write down the figures
      to compare later: the number of ledgers, people and categories, one ledger's entry count and
      total, the newest three entries (date, amount, reason), the budget on Overview, and the
      storage figure on Data Backup. From now until step 6 passes, change nothing in Plannr on the
      phone.
   2. **Prove the restore on the emulator, with the release build.** Use the same release APK the
      phone will get. The emulator (`emulator-5554`) holds test data only, so uninstalling there is
      fine: `adb -s emulator-5554 uninstall com.plannr.app`, then
      `adb -s emulator-5554 install <release APK>` (it must answer `Success`). Copy both files to
      the emulator and pick them as in A3 of the checklist ("The file picker"). Restore the
      encrypted backup and compare every figure from step 1 and the newest entries with the phone.
      Then empty the app (`adb -s emulator-5554 shell pm clear com.plannr.app`), restore the JSON
      backup and compare again. **Any mismatch, error or missing item: stop. Do not uninstall
      anything on the phone.** Keep the backups as they are and ask.
   3. **Only then, on the phone, uninstall the debug app** (Android Settings → Apps → Plannr →
      Uninstall). This erases its data on the phone: that is why steps 1 and 2 come first. From
      here, the two backup copies are the only copy of the data.
   4. **Install the release APK.** First check it on the laptop:
      `apksigner verify --print-certs <release APK>` must print the release certificate SHA-256
      you wrote down (section 1.3), and not the debug key's `fd12f081…b95629`. Then
      `adb -d install <release APK>`. It must answer `Success`. Anything else: stop and ask.
   5. **Restore the encrypted backup** on the phone: Data Backup → **Restore from encrypted
      backup**, the file from step 1 and its passphrase. If that fails, restore the JSON backup
      with **Import / Restore** instead. If both fail: stop and ask. Do not uninstall again: the
      backup copies from step 1 still hold the data.
   6. **Verify on the phone:** the counts and totals from step 1, the newest entries, the budget
      on Overview, a PDF (Overview → **Download PDF**), a new test entry (close Plannr fully, open
      it again, check the entry is there, then delete it), and Home's **Backup reminder**. Then
      clear your data from the emulator as D of the checklist does, and keep the unencrypted JSON
      only in your two backup places (never in a cloud folder or an e-mail).

   After the round, the phone runs the release build. Every later update is a release APK signed
   with the release key, installed over it with `adb -d install -r` as `docs/RELEASE.md` says,
   never with an uninstall. Debug builds no longer install on that phone.

2. **The debug key, until the switch round is done.** That phone runs a debug build. As long as
   it does (today, until the switch round above is carried out), it can only
   be updated with debug builds signed by the same Android debug key as the app on it. The last build
   made for it (`9d7fd97`) was signed with the debug key of the owner's current laptop (certificate
   `fd12f081…b95629`; Android's default debug keystore in the user profile, which the Android build
   tools made for the first debug build); the checklist confirms the phone's own copy before any
   install. A debug build made on another PC, or on that laptop after its debug keystore is lost,
   will not install over the phone's Plannr (the checklist says stop). On a new machine, check a
   debug APK built there as the checklist's "Check the APK on the laptop" says before any phone
   step: its certificate must be `fd12f081…b95629`. Whether and how to keep a copy of that debug key
   until the round is done is the owner's call (also in `SETUP.md` §2). **After the switch round,
   the phone no longer depends on the debug key:** it runs the release build, and only the release
   key matters for it.

3. **Decided: keep the strict stop on password lines in `keystore.properties`** (owner's
   decision, dated 2026-11-28). If `keystore.properties` still has a `storePassword` or
   `keyPassword` line, `npm run release:android` stops before it changes anything and names the
   lines, never their values. The other way named was only to warn and go on. It was not chosen:
   a password line left in the file keeps the password on disk, next to the key's path. Remove
   the two lines (keep `storeFile` and `keyAlias`); the passwords belong in the password manager.

Owner to-do (2026-11-23): make the second offline backup copy of the release key (section 1.3),
and decide whether to keep a copy of the laptop's debug key until the switch round (above).
