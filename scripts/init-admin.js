'use strict';
// Creates (or resets) an admin account. Usage:
//   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" npm run init-admin
// - If ADMIN_PASSWORD is not provided, a strong random password is generated and printed ONCE.
// - The admin must change the password at first login.
// - Nothing is hardcoded; there is no default admin password anywhere in this project.
const readline = require('node:readline/promises');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const { openDb, migrate } = require('../src/db');
const { generatePassword, email: vEmail, password: vPassword, str } = require('../src/util');
const { audit } = require('../src/audit');

(async () => {
  const db = openDb(config.dbPath);
  migrate(db);
  let em = process.env.ADMIN_EMAIL;
  let name = process.env.ADMIN_NAME;
  if (!em || !name) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    name = name || (await rl.question('Admin name: '));
    em = em || (await rl.question('Admin email: '));
    rl.close();
  }
  em = vEmail(em);
  name = str(name, 'Name', { required: true, max: 100 });
  let pw = process.env.ADMIN_PASSWORD;
  const generated = !pw;
  pw = pw ? vPassword(pw) : generatePassword();
  const hash = await bcrypt.hash(pw, 12);
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  if (existing && existing.role !== 'admin') {
    console.error('A non-admin user with this email already exists. Use a different email.');
    process.exit(1);
  }
  if (existing) {
    db.prepare('UPDATE users SET name=?, password_hash=?, must_change_password=1, status=?, failed_logins=0, locked_until=NULL WHERE id=?').run(name, hash, 'active', existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    audit(db, null, 'admin.reset', 'user', existing.id, { via: 'cli' });
  } else {
    const id = db.prepare("INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?,?,?, 'admin', 1)").run(name, em, hash).lastInsertRowid;
    audit(db, null, 'admin.create', 'user', id, { via: 'cli' });
  }
  console.log(`\nAdmin ready: ${em}`);
  if (generated) console.log(`Temporary password (shown once, change it at first login): ${pw}\n`);
  else console.log('Password set from ADMIN_PASSWORD (you will be asked to change it at first login).\n');
  db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
