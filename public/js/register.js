(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const form = el('form');
  const errBox = el('error');
  el('logo').innerHTML = UI.icon('calendar');
  let mode = 'admin_only';

  UI.get('/api/public/config').then((c) => {
    mode = c.registrationMode;
    el('org').textContent = c.orgName;
    if (mode === 'admin_only') { form.classList.add('hidden'); el('closed').classList.remove('hidden'); }
    if (mode === 'invite_code') el('codeField').classList.remove('hidden');
  }).catch((e) => { errBox.textContent = e.message; errBox.classList.remove('hidden'); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.classList.add('hidden');
    const btn = el('submit');
    const body = {
      name: el('name').value, email: el('email').value, batch: el('batch').value, phone: el('phone').value, password: el('password').value,
    };
    if (mode === 'invite_code') body.code = el('code').value;
    if (!body.name.trim() || !body.email.trim() || !body.password) {
      errBox.textContent = 'Please fill in your name, email and password.';
      errBox.classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    try {
      await UI.post('/api/auth/register', body);
      form.classList.add('hidden');
      el('done').classList.remove('hidden');
    } catch (ex) {
      errBox.textContent = ex.message;
      errBox.classList.remove('hidden');
      btn.disabled = false;
    }
  });
})();
