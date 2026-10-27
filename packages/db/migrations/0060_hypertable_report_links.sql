-- P7.2 (load test): plays, minute summaries and screen health are split by time (TimescaleDB). Each
-- linked to its report with a foreign key, and making a new time piece (a chunk: plays get one a
-- day) then needs a lock on screen_reports that every upload in flight blocks: under a full fleet
-- (about 520 uploads a second) uploads deadlock and the new day cannot start. The same check, "the
-- report this row comes from is stored", is now made row by row by a trigger instead: nothing
-- locks screen_reports to start a new piece. screen_reports can never be changed or deleted
-- (append-only), so the key's other half (no report removed under a row) still holds.
CREATE FUNCTION recall_report_exists() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM screen_reports r
                  WHERE r.screen_id = NEW.screen_id AND r.seq = NEW.seq) THEN
    RAISE EXCEPTION 'no stored report % of screen % for this row', NEW.seq, NEW.screen_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE plays DROP CONSTRAINT plays_screen_id_seq_fkey;
ALTER TABLE minute_summaries DROP CONSTRAINT minute_summaries_screen_id_seq_fkey;
ALTER TABLE screen_health DROP CONSTRAINT screen_health_screen_id_seq_fkey;

CREATE TRIGGER plays_report_exists BEFORE INSERT ON plays
  FOR EACH ROW EXECUTE FUNCTION recall_report_exists();
CREATE TRIGGER minute_summaries_report_exists BEFORE INSERT ON minute_summaries
  FOR EACH ROW EXECUTE FUNCTION recall_report_exists();
CREATE TRIGGER screen_health_report_exists BEFORE INSERT ON screen_health
  FOR EACH ROW EXECUTE FUNCTION recall_report_exists();
