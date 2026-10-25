-- P1.7.7: the Monday payout run. The system prepares it (each rider's pay owed), finance approves
-- it in admin, the payout provider pays each rider's bank or UPI, failures retry and show in admin.
-- Append-only (hard rule 3): every account change, approval and attempt kept with who and when.

-- Where a rider is paid; the latest row wins.
CREATE TABLE rider_payout_accounts (
  rider_id    text        NOT NULL CHECK (rider_id ~ '^[A-Za-z0-9-]{3,40}$'),
  set_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  destination jsonb       NOT NULL,
  set_by      text        NOT NULL,
  PRIMARY KEY (rider_id, set_at)
);

-- One run each Monday (India date).
CREATE TABLE payout_runs (
  run_id      date        PRIMARY KEY CHECK (extract(isodow FROM run_id) = 1),
  prepared_at timestamptz NOT NULL,
  prepared_by text        NOT NULL
);
-- What each rider is paid in a run, and to where (as it was when the run was prepared).
CREATE TABLE payout_lines (
  run_id       date   NOT NULL REFERENCES payout_runs (run_id),
  rider_id     text   NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  destination  jsonb  NOT NULL,
  PRIMARY KEY (run_id, rider_id)
);
CREATE TABLE payout_approvals (
  run_id      date        PRIMARY KEY REFERENCES payout_runs (run_id),
  approved_by text        NOT NULL,
  approved_at timestamptz NOT NULL
);
-- Each try to pay a line, as the provider answered (or no answer: pending), and a line given up
-- (failed too often) or cancelled (run cancelled, or the rider is now owed less): its money comes
-- back into the next run.
CREATE TABLE payout_attempts (
  run_id       date        NOT NULL,
  rider_id     text        NOT NULL,
  attempt      integer     NOT NULL CHECK (attempt > 0),
  status       text        NOT NULL CHECK (status IN
                 ('paid', 'pending', 'failed', 'given up', 'cancelled')),
  provider_ref text,
  reason       text,
  at           timestamptz NOT NULL,
  PRIMARY KEY (run_id, rider_id, attempt),
  FOREIGN KEY (run_id, rider_id) REFERENCES payout_lines (run_id, rider_id)
);

CREATE TRIGGER rider_payout_accounts_no_change BEFORE UPDATE OR DELETE ON rider_payout_accounts
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER rider_payout_accounts_no_truncate BEFORE TRUNCATE ON rider_payout_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payout_runs_no_change BEFORE UPDATE OR DELETE ON payout_runs
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payout_runs_no_truncate BEFORE TRUNCATE ON payout_runs
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payout_lines_no_change BEFORE UPDATE OR DELETE ON payout_lines
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payout_lines_no_truncate BEFORE TRUNCATE ON payout_lines
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payout_approvals_no_change BEFORE UPDATE OR DELETE ON payout_approvals
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payout_approvals_no_truncate BEFORE TRUNCATE ON payout_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payout_attempts_no_change BEFORE UPDATE OR DELETE ON payout_attempts
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payout_attempts_no_truncate BEFORE TRUNCATE ON payout_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON rider_payout_accounts, payout_runs, payout_lines, payout_approvals,
  payout_attempts TO recall_app;
