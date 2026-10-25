-- P2.1: screens. Each controller box is enrolled once at our warehouse (its hardware serial, its id),
-- gets certificates for its secure line, and is fitted to a bike and a rider by scanning its QR.
-- Append-only (hard rule 3): a new fitting row moves the screen on; a row with no bike takes it off.
CREATE TABLE screens (
  screen_id       text        PRIMARY KEY CHECK (screen_id ~ '^SCR-[0-9A-HJKMNP-TV-Z]{8}$'),
  hardware_serial text        NOT NULL UNIQUE CHECK (hardware_serial ~ '^[A-Za-z0-9._:-]{4,64}$'),
  model           text        NOT NULL CHECK (length(model) BETWEEN 1 AND 80),
  enrolled_by     text        NOT NULL,
  enrolled_at     timestamptz NOT NULL
);

CREATE TABLE screen_certificates (
  serial      text        PRIMARY KEY CHECK (serial ~ '^[0-9a-f]{1,40}$'),
  screen_id   text        NOT NULL REFERENCES screens (screen_id),
  public_key  text        NOT NULL CHECK (public_key ~ '^[A-Za-z0-9+/]+={0,2}$'),
  cert_pem    text        NOT NULL CHECK (cert_pem LIKE '-----BEGIN CERTIFICATE-----%'),
  not_before  timestamptz NOT NULL,
  not_after   timestamptz NOT NULL CHECK (not_after > not_before),
  issued_by   text        NOT NULL,
  issued_at   timestamptz NOT NULL
);
CREATE INDEX screen_certificates_screen ON screen_certificates (screen_id, not_after);

CREATE TABLE screen_fittings (
  screen_id text        NOT NULL REFERENCES screens (screen_id),
  from_at   timestamptz NOT NULL,
  -- Number plate in one form ("TS09EA1234"); null = taken off the bike.
  bike      text        CHECK (bike ~ '^[A-Z0-9]{4,12}$'),
  rider_id  text        CHECK (rider_id ~ '^[A-Za-z0-9-]{3,40}$'),
  reason    text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  set_by    text        NOT NULL,
  set_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (screen_id, from_at),
  CHECK ((bike IS NULL) = (rider_id IS NULL))
);
CREATE INDEX screen_fittings_bike ON screen_fittings (bike, from_at);

-- A key belongs to one screen: a copied key must not make one bike count as two (review, P2.1).
CREATE UNIQUE INDEX screen_keys_public_key ON screen_keys (public_key);
CREATE INDEX screen_certificates_public_key ON screen_certificates (public_key);

CREATE TRIGGER screens_no_change BEFORE UPDATE OR DELETE ON screens
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screens_no_truncate BEFORE TRUNCATE ON screens
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_certificates_no_change BEFORE UPDATE OR DELETE ON screen_certificates
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_certificates_no_truncate BEFORE TRUNCATE ON screen_certificates
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_fittings_no_change BEFORE UPDATE OR DELETE ON screen_fittings
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_fittings_no_truncate BEFORE TRUNCATE ON screen_fittings
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON screens, screen_certificates, screen_fittings TO recall_app;
