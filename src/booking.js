'use strict';
const { tx } = require('./db');
const { HttpError, nowIso, newBookingRef } = require('./util');
const { istNow, isValidDate, isValidSlotTime, addMinutes, addDays, isPast, hoursUntil } = require('./time');
const { audit } = require('./audit');
const { createNotification } = require('./notify');
const { getSettings } = require('./settings');

const LIVE = "('confirmed','completed')";

// ---------- formatting for notification text (IST) ----------
function longDate(date) {
  return new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
}
function t12(t) {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const whenText = (b) => `${longDate(b.date)}, ${t12(b.start_time)}–${t12(b.end_time)} (IST)`;

// ---------- student-safe availability queries (NO mentor columns are ever selected) ----------
const OPEN_SLOT_FROM = `
  FROM availability a
  JOIN mentors m ON m.id = a.mentor_id AND m.status = 'active'
  WHERE a.status = 'open'
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.availability_id = a.id AND b.status IN ${LIVE})`;

function bookableWindow(settings) {
  const now = istNow();
  return { minDate: now.date, maxDate: addDays(now.date, settings.max_advance_days) };
}

function studentDates(db, month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new HttpError(400, 'VALIDATION', 'month must be YYYY-MM');
  const settings = getSettings(db);
  const { minDate, maxDate } = bookableWindow(settings);
  const from = `${month}-01`;
  const to = `${month}-31`;
  const rows = db.prepare(
    `SELECT DISTINCT a.date, a.start_time ${OPEN_SLOT_FROM} AND a.date >= ? AND a.date <= ? AND a.date >= ? AND a.date <= ?`
  ).all(from, to, minDate, maxDate);
  const dates = new Set();
  for (const r of rows) if (hoursUntil(r.date, r.start_time) >= settings.min_notice_hours) dates.add(r.date);
  return { dates: [...dates].sort(), window: { from: minDate, to: maxDate } };
}

function studentSlots(db, studentId, date) {
  if (!isValidDate(date)) throw new HttpError(400, 'VALIDATION', 'date must be YYYY-MM-DD');
  const settings = getSettings(db);
  const { minDate, maxDate } = bookableWindow(settings);
  if (date < minDate || date > maxDate) return [];
  const rows = db.prepare(
    `SELECT DISTINCT a.start_time, a.end_time ${OPEN_SLOT_FROM} AND a.date = ? ORDER BY a.start_time`
  ).all(date);
  const mine = new Set(
    db.prepare(`SELECT start_time FROM bookings WHERE student_id = ? AND date = ? AND status IN ${LIVE}`).all(studentId, date).map((r) => r.start_time)
  );
  return rows
    .filter((r) => hoursUntil(date, r.start_time) >= settings.min_notice_hours)
    .map((r) => ({ start_time: r.start_time, end_time: r.end_time, state: mine.has(r.start_time) ? 'yours' : 'available' }));
}

// ---------- core insert ----------
function translateDbError(e) {
  const m = String(e && e.message);
  if (e instanceof HttpError) return e;
  if (m.includes('UNIQUE constraint failed: bookings.student_id')) return new HttpError(409, 'ALREADY_BOOKED', 'You already have a session at that time.');
  if (m.includes('UNIQUE constraint failed: bookings.availability_id') || m.includes('UNIQUE constraint failed: bookings.mentor_id') || m.includes('MENTOR_OVERLAP')) {
    return new HttpError(409, 'SLOT_TAKEN', 'Sorry, that time slot was just taken. Please choose another.');
  }
  if (m.includes('SLOT_MISMATCH')) return new HttpError(409, 'SLOT_UNAVAILABLE', 'That time slot is no longer available.');
  return e;
}

function studentRow(db, studentId) {
  const s = db.prepare(
    `SELECT s.id, s.user_id, s.status, u.name, u.status AS user_status FROM students s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).get(studentId);
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'Student not found');
  return s;
}

// Inserts the booking row (+audit +notification). Must be called inside tx().
function placeBooking(db, { student, slot, actor, rescheduleFrom = null }) {
  if (isPast(slot.date, slot.start_time)) throw new HttpError(400, 'PAST_SLOT', 'That time has already passed.');
  const ref = newBookingRef();
  const now = nowIso();
  let id;
  try {
    id = db.prepare(
      `INSERT INTO bookings (ref, student_id, mentor_id, availability_id, date, start_time, end_time, status,
                             rescheduled_from_id, created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'confirmed', ?,?,?,?)`
    ).run(ref, student.id, slot.mentor_id, slot.id, slot.date, slot.start_time, slot.end_time,
      rescheduleFrom ? rescheduleFrom.id : null, actor.id, now, now).lastInsertRowid;
  } catch (e) { throw translateDbError(e); }
  const booking = { id: Number(id), ref, date: slot.date, start_time: slot.start_time, end_time: slot.end_time };
  audit(db, actor, rescheduleFrom ? 'booking.reschedule' : 'booking.create', 'booking', id, {
    ref, student_id: student.id, mentor_id: slot.mentor_id, date: slot.date, start_time: slot.start_time,
    rescheduled_from: rescheduleFrom ? rescheduleFrom.id : undefined,
  });
  createNotification(db, {
    userId: student.user_id, bookingId: Number(id),
    type: rescheduleFrom ? 'rescheduled' : 'confirmed',
    title: rescheduleFrom ? 'Your mentor session was rescheduled' : 'Mentor session confirmed',
    body: `${rescheduleFrom ? 'New time' : 'Your session is booked'}: ${whenText(booking)}. Reference ${ref}.`,
  });
  return booking;
}

function liveBookingOwned(db, studentId, ref) {
  const b = db.prepare('SELECT * FROM bookings WHERE ref = ? AND student_id = ?').get(ref, studentId);
  if (!b) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  return b;
}

// ---------- student actions ----------
function pickSlot(db, date, start, preferMentorId) {
  return db.prepare(
    `SELECT a.id, a.mentor_id, a.date, a.start_time, a.end_time ${OPEN_SLOT_FROM} AND a.date = ? AND a.start_time = ?
     ORDER BY (a.mentor_id = ?) DESC,
              (SELECT COUNT(*) FROM bookings x WHERE x.mentor_id = a.mentor_id AND x.date = a.date AND x.status IN ${LIVE}) ASC,
              a.mentor_id ASC
     LIMIT 1`
  ).get(date, start, preferMentorId || 0);
}

function studentBook(db, { studentId, date, start_time, actor, rescheduleRef = null }) {
  if (!isValidDate(date) || !isValidSlotTime(start_time)) throw new HttpError(400, 'VALIDATION', 'Invalid date or time');
  return tx(db, () => {
    const settings = getSettings(db);
    const student = studentRow(db, studentId);
    if (student.status !== 'active' || student.user_status !== 'active') throw new HttpError(403, 'ACCOUNT_INACTIVE', 'Your account is not active.');

    const { minDate, maxDate } = bookableWindow(settings);
    if (date < minDate || date > maxDate) throw new HttpError(400, 'OUT_OF_WINDOW', `You can book up to ${settings.max_advance_days} days ahead.`);
    if (isPast(date, start_time)) throw new HttpError(400, 'PAST_SLOT', 'That time has already passed.');
    if (hoursUntil(date, start_time) < settings.min_notice_hours) throw new HttpError(400, 'TOO_SOON', 'That time is too soon to book.');

    let old = null;
    if (rescheduleRef) {
      old = liveBookingOwned(db, studentId, rescheduleRef);
      if (old.status !== 'confirmed') throw new HttpError(409, 'NOT_RESCHEDULABLE', 'Only confirmed bookings can be rescheduled.');
      if (!settings.allow_student_reschedule) throw new HttpError(403, 'RESCHEDULE_DISABLED', 'Rescheduling is not enabled.');
      if (hoursUntil(old.date, old.start_time) < settings.reschedule_deadline_hours) {
        throw new HttpError(403, 'DEADLINE_PASSED', `Sessions can only be rescheduled at least ${settings.reschedule_deadline_hours} hours before they start.`);
      }
      if (old.date === date && old.start_time === start_time) throw new HttpError(400, 'SAME_SLOT', 'Choose a different time.');
    } else if (settings.max_upcoming_bookings > 0) {
      const n = db.prepare(
        `SELECT COUNT(*) AS n FROM bookings WHERE student_id = ? AND status = 'confirmed' AND (date || 'T' || start_time) > ?`
      ).get(studentId, `${istNow().date}T${istNow().time}`).n;
      if (n >= settings.max_upcoming_bookings) {
        throw new HttpError(409, 'LIMIT_REACHED', `You can have at most ${settings.max_upcoming_bookings} upcoming sessions. Cancel one to book another.`);
      }
    }

    const slot = pickSlot(db, date, start_time, old ? old.mentor_id : null);
    if (!slot) throw new HttpError(409, 'SLOT_TAKEN', 'Sorry, that time slot is no longer available. Please choose another.');

    if (old) {
      db.prepare("UPDATE bookings SET status='rescheduled', updated_at=? WHERE id=?").run(nowIso(), old.id);
      audit(db, actor, 'booking.status', 'booking', old.id, { from: 'confirmed', to: 'rescheduled' });
    }
    return placeBooking(db, { student, slot, actor, rescheduleFrom: old });
  });
}

function studentCancel(db, { studentId, ref, actor }) {
  return tx(db, () => {
    const settings = getSettings(db);
    const b = liveBookingOwned(db, studentId, ref);
    if (b.status !== 'confirmed') throw new HttpError(409, 'NOT_CANCELLABLE', 'Only confirmed bookings can be cancelled.');
    if (!settings.allow_student_cancel) throw new HttpError(403, 'CANCEL_DISABLED', 'Cancellation is not enabled. Please contact your coordinator.');
    if (hoursUntil(b.date, b.start_time) < settings.cancel_deadline_hours) {
      throw new HttpError(403, 'DEADLINE_PASSED', `Sessions can only be cancelled at least ${settings.cancel_deadline_hours} hours before they start.`);
    }
    return doCancel(db, b, actor, 'student', null);
  });
}

function doCancel(db, b, actor, role, reason) {
  db.prepare("UPDATE bookings SET status='cancelled', cancelled_by_role=?, cancel_reason=?, updated_at=? WHERE id=?")
    .run(role, reason, nowIso(), b.id);
  audit(db, actor, 'booking.cancel', 'booking', b.id, { by: role, reason });
  const s = db.prepare('SELECT user_id FROM students WHERE id=?').get(b.student_id);
  createNotification(db, {
    userId: s.user_id, bookingId: b.id, type: 'cancelled', title: 'Mentor session cancelled',
    body: `The session on ${whenText(b)} was cancelled${role === 'admin' ? ' by the coordinator' : ''}. Reference ${b.ref}.`,
  });
  return { ref: b.ref, status: 'cancelled' };
}

// ---------- admin actions ----------
function adminCreate(db, { studentId, availabilityId, actor }) {
  return tx(db, () => {
    const student = studentRow(db, studentId);
    if (student.status !== 'active' || student.user_status !== 'active') throw new HttpError(400, 'ACCOUNT_INACTIVE', 'Student account is not active.');
    const slot = db.prepare(`SELECT a.id, a.mentor_id, a.date, a.start_time, a.end_time FROM availability a JOIN mentors m ON m.id=a.mentor_id AND m.status='active'
       WHERE a.id = ? AND a.status='open' AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.availability_id=a.id AND b.status IN ${LIVE})`).get(availabilityId);
    if (!slot) throw new HttpError(409, 'SLOT_UNAVAILABLE', 'That slot is not available (it may be booked, blocked, or the mentor is inactive).');
    return placeBooking(db, { student, slot, actor });
  });
}

function adminCancel(db, { id, reason, actor }) {
  return tx(db, () => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
    if (b.status !== 'confirmed') throw new HttpError(409, 'NOT_CANCELLABLE', 'Only confirmed bookings can be cancelled.');
    return doCancel(db, b, actor, 'admin', reason || null);
  });
}

function adminComplete(db, { id, actor }) {
  return tx(db, () => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
    if (b.status !== 'confirmed') throw new HttpError(409, 'NOT_COMPLETABLE', 'Only confirmed bookings can be marked completed.');
    db.prepare("UPDATE bookings SET status='completed', updated_at=? WHERE id=?").run(nowIso(), id);
    audit(db, actor, 'booking.complete', 'booking', id, { from: 'confirmed', to: 'completed' });
    return { id, status: 'completed' };
  });
}

// Moves a booking to another slot (a different time and/or a different mentor).
function adminReschedule(db, { id, availabilityId, actor }) {
  return tx(db, () => {
    const old = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!old) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
    if (old.status !== 'confirmed') throw new HttpError(409, 'NOT_RESCHEDULABLE', 'Only confirmed bookings can be rescheduled.');
    const slot = db.prepare(`SELECT a.id, a.mentor_id, a.date, a.start_time, a.end_time FROM availability a JOIN mentors m ON m.id=a.mentor_id AND m.status='active'
       WHERE a.id = ? AND a.status='open' AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.availability_id=a.id AND b.status IN ${LIVE})`).get(availabilityId);
    if (!slot) throw new HttpError(409, 'SLOT_UNAVAILABLE', 'That slot is not available.');
    if (slot.id === old.availability_id) throw new HttpError(400, 'SAME_SLOT', 'Choose a different slot.');
    const student = studentRow(db, old.student_id);
    db.prepare("UPDATE bookings SET status='rescheduled', updated_at=? WHERE id=?").run(nowIso(), old.id);
    audit(db, actor, 'booking.status', 'booking', old.id, { from: 'confirmed', to: 'rescheduled' });
    const sameTime = old.date === slot.date && old.start_time === slot.start_time;
    const nb = placeBooking(db, { student, slot, actor, rescheduleFrom: old });
    if (sameTime) {
      // mentor reassignment only: student-visible time is unchanged, so drop the (redundant) notification
      db.prepare("DELETE FROM notifications WHERE booking_id = ? AND type = 'rescheduled'").run(nb.id);
    }
    return nb;
  });
}

module.exports = {
  studentDates, studentSlots, studentBook, studentCancel,
  adminCreate, adminCancel, adminComplete, adminReschedule,
  longDate, t12, whenText, addMinutes,
};
