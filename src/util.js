'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const nowIso = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Unambiguous alphabet (no 0/O/1/I) for public booking references and generated passwords.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
const newBookingRef = () => `BK-${randomCode(8)}`;
function generatePassword() {
  return `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`.toLowerCase().replace(/^./, (c) => c.toUpperCase()) + '7';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---- input validation helpers (throw 400) ----
function str(v, field, { min = 0, max = 200, required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, 'VALIDATION', `${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new HttpError(400, 'VALIDATION', `${field} must be text`);
  const t = v.trim();
  if (required && t.length === 0) throw new HttpError(400, 'VALIDATION', `${field} is required`);
  if (t.length < min) throw new HttpError(400, 'VALIDATION', `${field} must be at least ${min} characters`);
  if (t.length > max) throw new HttpError(400, 'VALIDATION', `${field} must be at most ${max} characters`);
  return t.length ? t : null;
}
function email(v, field = 'Email', required = true) {
  const t = str(v, field, { max: 254, required });
  if (t === null) return null;
  if (!EMAIL_RE.test(t)) throw new HttpError(400, 'VALIDATION', `${field} is not a valid email address`);
  return t.toLowerCase();
}
function intId(v, field = 'id', required = true) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, 'VALIDATION', `${field} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'VALIDATION', `${field} is invalid`);
  return n;
}
function oneOf(v, allowed, field, required = true) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, 'VALIDATION', `${field} is required`);
    return null;
  }
  if (!allowed.includes(v)) throw new HttpError(400, 'VALIDATION', `${field} must be one of: ${allowed.join(', ')}`);
  return v;
}
function password(v, field = 'Password') {
  if (typeof v !== 'string') throw new HttpError(400, 'VALIDATION', `${field} is required`);
  if (v.length < 8) throw new HttpError(400, 'VALIDATION', `${field} must be at least 8 characters`);
  if (v.length > 200) throw new HttpError(400, 'VALIDATION', `${field} is too long`);
  return v;
}

module.exports = { HttpError, nowIso, sha256, randomToken, safeEqual, randomCode, newBookingRef, generatePassword, str, email, intId, oneOf, password };
