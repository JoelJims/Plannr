// Shared by the schema-history tests: runs jobs in child processes (test/_schema-history-child.js),
// and the baseline failure matrix used by test/migration-faults.test.js (user_version 2 fixtures)
// and test/slow/migration-faults-v1.test.js (user_version 1 fixtures).
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./lib');

const ROOT = path.join(__dirname, '..', '..', '..');
const CHILD = path.join(ROOT, 'test', '_schema-history-child.js');
const DB_JS = path.join(ROOT, 'db.js');
const PARALLEL = Math.max(2, Math.min(8, os.cpus().length - 2));

function createHarness(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let n = 0;
  const runChild = (modulePath, jobs) => {
    const name = `c${++n}`;
    const jobsFile = path.join(tmp, `${name}.jobs.json`);
    const outFile = path.join(tmp, `${name}.out.json`);
    fs.writeFileSync(jobsFile, JSON.stringify({ module: modulePath, jobs }));
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', CHILD, jobsFile, outFile], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(JSON.parse(fs.readFileSync(outFile, 'utf8'))) : reject(new Error(`child exited ${code}: ${err}`))));
    });
  };
  // Groups of jobs: each group runs in order, in one child; groups are spread over PARALLEL children.
  // Resolves to one array of results per group, in the groups' order.
  const runGroups = async (groups, modulePath = DB_JS) => {
    const buckets = Array.from({ length: PARALLEL }, () => []);
    groups.forEach((g, i) => buckets[i % PARALLEL].push(i));
    const outs = await Promise.all(buckets.map((b) => (b.length ? runChild(modulePath, b.flatMap((i) => groups[i])) : [])));
    const res = new Array(groups.length);
    buckets.forEach((b, k) => { let at = 0; for (const i of b) { res[i] = outs[k].slice(at, at + groups[i].length); at += groups[i].length; } });
    return res;
  };
  const baseFile = (f) => path.join(tmp, `${f.commit}.base.db`);
  const fresh = (f, ...parts) => {
    if (!fs.existsSync(baseFile(f))) L.loadFixture(f, baseFile(f));
    const dir = path.join(tmp, f.commit, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    const db = path.join(dir, 'plannr.db');
    fs.copyFileSync(baseFile(f), db);
    return db;
  };
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  return { tmp, runChild, runGroups, fresh, baseFile, cleanup };
}

const snapshotsBeside = (db) => {
  const dir = path.join(path.dirname(db), 'safety-snapshots');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^plannr-pre-migration-.*\.db$/.test(x)).sort().map((x) => path.join(dir, x)) : [];
};

/**
 * The baseline failure matrix for some fixtures (approved, so every destructive step runs). For each
 * fixture: an uninterrupted upgrade, recording its writes; then one run per failure point (the first
 * time each distinct statement runs, and every BEGIN/COMMIT) with that write failing; then a restart.
 * Returns the cases, each with what is needed to check it; the caller asserts.
 */
async function baselineFaults(h, fixtures, mask) {
  const record = await h.runGroups(fixtures.map((f) => [{ db: h.fresh(f, 'record'), run: 'init', approve: true, fault: { record: true } }]));
  const cases = [];
  const groups = [];
  fixtures.forEach((f, i) => {
    const [{ ok, log, error }] = record[i];
    if (!ok) throw new Error(`${f.file}: the uninterrupted upgrade failed: ${error}`);
    const finalDb = path.join(h.tmp, f.commit, 'record', 'plannr.db');
    const points = new Set();
    const seen = new Set();
    log.forEach((sql, k) => { if (!seen.has(sql)) { seen.add(sql); points.add(k + 1); } if (/^(BEGIN|COMMIT)\b/.test(sql)) points.add(k + 1); });
    for (const at of [...points].sort((a, b) => a - b)) {
      const db = h.fresh(f, `fault-${at}`);
      groups.push([{ db, run: 'init', approve: true, fault: { at } }]);
      cases.push({ f, at, sql: log[at - 1], db, finalDb, writes: log.length });
    }
  });
  const failed = await h.runGroups(groups);
  // The state right after each failure, read before the restart touches it.
  const finals = new Map();
  for (const [i, c] of cases.entries()) {
    c.failed = failed[i][0];
    c.during = { fp: L.fingerprintFile(c.db, { mask }), rows: L.rowsByKey(c.db, { mask }), checks: L.checks(c.db), snapshots: snapshotsBeside(c.db).map((s) => L.fingerprintFile(s)) };
    if (!finals.has(c.finalDb)) finals.set(c.finalDb, { fp: L.fingerprintFile(c.finalDb, { mask }), rows: L.rowsByKey(c.finalDb, { mask }) });
    c.final = finals.get(c.finalDb);
  }
  const restarted = await h.runGroups(cases.map((c) => [{ db: c.db, run: 'init', approve: true }]));
  for (const [i, c] of cases.entries()) {
    c.restart = restarted[i][0];
    c.after = { fp: L.fingerprintFile(c.db, { mask }), rows: L.rowsByKey(c.db, { mask }), checks: L.checks(c.db), snapshots: snapshotsBeside(c.db) };
  }
  return cases;
}

// "No row the finished upgrade keeps is missing, and every value is its old or its new one."
// Returns a list of problems (empty when it holds).
function dataProblems(baseRows, finalRows, nowRows) {
  const problems = [];
  for (const [t, rows] of Object.entries(baseRows)) {
    for (const [key, row] of rows) {
      const kept = finalRows[t] && finalRows[t].get(key);
      const there = nowRows[t] && nowRows[t].get(key);
      if (kept && !there) { problems.push(`${t} row ${key} is missing`); continue; }
      if (!there) continue;
      for (const [col, v] of Object.entries(row)) {
        if (col in there && there[col] !== v && !(kept && there[col] === kept[col])) problems.push(`${t} ${key}.${col} is ${there[col]}, neither the old ${v} nor the new ${kept && kept[col]}`);
      }
    }
  }
  return problems;
}

// What must hold right after a failed write, whatever the fixture. base: { fp, fpMasked, rows } of the
// fixture before the upgrade. Returns a list of problems (empty when all hold).
function duringFailureProblems(c, base) {
  const p = [];
  if (c.failed.ok) p.push('init() did not report the failure');
  else if (!/INJECTED FAULT/.test(c.failed.error)) p.push(`init() reported another error: ${c.failed.error}`);
  if (c.during.fp.userVersion !== base.fp.userVersion) p.push(`user_version was raised to ${c.during.fp.userVersion}`);
  if (c.during.checks.integrity !== 'ok') p.push(`the file is damaged: ${c.during.checks.integrity}`);
  const changes = JSON.stringify(c.final.fp) !== JSON.stringify(base.fpMasked);
  if (/^VACUUM INTO/.test(c.sql)) {
    if (c.during.snapshots.length) p.push('the snapshot failed, yet a snapshot file is there');
    if (JSON.stringify(c.during.fp) !== JSON.stringify(base.fpMasked)) p.push('the snapshot failed, yet the database changed');
  } else if (changes) {
    if (c.during.snapshots.length !== 1) p.push(`${c.during.snapshots.length} safety snapshots (expected 1)`);
    else if (JSON.stringify(c.during.snapshots[0]) !== JSON.stringify(base.fp)) p.push('the safety snapshot is not the database before the upgrade');
  } else if (JSON.stringify(c.during.fp) !== JSON.stringify(base.fpMasked)) {
    p.push('this upgrade changes nothing, yet the database changed');
  }
  p.push(...dataProblems(base.rows, c.final.rows, c.during.rows));
  return p;
}

function baseInfo(h, f, mask) {
  const file = h.baseFile(f);
  return { fp: L.fingerprintFile(file), fpMasked: L.fingerprintFile(file, { mask }), rows: L.rowsByKey(file, { mask }) };
}

module.exports = { createHarness, baselineFaults, dataProblems, duringFailureProblems, baseInfo, snapshotsBeside, PARALLEL, DB_JS };
