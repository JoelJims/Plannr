// Cross-platform plan, step 1.3 — the optional overall budget: one settings row (budget_paise),
// read by getBudgetPaise() for the Overview and the PDF, and set or cleared on the Overview page.
// The only copy: server.js and public/local-api.js both call register(app, ctx) and get back
// getBudgetPaise. See core/routes/people.js for what `app` and `ctx` are. It reads and writes through
// ctx.adapter, the async database interface (step 1.4 B14), so getBudgetPaise() answers with a Promise.
import { parseTotalToSave } from '../parsers.js';

export function register(app, ctx) {
  const { adapter, auth } = ctx;

  // Optional overall budget, stored as one settings row. NULL = unset.
  async function getBudgetPaise() {
    const r = await adapter.get("SELECT value FROM settings WHERE key = 'budget_paise'");
    if (!r || r.value == null || r.value === '') return null;
    const n = Number(r.value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  app.get('/api/budget', auth, async (req, res) => {
    res.json({ budgetPaise: await getBudgetPaise() });
  });

  // Set (positive ₹) or clear (empty) the overall budget. Optional / non-blocking.
  app.put('/api/budget', auth, async (req, res) => {
    const raw = req.body.budgetRupees;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      await adapter.run("INSERT INTO settings (key, value) VALUES ('budget_paise', NULL) ON CONFLICT(key) DO UPDATE SET value = NULL");
      return res.json({ budgetPaise: null });
    }
    const amount = parseTotalToSave(raw, 'Enter a valid budget greater than 0 (up to 2 decimals).'); // Q10: a total, at most the totals limit
    if (amount.error) return res.status(400).json({ error: amount.error });
    const { paise } = amount;
    await adapter.run("INSERT INTO settings (key, value) VALUES ('budget_paise', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(paise)]);
    res.json({ budgetPaise: paise });
  });

  return { getBudgetPaise };
}
