-- P1.7.4: agency and aggregator cuts (Prateek, 24 Oct 2026): never automatic. RECALL decides per
-- booking whether a cut is given; when it is, it is paid with the partner's GST on top, and RECALL
-- claims that GST back (input tax credit). Worked out on what was delivered.

ALTER TABLE ledger_postings DROP CONSTRAINT ledger_postings_account_check;
ALTER TABLE ledger_postings ADD CONSTRAINT ledger_postings_account_check CHECK (account IN (
  'payment-clearing', 'bank', 'gst-input', 'campaign-held', 'gst-payable', 'agency-payable',
  'aggregator-payable', 'rider-payable', 'refunds-payable', 'tds-payable', 'revenue',
  'agency-cuts', 'aggregator-cuts', 'rider-earnings', 'gateway-fees'));

-- One cut of each kind per booking at most, decided once.
CREATE TABLE booking_cuts (
  booking_id text        NOT NULL REFERENCES bookings (booking_id),
  kind       text        NOT NULL CHECK (kind IN ('agency', 'aggregator')),
  partner_id text        NOT NULL CHECK (length(partner_id) BETWEEN 1 AND 64),
  rate_bp    integer     NOT NULL CHECK (rate_bp BETWEEN 1 AND 5000),
  gst_bp     integer     NOT NULL CHECK (gst_bp BETWEEN 0 AND 2800),
  decided_by text        NOT NULL,
  reason     text        NOT NULL CHECK (length(reason) >= 5),
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, kind)
);
CREATE TRIGGER booking_cuts_no_change BEFORE UPDATE OR DELETE ON booking_cuts
  FOR EACH ROW EXECUTE FUNCTION recall_append_only();
CREATE TRIGGER booking_cuts_no_truncate BEFORE TRUNCATE ON booking_cuts
  FOR EACH STATEMENT EXECUTE FUNCTION recall_append_only();
GRANT SELECT, INSERT ON booking_cuts TO recall_app;
