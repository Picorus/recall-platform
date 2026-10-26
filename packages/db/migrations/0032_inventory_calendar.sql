-- P3.7: the inventory calendar. A hold can be ended before its set time (released: the bikes go back
-- on sale), with who and why; holds and limits keep why they were set. Nothing is edited or deleted.
CREATE TABLE hold_ends (
  hold_id  text        PRIMARY KEY REFERENCES holds (hold_id),
  ended_at timestamptz NOT NULL,
  ended_by text        NOT NULL CHECK (length(ended_by) BETWEEN 1 AND 120),
  reason   text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 200)
);
CREATE TRIGGER hold_ends_no_change BEFORE UPDATE OR DELETE ON hold_ends
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER hold_ends_no_truncate BEFORE TRUNCATE ON hold_ends
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON hold_ends TO recall_app;

ALTER TABLE holds ADD COLUMN reason text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 200);
ALTER TABLE area_hour_limits ADD COLUMN reason text
  CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 200);
CREATE INDEX hold_lines_area_hour ON hold_lines (area_id, day, start_hour);
