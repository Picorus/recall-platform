-- P3.4: a screen's service life (to repair, repaired, retired), each step with who and why, and
-- pausing a player rollout (paused, resumed). Append-only: a screen's state is its newest event.
CREATE TABLE screen_service_events (
  id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  screen_id text        NOT NULL REFERENCES screens (screen_id),
  kind      text        NOT NULL CHECK (kind IN ('to-repair', 'repaired', 'retired')),
  reason    text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  by        text        NOT NULL CHECK (length(by) BETWEEN 1 AND 80),
  at        timestamptz NOT NULL
);
CREATE INDEX screen_service_latest ON screen_service_events (screen_id, id DESC);

CREATE TRIGGER screen_service_events_no_change BEFORE UPDATE OR DELETE ON screen_service_events
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_service_events_no_truncate BEFORE TRUNCATE ON screen_service_events
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON screen_service_events TO recall_app;

ALTER TABLE release_events DROP CONSTRAINT release_events_kind_check;
ALTER TABLE release_events ADD CONSTRAINT release_events_kind_check
  CHECK (kind IN ('started', 'advanced', 'finished', 'rolled-back', 'replaced', 'paused', 'resumed'));
