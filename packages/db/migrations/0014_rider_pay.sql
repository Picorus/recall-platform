-- P1.7.5–6: rider pay. Which rider rides which screen, from when (a new row moves the screen on; a row
-- with no rider takes it off), and each rider's POC base. Append-only (hard rule 3): who and when kept.
CREATE TABLE rider_screens (
  screen_id text        NOT NULL CHECK (length(screen_id) BETWEEN 1 AND 64),
  from_at   timestamptz NOT NULL,
  rider_id  text        CHECK (rider_id ~ '^[A-Za-z0-9-]{3,40}$'),
  set_by    text        NOT NULL,
  set_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (screen_id, from_at)
);
CREATE INDEX rider_screens_rider ON rider_screens (rider_id, from_at);

-- The POC base a rider is on (₹2,000 / ₹4,000 / ₹6,000), from a month on; the latest month wins.
CREATE TABLE rider_poc_bases (
  rider_id   text        NOT NULL CHECK (rider_id ~ '^[A-Za-z0-9-]{3,40}$'),
  from_month text        NOT NULL CHECK (from_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  base_paise bigint      NOT NULL CHECK (base_paise >= 0),
  set_by     text        NOT NULL,
  reason     text        NOT NULL CHECK (length(reason) >= 5),
  set_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rider_id, from_month)
);

CREATE TRIGGER rider_screens_no_change BEFORE UPDATE OR DELETE ON rider_screens
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_screens_no_truncate BEFORE TRUNCATE ON rider_screens
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_poc_bases_no_change BEFORE UPDATE OR DELETE ON rider_poc_bases
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_poc_bases_no_truncate BEFORE TRUNCATE ON rider_poc_bases
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON rider_screens, rider_poc_bases TO recall_app;
