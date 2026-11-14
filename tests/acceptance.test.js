'use strict';
// End-to-end acceptance tests: real HTTP against the real app + a real (temporary) SQLite file.
process.env.LOGIN_RATE_MAX = '10000';
process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const { openDb, migrate } = require('../src/db');
const { createApp } = require('../src/server');
const { istNow, addDays, addMinutes } = require('../src/time');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-test-'));
const DB_FILE = path.join(tmp, 'test.db');
let db, server, base;

const MENTOR_NAMES = ['Zebulon Quillfeather', 'Ottoline Brackenridge', 'Percival Thornwhistle'];
const MENTOR_EMAILS = ['zq@mentors.internal', 'ob@mentors.internal', 'pt@mentors.internal'];
const PW = 'CorrectHorse-42';
let adminPw = 'AdminPass-9876';

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, url, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined && !opts.raw) headers['content-type'] = 'application/json';
    if (this.csrf && method !== 'GET' && !opts.noCsrf) headers['x-csrf-token'] = this.csrf;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body), redirect: 'manual' });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.startsWith('sid=')) this.cookie = kv.endsWith('=') ? '' : kv; }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
  patch(u, b = {}) { return this.req('PATCH', u, b); }
  put(u, b = {}) { return this.req('PUT', u, b); }
  del(u) { return this.req('DELETE', u, undefined); }
  async login(email, password) {
    const r = await this.req('POST', '/api/auth/login', { email, password }, { noCsrf: true });
    if (r.status === 200) this.csrf = r.json.csrf;
    return r;
  }
}

let mentorIds = [];
const studentIds = {};
function addStudent(name, email) {
  const hash = bcrypt.hashSync(PW, 4); // low cost: test speed only
  const uid = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?, 'student')").run(name, email, hash).lastInsertRowid;
  const sid = Number(db.prepare('INSERT INTO students (user_id, student_code, batch) VALUES (?,?,?)').run(uid, `T-${uid}`, 'Batch T').lastInsertRowid);
  studentIds[email] = sid;
  return sid;
}
function addSlot(mentorId, date, start) {
  return Number(db.prepare('INSERT INTO availability (mentor_id, date, start_time, end_time) VALUES (?,?,?,?)').run(mentorId, date, start, addMinutes(start, 30)).lastInsertRowid);
}
async function studentClient(email) { const c = new Client(); const r = await c.login(email, PW); assert.equal(r.status, 200, `login ${email}: ${r.text}`); return c; }
async function adminClient() { const c = new Client(); const r = await c.login('admin@test.example', adminPw); assert.equal(r.status, 200, r.text); return c; }

const D = (n) => addDays(istNow().date, n);

before(async () => {
  db = openDb(DB_FILE);
  migrate(db);
  const hash = bcrypt.hashSync(adminPw, 4);
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Test Admin','admin@test.example',?, 'admin')").run(hash);
  mentorIds = MENTOR_NAMES.map((n, i) => Number(db.prepare('INSERT INTO mentors (name, email, notes) VALUES (?,?,?)').run(n, MENTOR_EMAILS[i], 'internal note').lastInsertRowid));
  addStudent('Alice Student', 'alice@test.example');
  addStudent('Bob Student', 'bob@test.example');
  addStudent('Carol Student', 'carol@test.example');
  const app = createApp(db);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------
test('AT1: student can log in and book an available 30-minute slot', async () => {
  const date = D(5);
  addSlot(mentorIds[0], date, '10:00');
  const alice = await studentClient('alice@test.example');
  const dates = await alice.get(`/api/student/dates?month=${date.slice(0, 7)}`);
  assert.equal(dates.status, 200);
  assert.ok(dates.json.dates.includes(date));
  const slots = await alice.get(`/api/student/slots?date=${date}`);
  assert.deepEqual(slots.json.slots, [{ start_time: '10:00', end_time: '10:30', state: 'available' }]);
  const book = await alice.post('/api/student/bookings', { date, start_time: '10:00' });
  assert.equal(book.status, 201, book.text);
  assert.equal(book.json.booking.start_time, '10:00');
  assert.equal(book.json.booking.end_time, '10:30');
  // slot is gone immediately for everyone
  const after = await alice.get(`/api/student/slots?date=${date}`);
  assert.deepEqual(after.json.slots, []);
  const mine = await alice.get('/api/student/bookings');
  assert.equal(mine.json.upcoming.length, 1);
  assert.equal(mine.json.upcoming[0].status, 'confirmed');
});

test('AT2: mentor identity is never exposed to students (API, pages, scripts, notifications)', async () => {
  const alice = await studentClient('alice@test.example');
  const dumps = [];
  const grab = async (u) => { const r = await alice.get(u); dumps.push([u, r.text]); return r; };
  await grab('/api/auth/me');
  await grab('/api/student/dashboard');
  await grab('/api/student/bookings');
  await grab('/api/student/notifications');
  await grab('/api/student/profile');
  await grab(`/api/student/dates?month=${D(5).slice(0, 7)}`);
  await grab(`/api/student/slots?date=${D(5)}`);
  const mine = (await alice.get('/api/student/bookings')).json.upcoming[0];
  await grab(`/api/student/bookings/${mine.id}`);
  await grab('/app');
  await grab('/assets/student.js');
  await grab('/js/common.js');
  await grab('/css/app.css');
  for (const [u, text] of dumps) {
    const lower = text.toLowerCase();
    for (const n of [...MENTOR_NAMES, ...MENTOR_EMAILS, 'internal note']) assert.ok(!lower.includes(n.toLowerCase()), `${u} leaked "${n}"`);
    assert.ok(!/mentor_id|mentor_name|"mentor"/i.test(text.replace(/Book a Mentor|mentor session/gi, '')), `${u} contains a mentor field`);
  }
  // student endpoints that could reveal mentors don't exist
  for (const u of ['/api/student/mentors', '/api/student/mentors/1', '/api/admin/mentors']) {
    const r = await alice.get(u);
    assert.ok([403, 404].includes(r.status), `${u} -> ${r.status}`);
  }
  // asking for a different slot shape (e.g. with mentor hints) cannot select a mentor
  const r = await alice.post('/api/student/bookings', { date: D(5), start_time: '10:00', mentor_id: mentorIds[1] });
  assert.ok([409].includes(r.status)); // slot already taken; mentor_id ignored regardless
});

test('AT3: admin sees the mentor assigned to the booking', async () => {
  const admin = await adminClient();
  const list = await admin.get('/api/admin/bookings');
  assert.equal(list.status, 200);
  const b = list.json.rows.find((x) => x.student_name === 'Alice Student');
  assert.ok(b);
  assert.equal(b.mentor_name, MENTOR_NAMES[0]);
  assert.equal(b.student_email, 'alice@test.example');
  assert.ok(b.ref && b.created_at && b.date && b.start_time && b.end_time && b.status);
  const detail = await admin.get(`/api/admin/bookings/${b.id}`);
  assert.equal(detail.json.booking.mentor_name, MENTOR_NAMES[0]);
  assert.ok(detail.json.history.some((h) => h.action === 'booking.create' && h.actor_name === 'Alice Student'));
});

test('AT4: two students cannot book the same single-capacity slot, even when clicking simultaneously', async () => {
  const date = D(6);
  addSlot(mentorIds[1], date, '14:00'); // exactly one slot, one mentor
  const emails = [];
  for (let i = 0; i < 25; i++) { const e = `racer${i}@test.example`; addStudent(`Racer ${i}`, e); emails.push(e); }
  const clients = await Promise.all(emails.map(studentClient));
  const results = await Promise.all(clients.map((c) => c.post('/api/student/bookings', { date, start_time: '14:00' })));
  const ok = results.filter((r) => r.status === 201);
  const taken = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, `expected exactly one success, got ${ok.length}`);
  assert.equal(taken.length, 24);
  assert.ok(taken.every((r) => r.json.error.code === 'SLOT_TAKEN'));
  const n = db.prepare("SELECT COUNT(*) n FROM bookings WHERE date = ? AND start_time = '14:00' AND status = 'confirmed'").get(date).n;
  assert.equal(n, 1);
});

test('AT4b: the database itself rejects double bookings (bypassing the app)', () => {
  const date = D(7);
  const slot = addSlot(mentorIds[0], date, '09:00');
  const sid = studentIds['alice@test.example'];
  const ins = (student, ref) => db.prepare(
    "INSERT INTO bookings (ref, student_id, mentor_id, availability_id, date, start_time, end_time) VALUES (?,?,?,?,?,?,?)"
  ).run(ref, student, mentorIds[0], slot, date, '09:00', '09:30');
  ins(sid, 'BK-DBTEST01');
  assert.throws(() => ins(studentIds['bob@test.example'], 'BK-DBTEST02'), /UNIQUE|MENTOR_OVERLAP/);
});

test('AT5: one mentor cannot receive overlapping bookings (unique index + overlap trigger)', () => {
  const date = D(8);
  const s1 = addSlot(mentorIds[2], date, '10:00');
  const sid = studentIds['bob@test.example'];
  db.prepare("INSERT INTO bookings (ref, student_id, mentor_id, availability_id, date, start_time, end_time) VALUES ('BK-OVL00001',?,?,?,?,?,?)")
    .run(sid, mentorIds[2], s1, date, '10:00', '10:30');
  // overlapping time range for the same mentor, different student, no availability row match
  assert.throws(() => db.prepare("INSERT INTO bookings (ref, student_id, mentor_id, availability_id, date, start_time, end_time) VALUES ('BK-OVL00002',?,?,?,?,?,?)")
    .run(studentIds['carol@test.example'], mentorIds[2], s1, date, '10:15', '10:45'), /MENTOR_OVERLAP|SLOT_MISMATCH|UNIQUE/);
  // booking must match an open slot
  assert.throws(() => db.prepare("INSERT INTO bookings (ref, student_id, mentor_id, availability_id, date, start_time, end_time) VALUES ('BK-OVL00003',?,?,NULL,?,?,?)")
    .run(studentIds['carol@test.example'], mentorIds[2], date, '12:00', '12:30'), /SLOT_MISMATCH/);
});

test('AT5b: with two mentors at the same time, two students succeed and a third is refused (one student-visible option, no mentor choice)', async () => {
  const date = D(9);
  addSlot(mentorIds[0], date, '16:00');
  addSlot(mentorIds[1], date, '16:00');
  const a = await studentClient('alice@test.example');
  const b = await studentClient('bob@test.example');
  const c = await studentClient('carol@test.example');
  const slots = await a.get(`/api/student/slots?date=${date}`);
  assert.equal(slots.json.slots.length, 1, 'shown as one bookable time');
  assert.equal(JSON.stringify(slots.json).includes('capacity'), false);
  const r1 = await a.post('/api/student/bookings', { date, start_time: '16:00' });
  const r2 = await b.post('/api/student/bookings', { date, start_time: '16:00' });
  const r3 = await c.post('/api/student/bookings', { date, start_time: '16:00' });
  assert.deepEqual([r1.status, r2.status, r3.status], [201, 201, 409]);
  const rows = db.prepare("SELECT DISTINCT mentor_id FROM bookings WHERE date = ? AND start_time='16:00' AND status='confirmed'").all(date);
  assert.equal(rows.length, 2, 'assigned to two different mentors');
});

test('AT6: a student cannot read or change another student\'s bookings', async () => {
  const alice = await studentClient('alice@test.example');
  const bob = await studentClient('bob@test.example');
  const aliceBooking = (await alice.get('/api/student/bookings')).json.upcoming[0];
  assert.equal((await bob.get(`/api/student/bookings/${aliceBooking.id}`)).status, 404);
  assert.equal((await bob.post(`/api/student/bookings/${aliceBooking.id}/cancel`)).status, 404);
  assert.equal((await bob.post(`/api/student/bookings/${aliceBooking.id}/reschedule`, { date: D(9), start_time: '16:00' })).status, 404);
  // numeric ids / admin ids don't work either
  assert.equal((await bob.get('/api/student/bookings/1')).status, 404);
  const bobList = (await bob.get('/api/student/bookings')).json;
  assert.ok([...bobList.upcoming, ...bobList.past].every((b) => b.id !== aliceBooking.id));
  // still confirmed
  const check = db.prepare('SELECT status FROM bookings WHERE ref = ?').get(aliceBooking.id);
  assert.equal(check.status, 'confirmed');
});

test('AT7: students cannot reach admin pages or admin APIs; anonymous users are bounced', async () => {
  const alice = await studentClient('alice@test.example');
  const page = await alice.get('/admin');
  assert.equal(page.status, 403);
  assert.ok(page.text.toLowerCase().includes('access denied'));
  assert.equal((await alice.get('/assets/admin.js')).status, 403);
  for (const u of ['/api/admin/dashboard', '/api/admin/students', '/api/admin/mentors', '/api/admin/bookings', '/api/admin/settings', '/api/admin/audit', '/api/admin/bookings/export.csv']) {
    assert.equal((await alice.get(u)).status, 403, u);
  }
  for (const [m, u, b] of [['POST', '/api/admin/mentors', { name: 'x' }], ['POST', '/api/admin/availability/generate', {}], ['PUT', '/api/admin/settings', { max_advance_days: 5 }], ['DELETE', '/api/admin/mentors/1']]) {
    const r = await alice.req(m, u, b);
    assert.equal(r.status, 403, `${m} ${u}`);
  }
  const anon = new Client();
  assert.equal((await anon.get('/api/admin/dashboard')).status, 401);
  assert.equal((await anon.get('/api/student/dashboard')).status, 401);
  assert.equal((await anon.get('/admin')).status, 302);
  assert.equal((await anon.get('/assets/admin.js')).status, 401);
  // admin cannot use student endpoints either
  const admin = await adminClient();
  assert.equal((await admin.get('/api/student/dashboard')).status, 403);
  assert.equal((await admin.get('/app')).status, 403);
  assert.equal((await anon.get('/definitely/not/here')).status, 404);
});

test('AT8: admin can manage mentors/students and open/close availability; filter and export bookings', async () => {
  const admin = await adminClient();
  // mentors
  const m = await admin.post('/api/admin/mentors', { name: 'Hermione Test', email: 'h@mentors.internal', notes: 'n' });
  assert.equal(m.status, 201);
  const mid = m.json.id;
  assert.equal((await admin.patch(`/api/admin/mentors/${mid}`, { phone: '999' })).status, 200);
  // students
  const s = await admin.post('/api/admin/students', { name: 'New Kid', email: 'newkid@test.example', batch: 'Batch Z' });
  assert.equal(s.status, 201);
  assert.ok(s.json.generated_password.length >= 10);
  assert.equal((await admin.post('/api/admin/students', { name: 'Dup', email: 'newkid@test.example' })).status, 409);
  const kid = new Client();
  assert.equal((await kid.login('newkid@test.example', s.json.generated_password)).status, 200);
  assert.equal((await kid.get('/api/student/dashboard')).json?.error?.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await kid.post('/api/auth/change-password', { current: s.json.generated_password, next: 'BrandNewPass-1' })).status, 200);
  assert.equal((await kid.get('/api/student/dashboard')).status, 200);
  // open availability: single date, range, recurring
  const d1 = D(20);
  const g = await admin.post('/api/admin/availability/generate', { mentor_id: mid, mode: 'single', date: d1, start_time: '10:00', end_time: '12:00' });
  assert.equal(g.status, 201);
  assert.equal(g.json.created, 4); // 10:00, 10:30, 11:00, 11:30
  const again = await admin.post('/api/admin/availability/generate', { mentor_id: mid, mode: 'single', date: d1, start_time: '10:00', end_time: '12:00' });
  assert.equal(again.json.created, 0);
  assert.equal(again.json.already_existed, 4);
  assert.equal((await admin.post('/api/admin/availability/generate', { mentor_id: mid, mode: 'single', date: d1, start_time: '10:15', end_time: '12:00' })).status, 400);
  const rec = await admin.post('/api/admin/availability/generate', { mentor_id: mid, mode: 'recurring', date: D(21), end_date: D(35), weekdays: [1, 2, 3, 4, 5, 6, 0], start_time: '09:00', end_time: '09:30' });
  assert.equal(rec.json.created, 15);
  // close the date
  const closed = await admin.post('/api/admin/availability/status', { date: d1, mentor_id: mid, status: 'blocked' });
  assert.equal(closed.json.changed, 4);
  const stu = await studentClient('alice@test.example');
  assert.deepEqual((await stu.get(`/api/student/slots?date=${d1}`)).json.slots, []);
  // reopen
  assert.equal((await admin.post('/api/admin/availability/status', { date: d1, mentor_id: mid, status: 'open' })).json.changed, 4);
  assert.equal((await stu.get(`/api/student/slots?date=${d1}`)).json.slots.length, 4);
  // book one, then try to delete/block all: booked slot protected
  assert.equal((await kid.post('/api/student/bookings', { date: d1, start_time: '10:00' })).status, 201);
  const del = await admin.post('/api/admin/availability/delete', { date: d1, mentor_id: mid });
  assert.deepEqual([del.json.deleted, del.json.skipped_booked], [3, 1]);
  // mentor with bookings cannot be deleted, can be deactivated
  assert.equal((await admin.del(`/api/admin/mentors/${mid}`)).status, 409);
  const deact = await admin.patch(`/api/admin/mentors/${mid}`, { status: 'inactive' });
  assert.equal(deact.json.future_bookings_affected, 1);
  // filter + export
  const f = await admin.get(`/api/admin/bookings?status=confirmed&from=${d1}&to=${d1}`);
  assert.equal(f.json.total, 1);
  assert.equal(f.json.rows[0].mentor_name, 'Hermione Test');
  const byStudent = await admin.get(`/api/admin/bookings?student_id=${studentIds['alice@test.example']}`);
  assert.ok(byStudent.json.rows.every((x) => x.student_id === studentIds['alice@test.example']));
  const byMentor = await admin.get(`/api/admin/bookings?mentor_id=${mentorIds[0]}`);
  assert.ok(byMentor.json.rows.every((x) => x.mentor_id === mentorIds[0]));
  const csv = await admin.get('/api/admin/bookings/export.csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.headers.get('content-type').startsWith('text/csv'));
  assert.ok(csv.text.includes('mentor_name') && csv.text.includes('Alice Student') && csv.text.includes(MENTOR_NAMES[0]));
  // schedule view + dashboard
  const sched = await admin.get(`/api/admin/schedule?from=${D(5)}&to=${D(9)}`);
  assert.equal(sched.json.days.length, 5);
  const dash = await admin.get('/api/admin/dashboard');
  for (const k of ['total_students', 'total_mentors', 'upcoming_bookings', 'completed_sessions', 'cancelled_bookings', 'available_slots']) assert.equal(typeof dash.json.cards[k], 'number');
  // admin booking lifecycle: create, reschedule, complete, cancel + audit
  const open = await admin.get(`/api/admin/slots?date=${D(21)}`);
  assert.equal(open.json.rows.length, 0, 'inactive mentor slots are not offered');
  await admin.patch(`/api/admin/mentors/${mid}`, { status: 'active' });
  const slots = (await admin.get(`/api/admin/slots?date=${D(21)}`)).json.rows;
  assert.ok(slots.length >= 1);
  const created = await admin.post('/api/admin/bookings', { student_id: studentIds['bob@test.example'], availability_id: slots[0].id });
  assert.equal(created.status, 201);
  const slots2 = (await admin.get(`/api/admin/slots?date=${D(22)}`)).json.rows;
  const moved = await admin.post(`/api/admin/bookings/${created.json.booking.id}/reschedule`, { availability_id: slots2[0].id });
  assert.equal(moved.status, 200);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(created.json.booking.id).status, 'rescheduled');
  assert.equal((await admin.post(`/api/admin/bookings/${moved.json.booking.id}/complete`)).status, 200);
  assert.equal((await admin.post(`/api/admin/bookings/${moved.json.booking.id}/cancel`, {})).status, 409);
  const audit = await admin.get('/api/admin/audit?entity_type=booking');
  assert.ok(audit.json.rows.some((r) => r.action === 'booking.complete' && r.actor_name === 'Test Admin'));
  // settings are configurable
  const st = await admin.put('/api/admin/settings', { cancel_deadline_hours: 48, registration_mode: 'invite_code', registration_code: 'JOIN-US' });
  assert.equal(st.json.settings.cancel_deadline_hours, 48);
  assert.equal((await admin.put('/api/admin/settings', { cancel_deadline_hours: -3 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { nonsense: 1 })).status, 400);
  const anon = new Client();
  assert.equal((await anon.post('/api/auth/register', { name: 'X', email: 'x@test.example', password: 'longenough1', code: 'wrong' })).status, 403);
  assert.equal((await anon.post('/api/auth/register', { name: 'X', email: 'x@test.example', password: 'longenough1', code: 'JOIN-US' })).status, 201);
  await admin.put('/api/admin/settings', { cancel_deadline_hours: 24, registration_mode: 'admin_only' });
  assert.equal((await anon.post('/api/auth/register', { name: 'Y', email: 'y@test.example', password: 'longenough1' })).status, 403);
});

test('AT9: data persists in the database after logout, a new login and a full restart', async () => {
  const before = await studentClient('alice@test.example');
  const ids = (await before.get('/api/student/bookings')).json.upcoming.map((b) => b.id).sort();
  assert.ok(ids.length >= 1);
  await before.post('/api/auth/logout');
  // restart: new DB connection + new app instance on the same file
  const db2 = openDb(DB_FILE);
  const app2 = createApp(db2);
  const srv2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
  const oldBase = base; base = `http://127.0.0.1:${srv2.address().port}`;
  try {
    const c = await studentClient('alice@test.example');
    const ids2 = (await c.get('/api/student/bookings')).json.upcoming.map((b) => b.id).sort();
    assert.deepEqual(ids2, ids);
    // old session cookie from before logout is dead
    const stale = new Client(); stale.cookie = before.cookie;
    assert.equal((await stale.get('/api/student/dashboard')).status, 401);
  } finally { base = oldBase; srv2.close(); db2.close(); }
});

test('AT10: past slots and bad input are rejected; cancellation / reschedule rules are enforced', async () => {
  const stu = await studentClient('carol@test.example');
  const admin = await adminClient();
  // past: insert a slot directly in the past, students can't see or book it
  const past = addDays(istNow().date, -1);
  addSlot(mentorIds[0], past, '10:00');
  assert.deepEqual((await stu.get(`/api/student/slots?date=${past}`)).json.slots, []);
  const r = await stu.post('/api/student/bookings', { date: past, start_time: '10:00' });
  assert.equal(r.status, 400);
  assert.equal((await stu.post('/api/student/bookings', { date: 'nonsense', start_time: '10:00' })).status, 400);
  assert.equal((await stu.post('/api/student/bookings', { date: D(2), start_time: '10:10' })).status, 400);
  // admin cannot create past slots either
  const g = await admin.post('/api/admin/availability/generate', { mentor_id: mentorIds[0], mode: 'single', date: past, start_time: '08:00', end_time: '09:00' });
  assert.equal(g.json.created, 0);
  assert.equal(g.json.skipped_past, 2);
  // deadline: a booking 2 hours from now cannot be cancelled with a 24h policy
  const now = istNow();
  const soon = new Date(Date.now() + 5.5 * 3600e3 + 3 * 3600e3).toISOString();
  const soonDate = soon.slice(0, 10);
  const soonTime = `${soon.slice(11, 13)}:${Number(soon.slice(14, 16)) < 30 ? '30' : '00'}`;
  const soonDate2 = Number(soon.slice(14, 16)) < 30 ? soonDate : new Date(Date.parse(soon) + 3600e3).toISOString().slice(0, 10);
  const soonHour = Number(soon.slice(14, 16)) < 30 ? soon.slice(11, 13) : String((Number(soon.slice(11, 13)) + 1) % 24).padStart(2, '0');
  const t = `${soonHour}:${Number(soon.slice(14, 16)) < 30 ? '30' : '00'}`;
  void now; void soonTime;
  if (t > '00:30') { // skip on the rare midnight wrap
    const aid = addSlot(mentorIds[2], soonDate2, t);
    const bk = await stu.post('/api/student/bookings', { date: soonDate2, start_time: t });
    assert.equal(bk.status, 201, bk.text);
    const c = await stu.post(`/api/student/bookings/${bk.json.booking.id}/cancel`);
    assert.equal(c.status, 403);
    assert.equal(c.json.error.code, 'DEADLINE_PASSED');
    void aid;
  }
  // far-future booking can be cancelled, frees the slot, and can be rebooked by someone else
  const date = D(12);
  addSlot(mentorIds[0], date, '11:00');
  const bk = await stu.post('/api/student/bookings', { date, start_time: '11:00' });
  assert.equal(bk.status, 201);
  assert.equal((await stu.post(`/api/student/bookings/${bk.json.booking.id}/cancel`)).status, 200);
  const bob = await studentClient('bob@test.example');
  assert.equal((await bob.post('/api/student/bookings', { date, start_time: '11:00' })).status, 201);
  // student reschedule moves the booking and frees the old slot
  const d2 = D(13);
  addSlot(mentorIds[0], d2, '11:00');
  const bk2 = await bob.get('/api/student/bookings');
  const target = bk2.json.upcoming.find((b) => b.date === date);
  const rs = await bob.post(`/api/student/bookings/${target.id}/reschedule`, { date: d2, start_time: '11:00' });
  assert.equal(rs.status, 200, rs.text);
  const hist = (await bob.get('/api/student/bookings')).json;
  assert.ok(hist.past.some((b) => b.id === target.id && b.status === 'rescheduled'));
  assert.ok(hist.upcoming.some((b) => b.date === d2));
  assert.equal((await stu.get(`/api/student/slots?date=${date}`)).json.slots.length, 1);
  // booking limit setting
  await admin.put('/api/admin/settings', { max_upcoming_bookings: 1 });
  addSlot(mentorIds[0], D(14), '11:00');
  const limited = await bob.post('/api/student/bookings', { date: D(14), start_time: '11:00' });
  assert.equal(limited.status, 409);
  assert.equal(limited.json.error.code, 'LIMIT_REACHED');
  await admin.put('/api/admin/settings', { max_upcoming_bookings: 3 });
});

test('Security: CSRF, content-type, sessions, headers, injection and lockout', async () => {
  const alice = await studentClient('alice@test.example');
  // missing CSRF token
  const noTok = await alice.req('POST', '/api/student/notifications/read', {}, { noCsrf: true });
  assert.equal(noTok.status, 403);
  // wrong token
  const bad = await alice.req('POST', '/api/student/notifications/read', {}, { headers: { 'x-csrf-token': 'nope' }, noCsrf: true });
  assert.equal(bad.status, 403);
  // cross-site origin
  const xs = await alice.req('POST', '/api/student/notifications/read', {}, { headers: { origin: 'https://evil.example' } });
  assert.equal(xs.status, 403);
  // form-encoded posts are refused
  const form = await alice.req('POST', '/api/student/notifications/read', 'a=b', { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': alice.csrf } });
  assert.equal(form.status, 415);
  // cookie flags + headers
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alice@test.example', password: PW }) });
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/i); assert.match(sc, /SameSite=Lax/i);
  assert.ok(res.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal(res.headers.get('x-powered-by'), null);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes('password'));
  // SQL injection attempts are inert
  const admin = await adminClient();
  const inj = await admin.get(`/api/admin/bookings?q=${encodeURIComponent("' OR 1=1; DROP TABLE bookings;--")}`);
  assert.equal(inj.status, 200); assert.equal(inj.json.total, 0);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM bookings').get().n > 0);
  assert.equal((await admin.get('/api/admin/bookings?status=bogus')).status, 400);
  assert.equal((await new Client().login("admin@test.example' OR '1'='1", 'x')).status, 400);
  // passwords are hashed
  const row = db.prepare("SELECT password_hash FROM users WHERE email='alice@test.example'").get();
  assert.match(row.password_hash, /^\$2[aby]\$/);
  // stored markup stays inert data (frontend escapes it); API returns it verbatim as JSON text
  const x = await admin.post('/api/admin/mentors', { name: '<img src=x onerror=alert(1)>' });
  assert.equal(x.status, 201);
  // unknown JSON / bad JSON
  assert.equal((await alice.req('POST', '/api/student/bookings', '{bad', { raw: true, headers: { 'content-type': 'application/json', 'x-csrf-token': alice.csrf } })).status, 400);
  // lockout after repeated failures
  const victim = new Client();
  for (let i = 0; i < 5; i++) assert.equal((await victim.login('bob@test.example', 'wrong-password')).status, 401);
  assert.equal((await victim.login('bob@test.example', PW)).status, 429);
  db.prepare("UPDATE users SET locked_until=NULL, failed_logins=0 WHERE email='bob@test.example'").run();
  // disabled students cannot sign in and lose their sessions
  const carol = await studentClient('carol@test.example');
  await admin.patch(`/api/admin/students/${studentIds['carol@test.example']}`, { status: 'inactive' });
  assert.equal((await carol.get('/api/student/dashboard')).status, 401);
  assert.equal((await new Client().login('carol@test.example', PW)).status, 403);
  await admin.patch(`/api/admin/students/${studentIds['carol@test.example']}`, { status: 'active' });
  // 404 page + API 404 json
  assert.equal((await alice.get('/api/nope')).status, 404);
});

test('Notifications: in-app confirmations exist and email is honestly "not_configured"', async () => {
  const alice = await studentClient('alice@test.example');
  const n = (await alice.get('/api/student/notifications')).json.notifications;
  assert.ok(n.length >= 1);
  assert.ok(n.some((x) => x.type === 'confirmed'));
  const rows = db.prepare('SELECT DISTINCT email_status FROM notifications').all().map((r) => r.email_status);
  assert.deepEqual(rows, ['not_configured']);
});
