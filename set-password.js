// set-password.js — the ONLY recovery path for a lost/broken login.
//
// Plannr deliberately has no in-app password reset, so recovery means writing a fresh hash directly
// into users. This CLI does that safely. It is NOT reachable from the app (no route, no button).
//
//   PLANNR_DB=/path/to.db node set-password.js <username>          # isolated (testing)
//   node set-password.js <username> --i-really-mean-the-live-db    # the real recovery use (live)
//
// The password is NEVER an argument (argv is visible in `ps` and shell history) — it is read from
// stdin with echo disabled, twice. Strength + hashing are the SAME code the app uses (password.js),
// so this can't set something the app would reject or hash differently.

// 1) Guard the TARGET before opening anything. Targeting live is this tool's legitimate purpose, so
//    it goes through the shared guard (prints the absolute path; refuses live-without-flag).
require('./db-guard').guardDbTarget();
const pw = require('./password');
const { db } = require('./db');

const username = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!username) {
  console.error('Usage: [PLANNR_DB=…] node set-password.js <username> [--i-really-mean-the-live-db]');
  process.exit(1);
}

// Non-TTY (piped, e.g. tests): buffer stdin and serve one line per prompt. TTY: raw mode, silent.
let pipedQueue = null;
function drainPipedStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf.split('\n').map((l) => l.replace(/\r$/, ''))));
  });
}
function readSecret(promptText) {
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    if (!process.stdin.isTTY) { const line = pipedQueue.length ? pipedQueue.shift() : ''; process.stdout.write('\n'); return resolve(line); }
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let s = '';
    const onData = (ch) => {
      const code = ch.charCodeAt(0);
      if (ch === '\r' || ch === '\n' || code === 4) { // Enter or Ctrl-D
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); resolve(s);
      } else if (code === 3) { // Ctrl-C — abort, nothing changed
        stdin.setRawMode(false); process.stdout.write('\n'); process.exit(1);
      } else if (code === 127 || code === 8) { // backspace / DEL
        s = s.slice(0, -1);
      } else { s += ch; }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  if (!process.stdin.isTTY) pipedQueue = await drainPipedStdin();

  // 2) Verify the user exists BEFORE anything else; print who we are about to change; confirm.
  const user = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get(username);
  if (!user) { console.error(`No user named "${username}" in this database.`); process.exit(1); }
  console.log(`About to set a NEW password for: ${user.username} (${user.display_name || 'no display name'}, id ${user.id}).`);
  console.log("This will also DELETE that user's sessions — they will be signed out on EVERY device.");
  const confirm = await readSecret(`Type the username "${user.username}" again to confirm: `);
  if (confirm !== user.username) { console.error('Confirmation did not match — nothing was changed.'); process.exit(1); }

  // 3) New password, twice, echo off. Same strength rule the app enforces (reused, not restated).
  const p1 = await readSecret('New password: ');
  const p2 = await readSecret('Confirm new password: ');
  if (p1 !== p2) { console.error('Passwords do not match — nothing was changed.'); process.exit(1); }
  const strengthErr = pw.passwordError(p1);
  if (strengthErr) { console.error(strengthErr + ' Nothing was changed.'); process.exit(1); }

  // 4) Hash with the shared hasher (async now — awaited), write it, invalidate sessions — atomically.
  const hash = await pw.hash(p1);
  let removed;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    removed = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id).changes;
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  // 5) Sanity check only — NEVER print the hash itself.
  console.log(`\nDone. Password updated for "${user.username}".`);
  console.log(`  new hash: length ${hash.length}, prefix "${hash.slice(0, 4)}" (the hash itself is not printed).`);
  console.log(`  sessions deleted: ${removed} — the user is now signed out on every device and must log in with the new password.`);
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('set-password failed:', (e && e.message) || e); process.exit(1); });
