// Shared behavior for Plannr's auth screens (login / register).
// One init, driven entirely by a per-page config object — no page forks the
// logic. Loaded as a normal (non-module) script; each page calls initAuth(...).
//
// Config fields:
//   formId          form element id                                (required)
//   endpoint        POST target, e.g. '/api/login'                 (required)
//   bodyFields      input ids serialized into the JSON body; each becomes a
//                   key of the same name with .value                (required)
//   busyText        submit-button text while the request is in flight
//   idleText        submit-button text at rest (restored in finally)
//   errorFallback   message shown when the server returns no error text
//   toggleFields    input ids the eye toggle reveals (first one sets direction)
//   checkSession    if true, fetch /api/me on load and redirect to '/' if logged in
//   matchFields     [a, b] input ids that must be equal before submitting
//   matchError      message shown when matchFields differ
//   onSuccess       'redirect' | 'message'
//   successRedirect location for onSuccess: 'redirect'
//   successMessage  fallback text for onSuccess: 'message' (when no data.message)
//   successSuffix   text appended after the success message
window.initAuth = function initAuth(config) {
  const form = document.getElementById(config.formId);
  const msg = document.getElementById('msg');
  const btn = document.getElementById('submitBtn');
  const toggle = document.getElementById('toggle');

  function showMsg(text, type) {
    msg.textContent = text;
    msg.className = 'msg show ' + type;
  }

  // Eye-icon show / hide toggle. The first field decides the direction and
  // every configured field follows it (register reveals password + confirm;
  // login reveals the one password field).
  const toggleFields = (config.toggleFields || []).map((id) => document.getElementById(id));
  if (toggle && toggleFields.length) {
    toggle.addEventListener('click', () => {
      const reveal = toggleFields[0].type === 'password';
      const type = reveal ? 'text' : 'password';
      toggleFields.forEach((f) => { f.type = type; });
      toggle.setAttribute('aria-pressed', String(reveal));
      toggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    });
  }

  // Already logged in? Skip straight to the app.
  if (config.checkSession) {
    fetch('/api/me').then((r) => { if (r.ok) location.href = '/'; });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.className = 'msg';

    // Optional client-side equality check (e.g. password == confirm) before submit.
    if (config.matchFields) {
      const [a, b] = config.matchFields.map((id) => document.getElementById(id));
      if (a.value !== b.value) {
        showMsg(config.matchError, 'error');
        return;
      }
    }

    btn.disabled = true;
    btn.textContent = config.busyText;
    try {
      const body = {};
      config.bodyFields.forEach((id) => { body[id] = document.getElementById(id).value; });
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (config.onSuccess === 'redirect') {
          location.href = config.successRedirect;
        } else {
          form.reset();
          showMsg((data.message || config.successMessage) + config.successSuffix, 'success');
        }
      } else {
        showMsg(data.error || config.errorFallback, 'error');
      }
    } catch {
      showMsg('Network error. Please try again.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = config.idleText;
    }
  });
};
