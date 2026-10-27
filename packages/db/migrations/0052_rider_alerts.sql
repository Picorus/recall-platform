-- P4.10: alerts to riders. A phone's push token as the rider app registered it (with his language),
-- for the session it came from; each alert (payout sent, screen silent, battery low, repair booked)
-- made once; and each try to send one to a phone. Append-only (hard rule 3).
CREATE TABLE rider_push_tokens (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash text        NOT NULL REFERENCES rider_sessions (token_hash),
  push_token text        NOT NULL CHECK (length(push_token) BETWEEN 10 AND 300),
  language   text        NOT NULL CHECK (language IN ('te', 'hi', 'en')),
  at         timestamptz NOT NULL
);
CREATE INDEX rider_push_tokens_session ON rider_push_tokens (token_hash, id DESC);

CREATE TABLE rider_alerts (
  alert_id   text        PRIMARY KEY CHECK (alert_id ~ '^ALR-[0-9A-F]{12}$'),
  rider_id   text        NOT NULL REFERENCES riders (rider_id),
  kind       text        NOT NULL CHECK (kind IN ('payout-paid', 'screen-offline', 'battery-low', 'repair-booked')),
  -- What it is about (a payout run, a silent spell, a day, a service event): one alert each.
  ref        text        NOT NULL CHECK (length(ref) BETWEEN 1 AND 120),
  vals       jsonb       NOT NULL,
  at         timestamptz NOT NULL,
  UNIQUE (rider_id, kind, ref)
);
CREATE INDEX rider_alerts_rider ON rider_alerts (rider_id, at DESC);
CREATE INDEX rider_alerts_at ON rider_alerts (at);

CREATE TABLE rider_alert_pushes (
  alert_id   text        NOT NULL REFERENCES rider_alerts (alert_id),
  push_token text        NOT NULL,
  status     text        NOT NULL CHECK (status IN ('sent', 'gone', 'failed')),
  detail     text        CHECK (detail IS NULL OR length(detail) <= 300),
  at         timestamptz NOT NULL
);
CREATE INDEX rider_alert_pushes_alert ON rider_alert_pushes (alert_id, push_token);
CREATE INDEX rider_alert_pushes_token ON rider_alert_pushes (push_token) WHERE status = 'gone';

CREATE TRIGGER rider_push_tokens_no_change BEFORE UPDATE OR DELETE ON rider_push_tokens
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_push_tokens_no_truncate BEFORE TRUNCATE ON rider_push_tokens
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_alerts_no_change BEFORE UPDATE OR DELETE ON rider_alerts
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_alerts_no_truncate BEFORE TRUNCATE ON rider_alerts
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_alert_pushes_no_change BEFORE UPDATE OR DELETE ON rider_alert_pushes
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_alert_pushes_no_truncate BEFORE TRUNCATE ON rider_alert_pushes
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON rider_push_tokens, rider_alerts, rider_alert_pushes TO recall_app;
