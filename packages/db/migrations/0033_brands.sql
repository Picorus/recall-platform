-- P3.8.1: brand and agency accounts. An account's details are versions (latest wins; nothing is
-- overwritten), with who and why. An agency is an account that books for brands; a brand may name
-- the agency that handles it and the delivery or ride app that referred it. Notes are kept for good.
-- Contacts and tax details stay in brand_contacts and brand_tax_profiles (P1.9, P1.7.9).
CREATE TABLE brands (
  brand_id   text        PRIMARY KEY CHECK (brand_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  kind       text        NOT NULL CHECK (kind IN ('brand', 'agency')),
  created_by text        NOT NULL CHECK (length(created_by) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL
);

CREATE TABLE brand_versions (
  brand_id   text        NOT NULL REFERENCES brands (brand_id),
  version    integer     NOT NULL CHECK (version >= 1),
  name       text        NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  agency_id  text        REFERENCES brands (brand_id),
  referred_by text       CHECK (referred_by IS NULL OR referred_by ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  active     boolean     NOT NULL,
  reason     text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  set_by     text        NOT NULL CHECK (length(set_by) BETWEEN 1 AND 120),
  set_at     timestamptz NOT NULL,
  PRIMARY KEY (brand_id, version),
  CHECK (agency_id IS NULL OR agency_id <> brand_id)
);

CREATE TABLE brand_notes (
  id       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_id text        NOT NULL REFERENCES brands (brand_id),
  note     text        NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  by       text        NOT NULL CHECK (length(by) BETWEEN 1 AND 120),
  at       timestamptz NOT NULL
);
CREATE INDEX brand_notes_brand ON brand_notes (brand_id, id DESC);
CREATE INDEX bookings_brand ON bookings (brand_id);

CREATE TRIGGER brands_no_change BEFORE UPDATE OR DELETE ON brands
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER brands_no_truncate BEFORE TRUNCATE ON brands
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER brand_versions_no_change BEFORE UPDATE OR DELETE ON brand_versions
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER brand_versions_no_truncate BEFORE TRUNCATE ON brand_versions
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER brand_notes_no_change BEFORE UPDATE OR DELETE ON brand_notes
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER brand_notes_no_truncate BEFORE TRUNCATE ON brand_notes
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON brands, brand_versions, brand_notes TO recall_app;
