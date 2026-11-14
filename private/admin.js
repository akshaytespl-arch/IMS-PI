/* Admin app. Served only to signed-in admins. */
(function () {
  'use strict';
  const { esc, icon, badge, empty, skeleton, errorBox, toast, longDate, shortDate, range12, time12, stamp, qs } = UI;
  const view = document.getElementById('view');
  const $ = (sel, root = view) => root.querySelector(sel);
  const $$ = (sel, root = view) => [...root.querySelectorAll(sel)];
  let me = null;

  const NAV = [
    ['Overview', [['#/', 'Dashboard', 'home'], ['#/schedule', 'Schedule', 'calendar']]],
    ['Manage', [['#/bookings', 'Bookings', 'list'], ['#/availability', 'Availability', 'clock'], ['#/mentors', 'Mentors', 'userCheck'], ['#/students', 'Students', 'users']]],
    ['Insights', [['#/reports', 'Reports & export', 'chart'], ['#/audit', 'Audit log', 'log'], ['#/settings', 'Settings', 'settings']]],
  ];
  function renderNav(path) {
    document.getElementById('nav').innerHTML = NAV.map(([g, items]) => `<div class="group">${g}</div>${items.map(([href, label, ic]) => {
      const p = href.slice(1);
      const cur = p === '/' ? path === '/' : path === p || path.startsWith(`${p}/`);
      return `<a href="${href}" ${cur ? 'aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span></a>`;
    }).join('')}`).join('');
  }
  function setView(html, title) {
    view.innerHTML = html;
    document.title = `${title} · Admin`;
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('menu').setAttribute('aria-expanded', 'false');
  }
  const head = (title, sub = '', actions = '') => `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p class="muted">${esc(sub)}</p>` : ''}</div><div class="actions-row">${actions}</div></div>`;
  const tableWrap = (cols, rowsHtml) => `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(sel) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  const dash = (v) => (v === null || v === undefined || v === '' ? '—' : esc(v));
  const copyBtn = (text) => `<button type="button" class="btn btn-sm" data-copy="${esc(text)}">Copy</button>`;

  function secretDialog(title, intro, secret) {
    return UI.openDialog({
      title,
      bodyHtml: `<p>${esc(intro)}</p><div class="code-block" id="secret">${esc(secret)}</div><p class="small muted mt">This is shown <strong>once</strong>. The user will be asked to choose their own password at first sign-in.</p>`,
      footHtml: `${copyBtn(secret)}<button type="button" class="btn btn-primary" data-done>Done</button>`,
      onOpen: (dlg, close) => {
        dlg.querySelector('[data-copy]').addEventListener('click', async (e) => { try { await navigator.clipboard.writeText(secret); e.target.textContent = 'Copied'; } catch { toast('Select the text and copy it manually.'); } });
        dlg.querySelector('[data-done]').addEventListener('click', () => close(true));
      },
    });
  }

  // ------------------------------------------------------------------ dashboard
  async function dashboard() {
    setView(`${head('Dashboard')}${skeleton(5)}`, 'Dashboard');
    try {
      const d = await UI.get('/api/admin/dashboard');
      const c = d.cards;
      const card = (n, l, href) => `<a class="card stat stat-link" href="${href}">${`<div class="num">${n}</div><div class="lbl">${esc(l)}</div>`}</a>`;
      setView(`${head('Dashboard', 'A quick look at today’s activity.')}
        ${d.email_note ? `<div class="alert alert-warn" role="status">${esc(d.email_note)} <a href="#/settings">Learn more</a></div>` : ''}
        <div class="grid grid-cards">
          ${card(c.total_students, 'Active students', '#/students')}
          ${card(c.total_mentors, 'Active mentors', '#/mentors')}
          ${card(c.upcoming_bookings, 'Upcoming bookings', '#/bookings?status=confirmed')}
          ${card(c.completed_sessions, 'Completed sessions', '#/bookings?status=completed')}
          ${card(c.cancelled_bookings, 'Cancelled bookings', '#/bookings?status=cancelled')}
          ${card(c.available_slots, 'Open slots', '#/availability')}
        </div>
        <div class="card mt-lg"><div class="card-head"><h2>Next sessions</h2><a href="#/bookings">All bookings</a></div>
        ${d.upcoming.length ? tableWrap(['When', 'Student', 'Mentor', 'Status', ''], d.upcoming.map((b) => `<tr><td class="nowrap">${esc(shortDate(b.date))}<br><span class="muted small">${esc(range12(b.start_time, b.end_time))}</span></td><td>${esc(b.student_name)}</td><td>${esc(b.mentor_name)}</td><td>${badge(b.status)}</td><td class="actions"><a class="btn btn-sm" href="#/bookings/${b.id}">View</a></td></tr>`).join(''))
          : empty('No upcoming bookings', 'Open some availability so students can book.', '<p><a class="btn btn-primary" href="#/availability">Open availability</a></p>', 'calendar')}
        </div>`, 'Dashboard');
    } catch (e) { setView(`${head('Dashboard')}${errorBox(e)}`, 'Dashboard'); }
  }

  // ------------------------------------------------------------------ students
  const sf = { q: '', status: '', batch: '', page: 1 };
  async function students() {
    setView(`${head('Students')}${skeleton(5)}`, 'Students');
    await drawStudents();
  }
  async function drawStudents() {
    try {
      const d = await UI.get(`/api/admin/students${qs({ q: sf.q, status: sf.status, batch: sf.batch, page: sf.page })}`);
      setView(`${head('Students', 'Create accounts, update details and reset passwords.', `<a class="btn" href="/api/admin/students/export.csv${qs({ q: sf.q, status: sf.status, batch: sf.batch })}">${icon('download')} Export CSV</a><button class="btn btn-primary" id="add" type="button">${icon('plus')} Add student</button>`)}
        <div class="toolbar">
          <div class="field grow"><label for="q">Search</label><input id="q" type="search" placeholder="Name, email, ID or batch" value="${esc(sf.q)}"></div>
          <div class="field"><label for="st">Status</label><select id="st">${opt('', 'All', sf.status)}${opt('active', 'Active', sf.status)}${opt('inactive', 'Inactive', sf.status)}</select></div>
          <div class="field"><label for="bt">Batch</label><select id="bt">${opt('', 'All batches', sf.batch)}${d.batches.map((b) => opt(b, b, sf.batch)).join('')}</select></div>
        </div>
        ${d.rows.length ? tableWrap(['Name', 'Student ID', 'Email', 'Batch', 'Phone', 'Status', 'Bookings', ''], d.rows.map((s) => `<tr>
          <td><strong>${esc(s.name)}</strong>${s.must_change_password ? '<br><span class="small muted">Password not yet changed</span>' : ''}</td><td>${dash(s.student_code)}</td><td>${esc(s.email)}</td><td>${dash(s.batch)}</td><td>${dash(s.phone)}</td>
          <td>${badge(s.status)}</td><td><a href="#/bookings?student_id=${s.id}">${s.bookings_count}</a></td>
          <td class="actions"><button class="btn btn-sm" data-edit="${s.id}">Edit</button> <button class="btn btn-sm" data-reset="${s.id}" data-name="${esc(s.name)}">Reset password</button>
          <button class="btn btn-sm" data-toggle="${s.id}" data-status="${s.status}" data-name="${esc(s.name)}">${s.status === 'active' ? 'Deactivate' : 'Activate'}</button>
          <button class="btn btn-sm btn-danger" data-del="${s.id}" data-name="${esc(s.name)}">Delete</button></td></tr>`).join(''))
          + UI.pager(d) : `<div class="card">${empty('No students found', sf.q || sf.status || sf.batch ? 'Try clearing the filters.' : 'Add your first student to get started.', '', 'users')}</div>`}`, 'Students');
      const rows = new Map(d.rows.map((r) => [String(r.id), r]));
      $('#q').addEventListener('input', UI.debounce((e) => { sf.q = e.target.value; sf.page = 1; drawStudents().then(() => { const el = $('#q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }));
      $('#st').addEventListener('change', (e) => { sf.status = e.target.value; sf.page = 1; drawStudents(); });
      $('#bt').addEventListener('change', (e) => { sf.batch = e.target.value; sf.page = 1; drawStudents(); });
      $$('[data-page]').forEach((b) => b.addEventListener('click', () => { sf.page = Number(b.dataset.page); drawStudents(); }));
      $('#add').addEventListener('click', async () => {
        let created = null;
        const ok = await UI.formDialog({
          title: 'Add student', submitText: 'Create account',
          intro: 'A temporary password is generated unless you set one. The student must change it at first sign-in.',
          fields: [
            { name: 'name', label: 'Full name', required: true, max: 100 },
            { name: 'email', label: 'Email', type: 'email', required: true, max: 254 },
            { name: 'student_code', label: 'Student ID', max: 40 }, { name: 'batch', label: 'Batch / group', max: 60 }, { name: 'phone', label: 'Phone', max: 30 },
            { name: 'password', label: 'Temporary password (optional)', type: 'password', help: 'Leave blank to generate one.' },
          ],
          onSubmit: async (v) => { created = await UI.post('/api/admin/students', v); },
        });
        if (ok && created) {
          if (created.generated_password) await secretDialog('Student created', 'Share this temporary password with the student:', created.generated_password);
          else toast('Student created.', 'success');
          drawStudents();
        }
      });
      $$('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
        const s = rows.get(b.dataset.edit);
        const ok = await UI.formDialog({
          title: 'Edit student', fields: [
            { name: 'name', label: 'Full name', required: true, value: s.name, max: 100 },
            { name: 'email', label: 'Email', type: 'email', required: true, value: s.email, max: 254 },
            { name: 'student_code', label: 'Student ID', value: s.student_code || '', max: 40 },
            { name: 'batch', label: 'Batch / group', value: s.batch || '', max: 60 }, { name: 'phone', label: 'Phone', value: s.phone || '', max: 30 }],
          onSubmit: (v) => UI.patch(`/api/admin/students/${s.id}`, v),
        });
        if (ok) { toast('Student updated.', 'success'); drawStudents(); }
      }));
      $$('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
        if (!await UI.confirmDialog({ title: 'Reset password?', body: `${b.dataset.name} will be signed out and given a new temporary password.`, confirmText: 'Reset password' })) return;
        try { const r = await UI.post(`/api/admin/students/${b.dataset.reset}/reset-password`); await secretDialog('Password reset', `New temporary password for ${b.dataset.name}:`, r.generated_password); drawStudents(); }
        catch (e) { toast(e.message, 'error'); }
      }));
      $$('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
        const next = b.dataset.status === 'active' ? 'inactive' : 'active';
        if (next === 'inactive' && !await UI.confirmDialog({ title: 'Deactivate student?', body: `${b.dataset.name} will be signed out and unable to sign in. Existing bookings are kept.`, confirmText: 'Deactivate', danger: true })) return;
        try { await UI.patch(`/api/admin/students/${b.dataset.toggle}`, { status: next }); toast(`Student ${next === 'active' ? 'activated' : 'deactivated'}.`, 'success'); drawStudents(); }
        catch (e) { toast(e.message, 'error'); }
      }));
      $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!await UI.confirmDialog({ title: 'Delete student?', body: `This permanently deletes ${b.dataset.name}. Students with booking history cannot be deleted — deactivate them instead.`, confirmText: 'Delete', danger: true })) return;
        try { await UI.del(`/api/admin/students/${b.dataset.del}`); toast('Student deleted.', 'success'); drawStudents(); }
        catch (e) { toast(e.message, 'error'); }
      }));
    } catch (e) { setView(`${head('Students')}${errorBox(e)}`, 'Students'); }
  }

  // ------------------------------------------------------------------ mentors
  const mf = { q: '', status: '' };
  async function mentors() {
    setView(`${head('Mentors')}${skeleton(5)}`, 'Mentors');
    await drawMentors();
  }
  async function drawMentors() {
    try {
      const d = await UI.get(`/api/admin/mentors${qs(mf)}`);
      setView(`${head('Mentors', 'Mentor names and contact details are internal — students never see them.', `<a class="btn" href="/api/admin/mentors/export.csv${qs(mf)}">${icon('download')} Export CSV</a><button class="btn btn-primary" id="add" type="button">${icon('plus')} Add mentor</button>`)}
        <div class="toolbar">
          <div class="field grow"><label for="q">Search</label><input id="q" type="search" placeholder="Name or email" value="${esc(mf.q)}"></div>
          <div class="field"><label for="st">Status</label><select id="st">${opt('', 'All', mf.status)}${opt('active', 'Active', mf.status)}${opt('inactive', 'Inactive', mf.status)}</select></div>
        </div>
        ${d.rows.length ? tableWrap(['Name', 'Email', 'Phone', 'Status', 'Open slots', 'Bookings', ''], d.rows.map((m) => `<tr>
          <td><strong>${esc(m.name)}</strong>${m.notes ? `<br><span class="small muted">${esc(m.notes.slice(0, 80))}${m.notes.length > 80 ? '…' : ''}</span>` : ''}</td><td>${dash(m.email)}</td><td>${dash(m.phone)}</td><td>${badge(m.status)}</td>
          <td><a href="#/availability?mentor_id=${m.id}">${m.open_slots}</a></td><td><a href="#/bookings?mentor_id=${m.id}">${m.bookings_count}</a></td>
          <td class="actions"><button class="btn btn-sm" data-edit="${m.id}">Edit</button>
          <button class="btn btn-sm" data-toggle="${m.id}" data-status="${m.status}" data-name="${esc(m.name)}">${m.status === 'active' ? 'Deactivate' : 'Activate'}</button>
          <button class="btn btn-sm btn-danger" data-del="${m.id}" data-name="${esc(m.name)}">Remove</button></td></tr>`).join(''))
          : `<div class="card">${empty('No mentors found', mf.q || mf.status ? 'Try clearing the filters.' : 'Add a mentor, then open availability for them.', '', 'userCheck')}</div>`}`, 'Mentors');
      const rows = new Map(d.rows.map((r) => [String(r.id), r]));
      $('#q').addEventListener('input', UI.debounce((e) => { mf.q = e.target.value; drawMentors().then(() => { const el = $('#q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }));
      $('#st').addEventListener('change', (e) => { mf.status = e.target.value; drawMentors(); });
      const mentorFields = (m = {}) => [
        { name: 'name', label: 'Name', required: true, value: m.name || '', max: 100 },
        { name: 'email', label: 'Email (internal)', type: 'email', value: m.email || '', max: 254 },
        { name: 'phone', label: 'Phone (internal)', value: m.phone || '', max: 30 },
        { name: 'notes', label: 'Internal notes', type: 'textarea', value: m.notes || '', max: 1000 },
      ];
      $('#add').addEventListener('click', async () => {
        const ok = await UI.formDialog({ title: 'Add mentor', submitText: 'Add mentor', fields: mentorFields(), onSubmit: (v) => UI.post('/api/admin/mentors', v) });
        if (ok) { toast('Mentor added. Next, open their availability.', 'success'); drawMentors(); }
      });
      $$('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
        const m = rows.get(b.dataset.edit);
        const ok = await UI.formDialog({ title: 'Edit mentor', fields: mentorFields(m), onSubmit: (v) => UI.patch(`/api/admin/mentors/${m.id}`, v) });
        if (ok) { toast('Mentor updated.', 'success'); drawMentors(); }
      }));
      $$('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
        const next = b.dataset.status === 'active' ? 'inactive' : 'active';
        if (next === 'inactive' && !await UI.confirmDialog({ title: 'Deactivate mentor?', body: `${b.dataset.name}’s open slots will no longer be offered to students. Existing bookings are kept — review them and reassign if needed.`, confirmText: 'Deactivate', danger: true })) return;
        try {
          const r = await UI.patch(`/api/admin/mentors/${b.dataset.toggle}`, { status: next });
          toast(r.future_bookings_affected ? `Deactivated. ${r.future_bookings_affected} upcoming booking(s) still assigned — review them.` : `Mentor ${next === 'active' ? 'activated' : 'deactivated'}.`, 'success');
          drawMentors();
        } catch (e) { toast(e.message, 'error'); }
      }));
      $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!await UI.confirmDialog({ title: 'Remove mentor?', body: `This permanently removes ${b.dataset.name} and their unbooked slots. Mentors with booking history cannot be removed — deactivate them instead.`, confirmText: 'Remove', danger: true })) return;
        try { await UI.del(`/api/admin/mentors/${b.dataset.del}`); toast('Mentor removed.', 'success'); drawMentors(); }
        catch (e) { toast(e.message, 'error'); }
      }));
    } catch (e) { setView(`${head('Mentors')}${errorBox(e)}`, 'Mentors'); }
  }

  // ------------------------------------------------------------------ availability
  const af = { from: '', to: '', mentor_id: '', status: '', page: 1 };
  let mentorList = [];
  async function availability(params) {
    if (params.mentor_id) af.mentor_id = params.mentor_id;
    if (!af.from) { af.from = UI.todayIST(); af.to = UI.addDays(af.from, 13); }
    setView(`${head('Availability')}${skeleton(5)}`, 'Availability');
    try { mentorList = (await UI.get('/api/admin/mentors?status=active')).rows; } catch (e) { return setView(`${head('Availability')}${errorBox(e)}`, 'Availability'); }
    drawAvailability();
  }
  async function drawAvailability() {
    try {
      const d = await UI.get(`/api/admin/availability${qs({ ...af, pageSize: 50 })}`);
      const today = UI.todayIST();
      const wk = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      setView(`${head('Availability', 'Open 30-minute slots for mentors. Students only see times — never who they are with.')}
        <div class="card">
          <div class="card-head"><h2>Open availability</h2></div>
          ${mentorList.length ? `<form id="gen" novalidate>
            <div id="generr" class="alert alert-error hidden" role="alert"></div>
            <div class="row">
              <div class="field"><label for="g_mentor">Mentor</label><select id="g_mentor">${mentorList.map((m) => opt(m.id, m.name, af.mentor_id)).join('')}</select></div>
              <div class="field"><label for="g_mode">Repeat</label><select id="g_mode"><option value="single">Single date</option><option value="range">Every day in a date range</option><option value="recurring">Selected weekdays in a date range</option></select></div>
              <div class="field"><label for="g_date" id="g_date_l">Date</label><input id="g_date" type="date" value="${today}" min="${today}" required></div>
              <div class="field hidden" id="g_end_w"><label for="g_end">Until</label><input id="g_end" type="date" min="${today}"></div>
            </div>
            <div class="field hidden" id="g_days_w"><span class="label">Weekdays</span><div class="weekday-picks">${[1, 2, 3, 4, 5, 6, 0].map((i) => `<label><input type="checkbox" name="wd" value="${i}" ${i >= 1 && i <= 5 ? 'checked' : ''}> ${wk[i]}</label>`).join('')}</div></div>
            <div class="row">
              <div class="field"><label for="g_start">From</label><input id="g_start" type="time" step="1800" value="10:00" required></div>
              <div class="field"><label for="g_endt">To</label><input id="g_endt" type="time" step="1800" value="13:00" required></div>
            </div>
            <p class="small muted" id="g_prev"></p>
            <button class="btn btn-primary" type="submit">Create slots</button>
          </form>` : empty('Add a mentor first', 'Slots belong to a mentor.', '<p><a class="btn btn-primary" href="#/mentors">Go to mentors</a></p>', 'userCheck')}
        </div>
        <div class="card mt">
          <div class="card-head"><h2>Close a date</h2></div>
          <form id="close" class="toolbar" novalidate>
            <div class="field"><label for="c_date">Date</label><input id="c_date" type="date" min="${today}" required></div>
            <div class="field"><label for="c_mentor">Mentor</label><select id="c_mentor">${opt('', 'All mentors', '')}${mentorList.map((m) => opt(m.id, m.name, '')).join('')}</select></div>
            <button class="btn" type="submit" data-act="blocked">Close date</button><button class="btn" type="submit" data-act="open">Reopen date</button>
          </form>
          <p class="small muted">Closing blocks every unbooked slot on that date. Existing bookings are not touched.</p>
        </div>
        <div class="card mt">
          <div class="card-head"><h2>Slots</h2><a class="btn btn-sm" href="/api/admin/availability/export.csv${qs(af)}">${icon('download')} Export CSV</a></div>
          <div class="toolbar">
            <div class="field"><label for="f_from">From</label><input id="f_from" type="date" value="${esc(af.from)}"></div>
            <div class="field"><label for="f_to">To</label><input id="f_to" type="date" value="${esc(af.to)}"></div>
            <div class="field"><label for="f_mentor">Mentor</label><select id="f_mentor">${opt('', 'All mentors', af.mentor_id)}${mentorList.map((m) => opt(m.id, m.name, af.mentor_id)).join('')}</select></div>
            <div class="field"><label for="f_status">Status</label><select id="f_status">${opt('', 'All', af.status)}${opt('open', 'Open', af.status)}${opt('booked', 'Booked', af.status)}${opt('blocked', 'Blocked', af.status)}</select></div>
          </div>
          <div class="actions-row mb"><button class="btn btn-sm" id="b_block" type="button" disabled>Block selected</button><button class="btn btn-sm" id="b_open" type="button" disabled>Unblock selected</button><button class="btn btn-sm btn-danger" id="b_del" type="button" disabled>Delete selected</button><span class="small muted" id="selcount" role="status"></span></div>
          ${d.rows.length ? tableWrap(['', 'Date', 'Time', 'Mentor', 'Status', 'Booked by'], d.rows.map((s) => `<tr>
            <td><input type="checkbox" class="rowck" value="${s.id}" aria-label="Select slot ${esc(s.date)} ${esc(s.start_time)} ${esc(s.mentor_name)}"></td>
            <td class="nowrap">${esc(shortDate(s.date))}</td><td class="nowrap">${esc(range12(s.start_time, s.end_time))}</td><td>${esc(s.mentor_name)}</td><td>${badge(s.status)}</td>
            <td>${s.booking_id ? `<a href="#/bookings/${s.booking_id}">${esc(s.student_name)}</a>` : '—'}</td></tr>`).join('')).replace('<th scope="col"></th>', '<th scope="col"><input type="checkbox" id="allck" aria-label="Select all slots on this page"></th>') + UI.pager(d)
            : empty('No slots in this range', 'Use “Open availability” above to create some.', '', 'clock')}
        </div>`, 'Availability');
      bindAvailability();
    } catch (e) { setView(`${head('Availability')}${errorBox(e)}`, 'Availability'); }
  }
  function bindAvailability() {
    const gen = $('#gen');
    if (gen) {
      const mode = $('#g_mode');
      const prev = () => {
        const m = mode.value;
        $('#g_end_w').classList.toggle('hidden', m === 'single');
        $('#g_days_w').classList.toggle('hidden', m !== 'recurring');
        $('#g_date_l').textContent = m === 'single' ? 'Date' : 'Start date';
        const a = $('#g_start').value; const b = $('#g_endt').value;
        const n = a && b && b > a ? Math.floor((Number(b.slice(0, 2)) * 60 + Number(b.slice(3)) - Number(a.slice(0, 2)) * 60 - Number(a.slice(3))) / 30) : 0;
        $('#g_prev').textContent = n > 0 ? `${n} slot${n === 1 ? '' : 's'} of 30 minutes per day.` : 'Choose a start and end time on the hour or half hour.';
      };
      ['change', 'input'].forEach((ev) => gen.addEventListener(ev, prev));
      prev();
      gen.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = $('#generr'); err.classList.add('hidden');
        const m = mode.value;
        const body = { mentor_id: Number($('#g_mentor').value), mode: m, date: $('#g_date').value, start_time: $('#g_start').value, end_time: $('#g_endt').value };
        if (m !== 'single') body.end_date = $('#g_end').value;
        if (m === 'recurring') body.weekdays = $$('input[name=wd]:checked', gen).map((c) => Number(c.value));
        try {
          const r = await UI.post('/api/admin/availability/generate', body);
          toast(`Created ${r.created} slot${r.created === 1 ? '' : 's'}${r.already_existed ? ` · ${r.already_existed} already existed` : ''}${r.skipped_past ? ` · ${r.skipped_past} in the past skipped` : ''}.`, 'success');
          af.page = 1; drawAvailability();
        } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); err.scrollIntoView({ block: 'nearest' }); }
      });
    }
    $('#close').addEventListener('submit', async (e) => {
      e.preventDefault();
      const act = e.submitter ? e.submitter.dataset.act : 'blocked';
      const date = $('#c_date').value;
      if (!date) return toast('Choose a date first.', 'error');
      const mid = $('#c_mentor').value;
      const mname = mid ? $('#c_mentor').selectedOptions[0].textContent : 'all mentors';
      if (act === 'blocked' && !await UI.confirmDialog({ title: 'Close this date?', body: `All unbooked slots on ${longDate(date)} for ${mname} will be blocked.`, confirmText: 'Close date', danger: true })) return;
      try {
        const r = await UI.post('/api/admin/availability/status', { date, mentor_id: mid ? Number(mid) : undefined, status: act });
        toast(`${r.changed} slot(s) ${act === 'blocked' ? 'closed' : 'reopened'}${r.skipped_booked ? ` · ${r.skipped_booked} booked slot(s) left as is` : ''}.`, 'success');
        drawAvailability();
      } catch (ex) { toast(ex.message, 'error'); }
    });
    const refilter = () => { af.from = $('#f_from').value; af.to = $('#f_to').value; af.mentor_id = $('#f_mentor').value; af.status = $('#f_status').value; af.page = 1; drawAvailability(); };
    ['#f_from', '#f_to', '#f_mentor', '#f_status'].forEach((s) => $(s).addEventListener('change', refilter));
    $$('[data-page]').forEach((b) => b.addEventListener('click', () => { af.page = Number(b.dataset.page); drawAvailability(); }));
    const ids = () => $$('.rowck:checked').map((c) => Number(c.value));
    const sync = () => { const n = ids().length; ['#b_block', '#b_open', '#b_del'].forEach((s) => { $(s).disabled = n === 0; }); $('#selcount').textContent = n ? `${n} selected` : ''; };
    $$('.rowck').forEach((c) => c.addEventListener('change', sync));
    const all = $('#allck'); if (all) all.addEventListener('change', () => { $$('.rowck').forEach((c) => { c.checked = all.checked; }); sync(); });
    const bulk = (btn, path, body, verb) => $(btn).addEventListener('click', async () => {
      const list = ids();
      if (btn === '#b_del' && !await UI.confirmDialog({ title: `Delete ${list.length} slot(s)?`, body: 'Booked slots are skipped. This cannot be undone.', confirmText: 'Delete', danger: true })) return;
      try { const r = await UI.post(path, { ids: list, ...body }); toast(`${r.changed ?? r.deleted} slot(s) ${verb}${r.skipped_booked ? ` · ${r.skipped_booked} booked slot(s) skipped` : ''}.`, 'success'); drawAvailability(); }
      catch (ex) { toast(ex.message, 'error'); }
    });
    bulk('#b_block', '/api/admin/availability/status', { status: 'blocked' }, 'blocked');
    bulk('#b_open', '/api/admin/availability/status', { status: 'open' }, 'unblocked');
    bulk('#b_del', '/api/admin/availability/delete', {}, 'deleted');
  }

  // ------------------------------------------------------------------ bookings
  const bf = { q: '', from: '', to: '', status: '', student_id: '', mentor_id: '', page: 1 };
  let studentOpts = [], mentorOpts = [];
  async function bookings(params) {
    for (const k of ['status', 'student_id', 'mentor_id', 'from', 'to', 'q']) if (params[k] !== undefined) bf[k] = params[k];
    setView(`${head('Bookings')}${skeleton(5)}`, 'Bookings');
    try {
      [studentOpts, mentorOpts] = await Promise.all([UI.get('/api/admin/students?pageSize=200').then((r) => r.rows), UI.get('/api/admin/mentors').then((r) => r.rows)]);
    } catch (e) { return setView(`${head('Bookings')}${errorBox(e)}`, 'Bookings'); }
    drawBookings();
  }
  async function drawBookings() {
    try {
      const d = await UI.get(`/api/admin/bookings${qs({ ...bf, pageSize: 25 })}`);
      const exp = qs({ q: bf.q, from: bf.from, to: bf.to, status: bf.status, student_id: bf.student_id, mentor_id: bf.mentor_id });
      setView(`${head('Bookings', 'Every booking, with the mentor assignment.', `<a class="btn" href="/api/admin/bookings/export.csv${exp}">${icon('download')} Export CSV</a><button class="btn btn-primary" id="new" type="button">${icon('plus')} New booking</button>`)}
        <div class="toolbar">
          <div class="field grow"><label for="q">Search</label><input id="q" type="search" placeholder="Student, email, ID, mentor or reference" value="${esc(bf.q)}"></div>
          <div class="field"><label for="from">From</label><input id="from" type="date" value="${esc(bf.from)}"></div>
          <div class="field"><label for="to">To</label><input id="to" type="date" value="${esc(bf.to)}"></div>
          <div class="field"><label for="status">Status</label><select id="status">${opt('', 'All', bf.status)}${['confirmed', 'completed', 'cancelled', 'rescheduled'].map((s) => opt(s, s[0].toUpperCase() + s.slice(1), bf.status)).join('')}</select></div>
          <div class="field"><label for="student">Student</label><select id="student">${opt('', 'All students', bf.student_id)}${studentOpts.map((s) => opt(s.id, s.name, bf.student_id)).join('')}</select></div>
          <div class="field"><label for="mentor">Mentor</label><select id="mentor">${opt('', 'All mentors', bf.mentor_id)}${mentorOpts.map((m) => opt(m.id, m.name, bf.mentor_id)).join('')}</select></div>
          <button class="btn" id="clear" type="button">Clear</button>
        </div>
        ${d.rows.length ? tableWrap(['ID', 'Student', 'Mentor', 'Date', 'Time', 'Booked at', 'Status', ''], d.rows.map((b) => `<tr>
          <td class="nowrap"><strong>#${b.id}</strong><br><span class="small muted">${esc(b.ref)}</span></td>
          <td>${esc(b.student_name)}<br><span class="small muted">${esc(b.student_code || `ID ${b.student_id}`)} · ${esc(b.student_email)}${b.student_phone ? ` · ${esc(b.student_phone)}` : ''}</span></td>
          <td>${esc(b.mentor_name)}<br><span class="small muted">ID ${b.mentor_id}</span></td>
          <td class="nowrap">${esc(shortDate(b.date))}</td><td class="nowrap">${esc(range12(b.start_time, b.end_time))}</td>
          <td class="small nowrap">${esc(stamp(b.created_at).replace(" IST", "").replace(/ 20\d\d,/, ","))}</td><td>${badge(b.status)}</td><td class="actions"><a class="btn btn-sm" href="#/bookings/${b.id}">View</a></td></tr>`).join('')) + UI.pager(d)
          : `<div class="card">${empty('No bookings match', 'Try different filters, or create a booking manually.', '', 'list')}</div>`}`, 'Bookings');
      $('#q').addEventListener('input', UI.debounce((e) => { bf.q = e.target.value; bf.page = 1; drawBookings().then(() => { const el = $('#q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }));
      [['#from', 'from'], ['#to', 'to'], ['#status', 'status'], ['#student', 'student_id'], ['#mentor', 'mentor_id']].forEach(([s, k]) => $(s).addEventListener('change', (e) => { bf[k] = e.target.value; bf.page = 1; drawBookings(); }));
      $('#clear').addEventListener('click', () => { Object.assign(bf, { q: '', from: '', to: '', status: '', student_id: '', mentor_id: '', page: 1 }); drawBookings(); });
      $$('[data-page]').forEach((b) => b.addEventListener('click', () => { bf.page = Number(b.dataset.page); drawBookings(); }));
      $('#new').addEventListener('click', async () => { if (await slotDialog({ title: 'New booking', student: true })) { toast('Booking created.', 'success'); drawBookings(); } });
    } catch (e) { setView(`${head('Bookings')}${errorBox(e)}`, 'Bookings'); }
  }

  // Dialog: pick a date, then one of the open slots (with mentor names — admin only).
  async function slotDialog({ title, student = false, submitText = 'Save', onPick, exclude }) {
    let studs = [];
    if (student) { try { studs = (await UI.get('/api/admin/students?status=active&pageSize=200')).rows; } catch (e) { toast(e.message, 'error'); return false; } }
    const today = UI.todayIST();
    return UI.openDialog({
      title,
      bodyHtml: `<div class="alert alert-error hidden" id="sd-err" role="alert"></div>
        ${student ? `<div class="field"><label for="sd-student">Student</label><select id="sd-student">${studs.map((s) => `<option value="${s.id}">${esc(s.name)}${s.student_code ? ` (${esc(s.student_code)})` : ''}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label for="sd-date">Date</label><input id="sd-date" type="date" min="${today}" value="${today}"></div>
        <div class="field"><label for="sd-slot">Time slot &amp; mentor</label><select id="sd-slot"></select><div class="help" id="sd-help"></div></div>`,
      footHtml: `<button type="button" class="btn" data-no>Cancel</button><button type="button" class="btn btn-primary" data-ok disabled>${esc(submitText === 'Save' ? 'Create booking' : submitText)}</button>`,
      onOpen: (dlg, close) => {
        const sel = dlg.querySelector('#sd-slot'); const ok = dlg.querySelector('[data-ok]'); const err = dlg.querySelector('#sd-err'); const help = dlg.querySelector('#sd-help');
        const load = async () => {
          const date = dlg.querySelector('#sd-date').value;
          sel.innerHTML = ''; ok.disabled = true; help.textContent = 'Loading…';
          if (!date) { help.textContent = ''; return; }
          try {
            const rows = (await UI.get(`/api/admin/slots?date=${date}`)).rows.filter((r) => r.id !== exclude);
            sel.innerHTML = rows.map((r) => `<option value="${r.id}">${esc(range12(r.start_time, r.end_time))} · ${esc(r.mentor_name)}</option>`).join('');
            ok.disabled = rows.length === 0;
            help.textContent = rows.length ? `${rows.length} open slot${rows.length === 1 ? '' : 's'} on ${longDate(date)}.` : `No open slots on ${longDate(date)}.`;
          } catch (e) { help.textContent = e.message; }
        };
        dlg.querySelector('#sd-date').addEventListener('change', load);
        load();
        dlg.querySelector('[data-no]').addEventListener('click', () => close(false));
        ok.addEventListener('click', async () => {
          ok.disabled = true; err.classList.add('hidden');
          try {
            const slot = Number(sel.value);
            if (onPick) await onPick(slot);
            else await UI.post('/api/admin/bookings', { student_id: Number(dlg.querySelector('#sd-student').value), availability_id: slot });
            close(true);
          } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); ok.disabled = false; load(); }
        });
      },
    }).then((v) => v === true);
  }

  async function bookingDetail(id) {
    setView(`${head('Booking')}${skeleton(5)}`, 'Booking');
    try {
      const d = await UI.get(`/api/admin/bookings/${id}`);
      const b = d.booking;
      const live = b.status === 'confirmed';
      const detail = (h) => { try { const o = JSON.parse(h); return Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '); } catch { return ''; } };
      setView(`<p><a href="#/bookings">${icon('chevL')} All bookings</a></p>
        ${head(`Booking #${b.id}`, `Reference ${b.ref}`, `${badge(b.status)}`)}
        <div class="grid grid-2">
          <div class="card"><h2>Session</h2><dl class="kv">
            <dt>Date</dt><dd>${esc(longDate(b.date))}</dd><dt>Time</dt><dd>${esc(range12(b.start_time, b.end_time))} (IST)</dd>
            <dt>Mentor</dt><dd>${esc(b.mentor_name)} <span class="muted small">(ID ${b.mentor_id})</span></dd>
            <dt>Status</dt><dd>${badge(b.status)}</dd><dt>Booked at</dt><dd>${esc(stamp(b.created_at))}</dd><dt>Last updated</dt><dd>${esc(stamp(b.updated_at))}</dd>
            <dt>Created by</dt><dd>${dash(b.created_by)}</dd>
            ${b.status === 'cancelled' ? `<dt>Cancelled by</dt><dd>${dash(b.cancelled_by_role)}</dd><dt>Reason</dt><dd>${dash(b.cancel_reason)}</dd>` : ''}</dl></div>
          <div class="card"><h2>Student</h2><dl class="kv">
            <dt>Name</dt><dd>${esc(b.student_name)}</dd><dt>Student ID</dt><dd>${dash(b.student_code)} <span class="muted small">(#${b.student_id})</span></dd>
            <dt>Email</dt><dd>${esc(b.student_email)}</dd><dt>Phone</dt><dd>${dash(b.student_phone)}</dd><dt>Batch</dt><dd>${dash(b.student_batch)}</dd></dl>
            <p class="mt"><a href="#/bookings?student_id=${b.student_id}">All bookings for this student</a></p></div>
        </div>
        <div class="card mt"><div class="card-head"><h2>Actions</h2></div>
          <div class="actions-row">
            <button class="btn" id="resch" type="button" ${live ? '' : 'disabled'}>${icon('refresh')} Reschedule / reassign mentor</button>
            <button class="btn" id="complete" type="button" ${live ? '' : 'disabled'}>${icon('check')} Mark completed</button>
            <button class="btn btn-danger" id="cancel" type="button" ${live ? '' : 'disabled'}>Cancel booking</button>
            <button class="btn" id="notes" type="button">Edit internal notes</button></div>
          ${live ? '' : '<p class="small muted mt">Only confirmed bookings can be rescheduled, completed or cancelled.</p>'}
          ${b.admin_notes ? `<p class="mt"><strong>Internal notes:</strong> ${esc(b.admin_notes)}</p>` : ''}</div>
        ${d.related.length ? `<div class="card mt"><h2>Related bookings</h2><ul>${d.related.map((r) => `<li><a href="#/bookings/${r.id}">#${r.id}</a> · ${esc(shortDate(r.date))} ${esc(time12(r.start_time))} · ${badge(r.status)}</li>`).join('')}</ul></div>` : ''}
        <div class="card mt"><h2>History</h2>${d.history.length ? `<ul class="timeline">${d.history.map((h) => `<li><strong>${esc(h.action.replace('booking.', ''))}</strong> by ${esc(h.actor_name)} (${esc(h.actor_role)})<br><span class="small muted">${esc(stamp(h.created_at))}${detail(h.details) ? ` · ${esc(detail(h.details))}` : ''}</span></li>`).join('')}</ul>` : '<p class="muted">No history recorded.</p>'}</div>`, `Booking #${b.id}`);
      $('#resch').addEventListener('click', async () => {
        if (await slotDialog({ title: 'Reschedule / reassign', submitText: 'Move booking', exclude: b.availability_id, onPick: (slot) => UI.post(`/api/admin/bookings/${b.id}/reschedule`, { availability_id: slot }) })) { toast('Booking moved. The student has been notified of any time change.', 'success'); bookings({}); location.hash = '#/bookings'; }
      });
      $('#complete').addEventListener('click', async () => {
        if (!await UI.confirmDialog({ title: 'Mark as completed?', body: 'The session will be recorded as completed.', confirmText: 'Mark completed' })) return;
        try { await UI.post(`/api/admin/bookings/${b.id}/complete`); toast('Marked completed.', 'success'); bookingDetail(id); } catch (e) { toast(e.message, 'error'); }
      });
      $('#cancel').addEventListener('click', async () => {
        const ok = await UI.formDialog({ title: 'Cancel booking', submitText: 'Cancel booking', intro: 'The student is notified and the slot becomes available again.', fields: [{ name: 'reason', label: 'Reason (optional)', max: 300 }], onSubmit: (v) => UI.post(`/api/admin/bookings/${b.id}/cancel`, { reason: v.reason }) });
        if (ok) { toast('Booking cancelled.', 'success'); bookingDetail(id); }
      });
      $('#notes').addEventListener('click', async () => {
        const ok = await UI.formDialog({ title: 'Internal notes', intro: 'Visible to admins only.', fields: [{ name: 'admin_notes', label: 'Notes', type: 'textarea', value: b.admin_notes || '', max: 1000 }], onSubmit: (v) => UI.patch(`/api/admin/bookings/${b.id}`, v) });
        if (ok) { toast('Notes saved.', 'success'); bookingDetail(id); }
      });
    } catch (e) { setView(`${head('Booking')}${errorBox(e)}<p><a href="#/bookings">Back to bookings</a></p>`, 'Booking'); }
  }

  // ------------------------------------------------------------------ schedule (date-wise view)
  let schedFrom = '';
  const monday = (d) => { const p = UI.parseDate(d); return UI.addDays(d, -((p.dow + 6) % 7)); };
  async function schedule(params) {
    schedFrom = params.from || schedFrom || monday(UI.todayIST());
    const to = UI.addDays(schedFrom, 6);
    setView(`${head('Schedule')}${skeleton(5)}`, 'Schedule');
    try {
      const d = await UI.get(`/api/admin/schedule${qs({ from: schedFrom, to })}`);
      setView(`${head('Schedule', `${shortDate(schedFrom)} – ${shortDate(to)}`, `<button class="btn btn-sm" id="pw" type="button">${icon('chevL')} Previous week</button><button class="btn btn-sm" id="tw" type="button">This week</button><button class="btn btn-sm" id="nw" type="button">Next week ${icon('chevR')}</button><input id="jump" type="date" value="${esc(schedFrom)}" aria-label="Jump to week containing date">`)}
        ${d.days.map((day) => `<div class="card schedule-day"><h3><span>${esc(longDate(day.date))}${day.date === UI.todayIST() ? ' <span class="badge badge-confirmed">Today</span>' : ''}</span><span class="muted small">${day.bookings.length} booking${day.bookings.length === 1 ? '' : 's'} · ${day.open_slots} open slot${day.open_slots === 1 ? '' : 's'}</span></h3>
          ${day.bookings.length ? tableWrap(['Time', 'Student', 'Mentor', 'Status', ''], day.bookings.map((b) => `<tr><td class="nowrap">${esc(range12(b.start_time, b.end_time))}</td><td>${esc(b.student_name)}</td><td>${esc(b.mentor_name)}</td><td>${badge(b.status)}</td><td class="actions"><a class="btn btn-sm" href="#/bookings/${b.id}">View</a></td></tr>`).join('')) : '<p class="muted small">Nothing booked.</p>'}</div>`).join('')}`, 'Schedule');
      const go = (f) => { schedFrom = f; schedule({ from: f }); };
      $('#pw').addEventListener('click', () => go(UI.addDays(schedFrom, -7)));
      $('#nw').addEventListener('click', () => go(UI.addDays(schedFrom, 7)));
      $('#tw').addEventListener('click', () => go(monday(UI.todayIST())));
      $('#jump').addEventListener('change', (e) => { if (e.target.value) go(monday(e.target.value)); });
    } catch (e) { setView(`${head('Schedule')}${errorBox(e)}`, 'Schedule'); }
  }

  // ------------------------------------------------------------------ reports
  function reports() {
    setView(`${head('Reports & export', 'Download CSV files for spreadsheets or records.')}
      <div class="card"><h2>Bookings</h2>
        <form id="rb" class="toolbar" novalidate>
          <div class="field"><label for="r_from">From</label><input id="r_from" type="date"></div>
          <div class="field"><label for="r_to">To</label><input id="r_to" type="date"></div>
          <div class="field"><label for="r_status">Status</label><select id="r_status">${opt('', 'All', '')}${['confirmed', 'completed', 'cancelled', 'rescheduled'].map((s) => opt(s, s[0].toUpperCase() + s.slice(1), '')).join('')}</select></div>
          <a class="btn btn-primary" id="r_dl" href="/api/admin/bookings/export.csv">${icon('download')} Download bookings CSV</a>
        </form>
        <p class="small muted">Includes booking ID, student and contact details, mentor, date, times, booked-at timestamp and status.</p></div>
      <div class="grid grid-2 mt">
        <div class="card"><h3>Students</h3><p class="muted small">All student accounts with booking counts.</p><a class="btn" href="/api/admin/students/export.csv">${icon('download')} Students CSV</a></div>
        <div class="card"><h3>Mentors</h3><p class="muted small">Mentor list with open slots and bookings.</p><a class="btn" href="/api/admin/mentors/export.csv">${icon('download')} Mentors CSV</a></div>
        <div class="card"><h3>Availability</h3><p class="muted small">Slots from today onwards.</p><a class="btn" href="/api/admin/availability/export.csv">${icon('download')} Availability CSV</a></div>
        <div class="card"><h3>Audit log</h3><p class="muted small">Latest 20,000 recorded changes.</p><a class="btn" href="/api/admin/audit/export.csv">${icon('download')} Audit CSV</a></div>
      </div>`, 'Reports');
    const upd = () => { $('#r_dl').href = `/api/admin/bookings/export.csv${qs({ from: $('#r_from').value, to: $('#r_to').value, status: $('#r_status').value })}`; };
    ['#r_from', '#r_to', '#r_status'].forEach((s) => $(s).addEventListener('change', upd));
  }

  // ------------------------------------------------------------------ audit
  const auf = { entity_type: '', action: '', page: 1 };
  async function audit() {
    setView(`${head('Audit log')}${skeleton(5)}`, 'Audit log');
    try {
      const d = await UI.get(`/api/admin/audit${qs({ ...auf, pageSize: 50 })}`);
      setView(`${head('Audit log', 'Who changed what, and when.', `<a class="btn" href="/api/admin/audit/export.csv${qs({ entity_type: auf.entity_type })}">${icon('download')} Export CSV</a>`)}
        <div class="toolbar"><div class="field"><label for="et">Record type</label><select id="et">${opt('', 'All', auf.entity_type)}${['booking', 'student', 'mentor', 'availability', 'settings', 'user'].map((t) => opt(t, t[0].toUpperCase() + t.slice(1), auf.entity_type)).join('')}</select></div></div>
        ${d.rows.length ? tableWrap(['When', 'Who', 'Action', 'Record', 'Details'], d.rows.map((r) => `<tr><td class="small nowrap">${esc(stamp(r.created_at))}</td><td>${esc(r.actor_name || 'system')}<br><span class="small muted">${esc(r.actor_role || '')}</span></td><td>${esc(r.action)}</td><td>${esc(r.entity_type)}${r.entity_id ? ` #${esc(r.entity_id)}` : ''}</td><td class="small muted">${esc((r.details || '').slice(0, 160))}</td></tr>`).join('')) + UI.pager(d)
          : `<div class="card">${empty('No entries', '', '', 'log')}</div>`}`, 'Audit log');
      $('#et').addEventListener('change', (e) => { auf.entity_type = e.target.value; auf.page = 1; audit(); });
      $$('[data-page]').forEach((b) => b.addEventListener('click', () => { auf.page = Number(b.dataset.page); audit(); }));
    } catch (e) { setView(`${head('Audit log')}${errorBox(e)}`, 'Audit log'); }
  }

  // ------------------------------------------------------------------ settings
  async function settings() {
    setView(`${head('Settings')}${skeleton(5)}`, 'Settings');
    try {
      const { settings: s, email_configured: ec } = await UI.get('/api/admin/settings');
      const num = (id, label, v, help, max = 720, min = 0) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="number" min="${min}" max="${max}" step="1" value="${esc(v)}" aria-describedby="${id}_h"><div class="help" id="${id}_h">${help}</div></div>`;
      setView(`${head('Settings', 'Booking rules and sign-up options. Changes apply immediately.')}
        <form id="sf" novalidate>
          <div id="sferr" class="alert alert-error hidden" role="alert"></div>
          <div class="card"><h2>General</h2>
            <div class="field"><label for="org_name">Organisation name</label><input id="org_name" type="text" maxlength="60" value="${esc(s.org_name)}"></div></div>
          <div class="card"><h2>Student sign-up</h2>
            <div class="field"><label for="registration_mode">Registration method</label><select id="registration_mode">
              ${opt('admin_only', 'Admin creates accounts (recommended)', s.registration_mode)}${opt('invite_code', 'Students self-register with an invite code', s.registration_mode)}${opt('open', 'Anyone can self-register', s.registration_mode)}</select></div>
            <div class="field ${s.registration_mode === 'invite_code' ? '' : 'hidden'}" id="codeWrap"><label for="registration_code">Invite code</label><input id="registration_code" type="text" maxlength="64" value="${esc(s.registration_code)}" autocomplete="off"><div class="help">Share this code only with your students.</div></div></div>
          <div class="card"><h2>Booking rules</h2>
            <div class="row">${num('max_advance_days', 'Book up to (days ahead)', s.max_advance_days, 'How far in advance students can book.', 365, 1)}${num('min_notice_hours', 'Minimum notice (hours)', s.min_notice_hours, 'Earliest bookable time from now.', 168)}${num('max_upcoming_bookings', 'Max upcoming per student', s.max_upcoming_bookings, '0 = unlimited.', 100)}</div></div>
          <div class="card"><h2>Cancellation & rescheduling</h2>
            <div class="check"><input type="checkbox" id="allow_student_cancel" ${s.allow_student_cancel ? 'checked' : ''}><label for="allow_student_cancel">Students can cancel their own sessions</label></div>
            ${num('cancel_deadline_hours', 'Cancellation deadline (hours before start)', s.cancel_deadline_hours, 'Students cannot cancel closer to the session than this.')}
            <div class="check"><input type="checkbox" id="allow_student_reschedule" ${s.allow_student_reschedule ? 'checked' : ''}><label for="allow_student_reschedule">Students can reschedule their own sessions</label></div>
            ${num('reschedule_deadline_hours', 'Reschedule deadline (hours before start)', s.reschedule_deadline_hours, 'Students cannot reschedule closer than this.')}</div>
          <div class="card"><h2>Notifications</h2>
            ${ec ? '<div class="alert alert-success" role="status">Email is configured (SMTP). Confirmations and reminders are emailed in addition to appearing in-app.</div>'
                 : '<div class="alert alert-warn" role="status"><strong>Email is not configured.</strong> Confirmations and reminders appear inside the website only. To enable email, set the <code>SMTP_*</code> variables on the server and restart (see the README).</div>'}
            ${num('reminder_hours_before', 'Send reminder (hours before session)', s.reminder_hours_before, 'A reminder is created this long before each confirmed session.', 168, 1)}</div>
          <div class="mt"><button class="btn btn-primary btn-lg" type="submit">Save settings</button></div>
        </form>`, 'Settings');
      $('#registration_mode').addEventListener('change', (e) => $('#codeWrap').classList.toggle('hidden', e.target.value !== 'invite_code'));
      $('#sf').addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = $('#sferr'); err.classList.add('hidden');
        const n = (id) => Number($(`#${id}`).value);
        const body = {
          org_name: $('#org_name').value, registration_mode: $('#registration_mode').value, registration_code: $('#registration_code').value,
          max_advance_days: n('max_advance_days'), min_notice_hours: n('min_notice_hours'), max_upcoming_bookings: n('max_upcoming_bookings'),
          allow_student_cancel: $('#allow_student_cancel').checked, cancel_deadline_hours: n('cancel_deadline_hours'),
          allow_student_reschedule: $('#allow_student_reschedule').checked, reschedule_deadline_hours: n('reschedule_deadline_hours'), reminder_hours_before: n('reminder_hours_before'),
        };
        try { await UI.put('/api/admin/settings', body); toast('Settings saved.', 'success'); }
        catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); err.scrollIntoView({ block: 'nearest' }); }
      });
    } catch (e) { setView(`${head('Settings')}${errorBox(e)}`, 'Settings'); }
  }

  // ------------------------------------------------------------------ router
  function route() {
    const { path, params } = UI.parseHash();
    renderNav(path);
    let m;
    if (path === '/' || path === '') return dashboard();
    if (path === '/students') return students();
    if (path === '/mentors') return mentors();
    if (path === '/availability') return availability(params);
    if (path === '/bookings') return bookings(params);
    if ((m = path.match(/^\/bookings\/(\d+)$/))) return bookingDetail(m[1]);
    if (path === '/schedule') return schedule(params);
    if (path === '/reports') return reports();
    if (path === '/audit') return audit();
    if (path === '/settings') return settings();
    return setView(`<div class="empty"><h1>Page not found</h1><p><a href="#/">Back to dashboard</a></p></div>`, 'Not found');
  }

  async function boot() {
    try { const r = await UI.get('/api/auth/me'); UI.state.csrf = r.csrf; me = r.user; } catch { return; }
    document.getElementById('logo').innerHTML = icon('shield');
    document.getElementById('menu').innerHTML = icon('menu');
    document.getElementById('who').textContent = me.name;
    const lo = document.getElementById('logout');
    lo.innerHTML = `${icon('logout')}<span>Sign out</span>`;
    lo.addEventListener('click', UI.logout);
    document.getElementById('menu').addEventListener('click', (e) => {
      const sb = document.getElementById('sidebar');
      const open = sb.classList.toggle('open');
      e.currentTarget.setAttribute('aria-expanded', String(open));
    });
    UI.get('/api/public/config').then((c) => { document.getElementById('org').textContent = `${c.orgName} · Admin`; }).catch(() => {});
    if (me.mustChangePassword) {
      document.getElementById('nav').innerHTML = '';
      setView(`<div class="card"><h1>Set a new password</h1><p class="muted">Please choose a personal password before using the admin area.</p><button class="btn btn-primary" id="fp" type="button">Choose a new password</button></div>`, 'New password');
      const go = async () => { if (await UI.passwordDialog(true)) location.reload(); };
      document.getElementById('fp').addEventListener('click', go);
      return go();
    }
    window.addEventListener('hashchange', route);
    route();
  }
  boot();
})();
