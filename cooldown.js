// Tiny in-memory per-key cooldown: allows at most one "arm" per windowMs per key.
// Used to throttle the manual test-send endpoints so rapid repeated clicks can't spam
// real recipients or blow through Gmail's quota / trip WhatsApp's automation limits.
// Not persistent (resets on restart) — fine for click-throttling, same as the auth
// rate limiter. Keyed by session token so it's per-session.
function makeCooldown(windowMs) {
  const last = new Map(); // key -> last-armed epoch ms
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, t] of last) if (now - t >= windowMs) last.delete(k); // prune expired
  }, windowMs);
  if (timer.unref) timer.unref(); // never keep the process alive on its own
  return {
    // Milliseconds until the next arm is allowed for this key (0 = allowed right now).
    remaining(key) { const t = last.get(key); return t ? Math.max(0, windowMs - (Date.now() - t)) : 0; },
    arm(key) { last.set(key, Date.now()); },   // start the cooldown
    clear(key) { last.delete(key); },           // cancel it (e.g. nothing was actually sent)
  };
}

module.exports = { makeCooldown };
