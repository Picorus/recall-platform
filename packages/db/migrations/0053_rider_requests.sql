-- P4.11: what a rider asks for from the app's profile: to change the bank he is paid to (a super
-- admin does it with him on a call, never the app alone), to leave RECALL, or to delete his account
-- (DPDP; Google Play needs the way to ask). Each opens a support conversation that staff work
-- through; asking again while one is open does not open another. Append-only (hard rule 3).
CREATE TABLE rider_requests (
  request_id text        PRIMARY KEY CHECK (request_id ~ '^REQ-[0-9A-F]{10}$'),
  rider_id   text        NOT NULL REFERENCES riders (rider_id),
  kind       text        NOT NULL CHECK (kind IN ('bank-change', 'leave', 'delete')),
  thread_id  text        NOT NULL REFERENCES support_threads (thread_id),
  at         timestamptz NOT NULL
);
CREATE INDEX rider_requests_rider ON rider_requests (rider_id, kind, at DESC);
CREATE TRIGGER rider_requests_no_change BEFORE UPDATE OR DELETE ON rider_requests
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_requests_no_truncate BEFORE TRUNCATE ON rider_requests
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON rider_requests TO recall_app;
