-- P2.14: the fitting check. A technician starts it from the rider app (a `fitting-check` command);
-- the box shows the test pattern, checks GPS, the 4G line, the camera and the battery, and sends a
-- fitting report. Each report is kept with the cloud's own verdict; the latest one says whether
-- the bike is ready. Append-only.
ALTER TABLE screen_commands DROP CONSTRAINT screen_commands_command_check;
ALTER TABLE screen_commands ADD CONSTRAINT screen_commands_command_check
  CHECK (command IN ('reboot', 'blank', 'unblank', 'test-pattern', 'brightness', 'send-logs', 'clear-cache', 'fitting-check'));
-- (The value rule of 0024 refers to two columns, so Postgres named it after the table.)
ALTER TABLE screen_commands DROP CONSTRAINT screen_commands_check;
ALTER TABLE screen_commands ADD CONSTRAINT screen_commands_value_check
  CHECK (CASE command
           WHEN 'brightness' THEN value IS NULL OR value BETWEEN 1 AND 100
           WHEN 'test-pattern' THEN value BETWEEN 5 AND 600
           WHEN 'fitting-check' THEN value BETWEEN 30 AND 600
           ELSE value IS NULL END);

ALTER TABLE screen_reports DROP CONSTRAINT screen_reports_kind_check;
ALTER TABLE screen_reports ADD CONSTRAINT screen_reports_kind_check
  CHECK (kind IN ('live', 'minute', 'play', 'health', 'command', 'fitting', 'rejected'));

CREATE TABLE fitting_checks (
  screen_id      text        NOT NULL,
  seq            bigint      NOT NULL,
  command_id     text        NOT NULL,
  at             timestamptz NOT NULL,
  gps_accuracy_m integer     CHECK (gps_accuracy_m >= 0),
  line_up        boolean     NOT NULL,
  camera         text        NOT NULL CHECK (camera IN ('ok', 'fail', 'unknown')),
  battery_pct    smallint    CHECK (battery_pct BETWEEN 0 AND 100),
  charging       boolean,
  panel          text        NOT NULL CHECK (panel IN ('ok', 'fail', 'unknown')),
  verdict        jsonb       NOT NULL,
  ready          boolean     NOT NULL,
  PRIMARY KEY (screen_id, seq),
  FOREIGN KEY (screen_id, seq) REFERENCES screen_reports (screen_id, seq)
);
CREATE INDEX fitting_checks_latest ON fitting_checks (screen_id, at DESC, seq DESC);

CREATE TRIGGER fitting_checks_no_change BEFORE UPDATE OR DELETE ON fitting_checks
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER fitting_checks_no_truncate BEFORE TRUNCATE ON fitting_checks
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON fitting_checks TO recall_app;
