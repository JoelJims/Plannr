// A Node host for core/storage-move.js (step 1.4 C5-C8): two node-sqlite files stand in for the
// phone's localStorage copy and its database file (plan §5.1). Every file lives in one temp folder:
//   local.db                 the "localStorage" copy (opened read-only by the move)
//   plannr-movingSQLite.db   the candidate
//   plannrSQLite.db          the database file
//   plannr-storage.json      the marker file
//   ls.json                  the "localStorage" keys: plannr-storage, plannr-storage-move
//   snapshots/               the safety snapshots
// opts.checkpoint(name) is called at every step boundary and inside the writes (tests throw or kill
// the process there). opts.freeBytes sets the free space; opts.failWrite makes the candidate write
// stop half-way with ENOSPC (a partial file is left, as a real full disk would).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

function fsyncWrite(file, bytes, chunks, checkpoint) {
  const fd = fs.openSync(file, 'w');
  try {
    const step = Math.ceil(bytes.length / chunks);
    for (let i = 0; i < chunks; i++) {
      fs.writeSync(fd, bytes, i * step, Math.max(0, Math.min(step, bytes.length - i * step)));
      if (checkpoint && i < chunks - 1) checkpoint(i);
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

async function makeHost(dir, opts = {}) {
  const { openNodeSqliteAdapter } = await load('db-adapter-node.js');
  const f = (name) => path.join(dir, name);
  const files = {
    local: f('local.db'), candidate: f('plannr-movingSQLite.db'), main: f('plannrSQLite.db'),
    marker: f('plannr-storage.json'), ls: f('ls.json'), snapshots: f('snapshots'),
  };
  const cp = async (name) => { if (opts.checkpoint) await opts.checkpoint(name); };
  const cpSync = (name) => { if (opts.checkpointSync) opts.checkpointSync(name); };
  const ls = {
    read: () => (fs.existsSync(files.ls) ? JSON.parse(fs.readFileSync(files.ls, 'utf8')) : {}),
    write(obj) { fs.writeFileSync(files.ls + '.tmp', JSON.stringify(obj)); fs.renameSync(files.ls + '.tmp', files.ls); },
  };
  const source = opts.source || openNodeSqliteAdapter(files.local, { readOnly: true });
  const host = {
    files,
    source,
    calls: [],
    now: () => new Date(opts.now || '2026-11-19T10:00:00.000Z'),
    async freeBytes() { return opts.freeBytes ?? 8e9; },
    async backup() {
      host.calls.push('backup');
      await cp('backup');
      if (opts.backupFails) throw new Error('the backup was not saved');
    },
    async snapshot(bytes) {
      host.calls.push('snapshot');
      fs.mkdirSync(files.snapshots, { recursive: true });
      const name = `plannr-pre-move-${host.calls.filter((c) => c === 'snapshot').length}.db`;
      fsyncWrite(path.join(files.snapshots, name), bytes, 2, () => cpSync('snapshot-half'));
      await cp('snapshot-written');
      if (!fs.readFileSync(path.join(files.snapshots, name)).equals(Buffer.from(bytes))) throw new Error('the snapshot did not read back');
      return name;
    },
    candidate: {
      async write(bytes) {
        host.calls.push('candidate.write');
        await cp('write-start');
        if (opts.failWrite) {
          fs.writeFileSync(files.candidate, Buffer.from(bytes).subarray(0, Math.floor(bytes.length / 2)));
          const e = new Error('ENOSPC: no space left on device, write'); e.code = 'ENOSPC'; throw e;
        }
        fsyncWrite(files.candidate, bytes, 4, (i) => cpSync(`write-chunk-${i + 1}`));
        await cp('write-synced');
      },
      async open() { return openNodeSqliteAdapter(files.candidate, { readOnly: true }); },
      async remove() { for (const x of [files.candidate, files.candidate + '-journal']) fs.rmSync(x, { force: true }); },
      async exists() { return fs.existsSync(files.candidate); },
      async place() { host.calls.push('candidate.place'); await cp('place'); fs.renameSync(files.candidate, files.main); },
    },
    main: {
      async exists() { return fs.existsSync(files.main); },
      async quickCheckOk() {
        try {
          const d = openNodeSqliteAdapter(files.main, { readOnly: true });
          try { return Object.values((await d.get('PRAGMA quick_check')) || {})[0] === 'ok'; } finally { await d.close(); }
        } catch { return false; }
      },
      async remove() { fs.rmSync(files.main, { force: true }); fs.rmSync(files.main + '-journal', { force: true }); },
      async setAside(stamp) { const to = f(`plannr-setaside-${stamp}SQLite.db`); fs.renameSync(files.main, to); return path.basename(to); },
    },
    marker: {
      async read() { return fs.existsSync(files.marker) ? JSON.parse(fs.readFileSync(files.marker, 'utf8')) : null; },
      async write(obj) {
        await cp('marker-write');
        const tmp = files.marker + '.tmp';
        fsyncWrite(tmp, Buffer.from(JSON.stringify(obj)), 1);
        fs.renameSync(tmp, files.marker);
      },
    },
    markerKey: {
      async read() { return ls.read()['plannr-storage'] || null; },
      async write(obj) { await cp('marker-key'); ls.write({ ...ls.read(), 'plannr-storage': obj }); },
    },
    progress: {
      async read() { return ls.read()['plannr-storage-move'] || null; },
      async write(obj) { await cp('progress-write'); ls.write({ ...ls.read(), 'plannr-storage-move': obj }); },
      async clear() { const o = ls.read(); delete o['plannr-storage-move']; ls.write(o); },
    },
    checkpoint: (name) => cp(name),
  };
  return host;
}

/** The facts decideAtStartup() takes, read from the host's files. */
async function startupFacts(host) {
  const marker = (await host.marker.read()) || (await host.markerKey.read());
  return {
    marker,
    candidate: await host.candidate.exists(),
    main: await host.main.exists(),
    mainOk: () => host.main.quickCheckOk(),
    moveInProgress: !!(await host.progress.read()),
  };
}

module.exports = { makeHost, startupFacts, load, ROOT };
