# Plan: send the PDF to WhatsApp or email, from Overview and from a reminder

Status: **part 1 built (2026-11-25), no button sends anything yet.** Written 2026-11-15; plugin
versions and the notification action support re-checked on 2026-11-22 against the installed packages
(section 7).

Built on 2026-11-25:
- Settings: `GET/PUT /api/share-settings`. They live in `core/routes/notification-times.js` (not a new
  `core/routes/share-settings.js`), because both hosts already register that file. `share_email_to`
  is in `CONTACT_SETTINGS_KEYS`. Tests: `test/ws2c-share-settings.test.js` (both passes).
- Home: the "Sending PDFs" settings. Test: `npm run test:share-settings`.
- `@capawesome/capacitor-mail-composer` pinned to exactly `0.2.2`, in `sync-public-modules.js` and the
  import maps of `overview.html` and `home.html`. Test: `test/ws2c-mail-composer.test.js`.
- `ShareToPlugin.java` (WhatsApp, then WhatsApp Business; "not-installed" otherwise), registered in
  `MainActivity.java`, with `<queries>` in the manifest. Test: `test/ws2c-share-to-plugin.test.js`.

Not built yet: `public/share-pdf.js` and the two Overview buttons (build step 4 and the rest of 5
and 6), the reminder data change (step 2), and the reminder **Send PDF** action (step 7, next).

**Decided by the owner on 2026-11-22:** the **Send PDF** action goes on the existing daily report
reminders (ids 101–105). A payment-due reminder is a separate, later feature and is not part of
this plan (section 2).

## 1. What exists today

| Feature | State | Where |
|---|---|---|
| PDF to WhatsApp | Partial | `public/overview.html` → `downloadPdf()` builds the PDF (`/api/overview/pdf`, the `@capgo/capacitor-pdf-generator` plugin), writes it to the app's cache folder and opens Android's share sheet (`Share.share`, title "Share report"). You pick WhatsApp in the sheet yourself. |
| PDF to email with recipient, subject, attachment | Partial | The same share sheet can hand the PDF to Gmail, but `@capacitor/share` 8.0.3 has no recipient field (its options are `title`, `text`, `url`, `files`, `dialogTitle`), so the recipient is never filled in. |
| A reminder with a "Send PDF" button | Missing | `public/notifications.js` schedules up to 5 daily reminders (ids 101–105, "Time for today's report.") and one backup-overdue reminder (id 201). Tapping one opens Overview or Data Backup. No action buttons. |

How reminders work now: Home saves up to 5 times through `GET/PUT /api/notification-times` (settings key
`daily_report_times`). `notifications.js` schedules them on the device with
`@capacitor/local-notifications` 8.3.1: daily, exact alarms only when Android allows them ("Allow
on-time reminders" button). Nothing uses the network.

## 2. What Android allows, and what it does not

- **Allowed:** a notification with action buttons. In `@capacitor/local-notifications` an action is
  registered with `registerActionTypes()` and attached with `actionTypeId`. On Android each button is
  a `PendingIntent.getActivity(...)` (see the plugin's `LocalNotificationManager.kt`), so tapping it
  **opens Plannr** and fires `localNotificationActionPerformed` with the button's `actionId`.
- **Allowed:** once Plannr is open because you tapped, it may build the PDF and open WhatsApp or the
  mail app with the file attached. That is a user-started action, so Android's limits on starting
  screens from the background do not apply.
- **Not allowed: fully automatic sending.** No app can send a WhatsApp message or an email on your
  behalf without you tapping Send. WhatsApp offers that only through its Business API, which is an
  online server service. That would break offline-first, so it is out of scope. The best Plannr can
  do is two taps: the reminder's **Send PDF**, then **Send** in WhatsApp or the mail app.
- **Not allowed: building the PDF while the app is closed.** The PDF is drawn by the WebView, which
  only exists while the app is open. The reminder therefore opens the app first.

**Which reminder gets the Send PDF button — decided (owner, 2026-11-22): the daily report
reminders.** Plannr has no payment-due reminder today. The only reminders are the daily report
reminders (ids 101–105, `SLOT_IDS` in `public/notifications.js`) and the backup-overdue reminder
(id 201, `BACKUP_REMINDER_ID`). **Send PDF** goes on the daily report reminders, ids 101–105, and
only on them; the backup-overdue reminder keeps no buttons. Contracts do store scheduled payment
dates (the `contract_payment_dates` table, `core/routes/contracts.js`), but nothing schedules a
notification from them. A payment-due reminder (for example "Payment to <contractor> due today")
is a **separate, later feature**. It is not part of this plan and gets its own plan when the owner
asks for it.

## 3. Settings (new, on Home under the reminders)

| Setting | Values | Default | Stored as (settings table) |
|---|---|---|---|
| Send PDFs to | WhatsApp · Email · Ask each time | Ask each time | `share_target` = `whatsapp` / `email` / `ask` |
| Email recipient(s) | up to 5 addresses, comma-separated | empty | `share_email_to` (JSON array of strings) |
| Email subject | text, up to 120 characters | `Plannr report – {date}` | `share_email_subject` |
| Per reminder: which PDF | Full · Pie · Table · Ledger, Light/Dark | Full, Light | `daily_report_times` becomes a list of `{ time, part, theme }`; a plain `"HH:MM"` string still reads as `{ time, part: 'full', theme: 'light' }` |

Decisions in this design (safest, reversible):
- **New keys, not the retired ones.** The desktop era left `daily_report_recipients` and
  `daily_report_whatsapp` behind (see `backup-format.js` `CONTACT_SETTINGS_KEYS`). They may still hold
  old addresses, so the new feature does not read them; it never picks up a recipient you did not
  type here.
- **Contacts stay opt-in in backups.** `share_email_to` joins `CONTACT_SETTINGS_KEYS`, so a JSON backup
  includes it only when you tick the contacts box, as today.
- **No WhatsApp number is stored.** WhatsApp opens on its own contact picker; choosing the chat stays
  with you.

## 4. The Android flow

```
Reminder fires ── [Send PDF] ──► Plannr opens (Overview)
                                   │ builds the reminder's PDF (part + theme), writes it to cache
                                   ▼
                     share_target = whatsapp ──► WhatsApp opens with the PDF attached ──► you pick the chat, tap Send
                     share_target = email ─────► mail app opens: To, Subject, PDF attached ──► you tap Send
                     share_target = ask ───────► Android share sheet (today's behaviour)
```

- Overview gets the same choice next to **Download PDF**: "Send to WhatsApp", "Send by email", or the
  share sheet, so the feature works without a reminder too.
- **WhatsApp missing** (not installed, or the emulator): fall back to the share sheet and say so.
- **No mail app** (`canComposeMail()` is false): fall back to the share sheet and say so.
- Tapping the notification body (not the button) keeps today's behaviour: open Overview, build
  nothing.
- The PDF file stays in the app's cache folder (as today); Android clears it when space is short.

## 5. Offline

- Building the PDF needs no network (unchanged; `test/offline.test.js` and `npm run test:offline`).
- Opening WhatsApp or the mail app needs no network either. They hold the message until the phone
  is back online.
- Following the "Offline first" rule in `CONTRIBUTING.md`, the button is optional and labelled, and
  works only when tapped. When `navigator.onLine` is false Plannr shows a clear note: "You're
  offline. WhatsApp/your mail app will send it when you're back online."
- Logging data never depends on any of this.

## 6. Desktop (Electron, Phase 4 of `docs/cross-platform-plan.md`)

- **PDF:** `webContents.printToPDF` (already planned for step 4.2), saved with a Save dialog.
- **Email:** `shell.openExternal('mailto:…?subject=…')` opens the mail program with To and Subject,
  but **`mailto:` cannot attach a file**. Plannr saves the PDF, opens the draft, and shows the file in
  its folder (`shell.showItemInFolder`) so you drag it in. Attaching automatically would need Simple
  MAPI through a native module on Windows; that is not planned.
- **WhatsApp Desktop:** its `whatsapp://send?text=` link cannot attach a file either. Same approach:
  save, show the file, open WhatsApp.
- **Reminders:** Electron `Notification`. Action buttons work on macOS; on Windows they are limited,
  so a click on the notification opens Plannr and shows the same buttons there.
- **Limit, stated plainly:** on desktop it is three steps (save, open, attach), not two.

## 7. Plugins

**Already installed, no change needed.** Versions read from `node_modules/*/package.json` on
2026-11-22. `package.json` gives a caret range for each; `package-lock.json` pins the exact version
that is installed. Keep these versions for this feature (no upgrade as part of it).

| Plugin | Installed | `package.json` | Used here for |
|---|---|---|---|
| `@capacitor/share` | 8.0.3 | `^8.0.1` | the share sheet (today's path and every fallback) |
| `@capacitor/local-notifications` | 8.3.1 | `^8.3.1` | the reminders and the **Send PDF** action |
| `@capacitor/filesystem` | 8.1.5 | `^8.1.3` | writing the PDF to the cache folder (`Directory.Cache`) |
| `@capgo/capacitor-pdf-generator` | 8.0.53 | `^8.0.36` | drawing the PDF |

Notification actions, checked in the plugin's own type definitions
(`node_modules/@capacitor/local-notifications/dist/esm/definitions.d.ts`, version 8.3.1):
- `registerActionTypes(options)` exists and is marked "Only available for iOS and Android" (line 98).
- An `ActionType` has an `id` and a list of `actions`; each `Action` has an `id` and a `title`
  (lines 372 and 438). A notification points to its action type with `actionTypeId` (line 716).
- Tapping a button fires `localNotificationActionPerformed` with `actionId` and the original
  notification (lines 236 and 1018). `public/notifications.js` already listens to this event for
  taps on the notification body.
- The `foreground`, `destructive` and `input` (reply text) options are iOS only. On Android every
  button opens the app (`PendingIntent.getActivity` in the plugin's
  `android/src/main/kotlin/.../LocalNotificationManager.kt`, line 255), which is what section 2
  expects.

**New, to be added in build step 5 (not now).**

**`@capawesome/capacitor-mail-composer`, pinned to exactly `0.2.2`** (published 2026-09-04, MIT,
peer `@capacitor/core >=8.0.0`, repository `capawesome-team/capacitor-plugins`).

- It provides `composeMail({ to, cc, bcc, subject, body, isHtml, attachments: [{ path }] })` and
  `canComposeMail()`.
- It opens the mail app and never sends by itself. On Android attachments go through the
  FileProvider Capacitor already registers (`${applicationId}.fileprovider`). The cache folder is
  already in `android/app/src/main/res/xml/file_paths.xml` (`cache-path`).
- Why this one: it is the only one found with a stated Capacitor 8 line and recent releases (0.0.1
  in July 2026 to 0.2.2 in September 2026). The alternative, `capacitor-email-composer` 8.0.0 (January
  2026), works too but releases less often.
- Re-check the version and changelog before installing.

**WhatsApp needs no new dependency.** A small local Android plugin (about 40 lines of Java, in
`android/app/src/main/java/.../ShareToPlugin.java`) sends `ACTION_SEND` with the PDF's FileProvider URI
and `setPackage("com.whatsapp")` (then `com.whatsapp.w4b`, WhatsApp Business). The manifest needs
`<queries>` for both packages (Android 11+ package visibility). The share sheet stays the fallback.

## 8. Files to change

| File | Change |
|---|---|
| `public/share-pdf.js` (new) | build PDF → write to cache → send to target, with the fallbacks; moved out of `overview.html` `downloadPdf()` |
| `public/overview.html` | the two new buttons; `downloadPdf()` calls `share-pdf.js` |
| `public/notifications.js` | `registerActionTypes` ("Send PDF"), `actionTypeId` on the daily report reminders (ids 101–105) only, the listener opens Overview with `?send=<part>&theme=<theme>` |
| `public/home.html` | the settings above, per-reminder PDF choice |
| `core/routes/share-settings.js` (new) | `GET/PUT /api/share-settings` with validation (addresses, subject length, target); one copy for both backends |
| `core/routes/notification-times.js` | `/api/notification-times` accepts the `{ time, part, theme }` objects and still reads old strings |
| `backup-format.js` | `share_email_to` joins `CONTACT_SETTINGS_KEYS` |
| `android/app/src/main/AndroidManifest.xml` | `<queries>` for `com.whatsapp`, `com.whatsapp.w4b` |
| `android/app/src/main/java/com/plannr/app/ShareToPlugin.java` (new) + `MainActivity` | the WhatsApp intent |
| `package.json`, `sync-public-modules.js`, the import maps in `public/*.html` | the pinned mail-composer plugin |
| `docs/PHONE-TEST-CHECKLIST.md`, `CHANGELOG.md`, `HANDOFF.md` | new checks and notes |

## 9. Tests

- **Node, both passes (dev server and phone code):** the share-settings route (valid and invalid
  addresses, more than 5, subject too long, unknown target); old reminder strings still read; new
  objects round-trip; contacts excluded from a JSON backup unless opted in.
- **UI (Playwright, with recording stand-ins for the plugins, as `test/shim-capacitor-fake.mjs` does
  for the PDF plugin):**
  - each target calls the right plugin with the PDF path, recipient and subject;
  - each fallback (no WhatsApp, no mail app) opens the share sheet and shows its message;
  - the offline note appears when `navigator.onLine` is false;
  - nothing is sent anywhere (the existing offline tripwire).
- **Emulator (scripted like `docs/PHONE-TEST-CHECKLIST.md`):**
  - a daily report reminder shows the **Send PDF** button, and tapping it opens Plannr and builds
    the PDF; the backup-overdue reminder (id 201) has no button;
  - with no mail app or WhatsApp on the emulator, the fallback sheet opens;
  - never send anything; close every sheet or composer with BACK.
- **Real phone, by the owner:**
  - WhatsApp opens with the PDF attached;
  - Gmail opens with To, Subject and the PDF attached;
  - nothing is sent until you tap Send;
  - airplane mode shows the offline note.

## 10. Build order (about 30 minutes each, one commit each, all suites after each)

1. `core/routes/share-settings.js` with its node tests (both passes). No UI yet.
2. Reminder data: `{ time, part, theme }` with the old-string fallback, and tests.
3. Home: the settings UI, and a UI test.
4. `public/share-pdf.js`: move today's share-sheet path out of `overview.html` unchanged; the PDF UI
   tests stay green.
5. Install `@capawesome/capacitor-mail-composer@0.2.2` (pinned), add it to the sync and import maps,
   and add the email target with its fallback and a UI test with a stand-in.
6. The WhatsApp plugin (Java) and manifest `<queries>`, plus the fallback; build the APK.
7. Notification action "Send PDF" in `notifications.js` on the daily report reminders (ids
   101–105), and the `?send=` handling on Overview.
8. Emulator run of the new checks; add them to `docs/PHONE-TEST-CHECKLIST.md`.
9. Desktop equivalent: only after Phase 4 step 4.2 exists.

Decided:
- **Which reminders get Send PDF** (owner, 2026-11-22): the daily report reminders, ids 101–105.
  A payment-due reminder is a separate, later feature, not part of this plan (section 2).

Open questions for the owner:
- Should a reminder's **Send PDF** button exist only when a target is set, or always, falling back to
  the share sheet?
- Do the retired `daily_report_*` contact keys get deleted by a migration? That needs a decision and a
  pre-migration snapshot, and is not part of this plan.
