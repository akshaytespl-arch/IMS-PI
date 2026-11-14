/* Shared, role-agnostic helpers. Contains no secrets and nothing role-specific. */
(function () {
  'use strict';

  const state = { csrf: '' };

  // ---------- escaping (all dynamic text goes through esc()) ----------
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"'`]/g, (c) => ESC[c]);

  // ---------- API ----------
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  async function api(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
    let res;
    try {
      res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const e = (data && data.error) || {};
      if (res.status === 401 && !path.startsWith('/api/auth/login')) {
        location.href = '/login?expired=1';
        throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has ended. Please sign in again.');
      }
      throw new ApiError(res.status, e.code || 'ERROR', e.message || 'Something went wrong. Please try again.');
    }
    return data;
  }
  const get = (p) => api('GET', p);
  const post = (p, b) => api('POST', p, b === undefined ? {} : b);
  const patch = (p, b) => api('PATCH', p, b);
  const put = (p, b) => api('PUT', p, b);
  const del = (p) => api('DELETE', p);
  const qs = (o) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  // ---------- date / time (all values are IST; dates are plain YYYY-MM-DD) ----------
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }; };
  const longDate = (s) => { const p = parseDate(s); return `${DAYS[p.dow]}, ${p.d} ${MONTHS[p.m - 1]} ${p.y}`; };
  const shortDate = (s) => { const p = parseDate(s); return `${DAYS[p.dow].slice(0, 3)}, ${p.d} ${MONTHS[p.m - 1].slice(0, 3)} ${p.y}`; };
  const time12 = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const range12 = (a, b) => `${time12(a)} – ${time12(b)}`;
  const stamp = (iso) => {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)) + ' IST';
  };
  const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  // ---------- icons (inline SVG, stroke = currentColor) ----------
  const PATHS = {
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    log: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  };
  const icon = (n, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[n] || ''}</svg>`;

  // ---------- badges (icon/text, never colour alone) ----------
  const BADGE = {
    confirmed: ['check', 'Confirmed'], completed: ['check', 'Completed'], cancelled: ['x', 'Cancelled'], rescheduled: ['refresh', 'Rescheduled'],
    open: ['clock', 'Open'], booked: ['check', 'Booked'], blocked: ['x', 'Blocked'], active: ['check', 'Active'], inactive: ['x', 'Inactive'], disabled: ['x', 'Disabled'],
  };
  const badge = (s) => { const b = BADGE[s] || ['clock', s]; return `<span class="badge badge-${esc(s)}">${icon(b[0])}${esc(b[1])}</span>`; };

  const empty = (title, text = '', action = '', ic = 'inbox') => `<div class="empty">${icon(ic)}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
  const skeleton = (n = 3) => Array.from({ length: n }, () => '<div class="skeleton"></div>').join('') + '<span class="sr-only" role="status">Loading…</span>';
  const errorBox = (e) => `<div class="alert alert-error" role="alert">${esc(e && e.message ? e.message : e)}</div>`;

  // ---------- toasts ----------
  function toast(msg, type = '') {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 7000 : 4500);
  }

  // ---------- dialogs ----------
  function openDialog({ title, bodyHtml, footHtml = '', onOpen }) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.setAttribute('aria-labelledby', 'dlg-title');
      dlg.innerHTML = `<div class="dlg-head"><h2 id="dlg-title">${esc(title)}</h2></div><div class="dlg-body">${bodyHtml}</div><div class="dlg-foot">${footHtml}</div>`;
      document.body.appendChild(dlg);
      let result = null;
      const close = (v) => { result = v; dlg.close(); };
      dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
      dlg.addEventListener('click', (e) => { if (e.target === dlg) close(null); });
      dlg.showModal();
      if (onOpen) onOpen(dlg, close);
    });
  }

  function confirmDialog({ title, body, confirmText = 'Confirm', danger = false, cancelText = 'Cancel' }) {
    return openDialog({
      title,
      bodyHtml: `<p>${esc(body)}</p>`,
      footHtml: `<button type="button" class="btn" data-no>${esc(cancelText)}</button><button type="button" class="btn ${danger ? 'btn-danger solid' : 'btn-primary'}" data-yes>${esc(confirmText)}</button>`,
      onOpen: (dlg, close) => {
        dlg.querySelector('[data-no]').addEventListener('click', () => close(false));
        const y = dlg.querySelector('[data-yes]');
        y.addEventListener('click', () => close(true));
        (danger ? dlg.querySelector('[data-no]') : y).focus();
      },
    }).then((v) => v === true);
  }

  // fields: [{ name, label, type: text|email|password|number|date|time|select|textarea|checkbox, required, options:[{value,label}], value, help, max, min }]
  function formDialog({ title, intro = '', fields, submitText = 'Save', onSubmit }) {
    const fieldHtml = fields.map((f) => {
      const id = `f_${f.name}`;
      const help = f.help ? `<div class="help" id="${id}_h">${esc(f.help)}</div>` : '';
      const common = `id="${id}" name="${esc(f.name)}" ${f.required ? 'required' : ''} ${f.help ? `aria-describedby="${id}_h"` : ''}`;
      let input;
      if (f.type === 'select') {
        input = `<select ${common}>${(f.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      } else if (f.type === 'textarea') {
        input = `<textarea ${common} maxlength="${f.max || 1000}">${esc(f.value || '')}</textarea>`;
      } else if (f.type === 'checkbox') {
        return `<div class="field"><label class="check"><input type="checkbox" id="${id}" name="${esc(f.name)}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>${help}</div>`;
      } else {
        input = `<input type="${f.type || 'text'}" ${common} value="${esc(f.value ?? '')}" ${f.max ? `maxlength="${f.max}"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''}>`;
      }
      return `<div class="field"><label for="${id}">${esc(f.label)}${f.required ? ' <span class="muted">*</span>' : ''}</label>${input}${help}<div class="err hidden" id="${id}_e" role="alert"></div></div>`;
    }).join('');
    return openDialog({
      title,
      bodyHtml: `${intro ? `<p class="muted">${esc(intro)}</p>` : ''}<form id="dlg-form" novalidate><div class="alert alert-error hidden" id="dlg-err" role="alert"></div>${fieldHtml}</form>`,
      footHtml: `<button type="button" class="btn" data-no>Cancel</button><button type="submit" form="dlg-form" class="btn btn-primary" id="dlg-submit">${esc(submitText)}</button>`,
      onOpen: (dlg, close) => {
        const form = dlg.querySelector('#dlg-form');
        const err = dlg.querySelector('#dlg-err');
        dlg.querySelector('[data-no]').addEventListener('click', () => close(null));
        const first = form.querySelector('input,select,textarea');
        if (first) first.focus();
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          err.classList.add('hidden');
          let bad = false;
          const values = {};
          for (const f of fields) {
            const el = form.elements[f.name];
            const eEl = dlg.querySelector(`#f_${f.name}_e`);
            let v = f.type === 'checkbox' ? el.checked : el.value.trim();
            if (f.type === 'password') v = el.value;
            if (f.type === 'number' && v !== '') v = Number(v);
            if (eEl) eEl.classList.add('hidden');
            if (el) el.removeAttribute('aria-invalid');
            if (f.required && (v === '' || v === null)) {
              bad = true;
              if (eEl) { eEl.textContent = `${f.label} is required.`; eEl.classList.remove('hidden'); el.setAttribute('aria-invalid', 'true'); }
            }
            values[f.name] = v;
          }
          if (bad) { const inv = form.querySelector('[aria-invalid=true]'); if (inv) inv.focus(); return; }
          const btn = dlg.querySelector('#dlg-submit');
          btn.disabled = true;
          try {
            const r = await onSubmit(values);
            close(r === undefined ? true : r);
          } catch (ex) {
            err.textContent = ex.message || 'Something went wrong.';
            err.classList.remove('hidden');
            btn.disabled = false;
          }
        });
      },
    });
  }

  // ---------- misc ----------
  const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  function pager({ total, page, pageSize }) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const to = Math.min(total, page * pageSize);
    return `<div class="pager"><span>${from}–${to} of ${total}</span><span class="actions-row">
      <button class="btn btn-sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${icon('chevL')} Previous</button>
      <button class="btn btn-sm" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next ${icon('chevR')}</button></span></div>`;
  }
  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, query = ''] = raw.split('?');
    return { path, params: Object.fromEntries(new URLSearchParams(query)) };
  }
  async function logout() {
    try { await post('/api/auth/logout'); } catch { /* ignore */ }
    location.href = '/login';
  }
  function passwordDialog(forced = false) {
    return formDialog({
      title: forced ? 'Choose a new password' : 'Change password',
      intro: forced ? 'For your security, please set a personal password before continuing.' : '',
      submitText: 'Update password',
      fields: [
        { name: 'current', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
        { name: 'next', label: 'New password', type: 'password', required: true, help: 'At least 8 characters.', autocomplete: 'new-password' },
        { name: 'again', label: 'Repeat new password', type: 'password', required: true, autocomplete: 'new-password' },
      ],
      onSubmit: async (v) => {
        if (v.next !== v.again) throw new Error('The new passwords do not match.');
        await post('/api/auth/change-password', { current: v.current, next: v.next });
      },
    });
  }

  window.UI = {
    state, esc, api, get, post, patch, put, del, qs, ApiError,
    longDate, shortDate, time12, range12, stamp, todayIST, addDays, parseDate, MONTHS, DAYS,
    icon, badge, empty, skeleton, errorBox, toast, openDialog, confirmDialog, formDialog, debounce, pager, parseHash, logout, passwordDialog,
  };
})();
