/* Student app. Served only to signed-in students. */
(function () {
  'use strict';
  const { esc, icon, badge, empty, skeleton, errorBox, toast, longDate, shortDate, range12, time12, MONTHS } = UI;
  const view = document.getElementById('view');
  let me = null;

  const NAV = [
    ['#/', 'Home', 'home'],
    ['#/book', 'Book a session', 'calendar'],
    ['#/bookings', 'My bookings', 'list'],
    ['#/profile', 'Profile', 'user'],
  ];

  function renderNav(path) {
    document.getElementById('nav').innerHTML = NAV.map(([href, label, ic]) => {
      const p = href.slice(1);
      const cur = p === path || (p !== '/' && path.startsWith(p));
      return `<a href="${href}" ${cur ? 'aria-current="page"' : ''}>${icon(ic)}<span class="t">${esc(label)}</span></a>`;
    }).join('');
  }

  function setView(html, title) {
    view.innerHTML = html;
    document.title = `${title} · Mentor Sessions`;
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------ dashboard
  async function dashboard() {
    setView(`<div class="page-head"><div><h1 id="h">Hello</h1></div></div>${skeleton(4)}`, 'Home');
    try {
      const d = await UI.get('/api/student/dashboard');
      const first = esc((d.name || '').split(' ')[0]);
      const nb = d.next_booking;
      const unread = d.notifications.some((n) => !n.read_at);
      setView(`
        <div class="page-head"><div><h1>Hello, ${first}</h1><p class="muted">Book a 30-minute session in a few clicks.</p></div></div>
        <div class="card">
          <div class="card-head"><h2>Ready for your next session?</h2></div>
          <p class="muted">Pick a date, choose a time, confirm. That’s it.</p>
          <a class="btn btn-primary btn-lg" href="#/book">${icon('calendar')} Book a Mentor Session</a>
        </div>
        <div class="grid grid-2 mt">
          <div class="card">
            <div class="card-head"><h2>Your next session</h2></div>
            ${nb ? `<div class="bk"><div><div class="when">${esc(longDate(nb.date))}</div><div class="meta">${esc(range12(nb.start_time, nb.end_time))} (IST)</div></div>${badge(nb.status)}</div>
                    <p class="mt"><a href="#/bookings">View all bookings</a></p>`
                 : empty('Nothing booked yet', 'When you book a session it will show up here.', '', 'calendar')}
          </div>
          <div class="card">
            <div class="card-head"><h2>At a glance</h2></div>
            <div class="grid grid-cards">
              <div><div class="num">${d.upcoming_count}</div><div class="muted small">Upcoming</div></div>
              <div><div class="num">${d.completed_count}</div><div class="muted small">Completed</div></div>
            </div>
            <p class="small muted mt">${d.policy.allow_cancel ? `You can cancel up to ${d.policy.cancel_deadline_hours} hours before a session.` : 'Cancellations are handled by your coordinator.'}</p>
          </div>
        </div>
        <div class="card mt">
          <div class="card-head"><h2>Updates</h2>${unread ? '<button class="btn btn-sm" id="markread" type="button">Mark all as read</button>' : ''}</div>
          ${d.notifications.length
            ? `<ul class="note-list">${d.notifications.map((n) => `<li class="${n.read_at ? '' : 'unread'}"><div class="t">${esc(n.title)}</div><div class="small muted">${esc(n.body)}</div><div class="small muted">${esc(UI.stamp(n.created_at))}</div></li>`).join('')}</ul>`
            : empty('No updates yet', 'Booking confirmations will appear here.')}
        </div>`, 'Home');
      const mr = document.getElementById('markread');
      if (mr) mr.addEventListener('click', async () => { await UI.post('/api/student/notifications/read'); dashboard(); });
    } catch (e) { setView(`<h1>Home</h1>${errorBox(e)}`, 'Home'); }
  }

  // ------------------------------------------------------------------ booking flow
  const bs = { month: '', dates: new Set(), win: null, date: null, slots: [], slot: null, step: 1, resched: null, reschedInfo: null, done: null, loadingSlots: false, err: '' };

  const monthKey = (d) => d.slice(0, 7);
  function shiftMonth(key, n) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  async function book(params) {
    const ref = params.reschedule || null;
    if (bs.resched !== ref || bs.done) {
      Object.assign(bs, { date: null, slots: [], slot: null, step: 1, done: null, err: '', resched: ref, reschedInfo: null });
    }
    bs.month = bs.month || monthKey(UI.todayIST());
    setView(`<h1>Book a session</h1>${skeleton(5)}`, 'Book a session');
    try {
      if (ref && !bs.reschedInfo) bs.reschedInfo = (await UI.get(`/api/student/bookings/${encodeURIComponent(ref)}`)).booking;
      await loadMonth();
      drawBook();
    } catch (e) { setView(`<h1>Book a session</h1>${errorBox(e)}<p><a href="#/bookings">Back to my bookings</a></p>`, 'Book a session'); }
  }

  async function loadMonth() {
    const r = await UI.get(`/api/student/dates?month=${bs.month}`);
    bs.dates = new Set(r.dates);
    bs.win = r.window;
  }

  function stepsHtml() {
    const cur = bs.done ? 4 : bs.slot ? 3 : bs.date ? 2 : 1;
    const items = ['Choose date', 'Choose time', 'Confirm'];
    return `<ol class="steps" aria-label="Booking progress">${items.map((t, i) => {
      const n = i + 1;
      const cls = n < cur ? 'done' : '';
      return `<li class="${cls}" ${n === cur ? 'aria-current="step"' : ''}><span class="n">${n < cur ? icon('check') : n}</span>${t}</li>`;
    }).join('')}</ol>`;
  }

  function calendarHtml() {
    const [y, m] = bs.month.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const today = UI.todayIST();
    const curMonth = monthKey(today);
    const maxMonth = bs.win ? monthKey(bs.win.to) : curMonth;
    let cells = UI.DAYS.map((d) => `<div class="dow" aria-hidden="true">${d.slice(0, 3)}</div>`).join('');
    for (let i = 0; i < first; i++) cells += '<div class="blank"></div>';
    for (let d = 1; d <= days; d++) {
      const date = `${bs.month}-${String(d).padStart(2, '0')}`;
      const avail = bs.dates.has(date);
      const cls = [avail ? 'avail' : '', date === today ? 'today' : '', date === bs.date ? 'sel' : ''].join(' ').trim();
      const label = `${longDate(date)}${avail ? ', times available' : ', no times available'}${date === bs.date ? ', selected' : ''}`;
      cells += `<button type="button" class="${cls}" data-date="${date}" aria-label="${esc(label)}" ${avail ? '' : 'disabled'} ${date === bs.date ? 'aria-pressed="true"' : ''}>${d}</button>`;
    }
    return `<div class="card">
      <div class="cal-head">
        <button class="btn btn-sm" type="button" id="prev" aria-label="Previous month" ${bs.month <= curMonth ? 'disabled' : ''}>${icon('chevL')}</button>
        <h3 aria-live="polite">${MONTHS[m - 1]} ${y}</h3>
        <button class="btn btn-sm" type="button" id="next" aria-label="Next month" ${bs.month >= maxMonth ? 'disabled' : ''}>${icon('chevR')}</button>
      </div>
      <div class="cal" role="group" aria-label="Choose a date">${cells}</div>
      <div class="legend"><span><i class="dot p"></i> Times available</span><span><i class="dot"></i> Selected day is filled</span><span>Greyed out: nothing open</span></div>
    </div>`;
  }

  function slotsHtml() {
    if (!bs.date) return `<div class="card">${empty('Pick a date first', 'Days with open times are marked with a dot.', '', 'calendar')}</div>`;
    const head = `<h2>${esc(longDate(bs.date))}</h2><p class="muted small">Sessions are 30 minutes · India Standard Time (IST)</p>`;
    if (bs.loadingSlots) return `<div class="card">${head}${skeleton(4)}</div>`;
    if (!bs.slots.length) return `<div class="card">${head}${empty('No times left on this day', 'Please choose another date.', '', 'clock')}</div>`;
    const groups = [['Morning', (t) => t < '12:00'], ['Afternoon', (t) => t >= '12:00' && t < '17:00'], ['Evening', (t) => t >= '17:00']];
    const html = groups.map(([name, f]) => {
      const list = bs.slots.filter((s) => f(s.start_time));
      if (!list.length) return '';
      return `<div class="slot-group"><h4>${name}</h4><div class="slots">${list.map((s) => s.state === 'yours'
        ? `<button class="slot yours" type="button" disabled>${icon('check')} ${esc(time12(s.start_time))} · Already booked by you</button>`
        : `<button class="slot" type="button" data-start="${esc(s.start_time)}" aria-label="${esc(`${range12(s.start_time, s.end_time)}, available`)}">${esc(range12(s.start_time, s.end_time))}</button>`).join('')}</div></div>`;
    }).join('');
    return `<div class="card">${head}<div class="mt">${html}</div></div>`;
  }

  function drawBook() {
    if (bs.done) return drawSuccess();
    if (bs.slot) return drawConfirm();
    const old = bs.reschedInfo;
    setView(`
      <div class="page-head"><div><h1>${old ? 'Reschedule your session' : 'Book a session'}</h1>
        <p class="muted">${old ? `Currently: ${esc(longDate(old.date))}, ${esc(range12(old.start_time, old.end_time))}. Pick a new date and time.` : 'Choose a date, then a 30-minute time.'}</p></div></div>
      ${bs.err ? `<div class="alert alert-error" role="alert">${esc(bs.err)}</div>` : ''}
      ${stepsHtml()}
      <div class="book-grid"><div>${calendarHtml()}</div><div id="slotsPane">${slotsHtml()}</div></div>`, 'Book a session');
    bs.err = '';
    bindBook();
  }

  function bindBook() {
    const prev = document.getElementById('prev');
    const next = document.getElementById('next');
    const shift = async (n) => { bs.month = shiftMonth(bs.month, n); bs.date = null; bs.slots = []; try { await loadMonth(); } catch (e) { toast(e.message, 'error'); } drawBook(); };
    prev.addEventListener('click', () => shift(-1));
    next.addEventListener('click', () => shift(1));
    view.querySelectorAll('.cal button[data-date]').forEach((b) => b.addEventListener('click', () => pickDate(b.dataset.date)));
    bindSlots();
  }
  function bindSlots() {
    view.querySelectorAll('.slot[data-start]').forEach((b) => b.addEventListener('click', () => {
      bs.slot = bs.slots.find((s) => s.start_time === b.dataset.start);
      drawBook();
    }));
  }

  async function pickDate(date) {
    bs.date = date; bs.slot = null; bs.loadingSlots = true;
    drawBook();
    try {
      bs.slots = (await UI.get(`/api/student/slots?date=${date}`)).slots;
    } catch (e) { bs.slots = []; toast(e.message, 'error'); }
    bs.loadingSlots = false;
    drawBook();
    const pane = document.getElementById('slotsPane');
    if (pane && window.matchMedia('(max-width: 820px)').matches) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function drawConfirm(error) {
    const re = !!bs.resched;
    setView(`
      <h1>${re ? 'Confirm new time' : 'Confirm your booking'}</h1>
      ${stepsHtml()}
      <div class="card">
        ${error ? `<div class="alert alert-error" role="alert">${esc(error)}</div>` : ''}
        <p>Please check the details below${re ? ' — your current session will be replaced' : ''}.</p>
        <div class="summary">
          <div><span class="k">Date</span><span class="v">${esc(longDate(bs.date))}</span></div>
          <div><span class="k">Time</span><span class="v">${esc(range12(bs.slot.start_time, bs.slot.end_time))}</span></div>
          <div><span class="k">Length</span><span class="v">30 minutes</span></div>
          <div><span class="k">Timezone</span><span class="v">India Standard Time (IST)</span></div>
        </div>
        <div class="actions-row">
          <button class="btn btn-primary btn-lg" id="confirm" type="button">${icon('check')} ${re ? 'Confirm new time' : 'Confirm booking'}</button>
          <button class="btn btn-lg" id="back" type="button">Back to times</button>
        </div>
      </div>`, 'Confirm booking');
    document.getElementById('back').addEventListener('click', () => { bs.slot = null; drawBook(); });
    document.getElementById('confirm').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Booking…';
      try {
        const body = { date: bs.date, start_time: bs.slot.start_time };
        const r = bs.resched
          ? await UI.post(`/api/student/bookings/${encodeURIComponent(bs.resched)}/reschedule`, body)
          : await UI.post('/api/student/bookings', body);
        bs.done = r.booking;
        drawBook();
      } catch (ex) {
        const conflict = ['SLOT_TAKEN', 'SLOT_UNAVAILABLE', 'PAST_SLOT', 'TOO_SOON', 'OUT_OF_WINDOW'].includes(ex.code);
        if (conflict) {
          // refresh availability and send the student back to pick another time
          bs.slot = null; bs.err = ex.message;
          try { await loadMonth(); bs.slots = (await UI.get(`/api/student/slots?date=${bs.date}`)).slots; } catch { /* shown below */ }
          drawBook();
        } else {
          btn.disabled = false;
          btn.innerHTML = `${icon('check')} ${re ? 'Confirm new time' : 'Confirm booking'}`;
          const box = view.querySelector('.card');
          box.insertAdjacentHTML('afterbegin', `<div class="alert alert-error" role="alert">${esc(ex.message)}</div>`);
        }
      }
    });
  }

  function icsFor(b) {
    const toUtc = (date, time) => {
      const [y, m, d] = date.split('-').map(Number);
      const [hh, mm] = time.split(':').map(Number);
      const t = new Date(Date.UTC(y, m - 1, d, hh, mm) - 5.5 * 3600e3);
      return t.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    };
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mentor Sessions//EN', 'BEGIN:VEVENT', `UID:${b.id}@mentor-sessions`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
      `DTSTART:${toUtc(b.date, b.start_time)}`, `DTEND:${toUtc(b.date, b.end_time)}`, 'SUMMARY:Mentor session', `DESCRIPTION:Reference ${b.id}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  }

  function drawSuccess() {
    const b = bs.done;
    setView(`
      <div class="card success-box">
        <div class="tick">${icon('check')}</div>
        <h1>${bs.resched ? 'Session rescheduled' : 'You’re booked!'}</h1>
        <p class="muted">Your session is confirmed. We’ve added it to My bookings.</p>
        <div class="summary">
          <div><span class="k">Date</span><span class="v">${esc(longDate(b.date))}</span></div>
          <div><span class="k">Time</span><span class="v">${esc(range12(b.start_time, b.end_time))} (IST)</span></div>
          <div><span class="k">Reference</span><span class="v">${esc(b.id)}</span></div>
        </div>
        <div class="actions-row center">
          <a class="btn btn-primary" href="#/bookings">View my bookings</a>
          <button class="btn" id="ics" type="button">${icon('download')} Add to calendar</button>
          <a class="btn" href="#/" id="home">Back to home</a>
        </div>
      </div>`, 'Booked');
    document.getElementById('ics').addEventListener('click', () => {
      const blob = new Blob([icsFor(b)], { type: 'text/calendar' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'session.ics';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    // reset flow state for next time
    Object.assign(bs, { date: null, slots: [], slot: null, resched: null, reschedInfo: null });
    
  }

  // ------------------------------------------------------------------ my bookings
  let tab = 'upcoming';
  async function bookings() {
    bs.done = null;
    setView(`<h1>My bookings</h1>${skeleton(4)}`, 'My bookings');
    try {
      const d = await UI.get('/api/student/bookings');
      const policyNote = (b) => (b.status === 'confirmed' && !b.can_cancel && !b.can_reschedule
        ? '<div class="small muted">Changes are closed for this session. Contact your coordinator if you need help.</div>' : '');
      const card = (b, upcoming) => `<div class="card bk">
        <div><div class="when">${esc(longDate(b.date))}</div><div class="meta">${esc(range12(b.start_time, b.end_time))} (IST) · Ref ${esc(b.id)}</div>${upcoming ? policyNote(b) : ''}</div>
        <div class="actions-row">${badge(b.status)}
          ${upcoming && b.can_reschedule ? `<a class="btn btn-sm" href="#/book?reschedule=${encodeURIComponent(b.id)}">${icon('refresh')} Reschedule</a>` : ''}
          ${upcoming && b.can_cancel ? `<button class="btn btn-sm btn-danger" type="button" data-cancel="${esc(b.id)}" data-when="${esc(`${longDate(b.date)}, ${range12(b.start_time, b.end_time)}`)}">Cancel</button>` : ''}
        </div></div>`;
      const list = tab === 'upcoming' ? d.upcoming : d.past;
      setView(`
        <div class="page-head"><div><h1>My bookings</h1></div><a class="btn btn-primary" href="#/book">${icon('plus')} New booking</a></div>
        <div class="tabs" role="tablist" aria-label="Booking lists">
          <button role="tab" id="t-up" aria-selected="${tab === 'upcoming'}" data-tab="upcoming">Upcoming (${d.upcoming.length})</button>
          <button role="tab" id="t-past" aria-selected="${tab === 'past'}" data-tab="past">Past &amp; cancelled (${d.past.length})</button>
        </div>
        <div role="tabpanel" aria-labelledby="${tab === 'upcoming' ? 't-up' : 't-past'}">
        ${list.length ? list.map((b) => card(b, tab === 'upcoming')).join('')
          : tab === 'upcoming' ? `<div class="card">${empty('No upcoming sessions', 'Book your first session to get started.', '<p><a class="btn btn-primary" href="#/book">Book a Mentor Session</a></p>', 'calendar')}</div>`
          : `<div class="card">${empty('No past sessions yet', 'Completed and cancelled sessions will be listed here.')}</div>`}
        </div>`, 'My bookings');
      view.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; bookings(); }));
      view.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
        const ok = await UI.confirmDialog({ title: 'Cancel this session?', body: `${b.dataset.when} will be cancelled and the time released.`, confirmText: 'Yes, cancel session', cancelText: 'Keep it', danger: true });
        if (!ok) return;
        try { await UI.post(`/api/student/bookings/${encodeURIComponent(b.dataset.cancel)}/cancel`); toast('Session cancelled.', 'success'); bookings(); }
        catch (e) { toast(e.message, 'error'); bookings(); }
      }));
    } catch (e) { setView(`<h1>My bookings</h1>${errorBox(e)}`, 'My bookings'); }
  }

  // ------------------------------------------------------------------ profile
  async function profile() {
    setView(`<h1>Profile</h1>${skeleton(3)}`, 'Profile');
    try {
      const p = await UI.get('/api/student/profile');
      setView(`
        <h1>Profile</h1>
        <div class="card">
          <dl class="kv">
            <dt>Name</dt><dd>${esc(p.name)}</dd>
            <dt>Email</dt><dd>${esc(p.email)}</dd>
            <dt>Student ID</dt><dd>${esc(p.student_code || '—')}</dd>
            <dt>Batch / group</dt><dd>${esc(p.batch || '—')}</dd>
          </dl>
          <form id="pf" class="mt-lg" novalidate>
            <div id="pferr" class="alert alert-error hidden" role="alert"></div>
            <div class="field"><label for="phone">Phone</label><input id="phone" type="text" maxlength="30" autocomplete="tel" value="${esc(p.phone || '')}"></div>
            <button class="btn btn-primary" type="submit">Save</button>
          </form>
        </div>
        <div class="card"><h2>Security</h2><p class="muted">Use a password you don’t use anywhere else.</p>
          <div class="actions-row"><button class="btn" id="pw" type="button">Change password</button><button class="btn" id="out" type="button">${icon('logout')} Sign out</button></div></div>`, 'Profile');
      document.getElementById('pf').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await UI.patch('/api/student/profile', { phone: document.getElementById('phone').value }); toast('Profile saved.', 'success'); }
        catch (ex) { const b = document.getElementById('pferr'); b.textContent = ex.message; b.classList.remove('hidden'); }
      });
      document.getElementById('pw').addEventListener('click', async () => { if (await UI.passwordDialog()) toast('Password updated.', 'success'); });
      document.getElementById('out').addEventListener('click', UI.logout);
    } catch (e) { setView(`<h1>Profile</h1>${errorBox(e)}`, 'Profile'); }
  }

  // ------------------------------------------------------------------ router
  function route() {
    const { path, params } = UI.parseHash();
    renderNav(path);
    if (path === '/book') return book(params);
    if (path === '/bookings') return bookings();
    if (path === '/profile') return profile();
    if (path === '/' || path === '') return dashboard();
    return setView(`<div class="empty"><h1>Page not found</h1><p><a href="#/">Back to home</a></p></div>`, 'Not found');
  }

  async function forcePassword() {
    setView(`<div class="card"><h1>Set a new password</h1><p class="muted">Your account needs a personal password before you can continue.</p><button class="btn btn-primary" id="fp" type="button">Choose a new password</button></div>`, 'New password');
    document.getElementById('nav').innerHTML = '';
    const go = async () => { if (await UI.passwordDialog(true)) location.reload(); };
    document.getElementById('fp').addEventListener('click', go);
    go();
  }

  async function boot() {
    try {
      const r = await UI.get('/api/auth/me');
      UI.state.csrf = r.csrf;
      me = r.user;
    } catch { return; }
    document.getElementById('logo').innerHTML = icon('calendar');
    document.getElementById('who').textContent = me.name;
    const lo = document.getElementById('logout');
    lo.innerHTML = `${icon('logout')}<span>Sign out</span>`;
    lo.addEventListener('click', UI.logout);
    UI.get('/api/public/config').then((c) => { document.getElementById('org').textContent = c.orgName; }).catch(() => {});
    if (me.mustChangePassword) return forcePassword();
    window.addEventListener('hashchange', route);
    route();
  }
  boot();
})();
