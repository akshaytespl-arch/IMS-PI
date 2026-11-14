'use strict';
const { HttpError } = require('./util');

// Admin-configurable behaviour. Nothing here is hardcoded in the booking logic.
const DEFAULTS = {
  org_name: 'Mentor Sessions',
  registration_mode: 'admin_only',   // admin_only | invite_code | open
  registration_code: '',
  allow_student_cancel: true,
  cancel_deadline_hours: 24,         // students may cancel only if the session is at least this far away
  allow_student_reschedule: true,
  reschedule_deadline_hours: 24,
  max_advance_days: 60,              // how far ahead students can book
  min_notice_hours: 1,               // earliest bookable time from "now"
  max_upcoming_bookings: 3,          // per student, 0 = unlimited
  reminder_hours_before: 24,
};

const RULES = {
  org_name: (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 60 && v.trim(),
  registration_mode: (v) => ['admin_only', 'invite_code', 'open'].includes(v) && v,
  registration_code: (v) => typeof v === 'string' && v.length <= 64 && v.trim(),
  allow_student_cancel: (v) => typeof v === 'boolean' && v,
  allow_student_reschedule: (v) => typeof v === 'boolean' && v,
  cancel_deadline_hours: (v) => Number.isInteger(v) && v >= 0 && v <= 720 && v,
  reschedule_deadline_hours: (v) => Number.isInteger(v) && v >= 0 && v <= 720 && v,
  max_advance_days: (v) => Number.isInteger(v) && v >= 1 && v <= 365 && v,
  min_notice_hours: (v) => Number.isInteger(v) && v >= 0 && v <= 168 && v,
  max_upcoming_bookings: (v) => Number.isInteger(v) && v >= 0 && v <= 100 && v,
  reminder_hours_before: (v) => Number.isInteger(v) && v >= 1 && v <= 168 && v,
};

function getSettings(db) {
  const out = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (r.key in DEFAULTS) {
      try { out[r.key] = JSON.parse(r.value); } catch { /* keep default */ }
    }
  }
  return out;
}

function updateSettings(db, patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) throw new HttpError(400, 'VALIDATION', `Unknown setting: ${k}`);
    const ok = RULES[k](v);
    // booleans may legitimately be false / numbers 0
    if (ok === false && typeof v !== 'boolean') throw new HttpError(400, 'VALIDATION', `Invalid value for ${k}`);
    if (typeof DEFAULTS[k] === 'boolean' && typeof v !== 'boolean') throw new HttpError(400, 'VALIDATION', `Invalid value for ${k}`);
    if (typeof DEFAULTS[k] === 'number' && !Number.isInteger(v)) throw new HttpError(400, 'VALIDATION', `Invalid value for ${k}`);
    clean[k] = typeof v === 'string' ? v.trim() : v;
  }
  const merged = { ...getSettings(db), ...clean };
  if (merged.registration_mode === 'invite_code' && !merged.registration_code) {
    throw new HttpError(400, 'VALIDATION', 'An invite code is required when registration mode is "invite_code"');
  }
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(clean)) up.run(k, JSON.stringify(v));
  return getSettings(db);
}

module.exports = { DEFAULTS, getSettings, updateSettings };
