// The desktop self-test's page side. PAGE CODE: desktop/self-test.js reads this file as text and runs
// it inside the window with webContents.executeJavaScript. The main process never imports it, and
// the app never serves it (it is not in public/).
//
// It uses the page the way a person does: it fills the Cash Inflow form and presses its buttons.
// Its only requests are the page's own /api and OUTSIDE, an address that can never resolve (.invalid,
// RFC 6761) and must be blocked. Every step answers { ok, detail }.
async function selfTestPage(op, arg) {
  const OUTSIDE = 'https://plannr-selftest.invalid/';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, ms = 15000) => {
    const start = Date.now();
    for (;;) {
      let v = null;
      try { v = check(); } catch { v = null; }
      if (v) return v;
      if (Date.now() - start > ms) return null;
      await sleep(100);
    }
  };
  const $ = (id) => document.getElementById(id);
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const rowWith = (text) => Array.from(document.querySelectorAll('#ciList tr')).find((tr) => tr.textContent.includes(text)) || null;
  const messageIs = (text) => visible($('ciMsg')) && $('ciMsg').textContent.trim() === text;
  const type = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  switch (op) {
    case 'ready': {
      await waitFor(() => window.__plannrMode !== undefined);
      return { ok: window.__plannrMode === 'server', detail: { url: location.href, mode: window.__plannrMode } };
    }
    case 'no-node': {
      const seen = { require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer };
      return { ok: Object.values(seen).every((t) => t === 'undefined'), detail: seen };
    }
    case 'preload': {
      const d = window.plannrDesktop;
      const seen = { value: JSON.stringify(d), keys: d ? Object.keys(d) : null, frozen: d ? Object.isFrozen(d) : null };
      return { ok: seen.value === '{"runtime":"desktop"}' && seen.keys.length === 1 && seen.frozen === true, detail: seen };
    }
    case 'outside': {
      const r = await fetch(OUTSIDE).then((x) => `loaded (${x.status})`, (e) => `blocked (${e && e.name})`);
      return { ok: r.startsWith('blocked'), detail: r };
    }
    case 'cash-inflow': {
      const ok = await waitFor(() => window.__plannrMode === 'server' && $('bySelect').options.length >= 2 && $('ciList').rows.length >= 1);
      return { ok: !!ok && location.href === 'app://plannr/cash-inflow.html', detail: { url: location.href, rows: $('ciList') ? $('ciList').rows.length : null } };
    }
    case 'add': {
      type($('amount'), arg.amount);
      type($('bySelect'), 'relative');
      type($('reason'), arg.reason);
      $('saveBtn').click();
      const ok = await waitFor(() => messageIs('Entry added.') && visible(rowWith(arg.reason)));
      return { ok: !!ok, detail: { message: $('ciMsg').textContent.trim() } };
    }
    case 'edit': {
      const button = rowWith(arg.from) && rowWith(arg.from).querySelector('[data-edit]');
      if (!button) return { ok: false, detail: 'no Edit button on the added row' };
      button.click();
      if (!await waitFor(() => $('saveBtn').textContent.trim() === 'Update entry' && $('reason').value === arg.from)) {
        return { ok: false, detail: 'the form did not switch to editing the entry' };
      }
      type($('amount'), arg.amount);
      type($('reason'), arg.reason);
      $('saveBtn').click();
      const confirm = await waitFor(() => {
        const dialog = document.querySelector('.pl-confirm-backdrop');
        return dialog && !dialog.hidden && dialog.querySelector('[data-plc="ok"]');
      });
      if (!confirm) return { ok: false, detail: 'no "Save changes?" dialog' };
      confirm.click();
      const ok = await waitFor(() => messageIs('Entry updated.') && visible(rowWith(arg.reason)));
      return { ok: !!ok, detail: { message: $('ciMsg').textContent.trim() } };
    }
    case 'shows': {
      const row = await waitFor(() => rowWith(arg.reason));
      const rowText = row ? row.textContent.replace(/\s+/g, ' ').trim() : null;
      const r = await fetch('/api/cash-in');
      const entries = ((await r.json()) || {}).entries || [];
      const mine = entries.filter((e) => String(e.reason).startsWith(arg.prefix)).map((e) => ({ reason: e.reason, amountPaise: e.amountPaise }));
      const ok = visible(row) && rowText.includes(arg.amountText) && !rowWith(arg.gone)
        && mine.length === 1 && mine[0].reason === arg.reason && mine[0].amountPaise === arg.amountPaise;
      return { ok, detail: { row: rowText, saved: mine } };
    }
    default:
      return { ok: false, detail: `unknown step ${op}` };
  }
}
