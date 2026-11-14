'use strict';
const config = require('./config');
const { nowIso } = require('./util');
const { istNow } = require('./time');

// Notifications are always stored (shown in-app). Email delivery only happens when SMTP is
// configured; otherwise rows are marked 'not_configured' — we never claim an email was sent.
// SECURITY: callers must never put mentor identity in title/body (they go to students).

function createNotification(db, { userId, bookingId = null, type, title, body }) {
  db.prepare(
    'INSERT INTO notifications (user_id, booking_id, type, title, body, email_status, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(userId, bookingId, type, title, body, config.emailConfigured ? 'queued' : 'not_configured', nowIso());
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

async function sendQueuedEmails(db) {
  if (!config.emailConfigured) return { sent: 0, failed: 0 };
  const rows = db.prepare(
    `SELECT n.id, n.title, n.body, u.email FROM notifications n JOIN users u ON u.id = n.user_id
     WHERE n.email_status = 'queued' ORDER BY n.id LIMIT 50`
  ).all();
  let sent = 0, failed = 0;
  for (const r of rows) {
    try {
      await getTransporter().sendMail({ from: config.smtp.from, to: r.email, subject: r.title, text: r.body });
      db.prepare("UPDATE notifications SET email_status='sent', email_error=NULL WHERE id=?").run(r.id);
      sent++;
    } catch (e) {
      db.prepare("UPDATE notifications SET email_status='failed', email_error=? WHERE id=?").run(String(e.message).slice(0, 300), r.id);
      failed++;
    }
  }
  return { sent, failed };
}

// Creates a reminder for confirmed bookings that start within `hours`. Idempotent via reminder_sent_at.
function scanReminders(db, hours) {
  const now = istNow();
  const rows = db.prepare(
    `SELECT b.id, b.date, b.start_time, b.end_time, s.user_id FROM bookings b JOIN students s ON s.id = b.student_id
     WHERE b.status='confirmed' AND b.reminder_sent_at IS NULL AND b.date >= ? AND b.date <= ?`
  ).all(now.date, require('./time').addDays(now.date, Math.ceil(hours / 24) + 1));
  const { hoursUntil } = require('./time');
  let n = 0;
  for (const b of rows) {
    const h = hoursUntil(b.date, b.start_time);
    if (h > 0 && h <= hours) {
      createNotification(db, {
        userId: b.user_id, bookingId: b.id, type: 'reminder',
        title: 'Reminder: mentor session coming up',
        body: `Your session is on ${b.date} from ${b.start_time} to ${b.end_time} (IST).`,
      });
      db.prepare('UPDATE bookings SET reminder_sent_at=? WHERE id=?').run(nowIso(), b.id);
      n++;
    }
  }
  return n;
}

module.exports = { createNotification, sendQueuedEmails, scanReminders };
