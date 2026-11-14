'use strict';
const config = require('./config');
const { openDb, migrate } = require('./db');
const { createApp, startBackgroundJobs } = require('./server');

const db = openDb(config.dbPath);
const applied = migrate(db);
if (applied.length) console.log('Applied migrations:', applied.join(', '));

const adminCount = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n;
if (adminCount === 0) {
  console.warn('\n  No admin account exists yet. Create one with:  npm run init-admin\n');
}
if (config.env === 'production' && !config.cookieSecure) {
  console.warn('  WARNING: COOKIE_SECURE is off in production. Serve over HTTPS and set COOKIE_SECURE=true.');
}
if (!config.emailConfigured) {
  console.warn('  Email is NOT configured (SMTP_* unset): notifications appear in-app only.');
}

startBackgroundJobs(db);
const app = createApp(db);
const server = app.listen(config.port, () => {
  console.log(`Mentor booking running on http://localhost:${config.port}  (${config.env}, timezone Asia/Kolkata)`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
