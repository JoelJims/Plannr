// Characterization test for repo.ledgers.validateImport (validateLedgerCsv in repo.js): it pins
// what the Ledger List CSV import accepts and rejects today, message for message, so the function
// can be split into helpers without changing what the user sees.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const repo = require('../repo');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

const HEADER = 'Code,Main ledger,Sub-code,Sub-ledger';
const csv = (...lines) => lines.join('\r\n');
const validate = (text) => repo.ledgers.validateImport(text);

test('an empty file, a note-only file and a wrong header are rejected as a whole', async () => {
  assert.deepStrictEqual(await validate(''), { ok: false, error: 'The file is empty.', rowErrors: [] });
  assert.deepStrictEqual(await validate('# do not edit codes\r\n'), { ok: false, error: 'The file is empty.', rowErrors: [] });
  assert.deepStrictEqual(await validate(csv('Code,Name,Sub,Subname', '1.0,A,,')),
    { ok: false, error: 'Expected columns "Code, Main ledger, Sub-code, Sub-ledger" as the first row.', rowErrors: [] });
});

test('each bad row is reported with its row number and the file is rejected', async () => {
  const r = await validate(csv(
    '# note row is skipped',
    HEADER,
    '1.5,Bad main,,',          // row 2: main code must be N.0
    '2.0,,,',                  // row 3: main with no name
    '3.0,Three,,',             // row 4: fine
    '3.0,Again,,',             // row 5: duplicate main
    '3.0,Three,3.x,Sub',       // row 6: malformed sub-code
    '3.0,Three,3.1,',          // row 7: sub with no name
    '3.0,Three,3.2,Two',       // row 8: fine
    '3.0,Three,3.2,Twice',     // row 9: duplicate sub
    '3.0,Three,4.1,Wrong',     // row 10: sub-code does not match its Code column
    '9.0,Nine,9.1,Orphan',     // row 11: main 9.0 never declared
  ));
  assert.deepStrictEqual(r, {
    ok: false,
    error: '8 row(s) failed validation.',
    rowErrors: [
      { row: 2, message: 'Row 2: Code "1.5" is malformed — a main ledger code must be "N.0".' },
      { row: 3, message: 'Row 3: main ledger "2.0" has no name.' },
      { row: 5, message: 'Row 5: code "3.0" is duplicated.' },
      { row: 6, message: 'Row 6: sub-code "3.x" is malformed — must be "N.M".' },
      { row: 7, message: 'Row 7: sub-ledger "3.1" has no name.' },
      { row: 9, message: 'Row 9: code "3.2" is duplicated.' },
      { row: 10, message: 'Row 10: sub-code "4.1" doesn\'t match its Code column ("3.0") — expected "4.0".' },
      { row: 11, message: 'Row 11: sub-ledger "9.1" references main "9.0", which is not present in this file.' },
    ],
  });
});

test('the app\'s own export validates back to the same mains and subs', async () => {
  const list = await repo.ledgers.list();
  const r = await validate(repo.ledgers.toCsv(list));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.mains, list.map((m) => ({ code: m.code, name: m.name })));
  assert.deepStrictEqual(r.subs, list.flatMap((m) => m.subLedgers.map((s) => ({ code: s.code, mainCode: m.code, name: s.name }))));
});

test('dropping a code that no row uses is fine; dropping one still in use is refused', async () => {
  const list = await repo.ledgers.list();
  assert.ok(list.length >= 6, 'seeded ledger list has 5.0 and a later main');
  const without = (code) => repo.ledgers.toCsv(list.filter((m) => m.code !== code));
  const unused = list[list.length - 1].code;
  assert.strictEqual((await validate(without(unused))).ok, true);

  H.seedContract({ ledgerCode: '5.0' });
  const r = await validate(without('5.0'));
  assert.deepStrictEqual(r, {
    ok: false,
    error: 'Codes are permanent — some were removed or altered in this file but are still used by existing rows: 5.0 (1 row). Only the ledger/sub-ledger NAME can be changed; the code itself cannot.',
    rowErrors: [{ row: null, message: 'Code "5.0" was removed or altered in this file, but is still used by 1 existing row. Codes cannot be changed once rows reference them — only the name can.' }],
  });
});
