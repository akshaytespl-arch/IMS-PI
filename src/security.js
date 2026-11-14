'use strict';
const config = require('./config');
const { HttpError, sha256, randomToken, safeEqual, nowIso } = require('./util');

const COOKIE = 'sid';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionHours * 3600 * 1000,
  });
}
function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
}

function createSession(db, userId, req) {
  const token = randomToken(32);
  const now = new Date();
  db.prepare(
    'INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    sha256(token), userId, randomToken(24), now.toISOString(), now.toISOString(),
    new Date(now.getTime() + config.sessionHours * 3600 * 1000).toISOString(),
    req.ip || null, String(req.get('user-agent') || '').slice(0, 200)
  );
  return token;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
}

// Loads req.user / req.session when a valid cookie is present. Never throws for anonymous requests.
function sessionLoader(db) {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.sessionToken = token || null;
    req.user = null;
    req.session = null;
    if (!token) return next();
    const row = db.prepare(
      `SELECT s.id AS sid, s.csrf_token, s.last_seen_at, s.expires_at,
              u.id, u.name, u.email, u.role, u.status, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
    ).get(sha256(token));
    if (!row) return next();
    const now = Date.now();
    const idleMs = config.sessionIdleMinutes * 60 * 1000;
    if (row.status !== 'active' || Date.parse(row.expires_at) <= now || now - Date.parse(row.last_seen_at) > idleMs) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(row.sid);
      return next();
    }
    // touch at most once a minute
    if (now - Date.parse(row.last_seen_at) > 60000) {
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.sid);
    }
    req.session = { id: row.sid, csrf: row.csrf_token };
    req.user = { id: row.id, name: row.name, email: row.email, role: row.role, mustChangePassword: !!row.must_change_password };
    next();
  };
}

// CSRF defence for state-changing requests (defence in depth, all three apply):
//  1. Origin/Referer host must match Host when the browser sends one
//  2. body must be JSON (cross-site forms cannot send application/json without a CORS preflight)
//  3. authenticated requests must carry the per-session token in X-CSRF-Token
function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.get('host')) return next(new HttpError(403, 'CSRF', 'Cross-site request blocked'));
  }
  // Requests that carry a body must be JSON. Bodiless requests (e.g. DELETE) rely on the custom
  // X-CSRF-Token header below, which a cross-site page cannot send without a CORS preflight.
  const hasBody = Number(req.get('content-length') || 0) > 0 || Boolean(req.get('transfer-encoding'));
  const ct = req.get('content-type') || '';
  if (hasBody && !ct.toLowerCase().startsWith('application/json')) return next(new HttpError(415, 'BAD_CONTENT_TYPE', 'Content-Type must be application/json'));
  if (req.session) {
    const sent = req.get('x-csrf-token');
    if (!sent || !safeEqual(sent, req.session.csrf)) return next(new HttpError(403, 'CSRF', 'Missing or invalid CSRF token'));
  }
  next();
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.'));
  next();
}

const PW_EXEMPT = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/change-password']);
function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.'));
    if (req.user.role !== role) return next(new HttpError(403, 'FORBIDDEN', 'You do not have access to this resource.'));
    if (req.user.mustChangePassword && !PW_EXEMPT.has(req.originalUrl.split('?')[0])) {
      return next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Please change your password before continuing.'));
    }
    next();
  };
}

module.exports = {
  COOKIE, parseCookies, setSessionCookie, clearSessionCookie, createSession, destroySession,
  sessionLoader, csrfGuard, requireAuth, requireRole,
};
