-- P1.7.5–6: rider pay. Which rider rides which screen, from when (a new row moves the screen on; a row
-- with no rider takes it off). Append-only (hard rule 3): who and when kept. A rider's first row also
-- sets his POC month: the base grows from his first month on a screen.
CREATE TABLE rider_screens (
  screen_id text        NOT NULL CHECK (length(screen_id) BETWEEN 1 AND 64),
  from_at   timestamptz NOT NULL,
  rider_id  text        CHECK (rider_id ~ '^[A-Za-z0-9-]{3,40}$'),
  set_by    text        NOT NULL,
  set_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (screen_id, from_at)
);
CREATE INDEX rider_screens_rider ON rider_screens (rider_id, from_at);

CREATE TRIGGER rider_screens_no_change BEFORE UPDATE OR DELETE ON rider_screens
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_screens_no_truncate BEFORE TRUNCATE ON rider_screens
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON rider_screens TO recall_app;
