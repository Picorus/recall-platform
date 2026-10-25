-- P1.7.8: the screen loan record. The bank lends to the rider; RECALL keeps only the loan's details
-- and status to show in the rider app. Never on RECALL's books (no ledger entries). Append-only.
CREATE TABLE screen_loans (
  loan_id        text        PRIMARY KEY CHECK (loan_id ~ '^[A-Za-z0-9-]{4,40}$'),
  rider_id       text        NOT NULL CHECK (rider_id ~ '^[A-Za-z0-9-]{3,40}$'),
  bank           text        NOT NULL CHECK (length(bank) BETWEEN 2 AND 80),
  amount_paise   bigint      NOT NULL CHECK (amount_paise > 0),
  emi_paise      bigint      NOT NULL CHECK (emi_paise > 0),
  months         integer     NOT NULL CHECK (months BETWEEN 1 AND 120),
  first_emi      date        NOT NULL,
  recorded_by    text        NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX screen_loans_rider ON screen_loans (rider_id);
-- Each status the bank reports, in order.
CREATE TABLE screen_loan_events (
  loan_id  text        NOT NULL REFERENCES screen_loans (loan_id),
  seq      integer     NOT NULL CHECK (seq > 0),
  status   text        NOT NULL CHECK (status IN
             ('applied', 'approved', 'rejected', 'disbursed', 'closed', 'defaulted')),
  note     text        NOT NULL DEFAULT '',
  set_by   text        NOT NULL,
  set_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (loan_id, seq)
);
CREATE TRIGGER screen_loans_no_change BEFORE UPDATE OR DELETE ON screen_loans
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_loans_no_truncate BEFORE TRUNCATE ON screen_loans
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_loan_events_no_change BEFORE UPDATE OR DELETE ON screen_loan_events
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER screen_loan_events_no_truncate BEFORE TRUNCATE ON screen_loan_events
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON screen_loans, screen_loan_events TO recall_app;
