// Spawned by test/migration-equivalence.test.js and test/migration-faults.test.js (not a *.test.js
// file, so the runner skips it). Runs a list of jobs, each against its own database file:
//
//   node test/_schema-history-child.js <jobs.json> <results.json>
//
// db.js opens PLANNR_DB when it loads, so every job imports a FRESH copy of the module (a different
// ?job= query string is a different ES module instance) after pointing PLANNR_DB at its file.
// jobs.json: { module: <path to the db.js to use>, jobs: [ job, ... ] }. A job:
//   { db, run: 'old-init' | 'init', approve?, chain?: { style, failAt, upTo }, fault?: { at } | { record: true } }
//   { db, run: 'old-runMigrations' | 'runMigrations', chain }   (numbered steps only, on a plain handle)
// fault: every exec() and statement run() during the job counts as one write; { at: n } makes the
// n-th throw before it reaches SQLite (a crash or full disk at that point); { record: true } returns
// the list of writes.
'use strict';
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { chain } = require('./fixtures/schema-history/test-chain');

// ---- fault injection, on node:sqlite itself ----------------------------------------------------------
const probe = new DatabaseSync(':memory:');
const StatementProto = Object.getPrototypeOf(probe.prepare('SELECT 1'));
probe.close();
const realExec = DatabaseSync.prototype.exec;
const realRun = StatementProto.run;
let armed = null; // { count, at, log }
function write(sql) {
  armed.count++;
  if (armed.log) armed.log.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 160));
  if (armed.count === armed.at) throw new Error(`INJECTED FAULT at write ${armed.at}: ${String(sql).replace(/\s+/g, ' ').trim().slice(0, 80)}`);
}
DatabaseSync.prototype.exec = function exec(sql) { if (armed) write(sql); return realExec.call(this, sql); };
StatementProto.run = function run(...args) { if (armed) write(this.sourceSQL); return realRun.apply(this, args); };

const APPROVALS = ['PLANNR_ALLOW_TAXONOMY_WIPE', 'PLANNR_ALLOW_SERVICE_PRICE_DROP'];

async function runJob(moduleUrl, job, i) {
  process.env.PLANNR_DB = job.db;
  process.env.PLANNR_TEST = '1';
  for (const k of APPROVALS) { if (job.approve) process.env[k] = '1'; else delete process.env[k]; }
  const m = await import(`${moduleUrl}?job=${i}`);
  const result = { ok: true };
  try {
    if (job.run === 'old-runMigrations' || job.run === 'runMigrations') {
      const h = new DatabaseSync(job.db);
      try {
        h.exec('PRAGMA foreign_keys = ON');
        result.applied = job.run === 'old-runMigrations'
          ? m.runMigrations(h, chain({ ...job.chain, style: 'sync' }))
          : await m.runMigrations(m.dbAdapter(h), chain({ ...job.chain, style: 'async' }));
      } finally { h.close(); }
    } else {
      armed = job.fault ? { count: 0, at: job.fault.at || 0, log: job.fault.record ? [] : null } : null;
      try {
        if (job.run === 'old-init') m.init();
        else await m.init(job.chain ? { migrations: chain({ ...job.chain, style: 'async' }) } : undefined);
      } finally {
        if (armed) { result.writes = armed.count; if (armed.log) result.log = armed.log; }
        armed = null;
      }
    }
  } catch (e) {
    result.ok = false;
    result.error = e.message;
  } finally {
    try { m.db.close(); } catch { /* already closed */ }
  }
  return result;
}

(async () => {
  const [jobsFile, resultsFile] = process.argv.slice(2);
  const { module: modulePath, jobs } = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
  const moduleUrl = pathToFileURL(modulePath).href;
  const results = [];
  for (const [i, job] of jobs.entries()) results.push(await runJob(moduleUrl, job, i));
  fs.writeFileSync(resultsFile, JSON.stringify(results));
})().catch((e) => { console.error(e); process.exitCode = 1; });
