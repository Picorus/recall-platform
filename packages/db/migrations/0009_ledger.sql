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

-- Lines whose earnings are final (all of what was paid is earned or refunded): not looked at again.
CREATE TABLE line_earnings_closed (
  line_id   text        PRIMARY KEY,
  closed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER line_earnings_closed_no_change BEFORE UPDATE OR DELETE ON line_earnings_closed
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();

-- The app never writes ledger rows directly: it posts a whole entry through ledger_post, so postings
-- can never be added to an entry later, and a reversal must mirror exactly the entry it undoes.
CREATE FUNCTION ledger_post(
  p_entry_id text, p_at timestamptz, p_kind text, p_ref text, p_memo text, p_reverses text,
  p_by text, p_postings jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO ledger_entries (entry_id, at, kind, ref, memo, reverses, posted_by)
  VALUES (p_entry_id, p_at, p_kind, p_ref, p_memo, p_reverses, p_by);
  INSERT INTO ledger_postings (entry_id, n, account, debit, credit, party)
  SELECT p_entry_id, x.n::integer, x.p->>'account', (x.p->>'debit')::bigint,
         (x.p->>'credit')::bigint, x.p->>'party'
    FROM jsonb_array_elements(p_postings) WITH ORDINALITY AS x(p, n);
  IF p_reverses IS NOT NULL AND EXISTS (
       (SELECT n, account, credit AS debit, debit AS credit, party FROM ledger_postings
         WHERE entry_id = p_reverses
        EXCEPT ALL
        SELECT n, account, debit, credit, party FROM ledger_postings WHERE entry_id = p_entry_id)
       UNION ALL
       (SELECT n, account, debit, credit, party FROM ledger_postings WHERE entry_id = p_entry_id
        EXCEPT ALL
        SELECT n, account, credit, debit, party FROM ledger_postings WHERE entry_id = p_reverses)) THEN
    RAISE EXCEPTION 'reversal % does not mirror %', p_entry_id, p_reverses;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION ledger_post(text, timestamptz, text, text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_post(text, timestamptz, text, text, text, text, text, jsonb)
  TO recall_app;

GRANT SELECT ON ledger_entries, ledger_postings TO recall_app;
GRANT SELECT, INSERT ON line_earnings_closed TO recall_app;
