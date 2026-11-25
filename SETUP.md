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

`server.js` is a desktop **dev and test tool only**. It serves the *same* screens from
`public/` against an ordinary database file on your computer (`data/plannr.db`). It exists
so the app can be developed and tested on a desktop, and it is what most of the automated
tests run against. **Nothing in `server.js` reaches the phone**, and it prints
`DEV MODE – not used by the phone app` when it starts. Its packages (`express`,
`playwright`, `@capacitor/cli`) are `devDependencies`.

How a page knows which one it is talking to (`public/runtime-mode.js`): inside the Android
app it always uses its own database and never even looks for a server; in a desktop browser
it uses `server.js` only when the page carries `server.js`'s `X-Plannr-Dev-Server` header.

Why that matters in practice:

- The route code lives **once**, in `core/` (`core/routes/` and its helpers), and both
  `server.js` and `public/local-api.js` run it. So do the shared files at the project root
  (`db.js`, `repo.js`, `ledgers.js`, `backup-format.js`, `request-rules.js`).
  `sync-public-modules.js` copies all of them, and the phone's database engine
  `db-engine.js`, into `public/`. Edit them at the project root or in `core/`, never in
  `public/`.
- `server.js` and `public/local-api.js` themselves are thin hosts, and each keeps what has
  to differ by platform (for example the PDF renderer). **A fix in `server.js` alone fixes
  nothing on the device.** When the two disagree, **the Android path is the one that is
  true**, because it is the one users run.
- A green `npm test` runs the HTTP tests twice: against `server.js`, and against the phone's
  `public/local-api.js` loaded in Node. It still does **not** prove the APK works.
  `npm run test:static-hosting` is the closest automated stand-in for the device.

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
they have to be copied across by hand. The key lives **outside the project**, in a folder of
its own; only its properties file goes into the **project root**, next to `package.json`:

| File | What it is | Where it goes |
|---|---|---|
| `plannr-release.keystore` | The signing key for release builds. | `D:\Keys\plannr\` — outside the project folder and outside git, on the same drive as the project (on a PC with only `C:`, use `C:\Keys\plannr\`) |
| `keystore.properties` | Where the key is and its alias. Two entries only: `storeFile` and `keyAlias`. **No passwords** (see below). | project root (git-ignored) |

**The two passwords are never in a file.** `android/app/build.gradle` takes them from two
environment variables, `PLANNR_STORE_PASSWORD` and `PLANNR_KEY_PASSWORD`. `npm run release:android`
uses them if they are set; if one is not set and you run it in a terminal, it asks for it and does
not show what you type. It hands them to Gradle only through Gradle's environment: never on the
command line, never written to disk, never printed. With no terminal (for example a piped or CI
run) and no variables, it stops before it changes anything. The simplest way is to let it ask. If
you set the variables yourself, set them in that one terminal window only and close it afterwards;
never put them in a script, a profile or a file in the project. If your `keystore.properties` still has
the two password lines from an older setup, delete those two lines: `npm run release:android`
stops while they are there (it names the lines, never their values). Keep the passwords in your
password manager.

**The `storeFile` line must be a path relative to the project root.** For a checkout at
`D:\Projects\Plannr` it reads `storeFile=../../Keys/plannr/plannr-release.keystore` (two folders
up from the project root is `D:\`). `android/app/build.gradle` joins this value to the project
root (`new File(projectRootDir, storeFile)`), so an absolute path such as `D:\Keys\...` does
**not** work.

**So the key folder must be on the same drive as the project.** A relative path cannot change
drive: from a checkout on `C:` no relative path reaches `D:\Keys\plannr\`. On a PC with only
`C:` (a typical laptop), put the key in `C:\Keys\plannr\` and the project under `C:\`, for
example `C:\Projects\Plannr`. Then the line stays exactly the same,
`storeFile=../../Keys/plannr/plannr-release.keystore`, because the key is again two folders up
from the project root. If the project is somewhere else on that drive, change the number of
`../` so the path still reaches `Keys\plannr\plannr-release.keystore` on that drive.

**Save `keystore.properties` as UTF-8 without a byte-order mark (BOM), or as plain ASCII.**
Gradle reads this file as Latin-1, so a BOM at the start becomes part of the first entry's name
and Gradle cannot read that entry. Windows PowerShell 5.1 adds a BOM when it writes "UTF-8"
(`Set-Content -Encoding utf8`, `Out-File -Encoding utf8`), and its plain `Out-File` and `>` write
UTF-16, which Gradle cannot read at all. In Notepad, choose Save as, Encoding "UTF-8" (not
"UTF-8 with BOM" and not a "UTF-16" one).

`npm run release:android` checks both files before it changes anything. It reads only the
`storeFile` line and resolves it against the project root. It stops (naming the path it expected)
if no key file is there, and it also stops if the line is an absolute path or starts with a drive
letter, if the file starts with a BOM or is saved as UTF-16, or if it still has a password line.
It never reads a password line's value. Its "Signing:" line shows the
key's path only when the release can go ahead; otherwise it says "NOT ready" (or "NOT found" when
there is no `keystore.properties`) and the reason follows.

`.gitignore` still blocks key files even though the key no longer lives in the project:
`*.keystore`, `*.jks`, `*.p12`, `*.pem` and `keystore.properties`. A copy dropped into the
project by mistake still cannot be committed. `test/release-guards.test.js` fails if those
lines go or if such a file is ever tracked.

> ### A missing keystore fails *silently*
>
> The build reads `keystore.properties` only if it is there — deliberately, so a fresh
> checkout with no key can still produce debug builds. If the file is absent,
> `assembleRelease` **does not fail**. It produces an **unsigned** release APK and says
> nothing about it. You find out when the phone refuses the install. (If the file is there
> but the key is not where `storeFile` says, Gradle does fail. `npm run release:android`
> catches both cases before it builds anything.)
>
> So check, rather than assume, after your first release build. `apksigner` is in the
> Android SDK's `build-tools\<version>\` folder (on Windows usually
> `%LOCALAPPDATA%\Android\Sdk\build-tools\<version>\apksigner.bat`):
>
> ```sh
> apksigner verify --print-certs android/app/build/outputs/apk/release/Plannr.apk
> ```
>
> That must print the signer's certificate, with a "certificate SHA-256 digest" line. Note
> that SHA-256 the first time (`docs/release-plan.md` §1.3); every later release must show
> the same one. "DOES NOT VERIFY", or another error, means the APK is not signed:
> `keystore.properties` is missing or wrong. Do not check with `keytool -printcert -jarfile`:
> it reads only the old v1 signature, which this APK may not have (`minSdkVersion` 24), so
> it can say "Not a signed jar file" even for a correctly signed APK.

> ### Never lose or replace this key
>
> Android refuses to upgrade an installed app with an APK signed by a different key
> (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). The only way past it is to uninstall first —
> **which destroys the database on the phone**, because Plannr's storage belongs to the
> app itself. There is no copy of it anywhere else. The copy in `D:\Keys\plannr\` is the
> working copy, not a backup. Keep **two offline backup copies** of the keystore (for
> example two USB sticks kept in different places; make the second one if only one
> exists), and keep **both passwords and the alias in a password manager**: a key without
> its passwords is as lost as no key. Take an encrypted backup from inside the app
> (`/data-backup`) before any install you are unsure about.

**The debug key matters too, for the owner's phone.** That phone runs a debug build. As long as it does (today, until any move in
`docs/release-plan.md` §6 is carried out, and for good if it stays on debug builds), it can only
be updated with debug builds signed by the same Android debug key as the app on it. The last build
made for it (`9d7fd97`) was signed with the debug key of the owner's current laptop (certificate
`fd12f081…b95629`; Android's default debug keystore in the user profile, which the Android build
tools made for the first debug build); the checklist confirms the phone's own copy before any
install. A debug build made on another PC, or on that laptop after its debug keystore is lost,
will not install over the phone's Plannr (the checklist says stop). On a new machine, check a
debug APK built there as the checklist's "Check the APK on the laptop" says before any phone
step: its certificate must be `fd12f081…b95629`. Whether and how to keep a copy of that debug key
is the owner's call.

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

The desktop server has no login, so it listens on `127.0.0.1` only: other devices on your
Wi-Fi cannot reach it. To open it to your network on purpose, set both `PLANNR_HOST=0.0.0.0`
and `PLANNR_TOKEN` (a random string of 16+ characters). Then open
`http://<this PC's IP>:3000/?token=<PLANNR_TOKEN>` once on each device. Without a long enough
token, the server refuses to start in that mode.

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
  `public/backup-format.js`, `public/request-rules.js`,
  `public/node-builtins-browser-stub.js` — copies of the files at the project root
- `public/core/` — a copy of `core/`, the route code both backends run
- `public/node_modules/` — the packages the app's import maps refer to
- `android/app/src/main/assets/`, `android/app/src/main/res/xml/config.xml`,
  `android/capacitor-cordova-android-plugins/` — Capacitor's own output

**Never hand-edit any of those.** Edit the copy at the project root (or in `core/`) and
re-run the sync.
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
./gradlew assembleDebug      # -> android/app/build/outputs/apk/debug/Plannr-debug.apk
# a signed release: from the project root, npm run release:android (it asks for the key
# passwords without showing them). ./gradlew assembleRelease alone stops unless
# PLANNR_STORE_PASSWORD and PLANNR_KEY_PASSWORD are set in that terminal window (only there)
adb -s emulator-5554 install -r android/app/build/outputs/apk/debug/Plannr-debug.apk   # the emulator
```

Always tell adb which device: `-s emulator-5554` for the emulator, `-d` for the phone on USB,
straight after `adb`. With both connected, a command without them can reach the wrong device.
**A phone that holds real data** gets an APK only as `docs/PHONE-TEST-CHECKLIST.md` says: both
backups proven on the emulator first, then `adb -d install -r`, never uninstall. A release APK
cannot be installed over a debug build (`docs/RELEASE.md`).

App id `com.plannr.app`. For a real release use `npm run release:android`: it runs every test,
raises `versionCode`/`versionName` in `android/app/build.gradle`, syncs and builds the signed APK.
The whole procedure — back up the phone, build, install over the old app, check the data — is
in [`docs/RELEASE.md`](docs/RELEASE.md).

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

- `adb -d install -r ...` (or `adb -s emulator-5554 install -r ...` for the emulator) skips
  the installer screens entirely, so it is the fastest route during development. Play Protect
  can still warn on first launch. On a phone with real data, follow
  `docs/PHONE-TEST-CHECKLIST.md` instead.
- **Do not turn off signing, or switch to debug signing, to make the warning go away.**
  The warning is about how the app was distributed, not about the signature being invalid,
  and unsigned or debug-signed builds break upgrades over an existing release install (see
  section 2; the owner's phone, which runs a debug build, is the exception described there).
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
npm run test:offline         # every page in a real browser with no connection
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
- **`server.js` is a thin host** (about 600 lines). The route code is in `core/routes/`,
  shared with the phone, so that is where most changes go (section 0).

---

## 8. Quick reference — a fresh machine, start to finish

```sh
git clone <repo> && cd Plannr               # e.g. in D:\Projects\ (C:\Projects\ on a C:-only PC)
# by hand, from your offline backup (section 2):
#   plannr-release.keystore -> D:\Keys\plannr\   (outside the project; create the folder;
#                              same drive as the project, so C:\Keys\plannr\ on a C:-only PC)
#   keystore.properties     -> this directory    (storeFile = the key's path relative to here,
#                              ../../Keys/plannr/plannr-release.keystore for <drive>:\Projects\Plannr;
#                              plus keyAlias; no passwords: the release build asks for them)
npm ci
npm test                                  # expect green
npm start                                 # http://localhost:3000 — check the app runs
npm run android:sync                      # regenerate public/ copies + the native project
# open the android/ directory in Android Studio, let it sync
npm run release:android                   # runs the tests, raises the version, asks for the key
                                          # passwords (not shown), then builds the signed APK
cd android                                # -> app/build/outputs/apk/release/Plannr.apk
# apksigner is in the SDK's build-tools/<version>/ folder; it must print the certificate
# SHA-256 you noted for this key (section 2)
apksigner verify --print-certs app/build/outputs/apk/release/Plannr.apk
# install on the emulator (-s emulator-5554); for a test phone on USB, use -d instead. Never on
# a phone with real data: that one goes through docs/PHONE-TEST-CHECKLIST.md (see section 3.5)
adb -s emulator-5554 install -r app/build/outputs/apk/release/Plannr.apk
# expect a Play Protect warning on the device — More details -> Install anyway
```

Then read `README.md` and `HANDOFF.md`.
