'use strict';
// Demo data for local development. Refuses to run in production.
//   npm run seed
// Creates 4 demo mentors, 6 demo students, 14 days of weekday availability and a few bookings.
// Demo students share ONE random password generated on each run and printed to the console.
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const { openDb, migrate } = require('../src/db');
const { generatePassword, newBookingRef } = require('../src/util');
const { istNow, addDays, weekday, addMinutes } = require('../src/time');

if (config.env === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'yes') {
  console.error('Refusing to seed demo data in production (set SEED_ALLOW_PRODUCTION=yes to override).');
  process.exit(1);
}

(async () => {
  const db = openDb(config.dbPath);
  migrate(db);
  if (db.prepare("SELECT COUNT(*) n FROM users WHERE email LIKE '%@demo.example'").get().n > 0) {
    console.log('Demo data already present. Delete the database file to start over.');
    return;
  }
  const pw = generatePassword();
  const hash = await bcrypt.hash(pw, 12);

  const mentors = [
    ['Dr. Anita Rao', 'anita.rao@demo.example'], ['Vikram Shah', 'vikram.shah@demo.example'],
    ['Meera Iyer', 'meera.iyer@demo.example'], ['Rohan Desai', 'rohan.desai@demo.example'],
  ].map(([n, e]) => Number(db.prepare('INSERT INTO mentors (name, email) VALUES (?,?)').run(n, e).lastInsertRowid));

  const students = [
    ['Aarav Patel', 'aarav@demo.example', 'S-1001', 'Batch A'], ['Diya Mehta', 'diya@demo.example', 'S-1002', 'Batch A'],
    ['Kabir Joshi', 'kabir@demo.example', 'S-1003', 'Batch B'], ['Ishita Nair', 'ishita@demo.example', 'S-1004', 'Batch B'],
    ['Neel Trivedi', 'neel@demo.example', 'S-1005', 'Batch C'], ['Saanvi Gupta', 'saanvi@demo.example', 'S-1006', 'Batch C'],
  ].map(([n, e, c, b]) => {
    const uid = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?, 'student')").run(n, e, hash).lastInsertRowid;
    return Number(db.prepare('INSERT INTO students (user_id, student_code, batch) VALUES (?,?,?)').run(uid, c, b).lastInsertRowid);
  });

  const now = istNow();
  const ins = db.prepare('INSERT OR IGNORE INTO availability (mentor_id, date, start_time, end_time) VALUES (?,?,?,?)');
  const windows = [['10:00', '13:00'], ['11:00', '14:00'], ['15:00', '18:00'], ['10:00', '12:00']];
  for (let i = 1; i <= 14; i++) {
    const d = addDays(now.date, i);
    const wd = weekday(d);
    if (wd === 0 || wd === 6) continue;
    mentors.forEach((mid, k) => {
      if ((i + k) % 4 === 3) return; // some gaps
      for (let t = windows[k][0]; t < windows[k][1]; t = addMinutes(t, 30)) ins.run(mid, d, t, addMinutes(t, 30));
    });
  }
  // a few bookings
  const pick = db.prepare(
    `SELECT a.id, a.mentor_id, a.date, a.start_time, a.end_time FROM availability a
     WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.availability_id = a.id) ORDER BY a.date, a.start_time, a.mentor_id LIMIT 1 OFFSET ?`
  );
  [0, 7, 15].forEach((off, i) => {
    const s = pick.get(off);
    if (!s) return;
    db.prepare(`INSERT INTO bookings (ref, student_id, mentor_id, availability_id, date, start_time, end_time) VALUES (?,?,?,?,?,?,?)`)
      .run(newBookingRef(), students[i], s.mentor_id, s.id, s.date, s.start_time, s.end_time);
  });

  console.log('\nDemo data created (4 mentors, 6 students, ~2 weeks of availability, 3 bookings).');
  console.log('Demo student logins: aarav@demo.example, diya@demo.example, kabir@demo.example, ishita@demo.example, neel@demo.example, saanvi@demo.example');
  console.log(`Demo student password (this run only): ${pw}\n`);
  db.close();
})().catch((e) => { console.error(e); process.exit(1); });
