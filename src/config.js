'use strict';
const path = require('node:path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env file: use real environment */ }

const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'booking.db'),
  // Set to true when served over HTTPS (always true in production unless overridden).
  cookieSecure: bool(process.env.COOKIE_SECURE, (process.env.NODE_ENV || '') === 'production'),
  trustProxy: process.env.TRUST_PROXY || '',   // e.g. "1" when behind nginx / a PaaS router
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 120),
  loginRateMax: Number(process.env.LOGIN_RATE_MAX || 20),   // per IP per 15 min
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  },
};
config.emailConfigured = Boolean(config.smtp.host && config.smtp.from);

module.exports = config;
