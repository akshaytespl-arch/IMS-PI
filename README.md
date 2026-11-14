# Student–Mentor Booking

A small, secure web app where **students book 30‑minute sessions without ever seeing who the mentor is**, and **admins manage everything** (mentors, students, availability, bookings, exports, settings).
All times are **Asia/Kolkata (IST)**.

Stack: Node.js ≥ 22.13 · Express · SQLite (built-in `node:sqlite`) · plain HTML/CSS/JS (no build step).

## Quick start (local)

```bash
npm install
cp .env.example .env                  # optional
npm run init-admin                    # prompts for name/email, prints a one-time password
npm run seed                          # optional: demo mentors, students, availability (dev only)
npm start                             # http://localhost:3000
```

* There is **no default admin password anywhere**. `init-admin` creates the first admin (generated password shown once, change forced at first login). Re-run it to reset an admin.
* `npm test` runs the acceptance + security test suite (real HTTP, temporary database).
* `npm run migrate` applies schema migrations (also applied automatically at startup).

## How the "mentor stays hidden" rule is enforced

1. **Students never choose a mentor.** They pick a date and a time; the server assigns any free mentor for that time (preferring the least‑booked mentor).
2. **Separate APIs.** `/api/student/*` queries never select any mentor column; response shapes are whitelisted. Students get an opaque booking reference, not numeric ids.
3. **Separate code.** `/assets/admin.js` and `/admin` are only served to admins (403 for students, redirect for anonymous). Student code contains no mentor fields.
4. **Notifications and emails** to students never include mentor details.
5. Tests (`AT2`) crawl every student endpoint, page and script and fail if any mentor name, email or note appears.

## Double-booking protection

Enforced in the database, not just the app:

* `UNIQUE` partial index: one live booking per availability slot.
* `UNIQUE` partial index: one live booking per mentor per start time, and per student per start time.
* Trigger rejects any overlapping booking for the same mentor, and any booking that doesn't match an open slot.
* Bookings run inside `BEGIN IMMEDIATE` transactions, so simultaneous clicks are serialised (test: 25 students racing for one slot → exactly 1 wins).

## Admin features

Dashboard · Schedule (day by day) · Bookings (search, filters, detail + history, create, reschedule/reassign mentor, complete, cancel, notes) · Availability (single date / range / weekday recurrence, close or reopen a date, bulk block/delete) · Mentors · Students (add, edit, reset password, deactivate, delete) · Reports & CSV export · Audit log · Settings (registration mode, booking window, cancel/reschedule rules, per‑student limit, reminders).

Deleting is blocked for anyone with booking history; deactivate instead. Deactivating a mentor hides their free slots and warns about their upcoming bookings.

## Configuration (`.env`)

See `.env.example`. Key variables: `PORT`, `DB_PATH`, `COOKIE_SECURE` (true on HTTPS), `TRUST_PROXY` (e.g. `1` behind a proxy), `SMTP_*`.

**Email is optional.** Without `SMTP_HOST`/`SMTP_FROM`, confirmations and reminders appear in the student's in‑app *Updates* list only, and the admin settings page says so. Nothing pretends an email was sent.

## Deploying

1. Any host that runs Node ≥ 22.13 with a **persistent disk** (SQLite file at `DB_PATH`). Examples: a VPS, Render/Railway/Fly with a volume.
2. Set `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`, `DB_PATH=/data/booking.db`. Serve over **HTTPS** (reverse proxy such as nginx/Caddy, or the platform's TLS).
3. `npm ci --omit=dev && npm run init-admin && npm start`.
4. Back up the database file (copy it while idle, or use `sqlite3 booking.db ".backup out.db"`).
5. Run **one** app instance (SQLite is single‑writer). For multiple instances, move to PostgreSQL.

Do not run `npm run seed` in production (it refuses unless forced).

## Security summary

bcrypt password hashing (cost 12) · opaque server‑side sessions, HttpOnly + SameSite=Lax (+Secure on HTTPS), idle and absolute expiry, rotated on login · CSRF token + Origin check + JSON‑only bodies · login rate limiting and account lockout (5 failures → 15 min) · parameterised SQL only · output escaping in the UI · strict CSP (no inline scripts/styles), Helmet headers · role checks on every API route · CSV export neutralises spreadsheet formulas · errors never leak internals · full audit log.

## Layout

```
migrations/   SQL schema      src/        server, auth, booking engine
private/      role-gated UI   public/     login, shared CSS/JS, error pages
scripts/      init-admin, seed   tests/   acceptance + security tests
```

## Known limits

* Password reset is admin‑initiated (no self‑service email reset), by design for a closed student group.
* Reminders are created by a 5‑minute in‑process job; they only run while the server is up.
* Slots are fixed at 30 minutes.
