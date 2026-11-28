// The desktop self-test's page side. PAGE CODE: desktop/self-test.js reads this file as text and runs
// it inside the window with webContents.executeJavaScript. The main process never imports it, and
// the app never serves it (it is not in public/).
//
// It uses the page the way a person does: it fills the Cash Inflow form and presses its buttons.
// Its only requests are the page's own /api and OUTSIDE, an address that can never resolve (.invalid,
// RFC 6761) and must be blocked. For the link checks it clicks links (and calls window.open) with
// the addresses self-test.js hands it, and the pages' own button and <a href> links; the link rules
// decide where they go. Every step answers { ok, detail }.
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
    case 'loaded': {
      // The page has loaded: the document is complete, the page's own script has run, it has a
      // viewport, and an element of this page (arg.selector, with arg.text if given) is visible.
      await waitFor(() => document.readyState === 'complete' && window.__plannrMode !== undefined);
      const el = arg && arg.selector ? document.querySelector(arg.selector) : null;
      const seen = {
        url: location.href, readyState: document.readyState, mode: window.__plannrMode, title: document.title,
        viewport: [window.innerWidth, window.innerHeight], visibility: document.visibilityState,
        element: el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : null,
      };
      const ok = seen.readyState === 'complete' && seen.mode === 'server' && window.innerWidth > 0 && window.innerHeight > 0
        && visible(el) && (!arg.text || seen.element === arg.text);
      return { ok, detail: seen };
    }
    case 'click-link': {
      // A link as a person would click it. The mark shows later whether this is still the same page.
      window.__plannrSelfTestMark = arg.mark;
      const a = document.createElement('a');
      a.href = arg.url;
      a.textContent = 'Plannr self-test link';
      document.body.appendChild(a);
      // Clicked after this answer has gone back, so a navigation cannot cut the answer off.
      setTimeout(() => { a.click(); a.remove(); }, 0);
      return { ok: true, detail: { href: a.href } };
    }
    case 'window-open': {
      window.__plannrSelfTestMark = arg.mark;
      const w = window.open(arg.url);
      // The window-open handler always denies, and then window.open answers null.
      return { ok: w === null, detail: { returned: w === null ? null : typeof w } };
    }
    case 'click-button': {
      const button = document.querySelector(arg.selector);
      if (!visible(button)) return { ok: false, detail: `no visible ${arg.selector}` };
      setTimeout(() => button.click(), 0);
      return { ok: true, detail: { text: button.textContent.trim() } };
    }
    case 'click-anchor': {
      // One of the page's own <a href> links, clicked as a person would: the address comes from the
      // page's own markup, not from this code. It must be a plain link (no target), so the browser
      // itself starts the navigation.
      const a = document.querySelector(arg.selector);
      if (!a) return { ok: false, detail: `no ${arg.selector}` };
      const seen = {
        tag: a.tagName, href: a.getAttribute('href'), resolved: a.href, target: a.getAttribute('target'),
        text: a.textContent.replace(/\s+/g, ' ').trim(),
      };
      if (!(a instanceof HTMLAnchorElement) || seen.href !== arg.href || seen.target !== null || !visible(a)) return { ok: false, detail: seen };
      setTimeout(() => a.click(), 0);
      return { ok: true, detail: seen };
    }
    case 'same-page': {
      const seen = { url: location.href, sameDocument: window.__plannrSelfTestMark === arg.mark, readyState: document.readyState };
      return { ok: seen.sameDocument && seen.url === arg.url && seen.readyState === 'complete', detail: seen };
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
