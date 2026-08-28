# SETUP.md — getting Plannr running on a new machine

This is the *setup* document: what to install, in what order, and what to run first.
For what Plannr **is** and how it works, read `README.md`, then `HANDOFF.md` (the model,
the money rules, the deliberate decisions, troubleshooting by symptom).

---

## 0. Read this before you install anything

**`server.js` is the reference implementation, not the target.**

The product is an **Android app**: `public/` (static HTML/JS) packaged by Capacitor,
talking to `public/local-api.js` — an in-page `fetch()` shim, no network at all — over
`@sqlite.org/sqlite-wasm` running inside the WebView. That is what ships. That is what
the user installs.

`server.js` is a Node/Express desktop mode that serves the *same* `public/` frontend
against a real SQLite file (`data/plannr.db`) via `node:sqlite`. It exists so the app can
be developed, driven and tested on a desktop, and it is what most of the automated suite
boots. **Nothing in `server.js` reaches the phone.**

Why that distinction matters in practice:

- `server.js` and `public/local-api.js` are two deliberately duplicated implementations of
  the same API surface (see HANDOFF.md §7, "Per-environment duplication"). A change to one
  is not a change to the other. **Fixing a bug in `server.js` alone fixes nothing on the
  device.**
- `server.js` is the more readable statement of the API surface, so it's what you read to
  understand behaviour — but when the two disagree at runtime, **the Android path is the
  one that is true**, because it is the one users run.
- `repo.js` is the single deliberate exception: one shared file under both, synced into
  `public/` by `sync-public-modules.js`. Edit it at the project root, never in `public/`.
- A green `npm test` proves the reference implementation works. It does **not** prove the
  APK works. `npm run test:static-hosting` is the closest automated proxy for the device.

---

## 1. Prerequisites — install in this order

| # | What | Version | Notes |
|---|---|---|---|
| 1 | **Node.js** | **>= 22.12.0** | `package.json` `engines`. Developed on **24.18.0 / npm 11.16.0**. Must be a version with `node:sqlite` — `server.js` and the whole test suite depend on it. There is no `better-sqlite3` fallback. |
| 2 | **Git** | any recent | |
| 3 | **Android Studio** | latest stable | Installs the Android SDK and `adb`, and ships the **JetBrains Runtime 21** the project builds against. |
| 4 | **Android SDK Platform 36** | API 36 | Studio → SDK Manager → SDK Platforms. `compileSdk`/`targetSdk` are both **36** (`android/variables.gradle`); the androidx versions pulled in by Capacitor 8.5 hard-require >= 36 via an AAR metadata check, so 35 will not build. |
| 5 | **Android SDK Build-Tools + Platform-Tools** | latest | Platform-Tools gives you `adb`. |
| 6 | **A device or emulator** | **Android 7.0+** | `minSdk = 24`. A physical device with USB debugging is what this was developed against. |

**Do not install Gradle.** The wrapper pins it: **Gradle 8.14.3**
(`android/gradle/wrapper/gradle-wrapper.properties`), **AGP 8.13.0** (`android/build.gradle`).
Always use `./gradlew` / `gradlew.bat`, never a system `gradle`.

**You do not need a separate JDK if you use Android Studio.** Capacitor's own modules require
a Java 21 toolchain regardless of `compileSdk`, and `android/settings.gradle` applies the
`foojay-resolver-convention` plugin so Gradle **auto-provisions JDK 21** if it can't find one.
Two consequences: Studio's bundled JBR 21 satisfies it with no setup, and **the very first
Gradle build needs network access** in case it has to download that toolchain.

---

## 2. Files that do NOT come from the repository

These are `.gitignore`d on purpose. `git clone` will not give you them — they have to be
copied across out of band, by hand, into the **project root** (next to `package.json`):

| File | Why it's out of band | Where it goes |
|---|---|---|
| `plannr-release.keystore` | Release signing key. | project root |
| `keystore.properties` | Its passwords and alias. Four keys: `storeFile` (= `plannr-release.keystore`, resolved relative to the project root), `storePassword`, `keyAlias`, `keyPassword`. | project root |

> ### A missing keystore fails *silently*
>
> `android/app/build.gradle` reads `keystore.properties` lazily and guarded — deliberately, so
> a fresh checkout with no keystore can still run debug builds. If the file is absent,
> `assembleRelease` **does not fail**. It produces an **unsigned** release APK and says
> nothing. You will only find out when the install is rejected on the phone.
>
> So verify, don't assume, after your first release build:
>
> ```sh
> keytool -printcert -jarfile android/app/build/outputs/apk/release/app-release.apk
> ```
>
> That must print a certificate. An error, or empty output, means your `keystore.properties`
> is missing or wrong.

> ### Never lose or replace this key
>
> Android refuses to upgrade an installed app with an APK signed by a different key
> (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). The only way past it is to uninstall first — **which
> destroys the on-device database**, because Plannr's storage is the app's own sandboxed
> WASM/OPFS store. There is no server-side copy of anything. Back the keystore up somewhere you
> will still have in five years, and take an in-app encrypted backup (`/data-backup`) before any
> risky install.

Also not in the repo, and not needed to build: `data/` (the desktop-mode database — real
financial records), and `PLANNR-AUDIT-LIVE.md` (a working audit document, if it was passed to
you).

---

## 3. First run — the order matters

### 3.1 Install dependencies

```sh
npm ci          # reproducible install from package-lock.json — prefer this over `npm install`
```

**Do this before anything else touches Gradle.** `android/capacitor.settings.gradle` points
every Capacitor Gradle module at `../node_modules/@capacitor/...`. With no `node_modules/`,
opening `android/` in Android Studio fails at Gradle configuration with a "project directory
does not exist" error that looks like a broken Android project and is not one.

### 3.2 Run the reference implementation and prove the checkout is sound

```sh
npm start                   # = node server.js  ->  http://localhost:3000   (PORT overrides)
npm test                    # the behaviour suite — expect green before you change anything
```

`npm test` is the fastest signal that the checkout is complete and correct. It also enforces
two safety properties worth knowing on day one: every test file points `PLANNR_DB` at its own
temp database, and `run-tests.js` compares `data/plannr.db`'s mtime before and after the whole
run and **fails if the live database was touched**.

> **The live-DB rule.** `server.js` defaults to `data/plannr.db` — correct, it *is* the app in
> desktop mode. Every other script goes through `db-guard.js`, which prints the absolute path it
> will write to and **refuses the live database** (an unset `PLANNR_DB` counts as live) unless
> you pass `--i-really-mean-the-live-db`. Always set `PLANNR_DB` when experimenting.

### 3.3 Generate the web assets and the native project

```sh
npm run android:sync        # = sync-public-modules.js  +  npx cap sync android
```

This is **not optional on a fresh checkout**, and it is not just a convenience wrapper. Three
sets of files were removed from this handover because they are generated, and this command is
what recreates them:

- `public/db.js`, `public/repo.js`, `public/db-engine.js`, `public/ledgers.js`,
  `public/node-builtins-browser-stub.js` — copies of the root modules (`sync-public-modules.js`)
- `public/node_modules/` — the vendor packages the import maps reference by absolute path
- `android/app/src/main/assets/`, `android/app/src/main/res/xml/config.xml`,
  `android/capacitor-cordova-android-plugins/` — Capacitor's own output (`npx cap sync`)

**Never hand-edit any of those.** Edit the root copy and re-run the sync. Re-run this command
after every change to `public/` or to a root module, and before every build — `webDir` is
`public/`, so whatever is in there at sync time is exactly what ships.

### 3.4 Open the Android project

Open the **`android/`** directory in Android Studio (not the project root). On first open Studio
will:

- write `android/local.properties` with your own `sdk.dir` — machine-specific, gitignored,
  removed from this handover, regenerated for you. If Studio doesn't, create it yourself:
  `sdk.dir=C\:\\path\\to\\Android\\Sdk` (escape the backslashes) or `sdk.dir=/path/to/Android/Sdk`.
- recreate `android/.idea/` from scratch — also machine-specific (it stores your last-deployed
  device serial and your JDK pin) and also gitignored. Leave it that way.
- run a Gradle sync that downloads the wrapper distribution and, if needed, a JDK 21 toolchain.
  The first one is slow. Later ones are not.

### 3.5 Build and install

From `android/` (or via Studio's Run button for debug):

```sh
./gradlew assembleDebug      # -> android/app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease    # -> android/app/build/outputs/apk/release/app-release.apk  (signed)
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

App id `com.plannr.app`, `versionCode 1`, `versionName "1.0"` — bump these in
`android/app/build.gradle` for a real release.

---

## 4. Installing on a phone — the Play Protect warning is expected

Plannr is **sideloaded** and signed with our **own** keystore. It is not distributed through the
Play Store and has no Play-verified developer identity, so **Google Play Protect will warn about
it on install.** This is normal. It is not a signing failure, and it is not something to "fix".

What you'll typically hit, in order (exact wording varies by Android version and OEM skin):

1. **"Install unknown apps"** — Android asks you to grant that permission to whichever app is
   doing the installing (Files, Chrome, Drive). Grant it to that specific app.
2. **A Play Protect dialog** — usually along the lines of *"Unsafe app blocked"*, *"App scan
   recommended"*, or an offer to *send the app to Google for scanning*. Choose
   **More details → Install anyway** (some builds hide it behind a small text link rather than a
   button). If it offers to scan, letting it scan is fine — it will pass; it just takes a few
   seconds.
3. **A possible second prompt on first launch**, if Play Protect re-scans the newly installed app.

Notes:

- `adb install -r ...` skips the installer UI and the "unknown sources" step entirely, so it's
  the fastest path during development — but Play Protect can still warn on first launch.
- **Do not disable signing or switch to debug signing to make the warning go away.** The warning
  is about *distribution channel*, not about the signature being invalid. Removing release
  signing would break upgrades over an existing install (see §2).
- Handing the APK to the end user: warn them about this dialog in advance. Without a heads-up,
  "Unsafe app blocked" reads as a virus alert and a non-technical user will cancel.

---

## 5. The three run modes

You will use all three. They share the whole of `public/`; only the backend under it changes.

| Command | Backend | Storage | Use it for |
|---|---|---|---|
| `npm start` (`node server.js`) | real Express routes | `node:sqlite` -> `data/plannr.db` | day-to-day development; what most tests boot |
| `node local-server.js` | the same `local-api.js` shim the app uses | sqlite-wasm, in a plain Chromium tab | testing the **exact static-hosting model the WebView uses**, without building an APK |
| the APK | `local-api.js` shim, no network | sqlite-wasm via OPFS/kvvfs, in the WebView | **the actual product** |

The middle one is the one people forget exists. It catches most Android-only breakage —
absolute-path assumptions, import-map resolution, nav-link behaviour under static hosting — in
seconds instead of a build cycle. Reach for it before you reach for `assembleDebug`.

---

## 6. Test commands

```sh
npm test                     # behaviour suite (node --test over test/*.test.js) — the gate
npm run test:slow            # the slower suite, serialised
npm run test:ui              # Playwright visual suite against an in-process server.js
npm run test:static-hosting  # Playwright against a real local-server.js child process
npm run test:backup-crypto   # round-trips the encrypted backup format through the real routes
```

Playwright's browsers are downloaded by its own install step. If a UI suite complains about a
missing browser, run `npx playwright install chromium`.

Other useful scripts: `npm run seed:demo` (demo data), `npm run reset-db` (wipe — read the guard
rules in README.md before pointing it at anything real).

---

## 7. Inherited state you should know about

- **The working tree has uncommitted changes.** `server.js`, `repo.js`, `sync-public-modules.js`,
  `test-ui/static-hosting.js` and five files under `public/` were modified and never committed,
  and there is an untracked `flow of program.txt`. Run `git status` and `git diff` first — don't
  assume `HEAD` is what was running.
- **The native Filesystem/Share save path has not been verified on a real device.** It was added
  by analogy to the already-device-verified PDF share path and passes every browser-runnable test
  (where `Capacitor.isNativePlatform()` is always false). Exercise it on hardware before real data
  goes in. See HANDOFF.md §8.
- **`server.js` is one very large file** (~142 KB) and is the main acknowledged structural debt.

---

## 8. Quick reference — a fresh machine, start to finish

```sh
git clone <repo> && cd Plannr
# copy plannr-release.keystore + keystore.properties into this directory by hand
npm ci
npm test                                  # expect green
npm start                                 # http://localhost:3000 — sanity-check the app
npm run android:sync                      # regenerate public/ copies + the native project
# open the android/ directory in Android Studio, let it sync
cd android && ./gradlew assembleRelease
keytool -printcert -jarfile app/build/outputs/apk/release/app-release.apk   # must print a cert
adb install -r app/build/outputs/apk/release/app-release.apk
# expect a Play Protect warning on the device — More details -> Install anyway
```

Then read `README.md` and `HANDOFF.md`.
