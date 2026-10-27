-- P4.8: screen problems a rider reports from the rider app (not turning on, damaged, stolen, an
-- accident, something else), with a photo when he has one. Each starts a support conversation with
-- him (P3.15) so staff answer, book a repair or a swap, and mark it done there. Append-only.
CREATE TABLE screen_problems (
  problem_id text        PRIMARY KEY CHECK (problem_id ~ '^PRB-[0-9A-F]{10}$'),
  rider_id   text        NOT NULL REFERENCES riders (rider_id),
  screen_id  text,
  kind       text        NOT NULL CHECK (kind IN ('not-on', 'damage', 'theft', 'accident', 'other')),
  note       text        NOT NULL CHECK (length(note) <= 1000),
  photo_key  text        CHECK (photo_key ~ '^[0-9a-f]{64}$'),
  photo_type text        CHECK (photo_type IN ('png', 'jpeg', 'webp')),
  thread_id  text        NOT NULL REFERENCES support_threads (thread_id),
  at         timestamptz NOT NULL,
  CHECK ((photo_key IS NULL) = (photo_type IS NULL))
);
CREATE INDEX screen_problems_rider ON screen_problems (rider_id, at DESC);
CREATE INDEX screen_problems_thread ON screen_problems (thread_id);
CREATE TRIGGER screen_problems_no_change BEFORE UPDATE OR DELETE ON screen_problems
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_problems_no_truncate BEFORE TRUNCATE ON screen_problems
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON screen_problems TO recall_app;
