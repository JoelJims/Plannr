// The phone's side of the storage move (step 1.4 C9; docs/step-1.4-storage-plan.md §2): the host that
// core/storage-move.js runs on, built from the two native plugins (CapacitorSQLite, and Plannr's own
// PlannrStorage, C2), the kvvfs copy in localStorage and the app's safety snapshots; and the startup
// decision, which copy the app uses (plan §2.2).
//
// Where things are (all inside the app's own data folder):
//   databases/plannrSQLite.db           the database file, once moved
//   databases/plannr-movingSQLite.db    the candidate during a move
//   files/plannr-storage.json           the marker file (native-v1 / localstorage-v1); authoritative
//   localStorage plannr-storage         repeats the marker (used only if the file cannot be read)
//   localStorage plannr-storage-move    the progress record (only a hint)
//   localStorage kvvfs-local*           the localStorage copy (the old copy after the move)
//   files/safety-snapshots/             the snapshots (gzipped), through safety-snapshots.js
//
// Without both plugins (the browser preview, the UI suites, an older APK) nothing here touches any
// file: chooseStorage() answers "localstorage" at once, and the app runs exactly as before.

import { decideAtStartup } from './core/storage-move.js';
import { openCapacitorAdapter, nativePlugins } from './db-adapter-capacitor.js';

export const MARKER_FILE = 'plannr-storage.json';
export const MARKER_KEY = 'plannr-storage';
export const PROGRESS_KEY = 'plannr-storage-move';
export const MAIN_NAME = 'plannr';
export const CANDIDATE_NAME = 'plannr-moving';
export const KVVFS_PREFIX = 'kvvfs-local';
// A test-only slow-down for the emulator's kill test (plan §5.3 E3): milliseconds to wait at every
// step boundary. Set only by the emulator script; nothing in the app sets it.
export const TEST_DELAY_KEY = 'plannr-test-move-delay-ms';

const plain = (p) => String(p).replace(/^file:\/\//, '');
const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64) => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
const readJsonKey = (ls, key) => { try { const v = JSON.parse(ls.getItem(key)); return v && typeof v === 'object' ? v : null; } catch { return null; } };

/** The plugins this build has, or null. Tests pass their own stand-ins (or null for none). */
export async function phonePlugins(override) {
  if (override !== undefined) return override;
  const { Capacitor } = await import('@capacitor/core');
  return nativePlugins(Capacitor);
}

/** Every path the move uses, from PlannrStorage.info(). */
export async function phonePaths(storage) {
  const i = await storage.info();
  const databases = plain(i.databasesDir);
  const files = plain(i.filesDir);
  return {
    ...i,
    main: `${databases}/${MAIN_NAME}SQLite.db`,
    candidate: `${databases}/${CANDIDATE_NAME}SQLite.db`,
    marker: `${files}/${MARKER_FILE}`,
    databases,
  };
}

/**
 * The host for core/storage-move.js on the phone.
 *   plugins       { sqlite, storage } (phonePlugins())
 *   localStorage  the page's localStorage
 *   backup        step 1: the page's own encrypted-backup flow; resolves once it is saved
 *   source        the adapter on the localStorage copy (the move's source), if a move will run
 *   file          the adapter on the database file in use, if the app is on the file
 *   lastEncryptedBackupAt   reads settings.last_encrypted_export_at of the data in use
 */
export async function makePhoneHost({ plugins, localStorage: ls, backup, source = null, file = null, lastEncryptedBackupAt, kvvfs } = {}) {
  const { sqlite, storage } = plugins;
  const paths = await phonePaths(storage);
  const exists = async (p) => Number((await storage.sizes({ paths: [p] }))[p]) >= 0;
  const removeWithJournal = async (p) => { await storage.remove({ path: p }); await storage.remove({ path: p + '-journal' }); };
  const delayMs = () => { const n = Number(ls.getItem(TEST_DELAY_KEY)); return Number.isFinite(n) && n > 0 ? Math.min(n, 60000) : 0; };

  const host = {
    paths,
    source,
    file,
    now: () => new Date(),
    async freeBytes() { return Number((await storage.info()).freeBytes); },
    async backup() {
      if (typeof backup !== 'function') throw new Error('the backup was not saved');
      await backup();
    },
    async snapshot(bytes, kind = 'pre-move') {
      const snaps = await import('./safety-snapshots.js');
      const fsApi = await import('@capacitor/filesystem');
      const filename = `plannr-${kind}-${snaps.stampNow()}.db`;
      const path = await snaps.saveSnapshot(filename, bytes, fsApi);
      // Read it back and compare (plan §2.1 step 2), beyond saveSnapshot's own stat check.
      const { data } = await fsApi.Filesystem.readFile({ path, directory: fsApi.Directory.Data });
      const back = await snaps.gunzip(fromBase64(data));
      if (back.length !== bytes.length || !back.every((v, i) => v === bytes[i])) throw new Error('the safety snapshot did not read back the same');
      return path;
    },
    candidate: {
      async write(bytes) { await storage.writeFile({ path: paths.candidate, data: toBase64(bytes) }); },
      async open() { return openCapacitorAdapter({ sqlite, storage, name: CANDIDATE_NAME }); },
      async remove() { await removeWithJournal(paths.candidate); },
      exists: () => exists(paths.candidate),
      async place() { await storage.rename({ from: paths.candidate, to: paths.main }); },
    },
    main: {
      exists: () => exists(paths.main),
      async quickCheckOk() {
        if (!(await exists(paths.main))) return false;
        let a = null;
        try {
          a = await openCapacitorAdapter({ sqlite, storage, name: MAIN_NAME });
          return Object.values((await a.get('PRAGMA quick_check')) || {})[0] === 'ok';
        } catch { return false; } finally { if (a) await a.close().catch(() => {}); }
      },
      async remove() { await removeWithJournal(paths.main); },
      async setAside(stamp) {
        const to = `${paths.databases}/plannr-setaside-${String(stamp).replace(/[^0-9A-Za-z-]/g, '-')}SQLite.db`;
        await storage.rename({ from: paths.main, to });
        return to;
      },
    },
    marker: {
      async read() {
        if (!(await exists(paths.marker))) return null;
        try {
          const { data } = await storage.readFile({ path: paths.marker });
          const m = JSON.parse(new TextDecoder().decode(fromBase64(data)));
          return m && typeof m === 'object' ? m : null;
        } catch { return null; }
      },
      async write(obj) {
        // Written beside it and forced to disk, then renamed over it: the marker is whole or absent.
        const tmp = paths.marker + '.tmp';
        await storage.writeFile({ path: tmp, data: toBase64(new TextEncoder().encode(JSON.stringify(obj))) });
        await storage.rename({ from: tmp, to: paths.marker });
      },
    },
    markerKey: {
      async read() { return readJsonKey(ls, MARKER_KEY); },
      async write(obj) { ls.setItem(MARKER_KEY, JSON.stringify(obj)); },
    },
    progress: {
      async read() { return readJsonKey(ls, PROGRESS_KEY); },
      async write(obj) { ls.setItem(PROGRESS_KEY, JSON.stringify(obj)); },
      async clear() { ls.removeItem(PROGRESS_KEY); },
    },
    async checkpoint() {
      const ms = delayMs();
      if (ms) await new Promise((r) => setTimeout(r, ms));
    },
    // C8: the old copy in localStorage (kvvfs), for the way back and for deleting it.
    local: {
      limitChars: 5 * 1024 * 1024, // local-api.js LOCALSTORAGE_LIMIT_CHARS; checked equal by test/storage-native.test.js
      async exists() { for (let i = 0; i < ls.length; i++) if (String(ls.key(i)).startsWith(KVVFS_PREFIX)) return true; return false; },
      async exportBytes() { const a = await kvvfs(); try { return await a.exportBytes(); } finally { await a.close(); } },
      async replaceWith(bytes) { const a = await kvvfs(); try { await a.replaceWith(bytes); } finally { await a.close(); } },
      async open() { return kvvfs(); },
      async clear() {
        const keys = [];
        for (let i = 0; i < ls.length; i++) if (String(ls.key(i)).startsWith(KVVFS_PREFIX)) keys.push(ls.key(i));
        for (const k of keys) ls.removeItem(k);
      },
    },
    async lastEncryptedBackupAt() { return lastEncryptedBackupAt ? lastEncryptedBackupAt() : null; },
  };
  return host;
}

/** The facts decideAtStartup() takes. */
export async function startupFacts(host) {
  return {
    marker: (await host.marker.read()) || (await host.markerKey.read()),
    candidate: await host.candidate.exists(),
    main: await host.main.exists(),
    mainOk: () => host.main.quickCheckOk(),
    moveInProgress: !!(await host.progress.read()),
  };
}

/**
 * Before any page reads data: which copy does the app use? Carries out the table's clean-up (deletes
 * a leftover candidate, sets aside a file nothing explains), then answers
 *   { use: 'localstorage', prompt? }              the app opens localStorage as today
 *   { use: 'native', adapter, marker }            the app uses the file; adapter is open on it
 *   { use: 'recovery', reason, marker, host }     the file is missing or damaged: the recovery screen
 */
export async function chooseStorage({ plugins: override, localStorage: ls = globalThis.localStorage } = {}) {
  const plugins = await phonePlugins(override);
  if (!plugins) return { use: 'localstorage', native: false };
  const host = await makePhoneHost({ plugins, localStorage: ls });
  const facts = await startupFacts(host);
  const d = await decideAtStartup(facts);
  for (const w of d.remove) await (w === 'candidate' ? host.candidate.remove() : host.main.remove());
  for (const w of d.setAside) if (w === 'main') await host.main.setAside(new Date().toISOString());
  if (d.use === 'native') {
    const adapter = await openCapacitorAdapter({ ...plugins, name: MAIN_NAME });
    return { use: 'native', native: true, adapter, marker: facts.marker };
  }
  if (d.use === 'recovery') return { use: 'recovery', native: true, reason: d.reason, marker: facts.marker, host };
  return { use: 'localstorage', native: true, prompt: d.prompt, marker: facts.marker };
}
