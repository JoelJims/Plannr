# Releasing a new version to the phone

Plannr keeps all its data **inside the app on the phone** (the WebView's storage for
`https://localhost`). An update keeps that data only when it is installed **over** the old app.
Uninstalling first deletes it. Follow these steps in order, every time.

## What keeps the data through an update

| Must stay the same | Where | Guarded by |
|---|---|---|
| App id `com.plannr.app` | `capacitor.config.json`, `android/app/build.gradle`, `strings.xml` | `test/release-guards.test.js` |
| Page origin `https://localhost` (scheme `https`, host `localhost`) — the data belongs to this origin | `capacitor.config.json` (`server.androidScheme`, `server.hostname`: leave them unset) and Capacitor's defaults | `test/release-guards.test.js` |
| The signing key | `plannr-release.keystore` in `D:\Keys\plannr\` (outside the project and outside git); `keystore.properties` in the project root (git-ignored), whose `storeFile` line points to the key with a path relative to the project root | `.gitignore` still lists `*.keystore`, `*.jks` and `keystore.properties`; `test/release-guards.test.js` checks they can't be committed; `npm run release:android` stops if the key is not where `storeFile` says |
| `versionCode` goes **up** | `android/app/build.gradle` | `npm run release:android` bumps it |

A debug APK (`Plannr-debug.apk`) is signed with the Android debug key, not the release key. A
phone that has the release build cannot take a debug build over it, and the other way round.
Always update a phone with the same kind of build it already has.

## 1. Back up the phone first

1. Open Plannr on the phone → **Data Backup**.
2. **Download encrypted backup** (the whole database). Choose a password you will remember.
3. Also **Download JSON backup** (format v2: everything, readable without a password).
4. Save both files **off the phone** (share them to your computer, Drive or e-mail) and check
   each file is there and not 0 bytes.
5. Note a few numbers to compare after the update: the number of ledgers, one ledger's total,
   and the storage figure on the Data Backup page.

## 2. Build

You need the key at `D:\Keys\plannr\plannr-release.keystore` and `keystore.properties` in the
project root, with its `storeFile` line set to the key's path relative to the project root
(`../../Keys/plannr/plannr-release.keystore` for a checkout at `D:\Projects\Plannr`; see
`SETUP.md` §2). Without `keystore.properties` the release APK would be **unsigned** and the phone
would refuse it; without the key file the Gradle build fails. In both cases
`npm run release:android` stops before changing anything. Its "Signing:" line shows the key path
it found. Keep two offline backup copies of the key and both passwords in a password manager
(`SETUP.md` §2).

```sh
npm run release:android -- --dry-run   # shows the version bump and the steps; changes nothing
npm run release:android                # or: npm run release:android -- --version-name 1.1.0
```

It runs every test (`npm test` and every `npm run test:*` UI suite except `test:slow`) and stops
at the first failure before changing anything. Then it raises `versionCode` by one (it only ever
goes up, and a number is never reused) and bumps `versionName`: the first public release is
`1.0.0`, which the plain command makes from today's `1.0`; after that it bumps the last number
(`1.0.0` → `1.0.1`). Use `--version-name` for a minor or major release (`docs/release-plan.md` §2).
It then runs `npm run android:sync`, and builds
`android/app/build/outputs/apk/release/Plannr.apk`. If the sync or the build fails,
`build.gradle` is put back.

Check the APK is signed with the release key:

```sh
keytool -printcert -jarfile android/app/build/outputs/apk/release/Plannr.apk
```

It must print a certificate. Its SHA-256 must be the same every release (compare with the last
one you noted). Then commit the version bump.

## 3. Install over the old app

**Do not uninstall Plannr.** Install the new APK on top of it:

- with a cable: `adb install -r android/app/build/outputs/apk/release/Plannr.apk`
- or copy `Plannr.apk` to the phone and open it; Android asks to **update** the app. If it says
  "install" instead of "update", stop: it does not see this as the same app.

If the install fails, **do not uninstall to get past it**:

| Message | Meaning | What to do |
|---|---|---|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` / "App not installed as package conflicts" | Signed with a different key (for example a debug build over a release build) | Build with the right key. |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | `versionCode` is not higher than the installed one | Build again with `npm run release:android`. |
| Play Protect warning | Normal for an app not from the Play Store (`SETUP.md` §4) | Continue. |

## 4. Check the data

1. Open Plannr. The ledger list shows the same ledgers as before.
2. Open one ledger and compare its total with the number you noted.
3. **Data Backup**: the storage figure is about the same; categories and people are there.
4. Add a test entry, close the app fully, open it again: the entry is still there. Delete it.

If Plannr shows **"Plannr could not open your data"**: do not uninstall and do not clear the
app's storage. Each step of the update's database upgrade runs in its own transaction, so a
failed step is rolled back and the data is left as the last finished step wrote it (for an upgrade
from schema v2 onwards, at that step's version). A pre-upgrade safety snapshot of the data as it
was before the update is in the app's private `safety-snapshots/` folder. Write down the message and fix the problem in a newer
version (higher `versionCode`). As a last resort, restore the backup from step 1.

## If the data is gone

On the **Data Backup** page, **Restore from encrypted backup** with the file from step 1 (it takes a
safety snapshot of whatever is there first). The JSON backup restores with **Import / Restore** on
the same page.
