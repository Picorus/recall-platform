-- P3.11.2: outside checks on a rider: identity (KYC), the rider agreement (e-sign) and his bank or
-- UPI (a ₹1 test deposit). Each check started, and its one result. Only what is needed is kept
-- (DPDP Act): the name on his ID and its last 4 characters, never the ID number; for the bank, a
-- fingerprint of the account checked (the account itself is in rider_payout_accounts).
CREATE TABLE rider_checks (
  check_id     text        PRIMARY KEY CHECK (check_id ~ '^CHK-[0-9A-F]{10}$'),
  rider_id     text        NOT NULL REFERENCES riders (rider_id),
  kind         text        NOT NULL CHECK (kind IN ('identity', 'agreement', 'bank')),
  provider_ref text        NOT NULL CHECK (length(provider_ref) BETWEEN 1 AND 120),
  -- Where the rider does it on his phone (identity, agreement).
  link         text        CHECK (link IS NULL OR length(link) <= 500),
  -- Agreement: the version sent. Bank: the fingerprint of the account checked.
  about        text        NOT NULL CHECK (length(about) <= 120),
  started_by   text        NOT NULL CHECK (length(started_by) BETWEEN 1 AND 120),
  started_at   timestamptz NOT NULL,
  seq          bigint      GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX rider_checks_rider ON rider_checks (rider_id, kind, seq DESC);

CREATE TABLE rider_check_results (
  check_id text        PRIMARY KEY REFERENCES rider_checks (check_id),
  outcome  text        NOT NULL CHECK (outcome IN ('passed', 'failed')),
  -- The name on his ID, or the name the bank holds.
  name     text        CHECK (name IS NULL OR length(name) BETWEEN 1 AND 120),
  id_last4 text        CHECK (id_last4 IS NULL OR id_last4 ~ '^[A-Za-z0-9]{4}$'),
  reason   text        CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  at       timestamptz NOT NULL
);

CREATE TRIGGER rider_checks_no_change BEFORE UPDATE OR DELETE ON rider_checks
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_checks_no_truncate BEFORE TRUNCATE ON rider_checks
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_check_results_no_change BEFORE UPDATE OR DELETE ON rider_check_results
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_check_results_no_truncate BEFORE TRUNCATE ON rider_check_results
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON rider_checks, rider_check_results TO recall_app;
