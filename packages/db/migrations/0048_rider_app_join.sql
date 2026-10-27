-- P4.2: a new number signs up on the rider app. The session it signed in with (P4.1, no rider then)
-- is joined to the rider record the sign-up made (or to the record staff had already made for that
-- number). Once, never changed (hard rule 3).
CREATE TABLE rider_session_joins (
  token_hash text        PRIMARY KEY REFERENCES rider_sessions (token_hash),
  rider_id   text        NOT NULL REFERENCES riders (rider_id),
  at         timestamptz NOT NULL
);
CREATE TRIGGER rider_session_joins_no_change BEFORE UPDATE OR DELETE ON rider_session_joins
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_session_joins_no_truncate BEFORE TRUNCATE ON rider_session_joins
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON rider_session_joins TO recall_app;
