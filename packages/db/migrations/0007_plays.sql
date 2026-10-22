-- P1.5: plays. Each play is made and signed on the screen (hard rule 1); the cloud checks it and
-- keeps it with whether it counts. Append-only (hard rule 3).

-- Each screen's public keys (ECDSA P-256, SubjectPublicKeyInfo DER, base64). A key is never deleted;
-- revoking it adds a row below: plays it signed from `plays_until` on are refused (and, if already
-- stored, not counted); plays before then still count.
CREATE TABLE screen_keys (
  screen_id  text        NOT NULL CHECK (length(screen_id) BETWEEN 1 AND 64),
  key_id     text        NOT NULL CHECK (key_id ~ '^[\x20-\x7e]{1,120}$'),
  public_key text        NOT NULL CHECK (public_key ~ '^[A-Za-z0-9+/]+={0,2}$'),
  added_by   text        NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (screen_id, key_id)
);
CREATE TABLE screen_key_revocations (
  screen_id  text        NOT NULL,
  key_id     text        NOT NULL,
  revoked_by text        NOT NULL,
  reason     text        NOT NULL CHECK (length(reason) >= 5),
  plays_until timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (screen_id, key_id),
  FOREIGN KEY (screen_id, key_id) REFERENCES screen_keys (screen_id, key_id)
);

-- Screens may now send plays.
ALTER TABLE screen_reports DROP CONSTRAINT screen_reports_kind_check;
ALTER TABLE screen_reports ADD CONSTRAINT screen_reports_kind_check
  CHECK (kind IN ('live', 'minute', 'play', 'rejected'));

-- Every play the cloud accepted (signature good, time sane, no overlap), counted or not. Its id is
-- the screen and the report number, which the reports table already keeps unique.
CREATE TABLE plays (
  screen_id    text        NOT NULL,
  seq          bigint      NOT NULL,
  start_at     timestamptz NOT NULL,
  key_id       text        NOT NULL,
  slot         text        NOT NULL CHECK (slot IN ('brand', 'make-up', 'aggregator', 'recall')),
  ref          text        NOT NULL,
  ad_id        text        NOT NULL,
  length_s     smallint    NOT NULL CHECK (length_s BETWEEN 1 AND 60),
  lat_e6       integer     NOT NULL,
  lng_e6       integer     NOT NULL,
  accuracy_m   integer     NOT NULL CHECK (accuracy_m >= 0),
  screen_place text        NOT NULL,
  -- Where the cloud found it, against the area shape in force then.
  cloud_place  text        NOT NULL,
  counts       text        NOT NULL CHECK (counts IN ('inside', 'edge', 'no')),
  -- The booking line it counts for, or why it does not count.
  line_id      text,
  reason       text,
  people       integer     NOT NULL CHECK (people >= 0),
  received_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((counts = 'no') = (line_id IS NULL) AND (counts = 'no') = (reason IS NOT NULL)),
  PRIMARY KEY (screen_id, seq, start_at),
  FOREIGN KEY (screen_id, seq) REFERENCES screen_reports (screen_id, seq),
  FOREIGN KEY (screen_id, key_id) REFERENCES screen_keys (screen_id, key_id)
);
SELECT create_hypertable('plays', by_range('start_at', INTERVAL '1 day'));
-- Backstops for "no play counted twice": one play per screen per start time, one per report number.
CREATE UNIQUE INDEX plays_screen_time ON plays (screen_id, start_at);
CREATE INDEX plays_screen_seq ON plays (screen_id, seq);
CREATE FUNCTION plays_one_per_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM plays WHERE screen_id = NEW.screen_id AND seq = NEW.seq) THEN
    RAISE EXCEPTION 'play %/% already stored', NEW.screen_id, NEW.seq;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM screen_reports
                  WHERE screen_id = NEW.screen_id AND seq = NEW.seq AND kind = 'play') THEN
    RAISE EXCEPTION 'play %/% has no play report', NEW.screen_id, NEW.seq;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plays_one_per_report BEFORE INSERT ON plays
  FOR EACH ROW EXECUTE FUNCTION plays_one_per_report();
CREATE INDEX plays_line ON plays (line_id, start_at) WHERE line_id IS NOT NULL;

CREATE TRIGGER screen_keys_no_change BEFORE UPDATE OR DELETE ON screen_keys
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_keys_no_truncate BEFORE TRUNCATE ON screen_keys
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_key_revocations_no_change BEFORE UPDATE OR DELETE ON screen_key_revocations
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_key_revocations_no_truncate BEFORE TRUNCATE ON screen_key_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER plays_no_change BEFORE UPDATE OR DELETE ON plays
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER plays_no_truncate BEFORE TRUNCATE ON plays
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON screen_keys, screen_key_revocations, plays TO recall_app;
