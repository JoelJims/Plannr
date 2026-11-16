// Cross-platform plan, step 1.3 — the optional overall budget: one settings row (budget_paise),
// read by getBudgetPaise() for the Overview and the PDF, and set or cleared on the Overview page.
// The only copy: server.js and public/local-api.js both call register(app, ctx) and get back
// getBudgetPaise. See core/routes/people.js for what `app` and `ctx` are.
import { parsePaise } from '../parsers.js';

export function register(app, ctx) {
  const { db, auth } = ctx;

  const BUDGET_STMT = db.prepare("SELECT value FROM settings WHERE key = 'budget_paise'");
  // Optional overall budget, stored as one settings row. NULL = unset.
  function getBudgetPaise() {
    const r = BUDGET_STMT.get();
    if (!r || r.value == null || r.value === '') return null;
    const n = Number(r.value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  app.get('/api/budget', auth, (req, res) => {
    res.json({ budgetPaise: getBudgetPaise() });
  });

  // Set (positive ₹) or clear (empty) the overall budget. Optional / non-blocking.
  app.put('/api/budget', auth, (req, res) => {
    const raw = req.body.budgetRupees;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise', NULL) ON CONFLICT(key) DO UPDATE SET value = NULL").run();
      return res.json({ budgetPaise: null });
    }
    const paise = parsePaise(raw);
    if (paise === null) return res.status(400).json({ error: 'Enter a valid budget greater than 0 (up to 2 decimals).' });
    db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(paise));
    res.json({ budgetPaise: paise });
  });

  return { getBudgetPaise };
}
