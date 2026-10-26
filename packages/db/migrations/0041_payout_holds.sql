-- P3.12: the payout run in admin. Finance can hold one rider's line (not sent until released) and
-- what preparing a run found (riders with no checked account, pay that could not be brought up to
-- date, changes in closed months) is kept with the run, so finance sees it whoever prepared it.
-- Append-only (hard rule 3): each hold and release is a new row with who, when and why.
CREATE TABLE payout_holds (
  run_id   date        NOT NULL,
  rider_id text        NOT NULL,
  seq      integer     NOT NULL CHECK (seq >= 1),
  held     boolean     NOT NULL,
  reason   text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  by_who   text        NOT NULL CHECK (length(by_who) BETWEEN 1 AND 120),
  at       timestamptz NOT NULL,
  PRIMARY KEY (run_id, rider_id, seq),
  FOREIGN KEY (run_id, rider_id) REFERENCES payout_lines (run_id, rider_id)
);

CREATE TABLE payout_run_findings (
  run_id   date  PRIMARY KEY REFERENCES payout_runs (run_id),
  -- { noAccount: [{riderId, owedPaise}], payProblems: [{riderId, error}],
  --   lateChanges: [{riderId, grossChange, month}] }
  findings jsonb NOT NULL
);

CREATE TRIGGER payout_holds_no_change BEFORE UPDATE OR DELETE ON payout_holds
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payout_holds_no_truncate BEFORE TRUNCATE ON payout_holds
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payout_run_findings_no_change BEFORE UPDATE OR DELETE ON payout_run_findings
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER payout_run_findings_no_truncate BEFORE TRUNCATE ON payout_run_findings
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON payout_holds, payout_run_findings TO recall_app;
