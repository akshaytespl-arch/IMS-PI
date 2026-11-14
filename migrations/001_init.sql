-- Student–Mentor Booking: initial schema
-- All dates are 'YYYY-MM-DD' and all times 'HH:MM' in Asia/Kolkata (IST).
-- All *_at timestamps are ISO-8601 UTC.

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email                TEXT    NOT NULL UNIQUE COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 254),
  password_hash        TEXT    NOT NULL,
  role                 TEXT    NOT NULL CHECK (role IN ('admin','student')),
  status               TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE students (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  student_code TEXT UNIQUE COLLATE NOCASE,
  batch        TEXT,
  phone        TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ix_students_batch ON students(batch);

CREATE TABLE mentors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email      TEXT,
  phone      TEXT,
  notes      TEXT,   -- internal only
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row = one 30-minute slot offered by one mentor.
CREATE TABLE availability (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mentor_id    INTEGER NOT NULL REFERENCES mentors(id) ON DELETE CASCADE,
  date         TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_time   TEXT    NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[03]0'),
  end_time     TEXT    NOT NULL CHECK (end_time   GLOB '[0-2][0-9]:[03]0'),
  slot_minutes INTEGER NOT NULL DEFAULT 30 CHECK (slot_minutes = 30),
  status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','blocked')),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (end_time > start_time),
  -- a mentor can only have one slot per start time => no overlapping slots per mentor
  UNIQUE (mentor_id, date, start_time)
);
CREATE INDEX ix_availability_date ON availability(date, start_time, status);

CREATE TABLE bookings (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  ref                  TEXT    NOT NULL UNIQUE,            -- public, unguessable reference shown to students
  student_id           INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  mentor_id            INTEGER NOT NULL REFERENCES mentors(id)  ON DELETE RESTRICT,
  availability_id      INTEGER REFERENCES availability(id) ON DELETE SET NULL,
  date                 TEXT    NOT NULL,
  start_time           TEXT    NOT NULL,
  end_time             TEXT    NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'confirmed'
                               CHECK (status IN ('confirmed','cancelled','completed','rescheduled')),
  rescheduled_from_id  INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  admin_notes          TEXT,
  created_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by_role    TEXT CHECK (cancelled_by_role IN ('admin','student')),
  cancel_reason        TEXT,
  reminder_sent_at     TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (end_time > start_time)
);
CREATE INDEX ix_bookings_student ON bookings(student_id, date, start_time);
CREATE INDEX ix_bookings_mentor  ON bookings(mentor_id, date, start_time);
CREATE INDEX ix_bookings_date    ON bookings(date, start_time);
CREATE INDEX ix_bookings_status  ON bookings(status);

-- Hard guarantees (enforced by the database, independent of application code):
--  1. a slot can hold only one live booking
CREATE UNIQUE INDEX ux_booking_slot ON bookings(availability_id)
  WHERE status IN ('confirmed','completed') AND availability_id IS NOT NULL;
--  2. a mentor cannot have two live bookings that start at the same time
CREATE UNIQUE INDEX ux_booking_mentor_time ON bookings(mentor_id, date, start_time)
  WHERE status IN ('confirmed','completed');
--  3. a student cannot hold two live bookings at the same time
CREATE UNIQUE INDEX ux_booking_student_time ON bookings(student_id, date, start_time)
  WHERE status IN ('confirmed','completed');

--  4. a mentor cannot have overlapping live bookings (belt and braces on top of 2)
CREATE TRIGGER trg_booking_no_mentor_overlap
BEFORE INSERT ON bookings
WHEN NEW.status IN ('confirmed','completed')
BEGIN
  SELECT RAISE(ABORT, 'MENTOR_OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.mentor_id = NEW.mentor_id AND b.date = NEW.date
      AND b.status IN ('confirmed','completed')
      AND b.start_time < NEW.end_time AND b.end_time > NEW.start_time
  );
END;

--  5. a booking must match an open availability slot of the same mentor
CREATE TRIGGER trg_booking_matches_slot
BEFORE INSERT ON bookings
WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'SLOT_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1 FROM availability a
    WHERE a.id = NEW.availability_id AND a.mentor_id = NEW.mentor_id
      AND a.date = NEW.date AND a.start_time = NEW.start_time
      AND a.end_time = NEW.end_time AND a.status = 'open'
  );
END;

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role    TEXT,
  actor_name    TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  details       TEXT,           -- JSON
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX ix_audit_created ON audit_log(created_at);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,  -- sha256 of the opaque cookie token
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX ix_sessions_user ON sessions(user_id);

-- In-app notifications double as the outbox for email.
-- NOTE: bodies must never contain mentor identity (they are sent to students).
CREATE TABLE notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id   INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  email_status TEXT NOT NULL DEFAULT 'not_configured'
               CHECK (email_status IN ('not_configured','queued','sent','failed')),
  email_error  TEXT,
  read_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ix_notifications_user ON notifications(user_id, created_at);
CREATE INDEX ix_notifications_email ON notifications(email_status);
