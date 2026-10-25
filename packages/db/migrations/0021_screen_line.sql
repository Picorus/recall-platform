-- P2.3.2: the secure line to screens. A certificate can be revoked (box lost, stolen or retired): the
-- gateway then refuses its line. Each hello (the line opening) and each upload refused whole are
-- kept, for the health view (last contact, app version) and for finding faulty boxes. Append-only.
CREATE TABLE screen_certificate_revocations (
  serial     text        PRIMARY KEY REFERENCES screen_certificates (serial),
  reason     text        NOT NULL CHECK (length(reason) BETWEEN 5 AND 200),
  revoked_by text        NOT NULL,
  revoked_at timestamptz NOT NULL
);

CREATE TABLE screen_hellos (
  screen_id text        NOT NULL REFERENCES screens (screen_id),
  at        timestamptz NOT NULL,
  app       text        NOT NULL CHECK (app ~ '^[0-9A-Za-z.+-]{1,32}$'),
  PRIMARY KEY (screen_id, at)
);

CREATE TABLE screen_line_refusals (
  screen_id text        NOT NULL REFERENCES screens (screen_id),
  at        timestamptz NOT NULL,
  kind      text        NOT NULL CHECK (kind IN ('hello', 'upload')),
  problem   text        NOT NULL CHECK (length(problem) BETWEEN 1 AND 80),
  bytes     integer     NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (screen_id, at, kind)
);

CREATE TRIGGER screen_certificate_revocations_no_change BEFORE UPDATE OR DELETE ON screen_certificate_revocations
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_certificate_revocations_no_truncate BEFORE TRUNCATE ON screen_certificate_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_hellos_no_change BEFORE UPDATE OR DELETE ON screen_hellos
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_hellos_no_truncate BEFORE TRUNCATE ON screen_hellos
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_line_refusals_no_change BEFORE UPDATE OR DELETE ON screen_line_refusals
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_line_refusals_no_truncate BEFORE TRUNCATE ON screen_line_refusals
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON screen_certificate_revocations, screen_hellos, screen_line_refusals
  TO recall_app;
