# Plannr for developers

The README is for people who use Plannr. This page and the documents it links are for people who
change it.

## What it is, technically

Plannr is an offline expense ledger for a single building project, packaged as an Android app with
[Capacitor](https://capacitorjs.com/). The screens are ordinary HTML and JavaScript running in a
WebView. There is no server, no account and no sign-in, and the app needs no network: its data is in
a SQLite database on the phone.

**The phone app is the product.** `server.js` is a desktop tool for development and testing only:
it serves the same screens against a separate database file on your computer, the phone app never
uses it, and it says so when it starts (`DEV MODE – not used by the phone app`). It listens on this
computer only (127.0.0.1) unless you set `PLANNR_HOST` and a `PLANNR_TOKEN`.

## How to run it

Android (the app):

```sh
npm install
npm run android:sync
```

Then open the `android/` folder in Android Studio and run it on the emulator or a test device. A
phone that already holds real data gets updates only as [RELEASE.md](RELEASE.md) and
[PHONE-TEST-CHECKLIST.md](PHONE-TEST-CHECKLIST.md) say (never uninstall).

Desktop dev server (development and tests only):

```sh
npm start
```

Demo data for screenshots or trying things out goes into a database of its own, never
`data/plannr.db`:

```sh
PLANNR_DB=/tmp/plannr-demo.db npm run seed:demo
```

## Tests

```sh
npm test                 # the desktop pass, then the phone-code pass (test/phone-code-differences.json)
npm run test:slow        # the slow migration fault tests
npm run test:ui          # one Playwright UI suite; every test:* script is one suite
```

The UI suites need `npm run sync:public-modules` first and Playwright's Chromium
(`npx playwright install chromium`). GitHub Actions (`.github/workflows/tests.yml`) runs `npm test`
on Ubuntu and Windows and every UI suite on Ubuntu: on each push to `main` and `plannr-phase2`, on
pull requests into `main` and `plannr-phase3`, and when started by hand (`workflow_dispatch`). The
push trigger still names `plannr-phase2`, not `plannr-phase3`, so a merge into `plannr-phase3` gets
no run of its own (open). Tests never open `data/plannr.db`: `run-tests.js` checks it, and `db.js`
refuses it inside the test runner.

## How it's built

The screens are plain HTML and JavaScript in `public/`, with no framework and no build step. All
data is in SQLite, and `db.js` owns the schema: on startup the database upgrades itself through
numbered migrations, with a safety snapshot first. `repo.js` is the one layer every read and write
goes through, and `ledgers.js` holds the starting list of spending categories.

Every API route except the dev server's `/api/health` lives once in `core/routes/` and runs in both
backends: `server.js` (Express, on the desktop) and `public/local-api.js` (inside the app, answering
the screens' requests without a network). On the phone the data starts in the WebView's
`localStorage` (sqlite-wasm). Data Backup → **Move to the new storage** moves it into a database
file of its own (`@capacitor-community/sqlite` behind Plannr's adapter). `android/` holds the
native project Capacitor generates.

## Backups and Auto Backup

The Data Backup page saves a full JSON backup, an encrypted backup (AES-256-GCM, a passphrase you
choose) and CSV files for a spreadsheet. Restores are checked in full before anything changes, and a
safety copy is taken first. Android's Auto Backup copies only what
`android/app/src/main/res/xml/backup_rules.xml` lists (the database file, its storage marker and the
old `localStorage` copy); the encrypted backup you save yourself is the safest copy to keep.

## What it doesn't do

- **One person, one project.** There are no accounts and no way to share a ledger with anyone else.
- **No sync.** Plannr never sends your data anywhere itself. Moving data to another phone means
  exporting a backup file and importing it there.
- **Not on the Play Store yet.** You build and install it yourself from this repository.

## Documents

| Document | For |
|---|---|
| [SETUP.md](../SETUP.md) | Setting up a new computer, building the Android app |
| [HANDOFF.md](../HANDOFF.md) | How everything works, in detail |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Changing the database safely (migrations, backups, tests) |
| [RELEASE.md](RELEASE.md) | Releasing an update to the phone without losing data |
| [release-plan.md](release-plan.md) | Plan for the first public release APK: the signing key, version numbers, moving from the debug build, release notes, a checklist, open questions |
| [PHONE-TEST-CHECKLIST.md](PHONE-TEST-CHECKLIST.md) | Checks on a real phone before a release, and the owner's phone round (backups proven on the emulator first) |
| [cross-platform-plan.md](cross-platform-plan.md) | The plan for one shared core, desktop and other users |
| [step-1.4-storage-plan.md](step-1.4-storage-plan.md) | Moving the phone's data into a database file of its own (done) |
| [storage-proposal.md](storage-proposal.md) | The first proposal for that move (replaced by the plan above) |
| [share-and-reminder-pdf-plan.md](share-and-reminder-pdf-plan.md) | Plan: sending the PDF to WhatsApp or email, also from a reminder (not done) |
| [security-quality-review-2026-11-21.md](security-quality-review-2026-11-21.md) | The latest security and quality review, with each finding's current status and what is still open |
| [CHANGELOG.md](../CHANGELOG.md) | What changed |
| `session-report-*.md` | Dated records of past work sessions ([2026-11-21](session-report-2026-11-21.md), [2026-11-22](session-report-2026-11-22.md), [2026-11-22, parallel](session-report-2026-11-22-parallel.md)). History, not the current state |
| [pr-plannr-phase2.md](pr-plannr-phase2.md) | The description of the pull request that merged Phase 2 into `main` (a record) |

## README images

The images in `docs/images/` use demo data only (`seed-demo.js`, with generic names), made on an
Android emulator after a fresh install. The PDF image is the Overview PDF's own page with the same
data.
