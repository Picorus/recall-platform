-- P1.2.4–P1.2.5: what screens send. Each numbered report is stored once (the key stops repeats);
-- minute summaries are kept in order per screen for moving hours. Append-only (hard rule 3), except
-- the small per-screen inbox position, which only ever moves forward.

CREATE TABLE screen_inboxes (
  screen_id  text        PRIMARY KEY CHECK (length(screen_id) BETWEEN 1 AND 64),
  -- Every report up to here has arrived (or is known lost).
  up_to      bigint      NOT NULL DEFAULT 0 CHECK (up_to >= 0),
  lost       bigint      NOT NULL DEFAULT 0 CHECK (lost >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION screen_inboxes_forward() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.up_to < OLD.up_to OR NEW.lost < OLD.lost OR NEW.screen_id <> OLD.screen_id THEN
    RAISE EXCEPTION 'screen inbox %: can only move forward', OLD.screen_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER screen_inboxes_forward BEFORE UPDATE ON screen_inboxes
  FOR EACH ROW EXECUTE FUNCTION screen_inboxes_forward();
CREATE TRIGGER screen_inboxes_no_delete BEFORE DELETE ON screen_inboxes
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();

-- Every report as received, including ones that arrived ahead of a gap.
CREATE TABLE screen_reports (
  screen_id   text        NOT NULL REFERENCES screen_inboxes (screen_id),
  seq         bigint      NOT NULL CHECK (seq > 0),
  kind        text        NOT NULL CHECK (kind IN ('live', 'minute')),
  made_at     timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  body        jsonb       NOT NULL,
  PRIMARY KEY (screen_id, seq)
);
CREATE TRIGGER screen_reports_no_change BEFORE UPDATE OR DELETE ON screen_reports
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_reports_no_truncate BEFORE TRUNCATE ON screen_reports
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

-- Minute summaries accepted in order: what moving hours and rider pay are counted from.
CREATE TABLE minute_summaries (
  screen_id   text        NOT NULL,
  minute      timestamptz NOT NULL,
  seq         bigint      NOT NULL,
  clock_s     smallint    NOT NULL CHECK (clock_s BETWEEN 0 AND 60),
  pay_clock_s smallint    NOT NULL CHECK (pay_clock_s BETWEEN 0 AND 60),
  moving_s    smallint    NOT NULL CHECK (moving_s BETWEEN 0 AND 60),
  distance_m  integer     NOT NULL CHECK (distance_m >= 0),
  plays       integer     NOT NULL CHECK (plays >= 0),
  people      integer     NOT NULL CHECK (people >= 0),
  seconds_at  jsonb       NOT NULL,
  clock_at    jsonb       NOT NULL,
  PRIMARY KEY (screen_id, minute, seq),
  FOREIGN KEY (screen_id, seq) REFERENCES screen_reports (screen_id, seq)
);
SELECT create_hypertable('minute_summaries', by_range('minute', INTERVAL '7 days'));
CREATE TRIGGER minute_summaries_no_change BEFORE UPDATE OR DELETE ON minute_summaries
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
