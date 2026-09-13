# Setting Plannr up on a new machine

What to install, in what order, and what to run first. For what Plannr is and how it
works, read `README.md`, then `HANDOFF.md`.

---

## 0. Read this before you install anything

**The Android app is the product. `server.js` is not.**

What ships is an Android app: the screens in `public/`, packaged by Capacitor, talking
to `public/local-api.js` — code that answers the app's requests locally instead of over
a network — backed by a database that runs inside the app itself. That is what a user
installs.

`server.js` is a desktop version. It serves the *same* screens from `public/` against an
ordinary database file on your computer (`data/plannr.db`). It exists so the app can be
developed and tested on a desktop, and it is what most of the automated tests run
against. **Nothing in `server.js` reaches the phone.**

Why that matters in practice:

- `server.js` and `public/local-api.js` are two separate pieces of code that answer the
  same requests. A change to one is not a change to the other. **Fixing a bug in
  `server.js` alone fixes nothing on the device.**
- `server.js` is the easier of the two to read, so it is the one to read when you want to
  understand how something behaves — but when the two disagree, **the Android path is the
  one that is true**, because it is the one users run.
- `repo.js` is the single deliberate exception: one shared file used by both, copied into
  `public/` by `sync-public-modules.js`. Edit it at the project root, never in `public/`.
- A green `npm test` proves the desktop version works. It does **not** prove the APK
  works. `npm run test:static-hosting` is the closest automated stand-in for the device.

---

## 1. Prerequisites — install in this order

| # | What | Version | Notes |
|---|---|---|---|
| 1 | **Node.js** | **>= 22.12.0** | Developed on 24.18.0 / npm 11.16.0. It must be a version that includes `node:sqlite`; `server.js` and the whole test suite depend on it, and there is no fallback. |
| 2 | **Git** | any recent | |
| 3 | **Android Studio** | latest stable | Brings the Android SDK, `adb`, and the Java 21 runtime the project builds against. |
| 4 | **Android SDK Platform 36** | API 36 | SDK Manager → SDK Platforms. Both `compileSdk` and `targetSdk` are 36; the libraries Capacitor pulls in require it, so 35 will not build. |
| 5 | **SDK Build-Tools + Platform-Tools** | latest | Platform-Tools is where `adb` comes from. |
| 6 | **A device or emulator** | **Android 7.0+** | Developed against a physical device with USB debugging on. |

**Do not install Gradle separately.** The version is pinned in the repository, so always
use `./gradlew` or `gradlew.bat`, never a system `gradle`.

**You do not need a separate Java install if you have Android Studio.** Studio's bundled
Java 21 satisfies the build, and Gradle will download one itself if it can't find it —
which means the very first build needs an internet connection.

---

## 2. Files that do not come from the repository

These are deliberately kept out of version control. `git clone` will not give you them;
they have to be copied across by hand into the **project root**, next to `package.json`:

| File | What it is | Where it goes |
|---|---|---|
| `plannr-release.keystore` | The signing key for release builds. | project root |
| `keystore.properties` | Its passwords and alias. Four entries: `storeFile` (= `plannr-release.keystore`, relative to the project root), `storePassword`, `keyAlias`, `keyPassword`. | project root |

> ### A missing keystore fails *silently*
>
> The build reads `keystore.properties` only if it is there — deliberately, so a fresh
> checkout with no key can still produce debug builds. If the file is absent,
> `assembleRelease` **does not fail**. It produces an **unsigned** release APK and says
> nothing about it. You find out when the phone refuses the install.
>
> So check, rather than assume, after your first release build:
>
> ```sh
> keytool -printcert -jarfile android/app/build/outputs/apk/release/app-release.apk
> ```
>
> That must print a certificate. An error, or empty output, means `keystore.properties`
> is missing or wrong.

> ### Never lose or replace this key
>
> Android refuses to upgrade an installed app with an APK signed by a different key
> (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). The only way past it is to uninstall first —
> **which destroys the database on the phone**, because Plannr's storage belongs to the
> app itself. There is no copy of it anywhere else. Back the keystore up somewhere you
> will still have it in five years, and take an encrypted backup from inside the app
> (`/data-backup`) before any install you are unsure about.

Also absent, and not needed to build: `data/`, the desktop database, which holds real
financial records.

---

## 3. First run — the order matters

### 3.1 Install dependencies

```sh
npm ci
```

**Do this before anything touches Gradle.** The Android project points at
`../node_modules/@capacitor/...`. With no `node_modules/`, opening `android/` in Android
Studio fails with a "project directory does not exist" error that looks like a broken
Android project and is not one.

### 3.2 Run the desktop version and check the checkout is sound

```sh
npm start                   # = node server.js  ->  http://localhost:3000   (PORT overrides)
npm test                    # expect green before you change anything
```

`npm test` is the quickest way to tell that the checkout is complete. It also protects the
real database: every test file points `PLANNR_DB` at its own temporary database, and the
runner checks `data/plannr.db`'s timestamp before and after the whole run and **fails if
the live database was touched**.

> **The live-database rule.** `server.js` defaults to `data/plannr.db` — correct, because
> in desktop mode that *is* the app. Every other script goes through `db-guard.js`, which
> prints the full path it is about to write to and **refuses the live database** unless you
> pass `--i-really-mean-the-live-db`. An unset `PLANNR_DB` counts as live. Always set
> `PLANNR_DB` when experimenting.

### 3.3 Generate the web assets and the native project

```sh
npm run android:sync        # = sync-public-modules.js  +  npx cap sync android
```

**Not optional on a fresh checkout.** Several files are generated rather than stored in the
repository, and this is the command that creates them:

- `public/db.js`, `public/repo.js`, `public/db-engine.js`, `public/ledgers.js`,
  `public/node-builtins-browser-stub.js` — copies of the files at the project root
- `public/node_modules/` — the packages the app's import maps refer to
- `android/app/src/main/assets/`, `android/app/src/main/res/xml/config.xml`,
  `android/capacitor-cordova-android-plugins/` — Capacitor's own output

**Never hand-edit any of those.** Edit the copy at the project root and re-run the sync.
Re-run it after every change to `public/` or to a root file, and before every build:
whatever is in `public/` at sync time is exactly what ships.

### 3.4 Open the Android project

Open the **`android/`** directory in Android Studio, not the project root. On first open
Studio will:

- write `android/local.properties` with your own SDK path. If it doesn't, create it:
  `sdk.dir=C\:\\path\\to\\Android\\Sdk` (escape the backslashes) or `sdk.dir=/path/to/Android/Sdk`.
- recreate `android/.idea/`. Both of those are specific to your machine and are not
  shared. Leave them that way.
- run a first sync that downloads Gradle and, if needed, Java 21. The first one is slow.
  Later ones are not.

### 3.5 Build and install

From `android/`, or via Studio's Run button for debug builds:

```sh
./gradlew assembleDebug      # -> android/app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease    # -> android/app/build/outputs/apk/release/app-release.apk  (signed)
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

App id `com.plannr.app`, `versionCode 1`, `versionName "1.0"` — raise these in
`android/app/build.gradle` for a real release.

---

## 4. Installing on a phone — expect a Play Protect warning

Plannr is installed directly rather than through the Play Store, and is signed with our own
key, so **Google Play Protect will warn about it.** That is normal. It is not a signing
failure and not something to fix.

What you will usually see, in order (wording varies by Android version and manufacturer):

1. **"Install unknown apps"** — Android asks you to allow whichever app is doing the
   installing (Files, Chrome, Drive). Grant it to that app.
2. **A Play Protect dialog** — usually *"Unsafe app blocked"* or an offer to send the app
   to Google for scanning. Choose **More details → Install anyway**; on some builds that is
   a small text link rather than a button. Letting it scan is fine — it passes, it just
   takes a few seconds.
3. **Possibly a second prompt on first launch**, if Play Protect re-scans the app.

Notes:

- `adb install -r ...` skips the installer screens entirely, so it is the fastest route
  during development. Play Protect can still warn on first launch.
- **Do not turn off signing, or switch to debug signing, to make the warning go away.**
  The warning is about how the app was distributed, not about the signature being invalid,
  and unsigned or debug-signed builds break upgrades over an existing install (see section 2).
- If you are handing the APK to someone else, warn them about this dialog first. Without
  warning, "Unsafe app blocked" reads as a virus alert and most people will cancel.

---

## 5. The three ways to run it

You will use all three. They share the whole of `public/`; only what answers the requests
underneath changes.

| Command | What answers requests | Where data lives | Use it for |
|---|---|---|---|
| `npm start` (`node server.js`) | a real web server | a database file on your computer | day-to-day development; what most tests use |
| `node local-server.js` | the same local code the app uses | a database inside the browser tab | testing the exact setup the app uses, without building an APK |
| the APK | the same local code, no network | a database inside the app | the actual product |

The middle one is the one people forget. It catches most Android-only breakage —
assumptions about absolute paths, how links behave when files are served as plain static
files — in seconds rather than a build cycle. Reach for it before `assembleDebug`.

---

## 6. Test commands

```sh
npm test                     # the main suite — the gate
npm run test:slow            # the slower suite, run one at a time
npm run test:ui              # visual tests against server.js
npm run test:static-hosting  # visual tests against a real local-server.js process
npm run test:backup-crypto   # round-trips the encrypted backup through the real code
```

Playwright downloads its own browsers. If a visual suite complains one is missing, run
`npx playwright install chromium`.

Also useful: `npm run seed:demo` (demo data) and `npm run reset-db` (wipe — read the
live-database rule in section 3.2 first).

---

## 7. Things worth knowing before you start

- **The save-and-share path on Android has not been tested on a real device.** It was
  written to match the PDF sharing path, which has been tested on a device, and it passes
  every test that can run in a browser — but browsers always report themselves as
  non-native, so the Android-specific branch is not covered. Try it on real hardware
  before putting real data in.
- **`server.js` is one very large file** (~142 KB). It works and it is tested, but it is
  the main thing that needs tidying.

---

## 8. Quick reference — a fresh machine, start to finish

```sh
git clone <repo> && cd Plannr
# copy plannr-release.keystore + keystore.properties into this directory by hand
npm ci
npm test                                  # expect green
npm start                                 # http://localhost:3000 — check the app runs
npm run android:sync                      # regenerate public/ copies + the native project
# open the android/ directory in Android Studio, let it sync
cd android && ./gradlew assembleRelease
keytool -printcert -jarfile app/build/outputs/apk/release/app-release.apk   # must print a cert
adb install -r app/build/outputs/apk/release/app-release.apk
# expect a Play Protect warning on the device — More details -> Install anyway
```

Then read `README.md` and `HANDOFF.md`.
