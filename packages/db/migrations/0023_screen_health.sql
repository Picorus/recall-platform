-- P2.11: each screen's health, one report a minute through the outbox (battery, temperatures,
-- storage, signal, LED panel, tamper, app version, the box's own counters), and alerts raised and
-- cleared on them, and on a screen not heard from for 30 minutes. Append-only: an alert's life is its
-- events (raised, then cleared), never a row changed.
ALTER TABLE screen_reports DROP CONSTRAINT screen_reports_kind_check;
ALTER TABLE screen_reports ADD CONSTRAINT screen_reports_kind_check
  CHECK (kind IN ('live', 'minute', 'play', 'health', 'rejected'));

CREATE TABLE screen_health (
  screen_id          text        NOT NULL,
  t                  timestamptz NOT NULL CHECK (extract(epoch FROM t)::bigint % 60 = 0),
  seq                bigint      NOT NULL,
  app                text        NOT NULL CHECK (length(app) BETWEEN 1 AND 40),
  up_s               bigint      NOT NULL CHECK (up_s >= 0),
  battery_pct        smallint    CHECK (battery_pct BETWEEN 0 AND 100),
  charging           boolean,
  battery_c          smallint,
  box_c              smallint,
  free_mb            integer     NOT NULL CHECK (free_mb >= 0),
  signal_dbm         smallint,
  led_fault          boolean,
  tamper             boolean,
  clock_disagree     boolean     NOT NULL,
  spots_not_counted  bigint      NOT NULL CHECK (spots_not_counted >= 0),
  plays_not_stored   bigint      NOT NULL CHECK (plays_not_stored >= 0),
  messages_refused   bigint      NOT NULL CHECK (messages_refused >= 0),
  gps_missed_seconds bigint      NOT NULL CHECK (gps_missed_seconds >= 0),
  ads_missing        bigint      NOT NULL CHECK (ads_missing >= 0),
  PRIMARY KEY (screen_id, t, seq),
  FOREIGN KEY (screen_id, seq) REFERENCES screen_reports (screen_id, seq)
);
SELECT create_hypertable('screen_health', by_range('t', INTERVAL '7 days'));

CREATE TABLE screen_alert_events (
  screen_id text        NOT NULL REFERENCES screen_inboxes (screen_id),
  kind      text        NOT NULL CHECK (kind IN ('overheating', 'low-battery', 'tamper', 'led-fault', 'low-storage', 'no-contact')),
  state     text        NOT NULL CHECK (state IN ('raised', 'cleared')),
  at        timestamptz NOT NULL,
  id        bigint      GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (screen_id, kind, id)
);
CREATE INDEX screen_alert_events_latest ON screen_alert_events (screen_id, kind, id DESC);

CREATE TRIGGER screen_health_no_change BEFORE UPDATE OR DELETE ON screen_health
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_health_no_truncate BEFORE TRUNCATE ON screen_health
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_alert_events_no_change BEFORE UPDATE OR DELETE ON screen_alert_events
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_alert_events_no_truncate BEFORE TRUNCATE ON screen_alert_events
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON screen_health, screen_alert_events TO recall_app;
