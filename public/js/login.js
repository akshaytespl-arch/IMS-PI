(function () {
  'use strict';
  const { $ = null } = {};
  const el = (id) => document.getElementById(id);
  const form = el('form');
  const errBox = el('error');
  const submit = el('submit');
  const params = new URLSearchParams(location.search);

  el('logo').innerHTML = UI.icon('calendar');
  if (params.get('expired')) {
    el('notice').textContent = 'Your session has ended. Please sign in again.';
    el('notice').classList.remove('hidden');
  }

  UI.get('/api/public/config').then((c) => {
    el('org').textContent = c.orgName;
    document.title = `Sign in · ${c.orgName}`;
    if (c.registrationMode !== 'admin_only') {
      el('reg').innerHTML = 'New here? <a href="/register">Create a student account</a>.';
    } else {
      el('reg').textContent = 'Accounts are created by your coordinator.';
    }
  }).catch(() => { /* config is cosmetic */ });

  el('toggle').addEventListener('click', (e) => {
    const pw = el('password');
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
    e.currentTarget.setAttribute('aria-pressed', String(show));
  });

  function showError(msg, field) {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.classList.add('hidden');
    const email = el('email');
    const pw = el('password');
    email.removeAttribute('aria-invalid');
    pw.removeAttribute('aria-invalid');
    if (!email.value.trim()) return showError('Please enter your email address.', email);
    if (!pw.value) return showError('Please enter your password.', pw);
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const r = await UI.post('/api/auth/login', { email: email.value.trim(), password: pw.value });
      const home = r.user.role === 'admin' ? '/admin' : '/app';
      const next = params.get('next');
      const ok = next && /^\/(admin|app)\/?$/.test(next) && next.startsWith(home);
      location.href = ok ? next : home;
    } catch (ex) {
      showError(ex.message);
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
})();
