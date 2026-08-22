// The cross-tenant isolation harness. Phase 1 built it (measuring 65 leaks); Phase 3 closed the
// data-access layer and it reached 0. Phase 1.6 (single-owner auth) removed login, so the harness's
// core mechanism — register user B, log in as B, and make real HTTP requests "as B" to verify B can't
// see A's data — no longer works: every request now resolves to the same fixed local owner regardless
// of any cookie, so there is no second live identity left to request as.
//
// What remains meaningful: assertRegistryComplete() below, which still catches a genuinely useful bug
// (a new tenant-bearing route added without being registered here or allowlisted as neutral). The
// actual cross-tenant leak checks are gone; that guarantee is Phase 2's to re-establish once
// multi-tenancy itself collapses to a single tenant.
//
//   npm run test:isolation

process.env.PLANNR_TEST = '1';
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
process.env.PLANNR_DB = path.join(os.tmpdir(), `plannr-isolation-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);

const app = require('../server');
const { init, DB_PATH } = require('../db');
const { assertRegistryComplete, REGISTRY } = require('./registry');
try { init(); } catch { /* server may already have run it */ }

// Never the live DB.
if (path.resolve(DB_PATH).toLowerCase() === path.resolve(__dirname, '..', 'data', 'plannr.db').toLowerCase()) {
  console.error('REFUSING: PLANNR_DB resolved to the live database.'); process.exit(3);
}

try {
  assertRegistryComplete(app);
} catch (e) {
  console.error('\n✖ REGISTRY COMPLETENESS FAILED:\n' + e.message + '\n');
  for (const s of ['', '-wal', '-shm']) { try { require('node:fs').unlinkSync(process.env.PLANNR_DB + s); } catch { /* ignore */ } }
  process.exit(2);
}

console.log('══════════════════════════════════════════════════════════════════════');
console.log(' Plannr cross-tenant isolation harness');
console.log('══════════════════════════════════════════════════════════════════════');
console.log(`Registry: ${REGISTRY.length} tenant-bearing routes registered; completeness assertion PASSED.`);
console.log('Cross-tenant leak checks are NOT run: single-owner auth (Phase 1.6) removed login, so there');
console.log('is no second live identity to request as. Re-establish this coverage in Phase 2.');
console.log('══════════════════════════════════════════════════════════════════════');

for (const s of ['', '-wal', '-shm']) { try { require('node:fs').unlinkSync(process.env.PLANNR_DB + s); } catch { /* ignore */ } }
process.exit(0);
