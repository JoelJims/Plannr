# Plan: publishing a public release APK safely

Status: **plan only**, apart from the key's new place: on 2026-11-22 the owner decided to move the
release key out of the project to `D:\Keys\plannr\` (section 1.2). Nothing else here changes a
signing setting or a signing file. Written 2026-11-22.

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
- Then create `keystore.properties` in the project root with the four entries from `SETUP.md` §2.
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
  `signingConfigs.release` block). `SETUP.md` §2 describes the file's four entries (the store file,
  the alias, and the two password lines).
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

Tell every user to do these steps, in this order. The button names are the ones on the
**Data Backup** page (`public/data-backup.html`).

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
section 5 is done.

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
      same certificate SHA-256 as the last release, and its Owner line has nothing personal in it.
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
