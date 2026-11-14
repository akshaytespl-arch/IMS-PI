'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const config = require('../config');
const { tx } = require('../db');
const { HttpError, nowIso, safeEqual, str, email, password } = require('../util');
const { createSession, destroySession, setSessionCookie, clearSessionCookie, requireAuth } = require('../security');
const { audit } = require('../audit');
const { getSettings } = require('../settings');

const BCRYPT_COST = 12;
// Used to equalise timing when the account does not exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

module.exports = function authRoutes(db) {
  const r = express.Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: config.loginRateMax, standardHeaders: true, legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' } },
  });

  const publicUser = (u) => ({ name: u.name, email: u.email, role: u.role, mustChangePassword: !!u.mustChangePassword });

  r.get('/public/config', (_req, res) => {
    const s = getSettings(db);
    res.json({ orgName: s.org_name, registrationMode: s.registration_mode });
  });

  r.post('/auth/login', limiter, async (req, res) => {
    const emailIn = email(req.body.email, 'Email');
    const pw = typeof req.body.password === 'string' ? req.body.password : '';
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(emailIn);
    const fail = () => new HttpError(401, 'BAD_CREDENTIALS', 'Incorrect email or password.');
    if (!u) { await bcrypt.compare(pw, DUMMY_HASH); throw fail(); }
    if (u.locked_until && Date.parse(u.locked_until) > Date.now()) {
      throw new HttpError(429, 'LOCKED', 'Too many failed attempts. Try again in a few minutes.');
    }
    const ok = await bcrypt.compare(pw, u.password_hash);
    if (!ok) {
      const fails = u.failed_logins + 1;
      db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
        .run(fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS).toISOString() : null, u.id);
      throw fail();
    }
    if (u.status !== 'active') throw new HttpError(403, 'DISABLED', 'This account has been disabled. Please contact the administrator.');
    if (u.role === 'student') {
      const s = db.prepare('SELECT status FROM students WHERE user_id = ?').get(u.id);
      if (!s || s.status !== 'active') throw new HttpError(403, 'DISABLED', 'This account has been disabled. Please contact the administrator.');
    }
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(nowIso(), u.id);
    // fresh session on every login (prevents session fixation)
    destroySession(db, req.sessionToken);
    const token = createSession(db, u.id, req);
    setSessionCookie(res, token);
    const sess = db.prepare('SELECT csrf_token FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(u.id);
    res.json({ user: publicUser({ ...u, mustChangePassword: u.must_change_password }), csrf: sess.csrf_token });
  });

  r.post('/auth/logout', (req, res) => {
    destroySession(db, req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user), csrf: req.session.csrf });
  });

  r.post('/auth/change-password', requireAuth, async (req, res) => {
    const cur = typeof req.body.current === 'string' ? req.body.current : '';
    const next = password(req.body.next, 'New password');
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await bcrypt.compare(cur, u.password_hash))) throw new HttpError(400, 'BAD_CURRENT_PASSWORD', 'Current password is incorrect.');
    if (cur === next) throw new HttpError(400, 'VALIDATION', 'Choose a password different from the current one.');
    const hash = await bcrypt.hash(next, BCRYPT_COST);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(req.user.id, req.session.id);
    audit(db, req.user, 'user.password_change', 'user', req.user.id, null);
    res.json({ ok: true });
  });

  // Self-registration (only when enabled by the admin in Settings).
  r.post('/auth/register', limiter, async (req, res) => {
    const s = getSettings(db);
    if (s.registration_mode === 'admin_only') throw new HttpError(403, 'REGISTRATION_CLOSED', 'Registration is closed. Please ask your coordinator for an account.');
    if (s.registration_mode === 'invite_code') {
      if (typeof req.body.code !== 'string' || !safeEqual(req.body.code.trim(), s.registration_code)) {
        throw new HttpError(403, 'BAD_CODE', 'Invalid invite code.');
      }
    }
    const name = str(req.body.name, 'Name', { required: true, max: 100 });
    const em = email(req.body.email, 'Email');
    const pw = password(req.body.password);
    const batch = str(req.body.batch, 'Batch', { max: 60 });
    const phone = str(req.body.phone, 'Phone', { max: 30 });
    const hash = await bcrypt.hash(pw, BCRYPT_COST);
    try {
      tx(db, () => {
        const uid = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?, 'student')").run(name, em, hash).lastInsertRowid;
        const sid = db.prepare('INSERT INTO students (user_id, batch, phone) VALUES (?,?,?)').run(uid, batch, phone).lastInsertRowid;
        audit(db, { id: uid, role: 'student', name }, 'student.register', 'student', sid, null);
      });
    } catch (e) {
      if (String(e.message).includes('UNIQUE constraint failed: users.email')) throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
      throw e;
    }
    res.status(201).json({ ok: true });
  });

  return r;
};

module.exports.BCRYPT_COST = BCRYPT_COST;
