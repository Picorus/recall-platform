-- P3.9.1: ads. Each uploaded ad belongs to a brand: its file (stored under its fingerprint), what
-- the file really is (read from its bytes) and the automatic checks' results. A booking chooses which
-- of its brand's ads it runs (2 to 5, a setting); changes are kept as events (latest wins). Nothing is
-- edited or deleted (hard rule 3). Reviews come in P3.9.2.
CREATE TABLE ads (
  ad_id       text        PRIMARY KEY CHECK (ad_id ~ '^AD-[0-9A-F]{10}$'),
  brand_id    text        NOT NULL REFERENCES brands (brand_id),
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  file_key    text        NOT NULL CHECK (file_key ~ '^[0-9a-f]{64}$'),
  bytes       bigint      NOT NULL CHECK (bytes >= 0),
  kind        text        CHECK (kind IN ('png', 'jpeg', 'webp', 'mp4')),
  width       integer,
  height      integer,
  duration_ms integer,
  codec       text,
  checks      jsonb       NOT NULL,
  -- The worst automatic check: 'fail' can never be approved.
  outcome     text        NOT NULL CHECK (outcome IN ('pass', 'warn', 'fail')),
  uploaded_by text        NOT NULL CHECK (length(uploaded_by) BETWEEN 1 AND 120),
  uploaded_at timestamptz NOT NULL
);
CREATE INDEX ads_brand ON ads (brand_id, uploaded_at DESC);

CREATE TABLE booking_ad_sets (
  booking_id text        NOT NULL REFERENCES bookings (booking_id),
  version    integer     NOT NULL CHECK (version >= 1),
  ad_ids     text[]      NOT NULL,
  set_by     text        NOT NULL CHECK (length(set_by) BETWEEN 1 AND 120),
  set_at     timestamptz NOT NULL,
  PRIMARY KEY (booking_id, version)
);

CREATE TRIGGER ads_no_change BEFORE UPDATE OR DELETE ON ads
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER ads_no_truncate BEFORE TRUNCATE ON ads
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER booking_ad_sets_no_change BEFORE UPDATE OR DELETE ON booking_ad_sets
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER booking_ad_sets_no_truncate BEFORE TRUNCATE ON booking_ad_sets
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON ads, booking_ad_sets TO recall_app;
