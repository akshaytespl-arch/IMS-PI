'use strict';
// PRIVACY: every query in this file is written explicitly and none touches the `mentors` table or any
// mentor_id column. Response shapes are whitelisted below, so mentor identity cannot reach a student.
const express = require('express');
const { HttpError, str } = require('../util');
const { requireRole } = require('../security');
const { getSettings } = require('../settings');
const { istNow, hoursUntil, isValidDate } = require('../time');
const booking = require('../booking');
const { audit } = require('../audit');

module.exports = function studentRoutes(db) {
  const r = express.Router();
  r.use(requireRole('student'));

  r.use((req, _res, next) => {
    const s = db.prepare(
      `SELECT s.id, s.student_code, s.batch, s.phone, s.status FROM students s WHERE s.user_id = ?`
    ).get(req.user.id);
    if (!s || s.status !== 'active') return next(new HttpError(403, 'ACCOUNT_INACTIVE', 'Your account is not active.'));
    req.student = s;
    next();
  });

  // Whitelisted view of a booking for students.
  function view(b, settings) {
    const upcoming = b.status === 'confirmed' && hoursUntil(b.date, b.start_time) > 0;
    const h = hoursUntil(b.date, b.start_time);
    return {
      id: b.ref,
      date: b.date,
      start_time: b.start_time,
      end_time: b.end_time,
      status: b.status,
      booked_at: b.created_at,
      can_cancel: upcoming && settings.allow_student_cancel && h >= settings.cancel_deadline_hours,
      can_reschedule: upcoming && settings.allow_student_reschedule && h >= settings.reschedule_deadline_hours,
    };
  }
  const COLS = 'ref, date, start_time, end_time, status, created_at';

  r.get('/dashboard', (req, res) => {
    const settings = getSettings(db);
    const now = istNow();
    const next = db.prepare(
      `SELECT ${COLS} FROM bookings WHERE student_id = ? AND status = 'confirmed' AND (date || 'T' || start_time) > ?
       ORDER BY date, start_time LIMIT 1`
    ).get(req.student.id, `${now.date}T${now.time}`);
    const counts = db.prepare(
      `SELECT SUM(status='confirmed' AND (date || 'T' || start_time) > ?) AS upcoming, SUM(status='completed') AS completed
       FROM bookings WHERE student_id = ?`
    ).get(`${now.date}T${now.time}`, req.student.id);
    const notes = db.prepare(
      'SELECT id, type, title, body, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 5'
    ).all(req.user.id);
    res.json({
      name: req.user.name,
      next_booking: next ? view(next, settings) : null,
      upcoming_count: counts.upcoming || 0,
      completed_count: counts.completed || 0,
      notifications: notes,
      policy: {
        allow_cancel: settings.allow_student_cancel, cancel_deadline_hours: settings.cancel_deadline_hours,
        allow_reschedule: settings.allow_student_reschedule, reschedule_deadline_hours: settings.reschedule_deadline_hours,
        max_advance_days: settings.max_advance_days,
      },
    });
  });

  r.get('/dates', (req, res) => {
    res.json(booking.studentDates(db, String(req.query.month || '')));
  });

  r.get('/slots', (req, res) => {
    const date = String(req.query.date || '');
    if (!isValidDate(date)) throw new HttpError(400, 'VALIDATION', 'date must be YYYY-MM-DD');
    res.json({ date, slots: booking.studentSlots(db, req.student.id, date) });
  });

  r.post('/bookings', (req, res) => {
    const b = booking.studentBook(db, {
      studentId: req.student.id, date: req.body.date, start_time: req.body.start_time, actor: req.user,
    });
    res.status(201).json({ booking: { id: b.ref, date: b.date, start_time: b.start_time, end_time: b.end_time, status: 'confirmed' } });
  });

  r.get('/bookings', (req, res) => {
    const settings = getSettings(db);
    const rows = db.prepare(`SELECT ${COLS} FROM bookings WHERE student_id = ? ORDER BY date DESC, start_time DESC LIMIT 500`).all(req.student.id);
    const now = istNow();
    const nowKey = `${now.date}T${now.time}`;
    const v = rows.map((b) => view(b, settings));
    const isUpcoming = (b) => b.status === 'confirmed' && `${b.date}T${b.start_time}` > nowKey;
    res.json({
      upcoming: v.filter(isUpcoming).sort((a, b) => `${a.date}${a.start_time}`.localeCompare(`${b.date}${b.start_time}`)),
      past: v.filter((b) => !isUpcoming(b)),
    });
  });

  r.get('/bookings/:ref', (req, res) => {
    const b = db.prepare(`SELECT ${COLS} FROM bookings WHERE ref = ? AND student_id = ?`).get(req.params.ref, req.student.id);
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
    res.json({ booking: view(b, getSettings(db)) });
  });

  r.post('/bookings/:ref/cancel', (req, res) => {
    booking.studentCancel(db, { studentId: req.student.id, ref: req.params.ref, actor: req.user });
    res.json({ ok: true });
  });

  r.post('/bookings/:ref/reschedule', (req, res) => {
    const b = booking.studentBook(db, {
      studentId: req.student.id, date: req.body.date, start_time: req.body.start_time, actor: req.user, rescheduleRef: req.params.ref,
    });
    res.json({ booking: { id: b.ref, date: b.date, start_time: b.start_time, end_time: b.end_time, status: 'confirmed' } });
  });

  r.get('/profile', (req, res) => {
    res.json({ name: req.user.name, email: req.user.email, student_code: req.student.student_code, batch: req.student.batch, phone: req.student.phone });
  });

  r.patch('/profile', (req, res) => {
    const phone = str(req.body.phone, 'Phone', { max: 30 });
    db.prepare('UPDATE students SET phone = ? WHERE id = ?').run(phone, req.student.id);
    audit(db, req.user, 'student.profile_update', 'student', req.student.id, null);
    res.json({ ok: true });
  });

  r.post('/notifications/read', (req, res) => {
    db.prepare("UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
    res.json({ ok: true });
  });

  r.get('/notifications', (req, res) => {
    res.json({
      notifications: db.prepare('SELECT id, type, title, body, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id),
    });
  });

  return r;
};
