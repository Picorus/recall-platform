-- P2.12: remote commands to screens, every one logged (who, why, when), and each box's answer (done,
-- refused, failed) as it came through the box's outbox. Append-only: a command is never changed;
-- one sent by mistake is answered by another (e.g. unblank after blank).
ALTER TABLE screen_reports DROP CONSTRAINT screen_reports_kind_check;
ALTER TABLE screen_reports ADD CONSTRAINT screen_reports_kind_check
  CHECK (kind IN ('live', 'minute', 'play', 'health', 'command', 'rejected'));

CREATE TABLE screen_commands (
  id        text        PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9-]{8,64}$'),
  screen_id text        NOT NULL REFERENCES screen_inboxes (screen_id),
  command   text        NOT NULL CHECK (command IN ('reboot', 'blank', 'unblank', 'test-pattern', 'brightness', 'send-logs', 'clear-cache')),
  value     integer     CHECK (CASE command
                                 WHEN 'brightness' THEN value IS NULL OR value BETWEEN 1 AND 100
                                 WHEN 'test-pattern' THEN value BETWEEN 5 AND 600
                                 ELSE value IS NULL END),
  made_at   timestamptz NOT NULL,
  until     timestamptz NOT NULL CHECK (until > made_at AND until <= made_at + interval '1 hour'),
  by        text        NOT NULL CHECK (length(by) BETWEEN 1 AND 80),
  reason    text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 200)
);
CREATE INDEX screen_commands_screen ON screen_commands (screen_id, made_at DESC);

CREATE TABLE screen_command_results (
  id        text        NOT NULL REFERENCES screen_commands (id),
  screen_id text        NOT NULL,
  seq       bigint      NOT NULL,
  result    text        NOT NULL CHECK (result IN ('done', 'refused', 'failed')),
  note      text        NOT NULL CHECK (length(note) <= 4000),
  at        timestamptz NOT NULL,
  PRIMARY KEY (screen_id, seq),
  FOREIGN KEY (screen_id, seq) REFERENCES screen_reports (screen_id, seq)
);
CREATE INDEX screen_command_results_id ON screen_command_results (id);

CREATE TRIGGER screen_commands_no_change BEFORE UPDATE OR DELETE ON screen_commands
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_commands_no_truncate BEFORE TRUNCATE ON screen_commands
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_command_results_no_change BEFORE UPDATE OR DELETE ON screen_command_results
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_command_results_no_truncate BEFORE TRUNCATE ON screen_command_results
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON screen_commands, screen_command_results TO recall_app;
