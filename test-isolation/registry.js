// Tenancy Phase 1 — the registry of every tenant-bearing surface, and a completeness assertion.
//
// The registry lists every /api endpoint that reads or mutates a tenant table (cash_out, cash_in,
// loans, contract, contract_payment_dates, contractor_payments) or a currently-global tenant surface
// (settings, the users roster). Each entry: method, path, read|mutate, and the tables it touches.
//
// assertRegistryComplete(app) is modelled on server.js's assertImportOwnershipComplete(): it derives
// the truth from the RUNNING app (app._router.stack), not a maintained list, and FAILS if any
// registered /api route is neither in the registry nor the tenant-neutral allowlist. So a new endpoint
// that touches tenant data breaks the build instead of silently escaping isolation coverage.

const REGISTRY = [
  // ── reads ────────────────────────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/cash-in', kind: 'read', tables: ['cash_in'] },
  { method: 'GET', path: '/api/cash-out', kind: 'read', tables: ['cash_out'] },
  { method: 'GET', path: '/api/loans', kind: 'read', tables: ['loans'] },
  { method: 'GET', path: '/api/contracts', kind: 'read', tables: ['contract', 'contract_services'] },
  { method: 'GET', path: '/api/contractor-payments', kind: 'read', tables: ['contractor_payments', 'contract'] },
  { method: 'GET', path: '/api/overview', kind: 'read', tables: ['cash_out', 'contractor_payments', 'contract', 'contract_payment_dates', 'loans', 'settings'] },
  { method: 'GET', path: '/api/overview/pdf', kind: 'read', tables: ['cash_out', 'contractor_payments', 'contract', 'loans'] },
  { method: 'GET', path: '/api/trash', kind: 'read', tables: ['cash_in', 'cash_out', 'loans', 'contract', 'contractor_payments'] },
  { method: 'GET', path: '/api/backup/export', kind: 'read', tables: ['contract', 'contract_services', 'contract_payment_dates', 'contractor_payments', 'loans', 'settings', 'cash_in', 'cash_out'] },
  { method: 'GET', path: '/api/users', kind: 'read', tables: ['users'] },
  { method: 'GET', path: '/api/budget', kind: 'read', tables: ['settings'] },
  { method: 'GET', path: '/api/health', kind: 'read', tables: ['settings'] },
  // ── mutations ────────────────────────────────────────────────────────────────────────────────
  { method: 'POST', path: '/api/cash-in', kind: 'mutate', tables: ['cash_in'] },
  { method: 'PUT', path: '/api/cash-in/:id', kind: 'mutate', tables: ['cash_in'] },
  { method: 'DELETE', path: '/api/cash-in/:id', kind: 'mutate', tables: ['cash_in'] },
  { method: 'POST', path: '/api/cash-out', kind: 'mutate', tables: ['cash_out'] },
  { method: 'POST', path: '/api/cash-out/batch', kind: 'mutate', tables: ['cash_out'] },
  { method: 'PUT', path: '/api/cash-out/:id', kind: 'mutate', tables: ['cash_out'] },
  { method: 'DELETE', path: '/api/cash-out/:id', kind: 'mutate', tables: ['cash_out'] },
  { method: 'POST', path: '/api/loans', kind: 'mutate', tables: ['loans'] },
  { method: 'PUT', path: '/api/loans/:id', kind: 'mutate', tables: ['loans'] },
  { method: 'DELETE', path: '/api/loans/:id', kind: 'mutate', tables: ['loans'] },
  { method: 'POST', path: '/api/contracts', kind: 'mutate', tables: ['contract'] },
  { method: 'PUT', path: '/api/contracts/:id', kind: 'mutate', tables: ['contract', 'contract_payment_dates'] },
  { method: 'DELETE', path: '/api/contracts/:id', kind: 'mutate', tables: ['contract'] },
  // Services phase — contract line-item services (Part A). Tenant-bearing; NO read filter yet, so leaky.
  { method: 'POST', path: '/api/contracts/:id/services', kind: 'mutate', tables: ['contract_services'] },
  { method: 'PUT', path: '/api/contracts/:id/services/:sid', kind: 'mutate', tables: ['contract_services'] },
  { method: 'DELETE', path: '/api/contracts/:id/services/:sid', kind: 'mutate', tables: ['contract_services'] },
  { method: 'POST', path: '/api/contractor-payments', kind: 'mutate', tables: ['contractor_payments', 'contract'] },
  { method: 'PUT', path: '/api/contractor-payments/:id', kind: 'mutate', tables: ['contractor_payments'] },
  { method: 'DELETE', path: '/api/contractor-payments/:id', kind: 'mutate', tables: ['contractor_payments'] },
  { method: 'POST', path: '/api/trash/:table/:id/restore', kind: 'mutate', tables: ['cash_in', 'cash_out', 'loans', 'contract', 'contractor_payments'] },
  { method: 'DELETE', path: '/api/trash/:table/:id', kind: 'mutate', tables: ['cash_in', 'cash_out', 'loans', 'contract', 'contractor_payments'] },
  { method: 'POST', path: '/api/backup/import', kind: 'mutate', tables: ['contract', 'contract_services', 'contract_payment_dates', 'contractor_payments', 'loans', 'settings', 'cash_in', 'cash_out'] },
  { method: 'PUT', path: '/api/budget', kind: 'mutate', tables: ['settings'] },
];

// Tenant-NEUTRAL /api routes: no cross-tenant data surface.
const NEUTRAL = new Set([
  // Services phase (Part E): the caller's OWN saved custom-ledger names, filtered by req.user.id — a
  // genuinely per-user pick-list, not shared household data, so it is correctly isolated (no leak).
  // Part 4 (Phase 11B) adds DELETE (prune a name): same per-user surface, tenant-scoped in repo
  // (DELETE ... WHERE tenant_id = ? AND name = ?) — a cross-tenant delete is a no-op, actively proved
  // in test/ledger-customs.test.js, so it belongs here alongside the GET rather than as a probe target.
  'GET /api/ledger-customs',
  'DELETE /api/ledger-customs',
  'GET /api/me',
]);

function listApiRoutes(app) {
  const stack = (app._router && app._router.stack) || (app.router && app.router.stack) || [];
  const out = [];
  for (const l of stack) {
    if (l.route && l.route.path && String(l.route.path).startsWith('/api/')) {
      for (const m of Object.keys(l.route.methods)) if (l.route.methods[m]) out.push(m.toUpperCase() + ' ' + l.route.path);
    }
  }
  return out;
}

// FAIL if any live /api route is neither registered nor allowlisted (a new endpoint escaped coverage),
// OR if the registry names a route that no longer exists (drift the other way). Modelled on
// assertImportOwnershipComplete — derived from the real router, not a hand-kept list.
function assertRegistryComplete(app) {
  const registered = new Set(REGISTRY.map((r) => r.method + ' ' + r.path));
  const live = listApiRoutes(app);
  const uncovered = live.filter((r) => !registered.has(r) && !NEUTRAL.has(r));
  if (uncovered.length) {
    throw new Error('Isolation registry INCOMPLETE — these live /api routes are neither registered as tenant-bearing nor allowlisted as tenant-neutral, so isolation coverage would silently escape:\n  ' + uncovered.join('\n  ') + '\nAdd each to REGISTRY (with its tables) or NEUTRAL.');
  }
  const liveSet = new Set(live);
  const stale = [...registered].filter((r) => !liveSet.has(r));
  if (stale.length) throw new Error('Isolation registry references routes that no longer exist:\n  ' + stale.join('\n  '));
}

module.exports = { REGISTRY, NEUTRAL, listApiRoutes, assertRegistryComplete };
