// The checks after the storage move copies the database (step 1.4 C4; docs/step-1.4-storage-plan.md §2.3).
//
// fingerprint(db) reads a database through the async interface (core/db-adapter.js), so the same code
// runs on both copies: the old one in localStorage (wasm-kvvfs) and the new file (capacitor-sqlite),
// and on node-sqlite in the tests. compareFingerprints(old, new) lists every difference; the move
// goes ahead only when the list is empty. What is compared:
//   - PRAGMA integrity_check on the new copy must be "ok";
//   - PRAGMA user_version;
//   - the schema text in sqlite_master, object by object (tables, indexes, triggers, views);
//   - for every table, sqlite_sequence included (the AUTOINCREMENT counters): the row count, and a
//     SHA-256 of all its rows in rowid order. Each value is hashed together with its SQLite type
//     (typeof()), so 1, 1.0 and '1' are three different values. A BLOB is hashed as its hex text.
// Rowid values themselves are not hashed (a table without an INTEGER PRIMARY KEY may be renumbered
// by VACUUM, keeping the order); an INTEGER PRIMARY KEY is a column and is hashed like any other.

const q = (name) => '"' + String(name).split('"').join('""') + '"';
const lit = (s) => "'" + String(s).split("'").join("''") + "'";

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function tableRows(db, table, cols) {
  if (!cols.length) return [];
  const sel = cols.map((c, i) => `typeof(${q(c)}) AS t${i}, CASE typeof(${q(c)}) WHEN 'blob' THEN hex(${q(c)}) ELSE ${q(c)} END AS v${i}`).join(', ');
  try {
    return await db.all(`SELECT ${sel} FROM ${q(table)} ORDER BY rowid`);
  } catch (e) {
    if (!/no such column: rowid/i.test(String(e && e.message))) throw e;
    // A WITHOUT ROWID table: its primary key orders it.
    return db.all(`SELECT ${sel} FROM ${q(table)} ORDER BY ${cols.map((c) => q(c)).join(', ')}`);
  }
}

/**
 * Everything the move compares, read from one database.
 * Returns { integrity, userVersion, schema: { '<type> <name>': sql }, tables: { name: { rows, sha256 } } }.
 */
export async function fingerprint(db) {
  const integrity = (await db.all('PRAGMA integrity_check')).map((r) => Object.values(r)[0]).join('; ');
  const userVersion = Number((await db.get('PRAGMA user_version')).user_version);
  const objects = await db.all(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type, name");
  const schema = {};
  for (const o of objects) schema[`${o.type} ${o.name}`] = o.sql === null ? null : String(o.sql);
  const tables = {};
  for (const o of objects) {
    if (o.type !== 'table') continue;
    const cols = (await db.all(`SELECT name FROM pragma_table_info(${lit(o.name)}) ORDER BY cid`)).map((r) => r.name);
    const rows = await tableRows(db, o.name, cols);
    const lines = rows.map((r) => JSON.stringify(cols.map((_, i) => [r[`t${i}`], r[`v${i}`]])));
    tables[o.name] = { rows: rows.length, sha256: await sha256Hex(lines.join('\n')) };
  }
  return { integrity, userVersion, schema, tables };
}

/** Every difference between the old copy and the new one, in plain words. Empty: they match. */
export function compareFingerprints(before, after) {
  const out = [];
  if (after.integrity !== 'ok') out.push(`the new copy failed its integrity check (${after.integrity})`);
  if (before.userVersion !== after.userVersion) out.push(`user_version differs: ${before.userVersion} before, ${after.userVersion} after`);
  for (const k of new Set([...Object.keys(before.schema), ...Object.keys(after.schema)])) {
    if (!(k in after.schema)) out.push(`${k} is missing from the new copy`);
    else if (!(k in before.schema)) out.push(`${k} is in the new copy only`);
    else if (before.schema[k] !== after.schema[k]) out.push(`the schema of ${k} differs`);
  }
  for (const t of Object.keys(before.tables)) {
    const a = before.tables[t];
    const b = after.tables[t];
    if (!b) continue; // already reported as a schema difference
    if (a.rows !== b.rows) out.push(`table ${t}: ${a.rows} rows before, ${b.rows} after`);
    else if (a.sha256 !== b.sha256) out.push(`table ${t}: the same number of rows (${a.rows}), but their contents differ`);
  }
  return out;
}

/** "All 14 tables match (1,234 rows)": the summary kept in the marker file and shown after the move. */
export function summarize(fp) {
  const names = Object.keys(fp.tables);
  const rows = names.reduce((n, t) => n + fp.tables[t].rows, 0);
  return { tables: names.length, rows, perTable: Object.fromEntries(names.map((t) => [t, { ...fp.tables[t] }])) };
}

export function summaryText(summary) {
  return `All ${summary.tables} tables match (${summary.rows.toLocaleString('en-IN')} rows).`;
}
