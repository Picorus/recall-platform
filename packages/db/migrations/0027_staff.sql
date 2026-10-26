-- P3.1: RECALL staff, their sign-in and their sessions. Everything append-only: a member's access is
-- their newest access row, their password and two-step secret their newest credentials row; a
-- session ends by an end row; idle time is read from "seen" rows (at most one a minute).
CREATE TABLE staff (
  id       text        PRIMARY KEY CHECK (id ~ '^STF-[0-9a-f]{12}$'),
  email    text        NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  name     text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  added_at timestamptz NOT NULL,
  added_by text        NOT NULL CHECK (length(added_by) BETWEEN 1 AND 80)
);

-- Who may do what, and every change to it (who, when, why; before is the previous row).
CREATE TABLE staff_access (
  id       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id text        NOT NULL REFERENCES staff (id),
  role     text        NOT NULL CHECK (role IN ('super-admin', 'admin', 'read-only')),
  areas    text[]      NOT NULL CHECK (areas <@ ARRAY['sales', 'ad-review', 'operations', 'finance', 'support']),
  active   boolean     NOT NULL,
  at       timestamptz NOT NULL,
  by       text        NOT NULL CHECK (length(by) BETWEEN 1 AND 80),
  reason   text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 200)
);
CREATE INDEX staff_access_latest ON staff_access (staff_id, id DESC);

-- An invite to set a password and the two-step code (new staff, or after a reset). Only the
-- token's hash is kept; the two-step secret is kept encrypted.
CREATE TABLE staff_invites (
  n           bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  token_hash  text        PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  staff_id    text        NOT NULL REFERENCES staff (id),
  totp_secret text        NOT NULL,
  made_at     timestamptz NOT NULL,
  until       timestamptz NOT NULL CHECK (until > made_at),
  by          text        NOT NULL CHECK (length(by) BETWEEN 1 AND 80)
);
CREATE INDEX staff_invites_staff ON staff_invites (staff_id, n DESC);

-- The password (scrypt) and two-step secret (encrypted) a member set from an invite.
CREATE TABLE staff_credentials (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id      text        NOT NULL REFERENCES staff (id),
  invite_hash   text        NOT NULL UNIQUE REFERENCES staff_invites (token_hash),
  password_hash text        NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  totp_secret   text        NOT NULL,
  -- The two-step step of the code that confirmed it: that code cannot then sign in.
  totp_step     bigint      NOT NULL,
  at            timestamptz NOT NULL
);
CREATE INDEX staff_credentials_latest ON staff_credentials (staff_id, id DESC);

-- Every sign-in try, right or wrong. `totp_step` of a successful one stops the same code being used
-- twice. `ip` is the caller's address (IPv6 by its /64 network): wrong tries lock an email from that
-- address only, so nobody can keep a member out from elsewhere.
CREATE TABLE staff_sign_ins (
  id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email     text        NOT NULL CHECK (length(email) <= 254),
  staff_id  text        REFERENCES staff (id),
  ok        boolean     NOT NULL,
  why       text        NOT NULL CHECK (length(why) <= 80),
  totp_step bigint,
  ip        text        NOT NULL CHECK (length(ip) <= 64),
  at        timestamptz NOT NULL
);
CREATE INDEX staff_sign_ins_staff ON staff_sign_ins (staff_id, id DESC);
CREATE INDEX staff_sign_ins_email ON staff_sign_ins (email, ip, id DESC);
CREATE INDEX staff_sign_ins_ip ON staff_sign_ins (ip, at DESC);

CREATE TABLE staff_sessions (
  token_hash text        PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  staff_id   text        NOT NULL REFERENCES staff (id),
  started_at timestamptz NOT NULL,
  ip         text        NOT NULL CHECK (length(ip) <= 64),
  agent      text        NOT NULL CHECK (length(agent) <= 300)
);
CREATE INDEX staff_sessions_staff ON staff_sessions (staff_id);

CREATE TABLE staff_session_seen (
  token_hash text        NOT NULL REFERENCES staff_sessions (token_hash),
  at         timestamptz NOT NULL,
  PRIMARY KEY (token_hash, at)
);

CREATE TABLE staff_session_ends (
  token_hash text        PRIMARY KEY REFERENCES staff_sessions (token_hash),
  at         timestamptz NOT NULL,
  why        text        NOT NULL CHECK (why IN ('signed-out', 'access-changed', 'reset', 'switched-off'))
);

CREATE TRIGGER staff_no_change BEFORE UPDATE OR DELETE ON staff
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_no_truncate BEFORE TRUNCATE ON staff
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_access_no_change BEFORE UPDATE OR DELETE ON staff_access
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_access_no_truncate BEFORE TRUNCATE ON staff_access
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_invites_no_change BEFORE UPDATE OR DELETE ON staff_invites
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_invites_no_truncate BEFORE TRUNCATE ON staff_invites
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_credentials_no_change BEFORE UPDATE OR DELETE ON staff_credentials
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_credentials_no_truncate BEFORE TRUNCATE ON staff_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_sign_ins_no_change BEFORE UPDATE OR DELETE ON staff_sign_ins
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_sign_ins_no_truncate BEFORE TRUNCATE ON staff_sign_ins
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_sessions_no_change BEFORE UPDATE OR DELETE ON staff_sessions
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_sessions_no_truncate BEFORE TRUNCATE ON staff_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_session_seen_no_change BEFORE UPDATE OR DELETE ON staff_session_seen
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_session_seen_no_truncate BEFORE TRUNCATE ON staff_session_seen
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_session_ends_no_change BEFORE UPDATE OR DELETE ON staff_session_ends
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER staff_session_ends_no_truncate BEFORE TRUNCATE ON staff_session_ends
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON staff, staff_access, staff_invites, staff_credentials, staff_sign_ins, staff_sessions, staff_session_seen, staff_session_ends TO recall_app;
