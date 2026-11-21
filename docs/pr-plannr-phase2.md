# Pull request: merge `plannr-phase2` into `main`

> Ready-to-use description for a pull request from `plannr-phase2` into `main`. **Not opened.**
> Paste everything below the line as the PR body when you open it.

---

## Summary

`plannr-phase2` is everything since the senior review of `main` (2026-11-14): the safety fixes from
that review, complete backups and versioned migrations, one shared core for the phone and the dev
server, and step 1.4, which moves the phone's data out of the WebView's storage (full at about
2.8 MB) into a database file of its own, with checks and a way back. 101 commits, all with
their tests; nothing in the shipped app needs the network.

**Merging also closes a security gap on `main`:** `main`'s `server.js` listens on every network
interface with no login (`app.listen(PORT, '0.0.0.0')`), so anyone on the same Wi-Fi can export or
replace the data while it runs. This branch listens on 127.0.0.1 only, with a Host allow-list against
DNS rebinding, and an opt-in LAN mode that needs a 16+ character token (`a3d5571`).

## What changes

**Safety and data (Phase 1 safety fixes, Steps 1–9)**
- The dev server: loopback only by default, Host allow-list, LAN only with `PLANNR_HOST` and
  `PLANNR_TOKEN`; hardening headers; it is marked as the dev server and is not used by the phone app.
- JSON backup v2 rebuilds the app exactly (every table and column); the import is checked in full
  before anything changes, takes a safety copy, and runs in one transaction.
- Versioned database migrations with a safety snapshot first; the newest 3 snapshots are kept; a
  database from a newer Plannr is refused.
- Storage meter and "Storage is full" messages; Android Auto Backup rules (under 25 MB).
- `npm run release:android`, `docs/RELEASE.md`, safe-update guards; `scripts/phone-test.ps1` and
  `docs/PHONE-TEST-CHECKLIST.md`.

**One core for the phone and the dev server (cross-platform plan steps 1.1–1.3)**
- Every API route lives once in `core/routes/` and runs in both backends (`server.js` and the
  phone's `public/local-api.js`); the HTTP tests run against both.
- Shared body rules, JSON 404s, input parsers, ledger index, Overview and its PDF content.

**Step 1.4: storage**
- A (encryption): one backup encryption (`core/backup-crypto.js`) for both; known-answer files
  (`test/fixtures/backup-kat/`) that every later version must open.
- B (async database interface): every database call is awaited through one adapter interface;
  the old upgrade code runs unchanged through it, proven write for write against the old runner on
  every historical schema (`test/fixtures/schema-history/`, `legacy-shapes/`).
- C (the phone's database file): `@capacitor-community/sqlite` 8.1.1 (pinned) behind Plannr's own
  adapter and storage plugin (`PlannrStorage`); the storage move (encrypted backup first, safety copy,
  copy, check every table, switch only if all of it matches); move back, use the old copy, delete
  the old copy; startup chooses the storage from a marker file and shows a recovery screen when it
  cannot; the Data Backup page runs the move; Auto Backup includes the database file.
- D (desktop): the dev server restores an encrypted backup through the same file adapter, with a
  whole-database safety copy first; `desktop-paths.js` for the future Electron app's data folder.

**Review fixes (2026-11-21)**
- `ed52850` Q1 (High): a database first made by the two oldest schemas starts again (the removed login's `sessions` table is import-owned).
- `678092c` F1: ledger codes from a restored backup are escaped wherever they go into HTML.
- `a3ea627` R2: a `PLANNR_DB` that is set but empty is refused instead of opening `data/plannr.db`.
- `d33953b` S9: `.gitignore` also covers other keys, `.env` variants and exported data files.
- The full review, with the open findings and the decisions they need: `docs/security-quality-review-2026-11-21.md`.

## Test results (at `e691756` and later documentation commits)

| Suite | Result |
|---|---|
| `npm test`, desktop pass | 665 tests: 662 pass, 3 skipped |
| `npm test`, phone-code pass | 213 of 230 (the 17 known differences, nothing new) |
| UI suites (Playwright) | all 15 pass |
| `npm run test:slow` | 2 of 2 pass |
| Emulator (`plannr-test`, Android 16) | E1–E6 pass on `5736195`; on the RC `53db636`: E1 (16 of 16) and E6 (27 of 27); `phone-test.ps1`: S, 1, 2, 3 pass, its PDF checks hit the app's 25 s limit on a slow emulator |

Every new test was proven by breaking the code it guards and watching it fail. No CI is set up
(no workflow in the repository): these were run locally.

## Known limits

- On the old storage (`localStorage`), Android's WebView writes to disk a few seconds after the
  page; a kill can lose the last seconds of saves. On the database file, a save is on disk when it
  answers. The move fixes this, but it is the user's choice to run it.
- A restore whose migrations fail after the file is replaced leaves the backup's data in place,
  with the safety copy beside it (no automatic roll-back yet; review S3/Q6).
- The PDF export gives up after 25 s ("the native print adapter did not respond"), which a slow
  emulator reached; real phones were not measured.
- The APK grew from about 6 MB to 15 MB (the storage plugin's native SQLite library).
- The storage plugin brings `USE_BIOMETRIC` and `USE_FINGERPRINT` permissions that Plannr does not
  use (no prompt; review S7).
- Pages load slowly with many entries on the phone (Overview about 10 s with 10,000 entries; the
  Data Backup page 10–15 s on a slow emulator): the efficiency work is not done.
- Not covered by tests on a device: the share sheet target, a real phone's storage limit, and the
  Auto Backup restore on a real Google account.

## Real-phone checks still needed before merging

On the RC (`D:\Backups\plannr\Plannr-debug-rc-53db636.apk`, SHA-256 `1c54c4c8…e1f0`), with **test
data only**, from `docs/PHONE-TEST-CHECKLIST.md`:

- [ ] 0 phone details; 1 data location; 2 meter and the real `localStorage` limit
- [ ] 3 JSON and encrypted export/restore with categories
- [ ] 4 airplane mode (offline Home and PDF); 5 update over the old version; 6 Auto Backup
- [ ] 8 this build's changes; S storage check (`phone-test.ps1 -AllowExisting`)
- [ ] 9 the storage move with test data (move, move back, delete the old copy, a kill during the move)

Only after these pass: the real data, in the order in the checklist's "Moving your real data"
(back up first, install over it, check, move, verify, and only after a week delete the old copy).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
