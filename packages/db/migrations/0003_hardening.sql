-- Review fixes for P1.2 storage: reports that fail checks are kept aside (never counted, never
-- blocking), minutes must start on a whole minute, the minute table cannot be wiped, every move of
-- a screen's inbox is logged, and the app works through a role that cannot switch any of this off.

-- A report that failed the checks still takes its number, so the screen's queue moves on.
ALTER TABLE screen_reports DROP CONSTRAINT screen_reports_kind_check;
ALTER TABLE screen_reports ADD CONSTRAINT screen_reports_kind_check
  CHECK (kind IN ('live', 'minute', 'rejected'));
ALTER TABLE screen_reports ADD CONSTRAINT screen_reports_body_size CHECK (octet_length(body::text) <= 16384);
ALTER TABLE screen_reports ADD COLUMN reject_reason text;
ALTER TABLE screen_reports ADD CONSTRAINT screen_reports_reason
  CHECK ((kind = 'rejected') = (reject_reason IS NOT NULL));

ALTER TABLE minute_summaries ADD CONSTRAINT minute_summaries_whole_minute
  CHECK (extract(epoch FROM minute)::bigint % 60 = 0);
ALTER TABLE minute_summaries ADD CONSTRAINT minute_summaries_pay_within_clock CHECK (pay_clock_s <= clock_s);
ALTER TABLE minute_summaries ADD CONSTRAINT minute_summaries_distance CHECK (distance_m <= 3000);
CREATE TRIGGER minute_summaries_no_truncate BEFORE TRUNCATE ON minute_summaries
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_inboxes_no_truncate BEFORE TRUNCATE ON screen_inboxes
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

-- Every move of a screen's inbox: who, when, before and after (hard rule 3).
CREATE TABLE screen_inbox_changes (
  screen_id   text        NOT NULL,
  up_to_from  bigint      NOT NULL,
  up_to_to    bigint      NOT NULL,
  lost_from   bigint      NOT NULL,
  lost_to     bigint      NOT NULL,
  changed_by  text        NOT NULL DEFAULT current_user,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER screen_inbox_changes_no_change BEFORE UPDATE OR DELETE ON screen_inbox_changes
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_inbox_changes_no_truncate BEFORE TRUNCATE ON screen_inbox_changes
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

CREATE FUNCTION screen_inboxes_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.up_to <> OLD.up_to OR NEW.lost <> OLD.lost THEN
    INSERT INTO screen_inbox_changes (screen_id, up_to_from, up_to_to, lost_from, lost_to)
    VALUES (OLD.screen_id, OLD.up_to, NEW.up_to, OLD.lost, NEW.lost);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER screen_inboxes_log AFTER UPDATE ON screen_inboxes
  FOR EACH ROW EXECUTE FUNCTION screen_inboxes_log();

-- The role the apps work through. It does not own any table, so it cannot alter, truncate, drop,
-- switch off triggers or drop TimescaleDB chunks; it can only add rows and read them (and move a
-- screen's inbox forward, which is logged above). Each app's login is made a member of it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'recall_app') THEN
    CREATE ROLE recall_app NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO recall_app;
GRANT SELECT, INSERT ON area_versions, screen_inboxes, screen_reports, minute_summaries, screen_inbox_changes
  TO recall_app;
GRANT UPDATE (up_to, lost, updated_at) ON screen_inboxes TO recall_app;
