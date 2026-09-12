# Plannr

## What it is

Plannr is an offline expense ledger for a single building project, packaged as an Android app. One
person installs it on their own phone and uses it to record what has been paid out, what has come in,
and what is still owed on a construction contract. There is no server, no account and no sign-in, and
the app makes no network requests — everything lives in a database file on the device. It is built
with [Capacitor](https://capacitorjs.com/), so the interface is ordinary HTML and JavaScript running
in a WebView; that same interface also runs on a desktop through `node server.js`, which is how it is
developed and tested.

Built by Joel Jims — [github.com/JoelJims](https://github.com/JoelJims).

## Screenshots

| Home | Cash Outflow | Overview |
|---|---|---|
| ![Home screen](screenshots/home.png) | ![Cash Outflow screen](screenshots/cash-outflow.png) | ![Overview screen](screenshots/overview.png) |

## What it does

- **Records money in and out.** Every credit and debit is a dated entry with a reason and a note of
  who paid, so the running total always traces back to something you typed.
- **Tracks what the contractor is owed.** Record the contract value and each payment made against it;
  Plannr shows the balance still outstanding. The contract price can be a figure you type, or a rate
  per square foot multiplied by the measured area once the building is finally measured. It covers one
  contract at a time — the database itself stops you having two active contracts.
- **Sorts spending into categories.** 24 main categories with sub-categories underneath, covering
  materials, labour, fees and the rest. You can rename, add and remove them yourself by exporting the
  list as a CSV, editing it and importing it back.
- **Keeps a running total against allowance caps.** Where the contract sets a ceiling for something
  like flooring, Plannr adds up what you have actually spent against it and shows whether you are over
  or under.
- **Records loans** taken for the build, with interest paid tracked as ordinary spending.
- **Shows an overview** — a colour-coded pie chart of where the money went, totals for any date range
  you pick, and a PDF you can save or share.
- **Deleted items go to a recycle bin instead of vanishing**, so a mistaken delete can be undone.
- **Backs itself up.** A full backup file you can restore from, an encrypted version protected by a
  passphrase you choose, and a plain CSV export for opening in a spreadsheet.

## How to run it

Desktop:

```sh
npm install
npm start
```

Android:

```sh
npm run android:sync
```

Then open the `android/` folder in Android Studio and run it on a device or emulator.

Tests:

```sh
npm test
```

## How it's built

The screens are plain HTML and JavaScript in `public/` — no framework, no build step. Everything
underneath stores its data in SQLite, and `db.js` owns the schema: on startup the database updates
itself safely, even if it runs twice. `repo.js` is the single layer every read and write goes
through, and `ledgers.js` holds the starting list of spending categories. What differs between the
two ways of running is only what answers the screens' requests. On the desktop that is `server.js`,
an ordinary Express server reading a database file on your computer. On Android it is
`public/local-api.js` — a small piece of code that answers the app's requests locally instead of over
a network — backed by `public/db-engine.js`, a database that runs inside the app itself. `android/`
holds the native project Capacitor generates. Maintainer-level detail lives in
[HANDOFF.md](HANDOFF.md).

## What it doesn't do

- **One person, one project.** There are no accounts and no way to share a ledger with anyone else.
- **No sync.** Nothing leaves the device on its own. Moving data to another phone means exporting a
  backup file and importing it there.
- **Not on the Play Store.** You build and install it yourself from this repository.
