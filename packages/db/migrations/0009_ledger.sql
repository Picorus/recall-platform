-- P1.7.1: the ledger. Double-entry, whole paise, append-only (hard rules 2 and 3). Every entry must
-- balance, and the database itself checks it when the transaction commits.

CREATE TABLE ledger_entries (
  entry_id  text        PRIMARY KEY CHECK (entry_id ~ '^[\x21-\x7e]{1,200}$'),
  at        timestamptz NOT NULL,
  kind      text        NOT NULL CHECK (length(kind) BETWEEN 1 AND 60),
  ref       text        NOT NULL CHECK (length(ref) BETWEEN 1 AND 200),
  memo      text        NOT NULL,
  -- A reversing entry names the one it undoes; an entry can be undone only once.
  reverses  text        UNIQUE REFERENCES ledger_entries (entry_id),
  posted_by text        NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_ref ON ledger_entries (ref);

CREATE TABLE ledger_postings (
  entry_id text   NOT NULL REFERENCES ledger_entries (entry_id),
  n        integer NOT NULL CHECK (n >= 1),
  account  text   NOT NULL CHECK (account IN (
             'payment-clearing', 'bank', 'campaign-held', 'gst-payable', 'agency-payable',
             'aggregator-payable', 'rider-payable', 'refunds-payable', 'tds-payable', 'revenue',
             'agency-cuts', 'aggregator-cuts', 'rider-earnings', 'gateway-fees')),
  debit    bigint NOT NULL CHECK (debit >= 0),
  credit   bigint NOT NULL CHECK (credit >= 0),
  party    text,
  CHECK ((debit > 0) <> (credit > 0)),
  PRIMARY KEY (entry_id, n)
);
CREATE INDEX ledger_postings_account ON ledger_postings (account, party);

-- At commit: every entry touched has at least two postings and its debits equal its credits.
CREATE FUNCTION ledger_entry_balances() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d bigint;
  c bigint;
  k integer;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO d, c, k
    FROM ledger_postings WHERE entry_id = NEW.entry_id;
  IF k < 2 OR d <> c THEN
    RAISE EXCEPTION 'ledger entry % does not balance (debits %, credits %, postings %)',
      NEW.entry_id, d, c, k;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER ledger_entries_balance AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_balances();
CREATE CONSTRAINT TRIGGER ledger_postings_balance AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_balances();

CREATE TRIGGER ledger_entries_no_change BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER ledger_postings_no_change BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER ledger_postings_no_truncate BEFORE TRUNCATE ON ledger_postings
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();

GRANT SELECT, INSERT ON ledger_entries, ledger_postings TO recall_app;
