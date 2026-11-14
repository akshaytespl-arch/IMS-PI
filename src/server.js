'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const { HttpError, nowIso } = require('./util');
const { sessionLoader, csrfGuard } = require('./security');
const { scanReminders, sendQueuedEmails } = require('./notify');
const { getSettings } = require('./settings');

const PUBLIC = path.join(__dirname, '..', 'public');
const PRIVATE = path.join(__dirname, '..', 'private');

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
      },
    },
    strictTransportSecurity: config.cookieSecure,
    crossOriginEmbedderPolicy: false,
  }));

  app.use(sessionLoader(db));

  // ------------------------------------------------------------------ API
  const api = express.Router();
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(express.json({ limit: '100kb' }));
  api.use(csrfGuard);
  api.use((req, _res, next) => { if (req.body === undefined) req.body = {}; next(); });
  api.use(require('./routes/auth')(db));
  api.use('/student', require('./routes/student')(db));
  api.use('/admin', require('./routes/admin')(db));
  api.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Not found')));
  app.use('/api', api);

  // ------------------------------------------------------------------ pages
  const send = (res, dir, file, status = 200) => {
    res.status(status).setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(dir, file));
  };
  const home = (u) => (u.role === 'admin' ? '/admin' : '/app');

  app.get('/', (req, res) => (req.user ? res.redirect(home(req.user)) : res.redirect('/login')));
  app.get(['/login', '/login.html'], (req, res) => (req.user ? res.redirect(home(req.user)) : send(res, PUBLIC, 'login.html')));
  app.get('/register', (req, res) => (req.user ? res.redirect(home(req.user)) : send(res, PUBLIC, 'register.html')));

  // Role-gated pages and scripts: the HTML and JS for a role are never served to other roles.
  function gate(role, dir, file, isScript) {
    return (req, res) => {
      if (!req.user) {
        if (isScript) return res.status(401).end();
        return res.redirect('/login');
      }
      if (req.user.role !== role) {
        if (isScript) return res.status(403).end();
        return send(res, PUBLIC, '403.html', 403);
      }
      return send(res, dir, file);
    };
  }
  app.get(['/app', '/app/'], gate('student', PRIVATE, 'student.html'));
  app.get(['/admin', '/admin/'], gate('admin', PRIVATE, 'admin.html'));
  app.get('/assets/student.js', gate('student', PRIVATE, 'student.js', true));
  app.get('/assets/admin.js', gate('admin', PRIVATE, 'admin.js', true));
  app.get('/app/*splat', (_req, res) => res.redirect('/app'));
  app.get('/admin/*splat', (_req, res) => res.redirect('/admin'));

  app.use(express.static(PUBLIC, { index: false, maxAge: 0, extensions: [] }));

  // ------------------------------------------------------------------ 404 / errors
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    return send(res, PUBLIC, '404.html', 404);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = 500, code = 'SERVER_ERROR', message = 'Something went wrong. Please try again.';
    if (err instanceof HttpError) { status = err.status; code = err.code; message = err.message; }
    else if (err && err.type === 'entity.parse.failed') { status = 400; code = 'BAD_JSON'; message = 'Malformed request body.'; }
    else if (err && err.type === 'entity.too.large') { status = 413; code = 'TOO_LARGE'; message = 'Request too large.'; }
    else if (err && err.status === 429) { status = 429; code = 'RATE_LIMITED'; message = 'Too many requests. Please slow down.'; }
    else {
      // log server-side only; never leak internals (or personal data) to the client
      console.error(`[${nowIso()}] ${req.method} ${req.path} -> ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
    }
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: { code, message } });
    return send(res, PUBLIC, status === 404 ? '404.html' : '403.html', status);
  });

  return app;
}

function startBackgroundJobs(db) {
  const tick = async () => {
    try {
      scanReminders(db, getSettings(db).reminder_hours_before);
      await sendQueuedEmails(db);
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
    } catch (e) { console.error('background job failed:', e.message); }
  };
  tick();
  const t = setInterval(tick, 5 * 60 * 1000);
  t.unref();
  return t;
}

module.exports = { createApp, startBackgroundJobs };
