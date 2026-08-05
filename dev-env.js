// Preload for `npm run dev` (loaded via `node --require ./dev-env.js` BEFORE server.js). Makes the
// --watch dev loop safe:
//   * PLANNR_NO_WHATSAPP=1 — whatsapp.init() is a clean no-op: no client, no Chromium, no reconnect on
//     every file save (that reconnect-per-save pattern is what throttled the WhatsApp account).
//   * PLANNR_NO_CATCHUP=1  — no boot catch-up, so a restart never attempts a send.
// Because WhatsApp never initialises, everReady() stays false and shutdown() skips the (305-file)
// snapshot — right for a real shutdown, wrong for a dev restart. server.js still runs as the main
// module (require.main === module), so it boots normally. `npm start` does NOT load this file, so
// production is completely unaffected: real WhatsApp, real catch-up, real shutdown snapshot.
process.env.PLANNR_NO_WHATSAPP = '1';
process.env.PLANNR_NO_CATCHUP = '1';
console.log('[dev] PLANNR_NO_WHATSAPP=1, PLANNR_NO_CATCHUP=1 — WhatsApp + boot catch-up disabled for the --watch loop.');
