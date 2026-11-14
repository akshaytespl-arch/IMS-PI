'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { tx } = require('../db');
const { HttpError, nowIso, str, email, intId, oneOf, generatePassword, password } = require('../util');
const { requireRole } = require('../security');
const { audit } = require('../audit');
const { getSettings, updateSettings } = require('../settings');
const { istNow, isValidDate, isValidSlotTime, addMinutes, addDays, weekday, isPast } = require('../time');
const booking = require('../booking');
const { BCRYPT_COST } = require('./auth');

const LIVE = "('confirmed','completed')";
const BOOKING_STATUSES = ['confirmed', 'cancelled', 'completed', 'rescheduled'];

function page(req) {
  const p = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  return { p, size, offset: (p - 1) * size };
}

// CSV with formula-injection protection for spreadsheet apps.
function toCsv(rows, columns) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

module.exports = function adminRoutes(db) {
  const r = express.Router();
  r.use(requireRole('admin'));

  const sendCsv = (res, name, rows, cols) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${istNow().date}.csv"`);
    res.send(toCsv(rows, cols));
  };

  // ------------------------------------------------------------------ dashboard
  r.get('/dashboard', (_req, res) => {
    const now = istNow();
    const nowKey = `${now.date}T${now.time}`;
    const one = (sql, ...p) => db.prepare(sql).get(...p).n;
    const upcomingRows = db.prepare(
      `SELECT b.id, b.ref, b.date, b.start_time, b.end_time, b.status, u.name AS student_name, m.name AS mentor_name
       FROM bookings b JOIN students s ON s.id=b.student_id JOIN users u ON u.id=s.user_id JOIN mentors m ON m.id=b.mentor_id
       WHERE b.status='confirmed' AND (b.date || 'T' || b.start_time) > ? ORDER BY b.date, b.start_time LIMIT 8`
    ).all(nowKey);
    res.json({
      cards: {
        total_students: one("SELECT COUNT(*) n FROM students WHERE status='active'"),
        total_mentors: one("SELECT COUNT(*) n FROM mentors WHERE status='active'"),
        upcoming_bookings: one("SELECT COUNT(*) n FROM bookings WHERE status='confirmed' AND (date || 'T' || start_time) > ?", nowKey),
        completed_sessions: one("SELECT COUNT(*) n FROM bookings WHERE status='completed'"),
        cancelled_bookings: one("SELECT COUNT(*) n FROM bookings WHERE status='cancelled'"),
        available_slots: one(
          `SELECT COUNT(*) n FROM availability a JOIN mentors m ON m.id=a.mentor_id AND m.status='active'
           WHERE a.status='open' AND (a.date || 'T' || a.start_time) > ?
             AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.availability_id=a.id AND b.status IN ${LIVE})`, nowKey),
      },
      upcoming: upcomingRows,
      email_note: require('../config').emailConfigured ? null : 'Email notifications are not configured; confirmations appear in-app only.',
    });
  });

  // ------------------------------------------------------------------ students
  function studentQuery(req) {
    const where = [];
    const args = [];
    if (req.query.q) {
      const q = `%${String(req.query.q).trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      where.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR s.student_code LIKE ? ESCAPE '\\' OR s.batch LIKE ? ESCAPE '\\')");
      args.push(q, q, q, q);
    }
    if (req.query.status) { where.push('s.status = ?'); args.push(oneOf(req.query.status, ['active', 'inactive'], 'status')); }
    if (req.query.batch) { where.push('s.batch = ?'); args.push(String(req.query.batch)); }
    return { w: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
  }
  const STUDENT_SELECT = `SELECT s.id, s.user_id, s.student_code, s.batch, s.phone, s.status, s.created_at,
      u.name, u.email, u.last_login_at, u.must_change_password,
      (SELECT COUNT(*) FROM bookings b WHERE b.student_id = s.id AND b.status IN ${LIVE}) AS bookings_count
    FROM students s JOIN users u ON u.id = s.user_id`;

  r.get('/students', (req, res) => {
    const { p, size, offset } = page(req);
    const { w, args } = studentQuery(req);
    const total = db.prepare(`SELECT COUNT(*) n FROM students s JOIN users u ON u.id=s.user_id ${w}`).get(...args).n;
    const rows = db.prepare(`${STUDENT_SELECT} ${w} ORDER BY u.name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args, size, offset);
    const batches = db.prepare("SELECT DISTINCT batch FROM students WHERE batch IS NOT NULL AND batch <> '' ORDER BY batch").all().map((x) => x.batch);
    res.json({ rows, total, page: p, pageSize: size, batches });
  });

  r.get('/students/export.csv', (req, res) => {
    const { w, args } = studentQuery(req);
    const rows = db.prepare(`${STUDENT_SELECT} ${w} ORDER BY u.name COLLATE NOCASE`).all(...args);
    sendCsv(res, 'students', rows, ['id', 'student_code', 'name', 'email', 'phone', 'batch', 'status', 'bookings_count', 'created_at', 'last_login_at']);
  });

  r.post('/students', async (req, res) => {
    const name = str(req.body.name, 'Name', { required: true, max: 100 });
    const em = email(req.body.email);
    const code = str(req.body.student_code, 'Student ID', { max: 40 });
    const batch = str(req.body.batch, 'Batch', { max: 60 });
    const phone = str(req.body.phone, 'Phone', { max: 30 });
    const given = req.body.password ? password(req.body.password) : null;
    const pw = given || generatePassword();
    const hash = await bcrypt.hash(pw, BCRYPT_COST);
    let sid;
    try {
      sid = tx(db, () => {
        const uid = db.prepare("INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?,?,?, 'student', 1)").run(name, em, hash).lastInsertRowid;
        const id = db.prepare('INSERT INTO students (user_id, student_code, batch, phone) VALUES (?,?,?,?)').run(uid, code, batch, phone).lastInsertRowid;
        audit(db, req.user, 'student.create', 'student', id, { email: em });
        return id;
      });
    } catch (e) {
      const m = String(e.message);
      if (m.includes('users.email')) throw new HttpError(409, 'EMAIL_TAKEN', 'A user with this email already exists.');
      if (m.includes('students.student_code')) throw new HttpError(409, 'CODE_TAKEN', 'That student ID is already in use.');
      throw e;
    }
    res.status(201).json({ id: Number(sid), generated_password: given ? undefined : pw });
  });

  r.patch('/students/:id', (req, res) => {
    const id = intId(req.params.id);
    const s = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Student not found');
    const name = req.body.name !== undefined ? str(req.body.name, 'Name', { required: true, max: 100 }) : null;
    const em = req.body.email !== undefined ? email(req.body.email) : null;
    const status = req.body.status !== undefined ? oneOf(req.body.status, ['active', 'inactive'], 'status') : null;
    try {
      tx(db, () => {
        if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, s.user_id);
        if (em) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(em, s.user_id);
        if (status) {
          db.prepare('UPDATE students SET status = ? WHERE id = ?').run(status, id);
          db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status === 'active' ? 'active' : 'disabled', s.user_id);
          if (status === 'inactive') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(s.user_id);
        }
        for (const [k, label, max] of [['student_code', 'Student ID', 40], ['batch', 'Batch', 60], ['phone', 'Phone', 30]]) {
          if (req.body[k] !== undefined) db.prepare(`UPDATE students SET ${k} = ? WHERE id = ?`).run(str(req.body[k], label, { max }), id);
        }
        audit(db, req.user, 'student.update', 'student', id, { fields: Object.keys(req.body) });
      });
    } catch (e) {
      const m = String(e.message);
      if (m.includes('users.email')) throw new HttpError(409, 'EMAIL_TAKEN', 'A user with this email already exists.');
      if (m.includes('students.student_code')) throw new HttpError(409, 'CODE_TAKEN', 'That student ID is already in use.');
      throw e;
    }
    res.json({ ok: true });
  });

  r.post('/students/:id/reset-password', async (req, res) => {
    const id = intId(req.params.id);
    const s = db.prepare('SELECT user_id FROM students WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Student not found');
    const pw = generatePassword();
    const hash = await bcrypt.hash(pw, BCRYPT_COST);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hash, s.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(s.user_id);
    audit(db, req.user, 'student.reset_password', 'student', id, null);
    res.json({ generated_password: pw });
  });

  r.delete('/students/:id', (req, res) => {
    const id = intId(req.params.id);
    const s = db.prepare('SELECT user_id FROM students WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Student not found');
    const n = db.prepare('SELECT COUNT(*) n FROM bookings WHERE student_id = ?').get(id).n;
    if (n > 0) throw new HttpError(409, 'HAS_BOOKINGS', 'This student has booking history and cannot be deleted. Deactivate the account instead.');
    tx(db, () => {
      db.prepare('DELETE FROM users WHERE id = ?').run(s.user_id); // cascades to students + sessions
      audit(db, req.user, 'student.delete', 'student', id, null);
    });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ mentors
  const MENTOR_SELECT = `SELECT m.id, m.name, m.email, m.phone, m.notes, m.status, m.created_at,
      (SELECT COUNT(*) FROM bookings b WHERE b.mentor_id = m.id AND b.status IN ${LIVE}) AS bookings_count,
      (SELECT COUNT(*) FROM availability a WHERE a.mentor_id = m.id AND a.date >= ? AND a.status='open') AS open_slots
    FROM mentors m`;

  function mentorQuery(req) {
    const where = [];
    const args = [];
    if (req.query.q) {
      const q = `%${String(req.query.q).trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      where.push("(m.name LIKE ? ESCAPE '\\' OR m.email LIKE ? ESCAPE '\\')");
      args.push(q, q);
    }
    if (req.query.status) { where.push('m.status = ?'); args.push(oneOf(req.query.status, ['active', 'inactive'], 'status')); }
    return { w: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
  }

  r.get('/mentors', (req, res) => {
    const { w, args } = mentorQuery(req);
    res.json({ rows: db.prepare(`${MENTOR_SELECT} ${w} ORDER BY m.name COLLATE NOCASE`).all(istNow().date, ...args) });
  });

  r.get('/mentors/export.csv', (req, res) => {
    const { w, args } = mentorQuery(req);
    const rows = db.prepare(`${MENTOR_SELECT} ${w} ORDER BY m.name COLLATE NOCASE`).all(istNow().date, ...args);
    sendCsv(res, 'mentors', rows, ['id', 'name', 'email', 'phone', 'status', 'bookings_count', 'open_slots', 'notes', 'created_at']);
  });

  r.post('/mentors', (req, res) => {
    const name = str(req.body.name, 'Name', { required: true, max: 100 });
    const em = email(req.body.email, 'Email', false);
    const phone = str(req.body.phone, 'Phone', { max: 30 });
    const notes = str(req.body.notes, 'Notes', { max: 1000 });
    const id = db.prepare('INSERT INTO mentors (name, email, phone, notes) VALUES (?,?,?,?)').run(name, em, phone, notes).lastInsertRowid;
    audit(db, req.user, 'mentor.create', 'mentor', id, { name });
    res.status(201).json({ id: Number(id) });
  });

  r.patch('/mentors/:id', (req, res) => {
    const id = intId(req.params.id);
    const m = db.prepare('SELECT * FROM mentors WHERE id = ?').get(id);
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'Mentor not found');
    const next = {
      name: req.body.name !== undefined ? str(req.body.name, 'Name', { required: true, max: 100 }) : m.name,
      email: req.body.email !== undefined ? email(req.body.email, 'Email', false) : m.email,
      phone: req.body.phone !== undefined ? str(req.body.phone, 'Phone', { max: 30 }) : m.phone,
      notes: req.body.notes !== undefined ? str(req.body.notes, 'Notes', { max: 1000 }) : m.notes,
      status: req.body.status !== undefined ? oneOf(req.body.status, ['active', 'inactive'], 'status') : m.status,
    };
    db.prepare('UPDATE mentors SET name=?, email=?, phone=?, notes=?, status=? WHERE id=?').run(next.name, next.email, next.phone, next.notes, next.status, id);
    audit(db, req.user, 'mentor.update', 'mentor', id, { fields: Object.keys(req.body) });
    let affected = 0;
    if (m.status === 'active' && next.status === 'inactive') {
      const now = istNow();
      affected = db.prepare(
        "SELECT COUNT(*) n FROM bookings WHERE mentor_id = ? AND status='confirmed' AND (date || 'T' || start_time) > ?"
      ).get(id, `${now.date}T${now.time}`).n;
    }
    res.json({ ok: true, future_bookings_affected: affected });
  });

  r.delete('/mentors/:id', (req, res) => {
    const id = intId(req.params.id);
    if (!db.prepare('SELECT 1 FROM mentors WHERE id = ?').get(id)) throw new HttpError(404, 'NOT_FOUND', 'Mentor not found');
    if (db.prepare('SELECT COUNT(*) n FROM bookings WHERE mentor_id = ?').get(id).n > 0) {
      throw new HttpError(409, 'HAS_BOOKINGS', 'This mentor has booking history and cannot be removed. Deactivate the mentor instead.');
    }
    tx(db, () => {
      db.prepare('DELETE FROM mentors WHERE id = ?').run(id); // cascades to unbooked availability
      audit(db, req.user, 'mentor.delete', 'mentor', id, null);
    });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ availability
  function availabilityQuery(req) {
    const where = [];
    const args = [];
    const from = req.query.from || istNow().date;
    if (!isValidDate(from)) throw new HttpError(400, 'VALIDATION', 'from must be YYYY-MM-DD');
    where.push('a.date >= ?'); args.push(from);
    if (req.query.to) {
      if (!isValidDate(req.query.to)) throw new HttpError(400, 'VALIDATION', 'to must be YYYY-MM-DD');
      where.push('a.date <= ?'); args.push(req.query.to);
    }
    if (req.query.mentor_id) { where.push('a.mentor_id = ?'); args.push(intId(req.query.mentor_id, 'mentor_id')); }
    if (req.query.status) {
      const st = oneOf(req.query.status, ['open', 'blocked', 'booked'], 'status');
      if (st === 'booked') where.push(`EXISTS (SELECT 1 FROM bookings b WHERE b.availability_id=a.id AND b.status IN ${LIVE})`);
      else if (st === 'open') where.push(`a.status='open' AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.availability_id=a.id AND b.status IN ${LIVE})`);
      else where.push("a.status='blocked'");
    }
    return { w: `WHERE ${where.join(' AND ')}`, args };
  }
  const AVAIL_SELECT = `SELECT a.id, a.mentor_id, m.name AS mentor_name, a.date, a.start_time, a.end_time, a.status AS slot_status,
      lb.id AS booking_id, lb.ref AS booking_ref, lb.status AS booking_status, su.name AS student_name,
      CASE WHEN lb.id IS NOT NULL THEN 'booked' ELSE a.status END AS status
    FROM availability a JOIN mentors m ON m.id = a.mentor_id
    LEFT JOIN bookings lb ON lb.availability_id = a.id AND lb.status IN ${LIVE}
    LEFT JOIN students ss ON ss.id = lb.student_id LEFT JOIN users su ON su.id = ss.user_id`;

  r.get('/availability', (req, res) => {
    const { p, size, offset } = page(req);
    const { w, args } = availabilityQuery(req);
    const total = db.prepare(`SELECT COUNT(*) n FROM availability a ${w}`).get(...args).n;
    const rows = db.prepare(`${AVAIL_SELECT} ${w} ORDER BY a.date, a.start_time, m.name LIMIT ? OFFSET ?`).all(...args, size, offset);
    res.json({ rows, total, page: p, pageSize: size });
  });

  r.get('/availability/export.csv', (req, res) => {
    const { w, args } = availabilityQuery(req);
    const rows = db.prepare(`${AVAIL_SELECT} ${w} ORDER BY a.date, a.start_time, m.name`).all(...args);
    sendCsv(res, 'availability', rows, ['id', 'date', 'start_time', 'end_time', 'mentor_id', 'mentor_name', 'status', 'booking_ref', 'student_name']);
  });

  // Create 30-minute slots for one mentor: a single date, a date range, or recurring weekdays within a range.
  r.post('/availability/generate', (req, res) => {
    const mentorId = intId(req.body.mentor_id, 'Mentor');
    const mode = oneOf(req.body.mode || 'single', ['single', 'range', 'recurring'], 'mode');
    const startDate = req.body.date;
    if (!isValidDate(startDate)) throw new HttpError(400, 'VALIDATION', 'A valid start date is required');
    const endDate = mode === 'single' ? startDate : req.body.end_date;
    if (!isValidDate(endDate)) throw new HttpError(400, 'VALIDATION', 'A valid end date is required');
    if (endDate < startDate) throw new HttpError(400, 'VALIDATION', 'End date cannot be before start date');
    if (!isValidSlotTime(req.body.start_time) || !isValidSlotTime(req.body.end_time)) {
      throw new HttpError(400, 'VALIDATION', 'Times must be on the hour or half hour (e.g. 10:00, 10:30)');
    }
    if (req.body.end_time <= req.body.start_time) throw new HttpError(400, 'VALIDATION', 'End time must be after start time');
    let days = null;
    if (mode === 'recurring') {
      if (!Array.isArray(req.body.weekdays) || !req.body.weekdays.length || !req.body.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
        throw new HttpError(400, 'VALIDATION', 'Choose at least one weekday');
      }
      days = new Set(req.body.weekdays);
    }
    const dates = [];
    for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
      if (dates.length > 366) throw new HttpError(400, 'VALIDATION', 'Date range is too long (max 1 year)');
      if (!days || days.has(weekday(d))) dates.push(d);
    }
    const times = [];
    for (let t = req.body.start_time; t && t < req.body.end_time; t = addMinutes(t, 30)) times.push(t);
    if (dates.length * times.length > 5000) throw new HttpError(400, 'VALIDATION', 'That would create too many slots at once (max 5000)');

    const result = tx(db, () => {
      const m = db.prepare('SELECT status FROM mentors WHERE id = ?').get(mentorId);
      if (!m) throw new HttpError(404, 'NOT_FOUND', 'Mentor not found');
      if (m.status !== 'active') throw new HttpError(400, 'MENTOR_INACTIVE', 'Cannot open availability for an inactive mentor.');
      const ins = db.prepare('INSERT OR IGNORE INTO availability (mentor_id, date, start_time, end_time, created_by) VALUES (?,?,?,?,?)');
      let created = 0, existing = 0, past = 0;
      for (const d of dates) {
        for (const t of times) {
          if (isPast(d, t)) { past++; continue; }
          const ch = ins.run(mentorId, d, t, addMinutes(t, 30), req.user.id).changes;
          if (ch) created++; else existing++;
        }
      }
      audit(db, req.user, 'availability.generate', 'mentor', mentorId, { mode, from: startDate, to: endDate, start: req.body.start_time, end: req.body.end_time, created });
      return { created, already_existed: existing, skipped_past: past };
    });
    res.status(201).json(result);
  });

  function selectSlotIds(body) {
    if (Array.isArray(body.ids)) {
      if (body.ids.length > 2000) throw new HttpError(400, 'VALIDATION', 'Too many slots selected');
      return body.ids.map((x) => intId(x, 'id'));
    }
    // by filter: a date or date range (+ optional mentor) — used for "close this date"
    const from = body.date || body.from;
    const to = body.date || body.to || from;
    if (!isValidDate(from) || !isValidDate(to)) throw new HttpError(400, 'VALIDATION', 'Provide ids or a valid date / date range');
    const args = [from, to];
    let sql = 'SELECT id FROM availability WHERE date >= ? AND date <= ?';
    if (body.mentor_id) { sql += ' AND mentor_id = ?'; args.push(intId(body.mentor_id, 'mentor_id')); }
    return db.prepare(sql).all(...args).map((x) => x.id);
  }

  r.post('/availability/status', (req, res) => {
    const status = oneOf(req.body.status, ['open', 'blocked'], 'status');
    const out = tx(db, () => {
      const ids = selectSlotIds(req.body);
      let changed = 0, skippedBooked = 0;
      const upd = db.prepare('UPDATE availability SET status = ? WHERE id = ? AND status <> ?');
      const live = db.prepare(`SELECT 1 FROM bookings WHERE availability_id = ? AND status IN ${LIVE}`);
      for (const id of ids) {
        if (status === 'blocked' && live.get(id)) { skippedBooked++; continue; }
        changed += upd.run(status, id, status).changes;
      }
      audit(db, req.user, status === 'blocked' ? 'availability.block' : 'availability.unblock', 'availability', null, { count: changed, skipped_booked: skippedBooked, scope: req.body.ids ? 'ids' : { date: req.body.date, from: req.body.from, to: req.body.to, mentor_id: req.body.mentor_id } });
      return { changed, skipped_booked: skippedBooked };
    });
    res.json(out);
  });

  r.post('/availability/delete', (req, res) => {
    const out = tx(db, () => {
      const ids = selectSlotIds(req.body);
      let deleted = 0, skippedBooked = 0;
      const live = db.prepare(`SELECT 1 FROM bookings WHERE availability_id = ? AND status IN ${LIVE}`);
      const del = db.prepare('DELETE FROM availability WHERE id = ?');
      for (const id of ids) {
        if (live.get(id)) { skippedBooked++; continue; }
        deleted += del.run(id).changes;
      }
      audit(db, req.user, 'availability.delete', 'availability', null, { count: deleted, skipped_booked: skippedBooked });
      return { deleted, skipped_booked: skippedBooked };
    });
    res.json(out);
  });

  // Open, unbooked, future slots with mentor names — used when an admin creates / moves a booking.
  r.get('/slots', (req, res) => {
    const date = String(req.query.date || '');
    if (!isValidDate(date)) throw new HttpError(400, 'VALIDATION', 'date must be YYYY-MM-DD');
    const rows = db.prepare(
      `SELECT a.id, a.date, a.start_time, a.end_time, m.id AS mentor_id, m.name AS mentor_name
       FROM availability a JOIN mentors m ON m.id=a.mentor_id AND m.status='active'
       WHERE a.date = ? AND a.status='open'
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.availability_id=a.id AND b.status IN ${LIVE})
       ORDER BY a.start_time, m.name`
    ).all(date);
    res.json({ rows: rows.filter((x) => !isPast(x.date, x.start_time)) });
  });

  // ------------------------------------------------------------------ bookings
  const BOOKING_SELECT = `SELECT b.id, b.ref, b.status, b.date, b.start_time, b.end_time, b.created_at, b.updated_at,
      b.student_id, s.student_code, su.name AS student_name, su.email AS student_email, s.phone AS student_phone, s.batch AS student_batch,
      b.mentor_id, m.name AS mentor_name, b.availability_id, b.admin_notes, b.cancel_reason, b.cancelled_by_role,
      b.rescheduled_from_id, cu.name AS created_by
    FROM bookings b
    JOIN students s ON s.id = b.student_id JOIN users su ON su.id = s.user_id
    JOIN mentors m ON m.id = b.mentor_id
    LEFT JOIN users cu ON cu.id = b.created_by_user_id`;

  function bookingQuery(req) {
    const where = [];
    const args = [];
    if (req.query.from) { if (!isValidDate(req.query.from)) throw new HttpError(400, 'VALIDATION', 'from must be YYYY-MM-DD'); where.push('b.date >= ?'); args.push(req.query.from); }
    if (req.query.to) { if (!isValidDate(req.query.to)) throw new HttpError(400, 'VALIDATION', 'to must be YYYY-MM-DD'); where.push('b.date <= ?'); args.push(req.query.to); }
    if (req.query.student_id) { where.push('b.student_id = ?'); args.push(intId(req.query.student_id, 'student_id')); }
    if (req.query.mentor_id) { where.push('b.mentor_id = ?'); args.push(intId(req.query.mentor_id, 'mentor_id')); }
    if (req.query.status) { where.push('b.status = ?'); args.push(oneOf(req.query.status, BOOKING_STATUSES, 'status')); }
    if (req.query.q) {
      const q = `%${String(req.query.q).trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      where.push("(su.name LIKE ? ESCAPE '\\' OR su.email LIKE ? ESCAPE '\\' OR b.ref LIKE ? ESCAPE '\\' OR s.student_code LIKE ? ESCAPE '\\' OR m.name LIKE ? ESCAPE '\\')");
      args.push(q, q, q, q, q);
    }
    return { w: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
  }
  const ORDER = req0 => (req0.query.order === 'asc' ? 'ASC' : 'DESC');

  r.get('/bookings', (req, res) => {
    const { p, size, offset } = page(req);
    const { w, args } = bookingQuery(req);
    const total = db.prepare(`SELECT COUNT(*) n FROM bookings b JOIN students s ON s.id=b.student_id JOIN users su ON su.id=s.user_id JOIN mentors m ON m.id=b.mentor_id ${w}`).get(...args).n;
    const o = ORDER(req);
    const rows = db.prepare(`${BOOKING_SELECT} ${w} ORDER BY b.date ${o}, b.start_time ${o}, b.id ${o} LIMIT ? OFFSET ?`).all(...args, size, offset);
    res.json({ rows, total, page: p, pageSize: size });
  });

  r.get('/bookings/export.csv', (req, res) => {
    const { w, args } = bookingQuery(req);
    const rows = db.prepare(`${BOOKING_SELECT} ${w} ORDER BY b.date, b.start_time, b.id`).all(...args);
    sendCsv(res, 'bookings', rows, [
      'id', 'ref', 'student_id', 'student_code', 'student_name', 'student_email', 'student_phone', 'student_batch',
      'mentor_id', 'mentor_name', 'date', 'start_time', 'end_time', 'status', 'created_at', 'updated_at',
      'cancelled_by_role', 'cancel_reason', 'admin_notes',
    ]);
  });

  r.get('/bookings/:id', (req, res) => {
    const id = intId(req.params.id);
    const b = db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(id);
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
    const history = db.prepare(
      `SELECT id, actor_name, actor_role, action, details, created_at FROM audit_log WHERE entity_type='booking' AND entity_id = ? ORDER BY id`
    ).all(String(id));
    const related = db.prepare(`SELECT id, ref, status, date, start_time FROM bookings WHERE id = ? OR rescheduled_from_id = ?`).all(b.rescheduled_from_id || -1, id);
    res.json({ booking: b, history, related });
  });

  r.post('/bookings', (req, res) => {
    const b = booking.adminCreate(db, { studentId: intId(req.body.student_id, 'Student'), availabilityId: intId(req.body.availability_id, 'Slot'), actor: req.user });
    res.status(201).json({ booking: b });
  });

  r.post('/bookings/:id/cancel', (req, res) => {
    const reason = str(req.body.reason, 'Reason', { max: 300 });
    res.json(booking.adminCancel(db, { id: intId(req.params.id), reason, actor: req.user }));
  });

  r.post('/bookings/:id/complete', (req, res) => {
    res.json(booking.adminComplete(db, { id: intId(req.params.id), actor: req.user }));
  });

  r.post('/bookings/:id/reschedule', (req, res) => {
    res.json({ booking: booking.adminReschedule(db, { id: intId(req.params.id), availabilityId: intId(req.body.availability_id, 'Slot'), actor: req.user }) });
  });

  r.patch('/bookings/:id', (req, res) => {
    const id = intId(req.params.id);
    if (!db.prepare('SELECT 1 FROM bookings WHERE id = ?').get(id)) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
    const notes = str(req.body.admin_notes, 'Notes', { max: 1000 });
    db.prepare('UPDATE bookings SET admin_notes = ?, updated_at = ? WHERE id = ?').run(notes, nowIso(), id);
    audit(db, req.user, 'booking.notes', 'booking', id, null);
    res.json({ ok: true });
  });

  // Day-by-day schedule: bookings grouped by date + open slot counts.
  r.get('/schedule', (req, res) => {
    const from = req.query.from || istNow().date;
    const to = req.query.to || addDays(from, 6);
    if (!isValidDate(from) || !isValidDate(to) || to < from) throw new HttpError(400, 'VALIDATION', 'Invalid date range');
    if (addDays(from, 31) < to) throw new HttpError(400, 'VALIDATION', 'Range is limited to 31 days');
    const bookings = db.prepare(`${BOOKING_SELECT} WHERE b.date >= ? AND b.date <= ? AND b.status IN ('confirmed','completed') ORDER BY b.date, b.start_time, m.name`).all(from, to);
    const open = db.prepare(
      `SELECT a.date, COUNT(*) AS n FROM availability a JOIN mentors m ON m.id=a.mentor_id AND m.status='active'
       WHERE a.date >= ? AND a.date <= ? AND a.status='open'
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.availability_id=a.id AND b.status IN ${LIVE}) GROUP BY a.date`
    ).all(from, to);
    const openBy = Object.fromEntries(open.map((x) => [x.date, x.n]));
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push({ date: d, open_slots: openBy[d] || 0, bookings: bookings.filter((b) => b.date === d) });
    res.json({ from, to, days });
  });

  // ------------------------------------------------------------------ settings / audit
  r.get('/settings', (_req, res) => {
    res.json({ settings: getSettings(db), email_configured: require('../config').emailConfigured });
  });

  r.put('/settings', (req, res) => {
    const before = getSettings(db);
    const after = updateSettings(db, req.body);
    const changed = Object.keys(req.body).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]) && k !== 'registration_code');
    audit(db, req.user, 'settings.update', 'settings', null, { changed });
    res.json({ settings: after });
  });

  function auditQuery(req) {
    const where = [];
    const args = [];
    if (req.query.entity_type) { where.push('entity_type = ?'); args.push(String(req.query.entity_type)); }
    if (req.query.action) { where.push('action LIKE ?'); args.push(`${String(req.query.action).replace(/[%_]/g, '')}%`); }
    return { w: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
  }
  r.get('/audit', (req, res) => {
    const { p, size, offset } = page(req);
    const { w, args } = auditQuery(req);
    const total = db.prepare(`SELECT COUNT(*) n FROM audit_log ${w}`).get(...args).n;
    const rows = db.prepare(`SELECT id, actor_name, actor_role, action, entity_type, entity_id, details, created_at FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, size, offset);
    res.json({ rows, total, page: p, pageSize: size });
  });
  r.get('/audit/export.csv', (req, res) => {
    const { w, args } = auditQuery(req);
    const rows = db.prepare(`SELECT id, created_at, actor_name, actor_role, action, entity_type, entity_id, details FROM audit_log ${w} ORDER BY id DESC LIMIT 20000`).all(...args);
    sendCsv(res, 'audit-log', rows, ['id', 'created_at', 'actor_name', 'actor_role', 'action', 'entity_type', 'entity_id', 'details']);
  });

  return r;
};
