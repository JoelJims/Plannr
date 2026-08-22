// Manual test-send cooldown — cooldown.js's makeCooldown (remaining/arm/clear).
const H = require('./helpers');
const { makeCooldown } = require('../cooldown');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

test('makeCooldown: remaining()===0, then >0 after arm(), then 0 after clear()', () => {
  const c = makeCooldown(10000);
  assert.strictEqual(c.remaining('k'), 0, 'fresh key -> allowed now');
  c.arm('k');
  const r = c.remaining('k');
  assert.ok(r > 0 && r <= 10000, `armed -> a positive remaining within the window, got ${r}`);
  c.clear('k');
  assert.strictEqual(c.remaining('k'), 0, 'cleared -> allowed again');
});
