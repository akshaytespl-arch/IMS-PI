'use strict';
// Everything in the app is expressed in Asia/Kolkata (IST, UTC+05:30, no DST).
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

function istNow() {
  const iso = new Date(Date.now() + IST_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidSlotTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):(00|30)$/.test(s);
}

function addMinutes(t, mins) {
  const [h, m] = t.split(':').map(Number);
  const total = h * 60 + m + mins;
  if (total >= 24 * 60) return null;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekday(date) { return new Date(`${date}T00:00:00Z`).getUTCDay(); } // 0=Sun

function slotStartMs(date, start) { return Date.parse(`${date}T${start}:00+05:30`); }
function isPast(date, start) { return slotStartMs(date, start) <= Date.now(); }
function hoursUntil(date, start) { return (slotStartMs(date, start) - Date.now()) / 3600000; }

module.exports = { istNow, isValidDate, isValidSlotTime, addMinutes, addDays, weekday, isPast, hoursUntil };
