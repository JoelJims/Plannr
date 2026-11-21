// Shared by the schema-history tests (test/migration-equivalence.test.js, test/migration-faults.test.js)
// and make-fixtures.js: load a fixture database, and describe a database exactly enough to say
// "these two are the same": the schema, user_version, and a checksum of every table's rows.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DIR = __dirname;
const manifest = () => JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

// A fixture's SQL text, after checking it is byte for byte the file the manifest describes.
function fixtureSql(entry) {
  const bytes = fs.readFileSync(path.join(DIR, entry.file));
  const got = sha256(bytes);
  if (got !== entry.sha256) throw new Error(`${entry.file}: sha256 ${got} does not match manifest.json (${entry.sha256}); the file was changed.`);
  return bytes.toString('utf8');
}

// Build a database file from a fixture.
function loadFixture(entry, file) {
  const d = new DatabaseSync(file);
  try { d.exec(fixtureSql(entry)); } finally { d.close(); }
  return file;
}

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const userTables = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const hasRowid = (d, t) => { try { d.prepare(`SELECT rowid FROM ${q(t)} LIMIT 0`).all(); return true; } catch { return false; } };

// Each value with its SQLite storage class, exactly: integers as BigInt text, reals with every bit
// (17 significant digits round-trip), text as JSON, blobs as hex.
function cell(type, v) {
  if (type === 'null') return 'N';
  if (type === 'integer') return 'I' + String(v);
  if (type === 'real') return 'R' + Number(v).toPrecision(17);
  if (type === 'text') return 'T' + JSON.stringify(v);
  return 'B' + Buffer.from(v).toString('hex');
}

// Rows of one table in a stable order (rowid, or every column for a WITHOUT ROWID table), each as a
// list of typed cells. `mask(table, column, type, value)` may replace a cell (see the timestamps note).
function tableRows(d, t, mask) {
  const cols = d.prepare(`PRAGMA table_info(${q(t)})`).all().map((c) => c.name);
  const sel = cols.map((c, i) => `typeof(${q(c)}) AS t${i}, ${q(c)} AS v${i}`).join(', ');
  // sqlite_sequence: one counter per table, in no meaningful order.
  const order = t === 'sqlite_sequence' ? 'name' : hasRowid(d, t) ? 'rowid' : cols.map(q).join(', ');
  const st = d.prepare(`SELECT ${sel} FROM ${q(t)} ORDER BY ${order}`);
  st.setReadBigInts(true);
  return { cols, rows: st.all().map((r) => cols.map((c, i) => (mask && mask(t, c, r[`t${i}`], r[`v${i}`])) || cell(r[`t${i}`], r[`v${i}`]))) };
}

// Timestamps that init() itself writes with datetime('now') (rows it seeds while upgrading) differ
// between two runs a second apart. maskSince('YYYY-MM-DD HH:MM:SS') hides created_at/updated_at
// values at or after that moment; every value a fixture already holds is older and is compared.
const maskSince = (since) => (t, c, type, v) => (type === 'text' && /^(created|updated)_at$/.test(c) && v >= since ? 'T"<written during this run>"' : null);

/** Everything that makes two databases "the same". */
function fingerprint(d, { mask } = {}) {
  const schema = d.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
    .map((r) => `${r.type} ${r.name} ON ${r.tbl_name}: ${r.sql === null ? '(auto)' : r.sql}`);
  const tables = {};
  for (const t of [...userTables(d), ...(d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get() ? ['sqlite_sequence'] : [])]) {
    const { cols, rows } = tableRows(d, t, mask);
    tables[t] = { rows: rows.length, sha256: sha256(JSON.stringify([cols, rows])) };
  }
  return { userVersion: d.prepare('PRAGMA user_version').get().user_version, schema, tables };
}
function fingerprintFile(file, opts) {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return fingerprint(d, opts); } finally { d.close(); }
}

// Every row of every table, keyed by its primary key (or rowid), for "is anything lost?" checks.
function rowsByKey(file, { mask } = {}) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const out = {};
    for (const t of userTables(d)) {
      const pk = d.prepare(`PRAGMA table_info(${q(t)})`).all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const { cols, rows } = tableRows(d, t, mask);
      const keyCols = pk.length ? pk : null;
      const rowids = keyCols ? null : d.prepare(`SELECT rowid AS r FROM ${q(t)} ORDER BY rowid`).all().map((r) => String(r.r));
      out[t] = new Map(rows.map((r, i) => [keyCols ? keyCols.map((k) => r[cols.indexOf(k)]).join('|') : rowids[i], Object.fromEntries(cols.map((c, j) => [c, r[j]]))]));
    }
    return out;
  } finally { d.close(); }
}

function checks(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      integrity: d.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check).join('; '),
      foreignKeyViolations: d.prepare('PRAGMA foreign_key_check').all().length,
    };
  } finally { d.close(); }
}

// SQL text that rebuilds the database exactly (make-fixtures.js): tables in creation order, rows in
// rowid order, the AUTOINCREMENT counters, indexes/triggers/views, then user_version.
function sqlLiteral(type, v) {
  if (type === 'null') return 'NULL';
  if (type === 'integer') return String(v);
  if (type === 'real') { const s = String(Number(v)); return /[.eE]/.test(s) ? s : `${s}.0`; } // shortest exact form; make-fixtures.js checks it reloads bit for bit
  if (type === 'text') return `'${String(v).replace(/'/g, "''")}'`;
  return `X'${Buffer.from(v).toString('hex')}'`;
}
function dumpSql(d, headerLines) {
  const out = headerLines.map((l) => `-- ${l}`);
  out.push('PRAGMA foreign_keys = OFF;', 'BEGIN;');
  const objs = d.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  for (const o of objs.filter((x) => x.type === 'table')) {
    out.push(`${o.sql};`);
    const cols = d.prepare(`PRAGMA table_info(${q(o.name)})`).all().map((c) => c.name);
    const st = d.prepare(`SELECT ${cols.map((c, i) => `typeof(${q(c)}) AS t${i}, ${q(c)} AS v${i}`).join(', ')} FROM ${q(o.name)} ORDER BY ${hasRowid(d, o.name) ? 'rowid' : cols.map(q).join(', ')}`);
    st.setReadBigInts(true);
    for (const r of st.all()) out.push(`INSERT INTO ${q(o.name)} (${cols.map(q).join(', ')}) VALUES (${cols.map((c, i) => sqlLiteral(r[`t${i}`], r[`v${i}`])).join(', ')});`);
  }
  if (d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
    out.push('DELETE FROM sqlite_sequence;');
    for (const r of d.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()) out.push(`INSERT INTO sqlite_sequence (name, seq) VALUES (${sqlLiteral('text', r.name)}, ${r.seq});`);
  }
  for (const o of objs.filter((x) => x.type !== 'table')) out.push(`${o.sql};`);
  out.push(`PRAGMA user_version = ${d.prepare('PRAGMA user_version').get().user_version};`, 'COMMIT;', '');
  return out.join('\n');
}

module.exports = { DIR, manifest, fixtureSql, loadFixture, fingerprint, fingerprintFile, rowsByKey, checks, maskSince, dumpSql, sha256 };
