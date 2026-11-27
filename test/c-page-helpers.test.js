// Workstream C clean-up: a helper two pages had copied line for line now lives once, in
// public/plannr-ui.js (window.PlannrUI), which both pages already load.
// plannr-ui.js is a plain browser script; here it runs in a node:vm context with a stand-in window.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');

function loadPlannrUI() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'plannr-ui.js'), 'utf8'), { window });
  return window.PlannrUI;
}

test('PlannrUI.parsePaise reads amounts exactly as the server does (core/parsers.js)', async () => {
  const ui = loadPlannrUI();
  assert.strictEqual(typeof ui.parsePaise, 'function');
  const { parsePaise: serverParsePaise } = await import('../core/parsers.js');
  const inputs = ['1', '0', '0.00', '0.01', '12.5', '12.50', '12.505', '1,234.56', ' 7 ', '-5', '1e3', 'abc', '', null, undefined, 42, '90071992547409.91', '900719925474099.99'];
  for (const v of inputs) assert.strictEqual(ui.parsePaise(v), serverParsePaise(v), `input ${JSON.stringify(v)}`);
  assert.strictEqual(ui.parsePaise('1,234.56'), 123456);
});

for (const page of ['contract-details.html', 'contractor-payments.html']) {
  test(`public/${page} uses PlannrUI.parsePaise, not its own copy`, () => {
    const src = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    assert.doesNotMatch(src, /function parsePaise\(/);
  });
}
