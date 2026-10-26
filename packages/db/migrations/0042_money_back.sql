-- P3.13.2: paying money owed back to brands (an approved refund, a payment after a cancellation or
-- of a wrong amount). Each amount owed is the ledger entry that put it on the books; each try to
-- send it back is kept: through the payment provider against the brand's payment (refunded,
-- pending, failed, given up), or recorded as sent by hand by bank transfer, with its reference.
-- Append-only (hard rule 3).
CREATE TABLE money_back_attempts (
  owed_entry   text        NOT NULL REFERENCES ledger_entries (entry_id),
  attempt      integer     NOT NULL CHECK (attempt >= 1),
  status       text        NOT NULL CHECK (status IN
                 ('refunded', 'pending', 'failed', 'given up', 'by-hand')),
  payment_id   text        CHECK (payment_id IS NULL OR payment_id ~ '^[A-Za-z0-9._-]{1,80}$'),
  provider_ref text        CHECK (provider_ref IS NULL OR length(provider_ref) <= 200),
  reason       text        CHECK (reason IS NULL OR length(reason) <= 300),
  by_who       text        NOT NULL CHECK (length(by_who) BETWEEN 1 AND 120),
  at           timestamptz NOT NULL,
  PRIMARY KEY (owed_entry, attempt)
);

CREATE TRIGGER money_back_attempts_no_change BEFORE UPDATE OR DELETE ON money_back_attempts
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER money_back_attempts_no_truncate BEFORE TRUNCATE ON money_back_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON money_back_attempts TO recall_app;
