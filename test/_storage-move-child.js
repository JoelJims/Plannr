// Child process for test/storage-move-kill.test.js (step 1.4 C6): runs the move in <dir> and is
// KILLED (a real process kill, not a thrown error) when it reaches checkpoint <name> for the
// <nth> time.   node test/_storage-move-child.js <dir> <name> <nth>
// Prints "FINISHED" if the move ends without reaching the point.
'use strict';
const path = require('node:path');
const os = require('node:os');
const { makeHost, load } = require('./_storage-move-host.js');

const [dir, point, nthArg] = process.argv.slice(2);
const tmp = path.resolve(os.tmpdir());
if (!dir || !path.resolve(dir).startsWith(tmp + path.sep)) { console.error('REFUSED: the folder must be inside the OS temp folder'); process.exit(3); }
const nth = Number(nthArg || 1);
const seen = {};
const hit = (name) => {
  seen[name] = (seen[name] || 0) + 1;
  if (name === point && seen[name] === nth) process.kill(process.pid, 'SIGKILL');
};

(async () => {
  const host = await makeHost(dir, { checkpoint: async (name) => hit(name), checkpointSync: hit });
  const { moveToFile } = await load('core/storage-move.js');
  await moveToFile(host);
  console.log('FINISHED');
  await host.source.close();
})().catch((e) => { console.error('MOVE FAILED', e && e.message); process.exit(1); });
