-- P3.13.3: paying agencies and aggregators their cuts. Finance pays a partner by bank transfer
-- (monthly, with its statement) and records it here with the bank reference; the ledger moves the
-- money from what is owed to the partner out of the bank. Never more than is owed. Append-only
-- (hard rule 3).
CREATE TABLE partner_payments (
  partner_id   text        NOT NULL CHECK (partner_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  kind         text        NOT NULL CHECK (kind IN ('agency', 'aggregator')),
  seq          integer     NOT NULL CHECK (seq >= 1),
  amount_paise bigint      NOT NULL CHECK (amount_paise > 0),
  reference    text        NOT NULL CHECK (reference ~ '^[A-Za-z0-9/ _-]{4,60}$'),
  note         text        CHECK (note IS NULL OR length(note) <= 300),
  -- The ledger entry that moved the money.
  entry_id     text        NOT NULL UNIQUE REFERENCES ledger_entries (entry_id),
  by_who       text        NOT NULL CHECK (length(by_who) BETWEEN 1 AND 120),
  at           timestamptz NOT NULL,
  PRIMARY KEY (partner_id, kind, seq),
  -- One bank transfer is recorded once (a lost reply and a second press never pay twice).
  UNIQUE (partner_id, kind, reference)
);

CREATE TRIGGER partner_payments_no_change BEFORE UPDATE OR DELETE ON partner_payments
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER partner_payments_no_truncate BEFORE TRUNCATE ON partner_payments
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON partner_payments TO recall_app;
